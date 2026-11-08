package ai.easyagent.kiki;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.webkit.CookieManager;
import android.webkit.WebBackForwardList;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.HashSet;
import java.util.Set;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/**
 * The shell's native surface.
 *
 * The bundled launcher (at the app origin) pairs or opens a Kiki server; that
 * server's web GUI then runs at its own origin so cookies, WebSocket, and file
 * uploads work as in a phone browser. This plugin requests camera permission
 * only on demand for QR scanning, performs pairing claims and reachability
 * probes natively without cross-origin restrictions, encrypts per-computer bearer
 * tokens with an AndroidKeyStore AES-GCM key, and verifies server identity via
 * the zero-token handshake before delivering credentials to any origin.
 */
@CapacitorPlugin(
    name = "KikiShell",
    permissions = { @Permission(strings = { Manifest.permission.CAMERA }, alias = "camera") }
)
public class KikiShellPlugin extends Plugin {

    private static final String PREFS = "kiki.shell";
    private static final String KEYSTORE_PROVIDER = "AndroidKeyStore";
    private static final String KEYSTORE_ALIAS = "ai.easyagent.kiki.peerTokenKey";
    private static final String TRUSTED_ORIGIN = "trustedOrigin";
    private static final String TOKEN_PREFIX = "peerToken.v2.";
    private static final String LEGACY_TOKEN_PREFIX = "peerToken.";
    private static final String HOST_ID_PREFIX = "peerHostId.";
    private static final String VERIFIED_ORIGINS_PREFIX = "verifiedOrigins.";
    static final String ACTION_CHANGE_SERVER = "ai.easyagent.kiki.CHANGE_SERVER";

    private volatile String pendingPairUri;
    private volatile String pendingAuthOrigin;
    private volatile String pendingAuthServerId;

    private static final class HandshakeResult {
        final boolean ok;
        final boolean redirected;
        final String targetHomeId;
        final String targetHostId;
        final String targetLabel;

        HandshakeResult(boolean ok, boolean redirected, String targetHomeId, String targetHostId, String targetLabel) {
            this.ok = ok;
            this.redirected = redirected;
            this.targetHomeId = targetHomeId;
            this.targetHostId = targetHostId;
            this.targetLabel = targetLabel;
        }
    }

