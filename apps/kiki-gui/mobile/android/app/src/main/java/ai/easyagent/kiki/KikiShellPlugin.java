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
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.Mac;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
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
    private static final String GRANT_ID_PREFIX = "peerGrantId.";
    private static final String VERIFIED_ORIGINS_PREFIX = "verifiedOrigins.";
    static final String ACTION_CHANGE_SERVER = "ai.easyagent.kiki.CHANGE_SERVER";
    private static final SecureRandom NONCE_RANDOM = new SecureRandom();

    private volatile String pendingPairUri;
    private volatile String pendingAuthOrigin;
    private volatile String pendingAuthServerId;
    private volatile String activeAuthOrigin;
    private volatile String activeAuthServerId;
    private volatile long pendingAuthEpoch = 0;
    private volatile long documentNavEpoch = 0;
    private volatile String currentDocumentNavNonce;
    private WebViewListener shellWebViewListener;

    private static final class HandshakeResult {
        final boolean ok;
        final boolean redirected;
        final String targetHomeId;
        final String targetHostId;
        final String targetLabel;
        final boolean mutualProofVerified;

        HandshakeResult(
            boolean ok,
            boolean redirected,
            String targetHomeId,
            String targetHostId,
            String targetLabel,
            boolean mutualProofVerified
        ) {
            this.ok = ok;
            this.redirected = redirected;
            this.targetHomeId = targetHomeId;
            this.targetHostId = targetHostId;
            this.targetLabel = targetLabel;
            this.mutualProofVerified = mutualProofVerified;
        }

        HandshakeResult(boolean ok, boolean redirected, String targetHomeId, String targetHostId, String targetLabel) {
            this(ok, redirected, targetHomeId, targetHostId, targetLabel, false);
        }
    }

    @Override
    public void load() {
        capturePairIntent(getActivity().getIntent());
        ensureWebViewListenersRegistered();
        getActivity()
            .getOnBackPressedDispatcher()
            .addCallback(
                getActivity(),
                new OnBackPressedCallback(true) {
                    @Override
                    public void handleOnBackPressed() {
                        WebView webView = getBridge().getWebView();
                        if (webView.canGoBack() && !backLeavesServer(webView)) {
                            invalidateCurrentDocumentNavigation();
                            webView.goBack();
                        } else {
                            getActivity().moveTaskToBack(true);
                        }
                    }
                }
            );
    }

    List<WebViewListener> ensureWebViewListenersRegistered() {
        if (shellWebViewListener == null) {
            shellWebViewListener =
                new WebViewListener() {
                    @Override
                    public void onPageStarted(WebView view) {
                        invalidateCurrentDocumentNavigation();
                    }

                    @Override
                    public void onPageCommitVisible(WebView view, String url) {
                        deliverCommittedToken(view, url, false);
                    }

                    @Override
                    public void onPageLoaded(WebView view) {
                        deliverCommittedToken(view, view == null ? null : view.getUrl(), true);
                    }
                };
        }
        getBridge().removeWebViewListener(shellWebViewListener);
        getBridge().addWebViewListener(shellWebViewListener);
        return Collections.singletonList(shellWebViewListener);
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
        String serverId = call.getString("serverId");
        String grantId = call.getString("grantId");
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
            HandshakeResult hs = fetchHandshake(normalizedOrigin, serverId, grantId);
            if (hs.redirected) {
                result.put("ok", false);
                call.resolve(result);
                return;
            }
            if (hs.ok) {
                result.put("ok", true);
                result.put("mutualProofVerified", hs.mutualProofVerified);
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

                String grantId = data == null ? "" : data.optString("grantId", "");
                storePeerToken(targetHomeId, base, peerToken);
                recordVerifiedOrigin(targetHomeId, base, targetHostId, grantId);

                result.put("ok", true);
                result.put("serverId", targetHomeId);
                result.put("targetHomeId", targetHomeId);
                result.put("targetHostId", targetHostId);
                result.put("targetLabel", data.optString("targetLabel", ""));
                result.put("grantId", grantId);
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
            clearActiveAuth();
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
            clearActiveAuth();
            JSObject untrusted = new JSObject();
            untrusted.put("ok", false);
            untrusted.put("reason", "pairing_required");
            call.resolve(untrusted);
            return;
        }
        String grantId = call.getString("grantId");
        String cleanEntry = stripTokenFromEntry(origin, entry);
        long callEpoch = ++pendingAuthEpoch;
        new Thread(() -> {
            HandshakeResult hs = fetchHandshake(origin, serverId, grantId);
            if (hs.redirected || !hs.ok || !hs.mutualProofVerified || hs.targetHomeId == null || hs.targetHomeId.isEmpty()) {
                clearPendingAuthIfCurrent(callEpoch);
                JSObject failed = new JSObject();
                failed.put("ok", false);
                failed.put("reason", "unreachable");
                call.resolve(failed);
                return;
            }
            if (!serverId.equals(hs.targetHomeId) || !matchesStoredHostId(serverId, hs.targetHostId)) {
                clearPendingAuthIfCurrent(callEpoch);
                JSObject mismatch = new JSObject();
                mismatch.put("ok", false);
                mismatch.put("reason", "identity_mismatch");
                mismatch.put("targetHomeId", hs.targetHomeId);
                call.resolve(mismatch);
                return;
            }
            if (callEpoch != pendingAuthEpoch) {
                return;
            }
            recordVerifiedOrigin(serverId, origin, hs.targetHostId, grantId);
            pendingAuthOrigin = origin;
            pendingAuthServerId = serverId;
            activeAuthOrigin = origin;
            activeAuthServerId = serverId;
            prefs().edit().putString(TRUSTED_ORIGIN, origin).apply();
            getBridge().getWebView().post(() -> {
                ensureWebViewListenersRegistered();
                getBridge().getWebView().loadUrl(cleanEntry);
            });
            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("origin", origin);
            call.resolve(result);
        }).start();
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
        pendingAuthEpoch++;
        documentNavEpoch++;
        currentDocumentNavNonce = null;
        pendingAuthOrigin = null;
        pendingAuthServerId = null;
    }

    private void clearActiveAuth() {
        documentNavEpoch++;
        currentDocumentNavNonce = null;
        activeAuthOrigin = null;
        activeAuthServerId = null;
    }

    private void invalidateCurrentDocumentNavigation() {
        documentNavEpoch++;
        currentDocumentNavNonce = null;
    }

    private void clearPendingAuthIfCurrent(long epoch) {
        if (pendingAuthEpoch == epoch) {
            pendingAuthOrigin = null;
            pendingAuthServerId = null;
        }
    }

    private void deliverCommittedToken(WebView view, String candidateUrl, boolean finalize) {
        if (view == null) return;
        String viewUrl = view.getUrl();
        String local = getBridge().getLocalUrl();
        if (local != null && viewUrl != null && viewUrl.startsWith(local)) {
            clearPendingAuth();
            clearActiveAuth();
            return;
        }

        String committedOrigin = viewUrl == null ? null : originOf(Uri.parse(viewUrl));
        String candidateOrigin = candidateUrl == null ? committedOrigin : originOf(Uri.parse(candidateUrl));

        String expectedOrigin = pendingAuthOrigin;
        String serverId = pendingAuthServerId;
        long expectedEpoch = pendingAuthEpoch;
        if (expectedOrigin == null || serverId == null) {
            if (
                activeAuthOrigin != null &&
                activeAuthServerId != null &&
                activeAuthOrigin.equals(committedOrigin) &&
                activeAuthOrigin.equals(candidateOrigin)
            ) {
                expectedOrigin = activeAuthOrigin;
                serverId = activeAuthServerId;
            } else {
                return;
            }
        }

        final String targetOrigin = expectedOrigin;
        final String targetServerId = serverId;
        if (
            committedOrigin == null ||
            !targetOrigin.equals(committedOrigin) ||
            !targetOrigin.equals(candidateOrigin)
        ) {
            clearPendingAuthIfCurrent(expectedEpoch);
            clearActiveAuth();
            if (local != null && (viewUrl == null || !viewUrl.startsWith(local))) {
                view.post(() -> view.loadUrl(local + "/index.html#unreachable"));
            }
            return;
        }
        if (!isOriginVerified(targetServerId, targetOrigin)) {
            clearPendingAuthIfCurrent(expectedEpoch);
            clearActiveAuth();
            return;
        }
        final long expectedDocEpoch;
        final String expectedNavNonce;
        if (!finalize || currentDocumentNavNonce == null) {
            expectedDocEpoch = ++documentNavEpoch;
            expectedNavNonce = "nav-" + expectedEpoch + "-" + expectedDocEpoch;
            currentDocumentNavNonce = expectedNavNonce;
        } else {
            expectedDocEpoch = documentNavEpoch;
            expectedNavNonce = currentDocumentNavNonce;
        }
        view.evaluateJavascript(buildDocumentNavNonceScript(targetOrigin, expectedNavNonce), null);
        new Thread(() -> {
            HandshakeResult hs = fetchHandshake(targetOrigin, targetServerId);
            if (
                expectedEpoch != pendingAuthEpoch ||
                expectedDocEpoch != documentNavEpoch ||
                !expectedNavNonce.equals(currentDocumentNavNonce)
            ) {
                return;
            }
            if (
                hs.redirected ||
                !hs.ok ||
                !hs.mutualProofVerified ||
                !targetServerId.equals(hs.targetHomeId) ||
                !matchesStoredHostId(targetServerId, hs.targetHostId)
            ) {
                view.post(() -> {
                    if (
                        expectedEpoch != pendingAuthEpoch ||
                        expectedDocEpoch != documentNavEpoch ||
                        !expectedNavNonce.equals(currentDocumentNavNonce)
                    ) {
                        return;
                    }
                    clearPendingAuthIfCurrent(expectedEpoch);
                    clearActiveAuth();
                    if (local != null) {
                        view.loadUrl(local + "/index.html#unreachable");
                    }
                });
                return;
            }
            String token = readPeerToken(targetServerId, targetOrigin);
            if (token == null || token.isEmpty()) {
                if (finalize) {
                    view.post(() -> {
                        if (
                            expectedEpoch != pendingAuthEpoch ||
                            expectedDocEpoch != documentNavEpoch ||
                            !expectedNavNonce.equals(currentDocumentNavNonce)
                        ) {
                            return;
                        }
                        clearPendingAuthIfCurrent(expectedEpoch);
                    });
                }
                return;
            }
            view.post(() -> {
                if (
                    expectedEpoch != pendingAuthEpoch ||
                    expectedDocEpoch != documentNavEpoch ||
                    !expectedNavNonce.equals(currentDocumentNavNonce)
                ) {
                    return;
                }
                if (finalize) {
                    clearPendingAuthIfCurrent(expectedEpoch);
                }
                String currentViewUrl = view.getUrl();
                String currentCommitted = currentViewUrl == null ? null : originOf(Uri.parse(currentViewUrl));
                if (!targetOrigin.equals(currentCommitted)) {
                    clearPendingAuthIfCurrent(expectedEpoch);
                    clearActiveAuth();
                    return;
                }
                view.evaluateJavascript(buildCredentialDeliveryScript(targetOrigin, token, expectedNavNonce), null);
            });
        }).start();
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

    static String buildDocumentNavNonceScript(String expectedOrigin, String navNonce) {
        String originJson = JSONObject.quote(expectedOrigin == null ? "" : expectedOrigin);
        String nonceJson = JSONObject.quote(navNonce == null ? "" : navNonce);
        return (
            "(function(){try{if(window.location.origin!==" +
            originJson +
            ")return false;var doc=window.document||window;var n=" +
            nonceJson +
            ";if(!n)return false;try{Object.defineProperty(doc,\"__kikiShellNavNonce\",{configurable:true,enumerable:false,writable:true,value:n});}catch(e){doc.__kikiShellNavNonce=n;}return true;}catch(e){return false;}})();"
        );
    }

    static String buildCredentialDeliveryScript(String expectedOrigin, String token) {
        return buildCredentialDeliveryScript(expectedOrigin, token, "");
    }

    static String buildCredentialDeliveryScript(String expectedOrigin, String token, String expectedNavNonce) {
        String originJson = JSONObject.quote(expectedOrigin == null ? "" : expectedOrigin);
        String tokenJson = JSONObject.quote(token == null ? "" : token);
        String nonceJson = JSONObject.quote(expectedNavNonce == null ? "" : expectedNavNonce);
        return (
            "(function(){try{if(window.location.origin!==" +
            originJson +
            ")return false;var doc=window.document||window;var n=" +
            nonceJson +
            ";if(n&&doc.__kikiShellNavNonce!==n)return false;var t=" +
            tokenJson +
            ";if(!t)return false;try{var raw=window.localStorage.getItem(\"kiki.connection\");var managed=window.localStorage.getItem(\"kiki.shell.managed\")===\"1\";if(raw){var parsed=JSON.parse(raw);var pTok=parsed&&typeof parsed.token===\"string\"?parsed.token.trim():\"\";var pUrl=parsed&&typeof parsed.url===\"string\"?parsed.url.trim():\"\";if(pTok!==\"\"&&(!managed||pUrl!==\"\")){try{window.localStorage.removeItem(\"kiki.shell.managed\");}catch(e){}try{window.sessionStorage.removeItem(\"kiki.peer.token\");}catch(e){}try{delete doc.__kikiShellStagedCredential;}catch(e){}return false;}}}catch(e){return false;}" +
            "try{window.localStorage.removeItem(\"kiki.connection\");window.localStorage.removeItem(\"kiki.shell.managed\");}catch(e){}" +
            "try{window.sessionStorage.removeItem(\"kiki.peer.token\");}catch(e){}" +
            "try{if(doc.__kikiShellDeliveredNonce&&doc.__kikiShellDeliveredNonce===n)return true;}catch(e){}" +
            "try{var used=false;Object.defineProperty(doc,\"__kikiShellStagedCredential\",{configurable:true,enumerable:false,get:function(){if(used)return null;used=true;try{delete doc.__kikiShellStagedCredential;}catch(e){}return{origin:" +
            originJson +
            ",token:t};}});}catch(e){try{doc.__kikiShellStagedCredential={origin:" +
            originJson +
            ",token:t};}catch(e2){return false;}}" +
            "try{if(n){try{Object.defineProperty(doc,\"__kikiShellDeliveredNonce\",{configurable:true,enumerable:false,writable:true,value:n});}catch(e){doc.__kikiShellDeliveredNonce=n;}}}catch(e){}" +
            "try{window.dispatchEvent(new CustomEvent(\"kiki:shell-token\",{detail:{origin:" +
            originJson +
            ",token:t}}));}catch(e){}return true;}catch(e){return false;}})();"
        );
    }

    private HandshakeResult fetchHandshake(String normalizedOrigin) {
        return fetchHandshake(normalizedOrigin, null, null);
    }

    private HandshakeResult fetchHandshake(String normalizedOrigin, String serverId) {
        return fetchHandshake(normalizedOrigin, serverId, null);
    }

    static String sha256Hex(String value) {
        if (value == null || value.isEmpty()) return null;
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(64);
            for (byte b : digest) {
                sb.append(String.format("%02x", b & 0xff));
            }
            return sb.toString();
        } catch (Exception e) {
            return null;
        }
    }

    static String hmacSha256Hex(String keyAscii, String message) {
        if (keyAscii == null || keyAscii.isEmpty() || message == null) return null;
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            SecretKeySpec spec = new SecretKeySpec(keyAscii.getBytes(StandardCharsets.UTF_8), "HmacSHA256");
            mac.init(spec);
            byte[] out = mac.doFinal(message.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(64);
            for (byte b : out) {
                sb.append(String.format("%02x", b & 0xff));
            }
            return sb.toString();
        } catch (Exception e) {
            return null;
        }
    }

    static boolean constantTimeEquals(String a, String b) {
        if (a == null || b == null) return false;
        byte[] left = a.trim().toLowerCase().getBytes(StandardCharsets.UTF_8);
        byte[] right = b.trim().toLowerCase().getBytes(StandardCharsets.UTF_8);
        return left.length > 0 && MessageDigest.isEqual(left, right);
    }

    static String generateHandshakeNonce() {
        byte[] bytes = new byte[16];
        NONCE_RANDOM.nextBytes(bytes);
        StringBuilder sb = new StringBuilder(32);
        for (byte b : bytes) {
            sb.append(String.format("%02x", b & 0xff));
        }
        return sb.toString();
    }

    private String resolveHandshakeKey(String serverId, String normalizedOrigin) {
        if (serverId == null || serverId.isEmpty() || !isOriginVerified(serverId, normalizedOrigin)) {
            return null;
        }
        String token = readPeerToken(serverId, normalizedOrigin);
        return sha256Hex(token);
    }

    private String resolveStoredGrantId(String serverId, String normalizedOrigin, String explicitGrantId) {
        if (explicitGrantId != null && !explicitGrantId.isEmpty()) return explicitGrantId;
        if (serverId == null || serverId.isEmpty()) return null;
        SharedPreferences sp = prefs();
        if (normalizedOrigin != null && !normalizedOrigin.isEmpty()) {
            String scoped = sp.getString(GRANT_ID_PREFIX + scopedTokenId(serverId, normalizedOrigin), null);
            if (scoped != null && !scoped.isEmpty()) return scoped;
        }
        return sp.getString(GRANT_ID_PREFIX + serverId, null);
    }

    private HandshakeResult fetchHandshake(String normalizedOrigin, String serverId, String explicitGrantId) {
        HttpURLConnection conn = null;
        try {
            URL handshakeUrl = new URL(normalizedOrigin + "/api/remote-connections/handshake");
            conn = (HttpURLConnection) handshakeUrl.openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(3500);
            conn.setReadTimeout(3500);
            conn.setRequestProperty("Accept", "application/json");
            String handshakeKey = resolveHandshakeKey(serverId, normalizedOrigin);
            String nonce = null;
            if (handshakeKey != null && !handshakeKey.isEmpty()) {
                nonce = generateHandshakeNonce();
                String reqProof = hmacSha256Hex(handshakeKey, "kiki-handshake-req-v1:" + nonce);
                if (reqProof != null && !reqProof.isEmpty()) {
                    conn.setRequestProperty("x-kiki-handshake-nonce", nonce);
                    conn.setRequestProperty("x-kiki-handshake-proof", reqProof);
                    String grantId = resolveStoredGrantId(serverId, normalizedOrigin, explicitGrantId);
                    if (grantId != null && !grantId.isEmpty()) {
                        conn.setRequestProperty("x-kiki-handshake-grant", grantId);
                    }
                }
            }
            int code = conn.getResponseCode();
            if (code >= 300 && code < 400) {
                return new HandshakeResult(false, true, "", "", "", false);
            }
            if (code >= 200 && code < 300) {
                JSONObject body = readJson(conn.getInputStream());
                JSONObject data = body == null ? null : body.optJSONObject("data");
                JSONObject target = data == null ? null : data.optJSONObject("identity");
                if (target == null && data != null) target = data.optJSONObject("target");
                String label = data == null ? "" : data.optString("targetLabel", "");
                String homeId = target == null ? "" : target.optString("homeId", "");
                String hostId = target == null ? "" : target.optString("hostId", "");
                boolean mutualVerified = false;
                if (handshakeKey != null && nonce != null && !homeId.isEmpty()) {
                    String resProof = conn.getHeaderField("x-kiki-handshake-proof");
                    String expectedRes = hmacSha256Hex(
                        handshakeKey,
                        "kiki-handshake-res-v1:" + nonce + ":" + homeId + ":" + hostId
                    );
                    mutualVerified = constantTimeEquals(resProof, expectedRes);
                }
                return new HandshakeResult(true, false, homeId, hostId, label, mutualVerified);
            }
        } catch (Exception ignored) {
            /* unreachable or non-JSON */
        } finally {
            if (conn != null) conn.disconnect();
        }
        return new HandshakeResult(false, false, "", "", "", false);
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

    private boolean matchesStoredHostId(String serverId, String candidateHostId) {
        String storedHostId = prefs().getString(HOST_ID_PREFIX + serverId, null);
        if (storedHostId == null || storedHostId.isEmpty()) return true;
        if (candidateHostId == null || candidateHostId.isEmpty()) return true;
        return storedHostId.equals(candidateHostId);
    }

    private boolean isOriginVerified(String serverId, String origin) {
        Set<String> set = prefs().getStringSet(VERIFIED_ORIGINS_PREFIX + serverId, null);
        return set != null && set.contains(origin);
    }

    private void recordVerifiedOrigin(String serverId, String origin, String hostId) {
        recordVerifiedOrigin(serverId, origin, hostId, null);
    }

    private void recordVerifiedOrigin(String serverId, String origin, String hostId, String grantId) {
        if (serverId == null || serverId.isEmpty() || origin == null || origin.isEmpty()) return;
        SharedPreferences sp = prefs();
        Set<String> existing = sp.getStringSet(VERIFIED_ORIGINS_PREFIX + serverId, null);
        Set<String> updated = existing == null ? new HashSet<>() : new HashSet<>(existing);
        updated.add(origin);
        SharedPreferences.Editor editor = sp.edit().putStringSet(VERIFIED_ORIGINS_PREFIX + serverId, updated);
        if (hostId != null && !hostId.isEmpty()) {
            editor.putString(HOST_ID_PREFIX + serverId, hostId);
        }
        if (grantId != null && !grantId.isEmpty()) {
            editor.putString(GRANT_ID_PREFIX + serverId, grantId);
            editor.putString(GRANT_ID_PREFIX + scopedTokenId(serverId, origin), grantId);
        }
        editor.apply();
    }

    private void removeVerifiedOrigin(String serverId, String origin) {
        if (serverId == null || serverId.isEmpty() || origin == null || origin.isEmpty()) return;
        SharedPreferences sp = prefs();
        Set<String> existing = sp.getStringSet(VERIFIED_ORIGINS_PREFIX + serverId, null);
        if (existing == null || !existing.contains(origin)) return;
        Set<String> updated = new HashSet<>(existing);
        updated.remove(origin);
        sp.edit().putStringSet(VERIFIED_ORIGINS_PREFIX + serverId, updated).apply();
    }

    private void forgetServerData(String serverId, String origin) {
        clearPendingAuth();
        clearActiveAuth();
        SharedPreferences sp = prefs();
        SharedPreferences.Editor editor = sp.edit();
        String trusted = sp.getString(TRUSTED_ORIGIN, null);
        if (serverId != null && !serverId.isEmpty()) {
            Set<String> verified = sp.getStringSet(VERIFIED_ORIGINS_PREFIX + serverId, null);
            if (verified != null) {
                for (String vOrigin : verified) {
                    editor.remove(TOKEN_PREFIX + scopedTokenId(serverId, vOrigin));
                    editor.remove(GRANT_ID_PREFIX + scopedTokenId(serverId, vOrigin));
                }
                if (trusted != null && verified.contains(trusted)) {
                    editor.remove(TRUSTED_ORIGIN);
                }
            }
            if (origin != null && !origin.isEmpty()) {
                editor.remove(TOKEN_PREFIX + scopedTokenId(serverId, origin));
                editor.remove(GRANT_ID_PREFIX + scopedTokenId(serverId, origin));
            }
            editor
                .remove(TOKEN_PREFIX + serverId)
                .remove(LEGACY_TOKEN_PREFIX + serverId)
                .remove(HOST_ID_PREFIX + serverId)
                .remove(GRANT_ID_PREFIX + serverId)
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
            clearPendingAuth();
            clearActiveAuth();
            return false;
        }
        String targetOrigin = originOf(url);
        String expectedPending = pendingAuthOrigin;
        if (expectedPending != null) {
            if (targetOrigin != null && expectedPending.equals(targetOrigin)) {
                invalidateCurrentDocumentNavigation();
                return false;
            }
            clearPendingAuth();
            clearActiveAuth();
            if (local != null) {
                WebView webView = getBridge().getWebView();
                webView.post(() -> webView.loadUrl(local + "/index.html#unreachable"));
            }
            return true;
        }
        String trusted = prefs().getString(TRUSTED_ORIGIN, null);
        if (trusted != null && trusted.equals(targetOrigin)) {
            invalidateCurrentDocumentNavigation();
            return false;
        }
        invalidateCurrentDocumentNavigation();
        clearActiveAuth();
        return null;
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent == null) return;
        if (capturePairIntent(intent)) {
            clearPendingAuth();
            clearActiveAuth();
            WebView webView = getBridge().getWebView();
            webView.post(() -> webView.loadUrl(getBridge().getLocalUrl() + "/index.html#pair"));
            return;
        }
        if (ACTION_CHANGE_SERVER.equals(intent.getAction())) {
            clearPendingAuth();
            clearActiveAuth();
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
        String host = data.getHost() == null ? "" : data.getHost().toLowerCase(java.util.Locale.ROOT);
        String path = data.getPath() == null ? "" : data.getPath().toLowerCase(java.util.Locale.ROOT);
        if (!("pair".equals(host) && (path.isEmpty() || "/".equals(path))) && !(host.isEmpty() && "/pair".equals(path))) {
            return false;
        }
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
