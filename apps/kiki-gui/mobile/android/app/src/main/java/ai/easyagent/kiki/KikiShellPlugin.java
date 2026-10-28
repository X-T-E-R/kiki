package ai.easyagent.kiki;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.webkit.CookieManager;
import android.webkit.WebBackForwardList;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The shell's only native surface.
 *
 * The launcher (bundled, at the app origin) asks to open one Kiki server; that
 * server's own web GUI then runs at its own origin, so its cookie sign-in,
 * WebSocket and file uploads behave exactly as in a phone browser. This plugin
 * keeps that one origin inside the app, sends every other site to the system
 * browser (Capacitor's default policy), maps the system back gesture onto the
 * page's history, and persists cookies when the app leaves the foreground.
 */
@CapacitorPlugin(name = "KikiShell")
public class KikiShellPlugin extends Plugin {

    private static final String PREFS = "kiki.shell";
    private static final String TRUSTED_ORIGIN = "trustedOrigin";
    static final String ACTION_CHANGE_SERVER = "ai.easyagent.kiki.CHANGE_SERVER";

    @Override
    public void load() {
        getActivity()
            .getOnBackPressedDispatcher()
            .addCallback(
                getActivity(),
                new OnBackPressedCallback(true) {
                    @Override
                    public void handleOnBackPressed() {
                        WebView webView = getBridge().getWebView();
                        // The page owns one history entry per open layer (drawer,
                        // inspector, sheet), so back closes the top layer first.
                        if (webView.canGoBack() && !backLeavesServer(webView)) {
                            webView.goBack();
                        } else {
                            // Keep the conversation warm instead of tearing it down.
                            getActivity().moveTaskToBack(true);
                        }
                    }
                }
            );
    }

    /** The entry just below a server's first page is the launcher: leaving it is not "back". */
    private boolean backLeavesServer(WebView webView) {
        WebBackForwardList list = webView.copyBackForwardList();
        int previous = list.getCurrentIndex() - 1;
        if (previous < 0) return true;
        String url = list.getItemAtIndex(previous).getUrl();
        String current = list.getCurrentItem() == null ? null : list.getCurrentItem().getUrl();
        String local = getBridge().getLocalUrl();
        return url != null && url.startsWith(local) && current != null && !current.startsWith(local);
    }

    @PluginMethod
    public void open(PluginCall call) {
        String origin = call.getString("origin");
        String entry = call.getString("entry");
        Uri originUri = origin == null ? null : Uri.parse(origin);
        Uri entryUri = entry == null ? null : Uri.parse(entry);
        if (!isWebOrigin(originUri) || entryUri == null || !origin.equals(originOf(entryUri))) {
            call.reject("invalid_origin");
            return;
        }
        prefs().edit().putString(TRUSTED_ORIGIN, origin).apply();
        getBridge().getWebView().post(() -> getBridge().getWebView().loadUrl(entry));
        JSObject result = new JSObject();
        result.put("origin", origin);
        call.resolve(result);
    }

    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        String trusted = prefs().getString(TRUSTED_ORIGIN, null);
        if (trusted != null && trusted.equals(originOf(url))) {
            return false;
        }
        return null;
    }

    /** The launcher shortcut: back to the launcher, keeping the saved server for one tap. */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent != null && ACTION_CHANGE_SERVER.equals(intent.getAction())) {
            WebView webView = getBridge().getWebView();
            webView.post(() -> {
                webView.loadUrl(getBridge().getLocalUrl() + "/index.html#change");
            });
        }
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        CookieManager.getInstance().flush();
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static boolean isWebOrigin(Uri uri) {
        if (uri == null || uri.getHost() == null || uri.getHost().isEmpty()) return false;
        String scheme = uri.getScheme();
        return ("http".equals(scheme) || "https".equals(scheme)) && uri.getUserInfo() == null;
    }

    static String originOf(Uri uri) {
        if (!isWebOrigin(uri)) return null;
        String host = uri.getHost();
        if (host.contains(":")) host = "[" + host + "]";
        int port = uri.getPort();
        boolean defaultPort = port == -1 || ("http".equals(uri.getScheme()) && port == 80) || ("https".equals(uri.getScheme()) && port == 443);
        return uri.getScheme() + "://" + host.toLowerCase(java.util.Locale.ROOT) + (defaultPort ? "" : ":" + port);
    }
}