    @Override
    public void load() {
        capturePairIntent(getActivity().getIntent());
        getBridge()
            .addWebViewListener(
                new WebViewListener() {
                    @Override
                    public void onPageCommitVisible(WebView view, String url) {
                        deliverCommittedToken(view, url, false);
                    }

                    @Override
                    public void onPageLoaded(WebView view) {
                        deliverCommittedToken(view, view == null ? null : view.getUrl(), true);
                    }
                }
            );
        getActivity()
            .getOnBackPressedDispatcher()
            .addCallback(
                getActivity(),
                new OnBackPressedCallback(true) {
                    @Override
                    public void handleOnBackPressed() {
                        WebView webView = getBridge().getWebView();
                        if (webView.canGoBack() && !backLeavesServer(webView)) {
                            webView.goBack();
                        } else {
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
    public void scanQr(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            requestPermissionForAlias("camera", call, "onCameraPermissionResult");
            return;
        }
        JSObject result = new JSObject();
        result.put("status", "granted");
        call.resolve(result);
    }

    @PermissionCallback
    private void onCameraPermissionResult(PluginCall call) {
        JSObject result = new JSObject();
        if (getPermissionState("camera") == PermissionState.GRANTED) {
            result.put("status", "granted");
        } else {
            result.put("status", "denied");
        }
        call.resolve(result);
    }

    @PluginMethod
    public void consumePendingPair(PluginCall call) {
        String uri = pendingPairUri;
        pendingPairUri = null;
        JSObject result = new JSObject();
        if (uri != null) {
            result.put("uri", uri);
        }
        call.resolve(result);
    }

    @PluginMethod
    public void probe(PluginCall call) {
        String origin = call.getString("origin");
        Uri originUri = origin == null ? null : Uri.parse(origin);
        if (!isWebOrigin(originUri)) {
            JSObject invalid = new JSObject();
            invalid.put("ok", false);
            call.resolve(invalid);
            return;
        }
        String normalizedOrigin = originOf(originUri);
        new Thread(() -> {
            JSObject result = new JSObject();
            HandshakeResult hs = fetchHandshake(normalizedOrigin);
            if (hs.redirected) {
                result.put("ok", false);
                call.resolve(result);
                return;
            }
            if (hs.ok) {
                result.put("ok", true);
                if (hs.targetLabel != null && !hs.targetLabel.isEmpty()) {
                    result.put("targetLabel", hs.targetLabel);
                }
                if (hs.targetHomeId != null && !hs.targetHomeId.isEmpty()) {
                    result.put("targetHomeId", hs.targetHomeId);
                }
                if (hs.targetHostId != null && !hs.targetHostId.isEmpty()) {
                    result.put("targetHostId", hs.targetHostId);
                }
                call.resolve(result);
                return;
            }

            HttpURLConnection metaConn = null;
            try {
                URL metaUrl = new URL(normalizedOrigin + "/api/meta");
                metaConn = (HttpURLConnection) metaUrl.openConnection();
                metaConn.setInstanceFollowRedirects(false);
                metaConn.setRequestMethod("GET");
                metaConn.setConnectTimeout(3500);
                metaConn.setReadTimeout(3500);
                int status = metaConn.getResponseCode();
                result.put("ok", (status >= 200 && status < 300) || status == 401 || status == 403);
            } catch (Exception e) {
                result.put("ok", false);
            } finally {
                if (metaConn != null) metaConn.disconnect();
            }
            call.resolve(result);
        }).start();
    }

    @PluginMethod
    public void claimPair(PluginCall call) {
        String endpoint = call.getString("endpoint");
        String code = call.getString("code");
        String homeId = call.getString("homeId");
        String hostId = call.getString("hostId");
        String sourceLabel = call.getString("sourceLabel", "Kiki Android");
        Uri endpointUri = endpoint == null ? null : Uri.parse(endpoint);
        if (!isWebOrigin(endpointUri) || code == null || code.isEmpty() || homeId == null || hostId == null) {
            JSObject invalid = new JSObject();
            invalid.put("ok", false);
            invalid.put("reason", "rejected");
            call.resolve(invalid);
            return;
        }
        String base = originOf(endpointUri);
        new Thread(() -> {
            JSObject result = new JSObject();
            HttpURLConnection conn = null;
            try {
                JSONObject source = new JSONObject();
                source.put("homeId", homeId);
                source.put("hostId", hostId);
                source.put("protocol", 1);

                JSONObject payload = new JSONObject();
                payload.put("code", code);
                payload.put("source", source);
                payload.put("sourceLabel", sourceLabel);
                payload.put("requestBridge", false);

                byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8);
                URL url = new URL(base + "/api/remote-connections/pair/claim");
                conn = (HttpURLConnection) url.openConnection();
                conn.setInstanceFollowRedirects(false);
                conn.setRequestMethod("POST");
                conn.setConnectTimeout(5000);
                conn.setReadTimeout(5000);
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setRequestProperty("Accept", "application/json");
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(bytes);
                }

                int status = conn.getResponseCode();
                if (status >= 300 && status < 400) {
                    result.put("ok", false);
                    result.put("reason", "rejected");
                    call.resolve(result);
                    return;
                }
                if (status < 200 || status >= 300) {
                    result.put("ok", false);
                    result.put("reason", (status >= 400 && status < 500) ? "rejected" : "unreachable");
                    call.resolve(result);
                    return;
                }

                JSONObject body = readJson(conn.getInputStream());
                JSONObject data = body == null ? null : body.optJSONObject("data");
                JSONObject target = data == null ? null : data.optJSONObject("target");
                String peerToken = data == null ? null : data.optString("peerToken", "");
                String targetHomeId = target == null ? null : target.optString("homeId", "");
                String targetHostId = target == null ? "" : target.optString("hostId", "");
                if (peerToken == null || peerToken.isEmpty() || targetHomeId == null || targetHomeId.isEmpty()) {
                    result.put("ok", false);
                    result.put("reason", "rejected");
                    call.resolve(result);
                    return;
                }

                storePeerToken(targetHomeId, base, peerToken);
                recordVerifiedOrigin(targetHomeId, base, targetHostId);

                result.put("ok", true);
                result.put("serverId", targetHomeId);
                result.put("targetHomeId", targetHomeId);
                result.put("targetHostId", targetHostId);
                result.put("targetLabel", data.optString("targetLabel", ""));
                result.put("grantId", data.optString("grantId", ""));
                result.put("revision", data.optInt("revision", 0));
                call.resolve(result);
            } catch (Exception e) {
                result.put("ok", false);
                result.put("reason", "unreachable");
                call.resolve(result);
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }

    @PluginMethod
    public void open(PluginCall call) {
        String origin = call.getString("origin");
        String entry = call.getString("entry");
        String serverId = call.getString("serverId");
        Uri originUri = origin == null ? null : Uri.parse(origin);
        Uri entryUri = entry == null ? null : Uri.parse(entry);
        if (!isWebOrigin(originUri) || entryUri == null || !origin.equals(originOf(entryUri))) {
            call.reject("invalid_origin");
            return;
        }
        if (serverId == null || serverId.isEmpty()) {
            clearPendingAuth();
            prefs().edit().putString(TRUSTED_ORIGIN, origin).apply();
            getBridge().getWebView().post(() -> getBridge().getWebView().loadUrl(entry));
            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("origin", origin);
            call.resolve(result);
            return;
        }
        if (!isOriginVerified(serverId, origin) || !hasStoredToken(serverId, origin)) {
            clearPendingAuth();
            JSObject untrusted = new JSObject();
            untrusted.put("ok", false);
            untrusted.put("reason", "pairing_required");
            call.resolve(untrusted);
            return;
        }
        String cleanEntry = stripTokenFromEntry(origin, entry);
        pendingAuthOrigin = origin;
        pendingAuthServerId = serverId;
        prefs().edit().putString(TRUSTED_ORIGIN, origin).apply();
        getBridge().getWebView().post(() -> getBridge().getWebView().loadUrl(cleanEntry));
        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("origin", origin);
        call.resolve(result);
    }

    @PluginMethod
    public void forgetServer(PluginCall call) {
        String serverId = call.getString("serverId");
        String origin = call.getString("origin");
        forgetServerData(serverId, origin);
        JSObject result = new JSObject();
        result.put("ok", true);
        call.resolve(result);
    }

    private void clearPendingAuth() {
        pendingAuthOrigin = null;
        pendingAuthServerId = null;
    }

    private void deliverCommittedToken(WebView view, String candidateUrl, boolean finalize) {
        String expectedOrigin = pendingAuthOrigin;
        String serverId = pendingAuthServerId;
        if (expectedOrigin == null || serverId == null || view == null) return;

        String viewUrl = view.getUrl();
        String committedOrigin = viewUrl == null ? null : originOf(Uri.parse(viewUrl));
        String candidateOrigin = candidateUrl == null ? committedOrigin : originOf(Uri.parse(candidateUrl));
        if (
            committedOrigin == null ||
            !expectedOrigin.equals(committedOrigin) ||
            !expectedOrigin.equals(candidateOrigin)
        ) {
            clearPendingAuth();
            String local = getBridge().getLocalUrl();
            if (local != null && (viewUrl == null || !viewUrl.startsWith(local))) {
                view.post(() -> view.loadUrl(local + "/index.html#unreachable"));
            }
            return;
        }
        if (!isOriginVerified(serverId, expectedOrigin)) {
            clearPendingAuth();
            return;
        }
        String token = readPeerToken(serverId, expectedOrigin);
        if (finalize) {
            clearPendingAuth();
        }
        if (token == null || token.isEmpty()) return;
        view.evaluateJavascript(buildCredentialDeliveryScript(expectedOrigin, token), null);
    }

    static String stripTokenFromEntry(String origin, String entry) {
        if (entry == null || entry.isEmpty()) return origin + "/";
        Uri parsed = Uri.parse(entry);
        if (!origin.equals(originOf(parsed))) return origin + "/";
        String fragment = parsed.getEncodedFragment();
        String nextFragment = fragment;
        if (fragment != null && (fragment.startsWith("token=") || fragment.contains("&token="))) {
            StringBuilder kept = new StringBuilder();
            for (String part : fragment.split("&")) {
                if (part.isEmpty() || part.startsWith("token=")) continue;
                if (kept.length() > 0) kept.append('&');
                kept.append(part);
            }
            nextFragment = kept.length() > 0 ? kept.toString() : null;
        }
        Uri.Builder builder = parsed.buildUpon().encodedFragment(nextFragment);
        if (parsed.getQueryParameter("token") != null) {
            builder.clearQuery();
            for (String name : parsed.getQueryParameterNames()) {
                if ("token".equals(name)) continue;
                for (String val : parsed.getQueryParameters(name)) {
                    builder.appendQueryParameter(name, val);
                }
            }
        }
        return builder.build().toString();
    }

    static String buildCredentialDeliveryScript(String expectedOrigin, String token) {
        String originJson = JSONObject.quote(expectedOrigin == null ? "" : expectedOrigin);
        String tokenJson = JSONObject.quote(token == null ? "" : token);
        return (
            "(function(){try{if(window.location.origin!==" +
            originJson +
            ")return false;var t=" +
            tokenJson +
            ";if(!t)return false;try{var raw=window.localStorage.getItem(\"kiki.connection\");var managed=window.localStorage.getItem(\"kiki.shell.managed\")===\"1\";if(raw&&!managed){var parsed=JSON.parse(raw);if(parsed&&typeof parsed.token===\"string\"&&parsed.token.trim()!==\"\")return false;}window.localStorage.setItem(\"kiki.connection\",JSON.stringify({url:\"\",token:t}));window.localStorage.setItem(\"kiki.shell.managed\",\"1\");}catch(e){return false;}" +
            "try{window.sessionStorage.setItem(\"kiki.peer.token\",t);}catch(e){}" +
            "try{window.dispatchEvent(new CustomEvent(\"kiki:shell-token\",{detail:{origin:" +
            originJson +
            ",token:t}}));}catch(e){}return true;}catch(e){return false;}})();"
        );
    }

    private HandshakeResult fetchHandshake(String normalizedOrigin) {
        HttpURLConnection conn = null;
        try {
            URL handshakeUrl = new URL(normalizedOrigin + "/api/remote-connections/handshake");
            conn = (HttpURLConnection) handshakeUrl.openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(3500);
            conn.setReadTimeout(3500);
            conn.setRequestProperty("Accept", "application/json");
            int code = conn.getResponseCode();
            if (code >= 300 && code < 400) {
                return new HandshakeResult(false, true, "", "", "");
            }
            if (code >= 200 && code < 300) {
                JSONObject body = readJson(conn.getInputStream());
                JSONObject data = body == null ? null : body.optJSONObject("data");
                JSONObject target = data == null ? null : data.optJSONObject("identity");
                if (target == null && data != null) target = data.optJSONObject("target");
                String label = data == null ? "" : data.optString("targetLabel", "");
                String homeId = target == null ? "" : target.optString("homeId", "");
                String hostId = target == null ? "" : target.optString("hostId", "");
                return new HandshakeResult(true, false, homeId, hostId, label);
            }
        } catch (Exception ignored) {
            /* unreachable or non-JSON */
        } finally {
            if (conn != null) conn.disconnect();
        }
        return new HandshakeResult(false, false, "", "", "");
    }

    private static String scopedTokenId(String serverId, String origin) {
        return (origin == null || origin.isEmpty()) ? serverId : (serverId + "@" + origin);
    }

    private boolean hasStoredToken(String serverId, String origin) {
        if (serverId == null || serverId.isEmpty()) return false;
        SharedPreferences sp = prefs();
        String scoped = scopedTokenId(serverId, origin);
        return (
            sp.contains(TOKEN_PREFIX + scoped) ||
            sp.contains(TOKEN_PREFIX + serverId) ||
            sp.contains(LEGACY_TOKEN_PREFIX + serverId)
        );
    }

    private boolean isOriginVerified(String serverId, String origin) {
        Set<String> set = prefs().getStringSet(VERIFIED_ORIGINS_PREFIX + serverId, null);
        return set != null && set.contains(origin);
    }

    private void recordVerifiedOrigin(String serverId, String origin, String hostId) {
        if (serverId == null || serverId.isEmpty() || origin == null || origin.isEmpty()) return;
        SharedPreferences sp = prefs();
        Set<String> existing = sp.getStringSet(VERIFIED_ORIGINS_PREFIX + serverId, null);
        Set<String> updated = existing == null ? new HashSet<>() : new HashSet<>(existing);
        updated.add(origin);
        SharedPreferences.Editor editor = sp.edit().putStringSet(VERIFIED_ORIGINS_PREFIX + serverId, updated);
        if (hostId != null && !hostId.isEmpty()) {
            editor.putString(HOST_ID_PREFIX + serverId, hostId);
        }
        editor.apply();
    }

    private void forgetServerData(String serverId, String origin) {
        clearPendingAuth();
        SharedPreferences sp = prefs();
        SharedPreferences.Editor editor = sp.edit();
        String trusted = sp.getString(TRUSTED_ORIGIN, null);
        if (serverId != null && !serverId.isEmpty()) {
            Set<String> verified = sp.getStringSet(VERIFIED_ORIGINS_PREFIX + serverId, null);
            if (verified != null) {
                for (String vOrigin : verified) {
                    editor.remove(TOKEN_PREFIX + scopedTokenId(serverId, vOrigin));
                }
                if (trusted != null && verified.contains(trusted)) {
                    editor.remove(TRUSTED_ORIGIN);
                }
            }
            if (origin != null && !origin.isEmpty()) {
                editor.remove(TOKEN_PREFIX + scopedTokenId(serverId, origin));
            }
            editor
                .remove(TOKEN_PREFIX + serverId)
                .remove(LEGACY_TOKEN_PREFIX + serverId)
                .remove(HOST_ID_PREFIX + serverId)
                .remove(VERIFIED_ORIGINS_PREFIX + serverId);
        }
        if (origin != null && !origin.isEmpty() && origin.equals(trusted)) {
            editor.remove(TRUSTED_ORIGIN);
        }
        editor.apply();
    }

    private SecretKey getOrCreateSecretKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER);
        keyStore.load(null);
        KeyStore.Entry existing = keyStore.getEntry(KEYSTORE_ALIAS, null);
        if (existing instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) existing).getSecretKey();
        }
        KeyGenerator keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER);
        KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
            KEYSTORE_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build();
        keyGenerator.init(spec);
        return keyGenerator.generateKey();
    }

