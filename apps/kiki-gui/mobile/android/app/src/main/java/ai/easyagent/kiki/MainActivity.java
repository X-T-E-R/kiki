package ai.easyagent.kiki;

import android.net.http.SslError;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.PluginHandle;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(KikiShellPlugin.class);
        super.onCreate(savedInstanceState);
        PluginHandle handle = getBridge() == null ? null : getBridge().getPlugin("KikiShell");
        if (handle != null && handle.getInstance() instanceof KikiShellPlugin shellPlugin) {
            shellPlugin.ensureWebViewListenersRegistered();
            getBridge()
                .setWebViewClient(
                    new BridgeWebViewClient(getBridge()) {
                        @Override
                        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                            if (!shellPlugin.handleSslError(view, handler, error)) {
                                super.onReceivedSslError(view, handler, error);
                            }
                        }
                    }
                );
            WebView webView = getBridge().getWebView();
            if (webView != null) {
                webView.setWebChromeClient(
                    new BridgeWebChromeClient(getBridge()) {
                        @Override
                        public void onPermissionRequest(PermissionRequest request) {
                            shellPlugin.handleWebPermissionRequest(request);
                        }
                    }
                );
            }
        }
    }
}