    private String encryptTokenValue(SecretKey key, String aadKey, String token) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        cipher.updateAAD(aadKey.getBytes(StandardCharsets.UTF_8));
        byte[] cipherBytes = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
        return (
            Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) +
            ":" +
            Base64.encodeToString(cipherBytes, Base64.NO_WRAP)
        );
    }

    private String decryptTokenValue(SecretKey key, String aadKey, String stored) {
        if (stored == null || stored.isEmpty()) return null;
        try {
            int sep = stored.indexOf(':');
            if (sep <= 0) return null;
            byte[] iv = Base64.decode(stored.substring(0, sep), Base64.NO_WRAP);
            byte[] cipherBytes = Base64.decode(stored.substring(sep + 1), Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
            cipher.updateAAD(aadKey.getBytes(StandardCharsets.UTF_8));
            byte[] plain = cipher.doFinal(cipherBytes);
            return new String(plain, StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }

    private void storePeerToken(String serverId, String origin, String token) throws Exception {
        SecretKey key = getOrCreateSecretKey();
        String encodedServer = encryptTokenValue(key, serverId, token);
        SharedPreferences.Editor editor = prefs()
            .edit()
            .putString(TOKEN_PREFIX + serverId, encodedServer)
            .remove(LEGACY_TOKEN_PREFIX + serverId);
        if (origin != null && !origin.isEmpty()) {
            String scoped = scopedTokenId(serverId, origin);
            editor.putString(TOKEN_PREFIX + scoped, encryptTokenValue(key, scoped, token));
        }
        editor.apply();
    }

    private String readPeerToken(String serverId, String origin) {
        SharedPreferences sp = prefs();
        try {
            SecretKey key = null;
            if (origin != null && !origin.isEmpty()) {
                String scoped = scopedTokenId(serverId, origin);
                String storedScoped = sp.getString(TOKEN_PREFIX + scoped, null);
                if (storedScoped != null && !storedScoped.isEmpty()) {
                    key = getOrCreateSecretKey();
                    String plain = decryptTokenValue(key, scoped, storedScoped);
                    if (plain != null && !plain.isEmpty()) return plain;
                }
            }
            String stored = sp.getString(TOKEN_PREFIX + serverId, null);
            if (stored != null && !stored.isEmpty()) {
                if (key == null) key = getOrCreateSecretKey();
                String plain = decryptTokenValue(key, serverId, stored);
                if (plain != null && !plain.isEmpty()) return plain;
            }
        } catch (Exception ignored) {
            /* fall back to legacy if present */
        }
        return sp.getString(LEGACY_TOKEN_PREFIX + serverId, null);
    }

    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        if (url == null) return null;
        String local = getBridge().getLocalUrl();
        if (local != null && url.toString().startsWith(local)) {
            return false;
        }
        String targetOrigin = originOf(url);
        String expectedPending = pendingAuthOrigin;
        if (expectedPending != null) {
            if (targetOrigin != null && expectedPending.equals(targetOrigin)) {
                return false;
            }
            clearPendingAuth();
            if (local != null) {
                WebView webView = getBridge().getWebView();
                webView.post(() -> webView.loadUrl(local + "/index.html#unreachable"));
            }
            return true;
        }
        String trusted = prefs().getString(TRUSTED_ORIGIN, null);
        if (trusted != null && trusted.equals(targetOrigin)) {
            return false;
        }
        return null;
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent == null) return;
        if (capturePairIntent(intent)) {
            clearPendingAuth();
            WebView webView = getBridge().getWebView();
            webView.post(() -> webView.loadUrl(getBridge().getLocalUrl() + "/index.html#pair"));
            return;
        }
        if (ACTION_CHANGE_SERVER.equals(intent.getAction())) {
            clearPendingAuth();
            WebView webView = getBridge().getWebView();
            webView.post(() -> {
                webView.loadUrl(getBridge().getLocalUrl() + "/index.html#change");
            });
        }
    }

    private boolean capturePairIntent(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return false;
        Uri data = intent.getData();
        if (data == null || !"kiki".equalsIgnoreCase(data.getScheme())) return false;
        pendingPairUri = data.toString();
        intent.setData(null);
        return true;
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        CookieManager.getInstance().flush();
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static JSONObject readJson(InputStream stream) throws Exception {
        if (stream == null) return null;
        StringBuilder sb = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line);
            }
        }
        return new JSONObject(sb.toString());
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
