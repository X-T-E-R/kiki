package dev.kiki.android.host.remote

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.net.http.SslCertificate
import android.net.http.SslError
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import dev.kiki.android.host.HostMode
import dev.kiki.android.host.KikiHostEnvironment
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URI
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.Certificate
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.Base64
import java.util.Locale
import java.util.concurrent.Executors
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLPeerUnverifiedException
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.X509TrustManager

@SuppressLint("RequiresFeature")
internal class RemotePeerShell(
    private val activity: Activity,
    private val host: KikiHostEnvironment,
    private val onAppearanceChanged: (Boolean) -> Unit,
    private val onLaunchQrScanner: ((String?) -> Unit) -> Unit,
    private val onSwitchToLocalHost: () -> Unit,
) : Closeable {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val worker = Executors.newCachedThreadPool { r ->
        Thread(r, "kiki-remote-shell-io").apply { isDaemon = true }
    }
    private val vaultPrefs = activity.applicationContext.getSharedPreferences(VAULT_PREFS, Context.MODE_PRIVATE)
    private val vaultLock = Any()

    private val assetLoader: WebViewAssetLoader = WebViewAssetLoader.Builder()
        .setDomain(ASSET_DOMAIN)
        .addPathHandler("/launcher/", SubtreeAssetHandler(activity.applicationContext, "kiki/launcher"))
        .addPathHandler("/gui/", SubtreeAssetHandler(activity.applicationContext, "kiki/gui"))
        .build()

    private var attachedWebView: WebView? = null
    private var launcherBootstrapScriptHandler: ScriptHandler? = null
    private var peerCredentialScriptHandler: ScriptHandler? = null

    @Volatile
    private var pendingPairUri: String? = null

    @Volatile
    private var pendingOpenOrigin: String? = null

    @Volatile
    private var pendingOpenServerId: String? = null

    @Volatile
    private var pendingPinnedFp: String? = null

    @Volatile
    private var pendingOpenOpId: String? = null

    @Volatile
    private var pendingOpenCommitted: Boolean = false

    @Volatile
    private var stagedOrigin: String? = null

    @Volatile
    private var stagedToken: String? = null

    @Volatile
    private var activePeerOrigin: String? = null

    @Volatile
    private var activePeerServerId: String? = null

    @Volatile
    private var activePinnedFp: String? = null

    @Volatile
    private var activeWsTunnel: PinnedWsTunnel? = null

    @Volatile
    private var activeRelayHttpsServer: PeerStreamConnector.RelayHttpsLoopbackServer? = null

    @Volatile
    private var openEpoch: Long = 0L

    fun attachToWebView(webView: WebView) {
        if (attachedWebView === webView) return
        detachFromWebView()
        attachedWebView = webView

        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(
                webView,
                BRIDGE_OBJECT_NAME,
                setOf(LAUNCHER_ORIGIN),
            ) { _, message, sourceOrigin, isMainFrame, replyProxy ->
                if (!isMainFrame || sourceOrigin.toString() != LAUNCHER_ORIGIN) return@addWebMessageListener
                val raw = message.data ?: return@addWebMessageListener
                handleBridgeCall(raw, replyProxy)
            }
        }

        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            launcherBootstrapScriptHandler = WebViewCompat.addDocumentStartJavaScript(
                webView,
                LAUNCHER_CAPACITOR_SHIM_SCRIPT,
                setOf(LAUNCHER_ORIGIN),
            )
        }
    }

    fun detachFromWebView() {
        launcherBootstrapScriptHandler?.let { runCatching { it.remove() } }
        launcherBootstrapScriptHandler = null
        peerCredentialScriptHandler?.let { runCatching { it.remove() } }
        peerCredentialScriptHandler = null
        attachedWebView?.let { wv ->
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                runCatching { WebViewCompat.removeWebMessageListener(wv, BRIDGE_OBJECT_NAME) }
            }
        }
        attachedWebView = null
    }

    fun openLauncher(fragment: String? = null) {
        val wv = attachedWebView ?: return
        clearActivePeerSession()
        val suffix = fragment?.trim()?.trimStart('#')?.takeIf { it.isNotEmpty() }?.let { "#$it" }.orEmpty()
        wv.loadUrl("$LAUNCHER_INDEX_URL$suffix")
    }

    fun acceptIncomingPairIntent(intent: Intent?): Boolean {
        val data = intent?.data ?: return false
        if (!data.scheme.equals("kiki", ignoreCase = true) || !data.host.equals("pair", ignoreCase = true)) {
            return false
        }
        val raw = data.toString()
        pendingPairUri = raw
        intent.data = null
        val wv = attachedWebView
        if (wv != null) {
            if (wv.url?.startsWith(LAUNCHER_ORIGIN) == true) {
                activity.runOnUiThread {
                    wv.evaluateJavascript("window.dispatchEvent(new CustomEvent('kiki:pair-deeplink'));", null)
                }
            } else {
                openLauncher("pair")
            }
        }
        return true
    }

    fun interceptRequest(request: WebResourceRequest): WebResourceResponse? =
        assetLoader.shouldInterceptRequest(request.url)

    fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val uri = request.url ?: return false
        val scheme = uri.scheme?.lowercase(Locale.ROOT) ?: return true

        if (scheme == "kiki" && uri.host.equals("pair", ignoreCase = true)) {
            pendingPairUri = uri.toString()
            if (view.url?.startsWith(LAUNCHER_ORIGIN) == true) {
                view.evaluateJavascript("window.dispatchEvent(new CustomEvent('kiki:pair-deeplink'));", null)
            } else {
                openLauncher("pair")
            }
            return true
        }
        if (scheme == "kiki-shell") {
            when (uri.host?.lowercase(Locale.ROOT)) {
                "connect" -> openLauncher("change")
                "settings", "permissions" -> host.openNativePhoneSettings(activity)
            }
            return true
        }

        val reqOrigin = originKey(uri.toString())
        if (reqOrigin == LAUNCHER_ORIGIN) {
            return false
        }

        if ((reqOrigin == "https://localhost" || reqOrigin == "http://localhost" || reqOrigin == "capacitor://localhost") &&
            (uri.path == null || uri.path == "/" || uri.path == "/index.html")
        ) {
            openLauncher(uri.fragment)
            return true
        }

        val allowedPeerOrigin = pendingOpenOrigin ?: activePeerOrigin
        if (allowedPeerOrigin != null && reqOrigin == allowedPeerOrigin) {
            return false
        }

        if (scheme == "http" || scheme == "https") {
            runCatching { activity.startActivity(Intent(Intent.ACTION_VIEW, uri)) }
        }
        return true
    }

    fun handleSslError(handler: SslErrorHandler, error: SslError): Boolean {
        val errorOrigin = originKey(error.url)
        val expectedOrigin = pendingOpenOrigin ?: activePeerOrigin
        val expectedFp = pendingPinnedFp ?: activePinnedFp
        if (errorOrigin == null || expectedOrigin == null || expectedFp == null) {
            return false
        }
        if (errorOrigin != expectedOrigin) {
            return false
        }
        if (certificateMatchesSpkiPin(error.certificate, expectedFp)) {
            handler.proceed()
            return true
        }
        return false
    }

    fun onPageStarted(view: WebView, url: String) {
        val navOrigin = originKey(url) ?: return
        if (navOrigin == LAUNCHER_ORIGIN) {
            clearActivePeerSession()
            return
        }
        deliverStagedCredentialIfMatching(view, navOrigin)
    }

    fun onPageCommitVisible(view: WebView, url: String) {
        val navOrigin = originKey(url) ?: return
        if (navOrigin == LAUNCHER_ORIGIN) return
        synchronized(this) {
            if (navOrigin == pendingOpenOrigin) {
                activePeerOrigin = pendingOpenOrigin
                activePeerServerId = pendingOpenServerId
                activePinnedFp = pendingPinnedFp
                pendingOpenOrigin = null
                pendingOpenServerId = null
                pendingPinnedFp = null
            }
        }
        deliverStagedCredentialIfMatching(view, navOrigin)
    }

    fun onMainFrameError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
        val failedUrl = request.url?.toString().orEmpty()
        if (failedUrl.startsWith(LAUNCHER_ORIGIN)) return
        val pending = pendingOpenOrigin
        if (pending != null && originKey(failedUrl) == pending) {
            clearActivePeerSession()
            view.loadUrl("$LAUNCHER_INDEX_URL#unreachable")
        }
    }

    override fun close() {
        scope.cancel()
        clearActivePeerSession()
        detachFromWebView()
        worker.shutdownNow()
    }

    private fun clearActivePeerSession() {
        synchronized(this) {
            openEpoch++
            pendingOpenOpId = null
            pendingOpenCommitted = false
            pendingOpenOrigin = null
            pendingOpenServerId = null
            pendingPinnedFp = null
            stagedOrigin = null
            stagedToken = null
            activePeerOrigin = null
            activePeerServerId = null
            activePinnedFp = null
            peerCredentialScriptHandler?.let { runCatching { it.remove() } }
            peerCredentialScriptHandler = null
            activeWsTunnel?.let { runCatching { it.close() } }
            activeWsTunnel = null
            activeRelayHttpsServer?.let { runCatching { it.close() } }
            activeRelayHttpsServer = null
        }
    }

    private fun handleBridgeCall(raw: String, replyProxy: JavaScriptReplyProxy) {
        val envelope = runCatching { JSONObject(raw) }.getOrNull() ?: return
        val id = envelope.optString("id", "")
        val method = envelope.optString("method", "")
        val params = envelope.optJSONObject("params") ?: JSONObject()
        if (id.isEmpty() || method.isEmpty()) return

        when (method) {
            "probe" -> worker.execute {
                replyResult(replyProxy, id) { handleProbe(params) }
            }

            "claimPair" -> worker.execute {
                replyResult(replyProxy, id) { handleClaimPair(params) }
            }

            "open" -> worker.execute {
                replyResult(replyProxy, id) { handleOpen(params) }
            }

            "cancelOpen" -> {
                val opId = params.optString("opId", "")
                val cancelled = synchronized(this) {
                    if (opId.isNotEmpty() && opId == pendingOpenOpId && !pendingOpenCommitted) {
                        openEpoch++
                        pendingOpenOpId = null
                        true
                    } else {
                        false
                    }
                }
                replyOk(replyProxy, id, JSONObject().put("ok", true).put("cancelled", cancelled))
            }

            "forgetServer" -> {
                val serverId = params.optString("serverId", "").trim()
                val origin = normalizeOrigin(params.optString("origin", ""))
                deleteServerSecrets(serverId, origin)
                replyOk(replyProxy, id, JSONObject().put("ok", true))
            }

            "scanQr" -> {
                activity.runOnUiThread {
                    onLaunchQrScanner { scanned ->
                        if (scanned.isNullOrBlank()) {
                            replyOk(replyProxy, id, JSONObject().put("status", "cancelled"))
                        } else {
                            replyOk(replyProxy, id, JSONObject().put("status", "scanned").put("value", scanned))
                        }
                    }
                }
            }

            "readClipboard" -> {
                activity.runOnUiThread {
                    val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                    val text = cm?.primaryClip
                        ?.takeIf { it.itemCount > 0 }
                        ?.getItemAt(0)
                        ?.coerceToText(activity)
                        ?.toString()
                        .orEmpty()
                    replyOk(replyProxy, id, JSONObject().put("text", text))
                }
            }

            "consumePendingPair" -> {
                val uri = pendingPairUri
                pendingPairUri = null
                val out = JSONObject()
                if (!uri.isNullOrBlank()) out.put("uri", uri)
                replyOk(replyProxy, id, out)
            }

            "setAppearance" -> {
                val dark = params.optBoolean("dark", false)
                activity.runOnUiThread { onAppearanceChanged(dark) }
                replyOk(replyProxy, id, JSONObject())
            }

            "getHostStatus" -> {
                replyOk(replyProxy, id, buildHostStatusJson())
            }

            "setLocalHostEnabled" -> {
                val enabled = params.optBoolean("enabled", false)
                activity.runOnUiThread {
                    if (enabled) {
                        onSwitchToLocalHost()
                    } else {
                        host.settings.hostMode = HostMode.REMOTE_ONLY
                    }
                    replyOk(replyProxy, id, buildHostStatusJson())
                }
            }

            "openNativeSettings" -> {
                activity.runOnUiThread {
                    host.openNativePhoneSettings(activity)
                    replyOk(replyProxy, id, JSONObject())
                }
            }

            "checkForUpdate" -> {
                scope.launch {
                    val outcome = host.updater.checkAndPrompt(activity, manual = true)
                    val res = JSONObject()
                        .put("ok", outcome.ok)
                        .put("updateAvailable", outcome.updateAvailable)
                    if (outcome.latestVersionName != null) res.put("latestVersionName", outcome.latestVersionName)
                    if (outcome.error != null) res.put("error", outcome.error)
                    replyOk(replyProxy, id, res)
                }
            }

            "setAutoCheckUpdates" -> {
                val enabled = params.optBoolean("enabled", true)
                host.settings.autoCheckUpdates = enabled
                replyOk(replyProxy, id, buildHostStatusJson())
            }

            else -> replyError(replyProxy, id, "Unsupported KikiShell method: $method")
        }
    }

    private fun buildHostStatusJson(): JSONObject = JSONObject()
        .put("embeddedHost", true)
        .put("localHostEnabled", host.settings.hostMode == HostMode.LOCAL_HOST)
        .put("versionName", host.versionName)
        .put("versionCode", host.versionCode)
        .put("distributionChannel", host.distributionChannel)
        .put("autoCheckUpdates", host.settings.autoCheckUpdates)

    private data class HandshakeCheckResult(
        val ok: Boolean,
        val redirected: Boolean = false,
        val statusCode: Int = 0,
        val targetHomeId: String = "",
        val targetHostId: String = "",
        val targetLabel: String = "",
        val mutualProofVerified: Boolean = false,
        val mutualRevokedVerified: Boolean = false,
        val mutualDisabledVerified: Boolean = false,
        val mutualInvitedVerified: Boolean = false,
        val inboundEnabled: Boolean = true,
    ) {
        fun handshakeStatus(): String? = when {
            mutualProofVerified -> "approved"
            mutualRevokedVerified -> "revoked"
            mutualDisabledVerified -> "inbound_disabled"
            mutualInvitedVerified -> "invited"
            else -> null
        }
    }

    private fun handleProbe(params: JSONObject): JSONObject {
        val rawOrigin = normalizeOrigin(params.optString("origin", ""))
            ?: return JSONObject().put("ok", false)
        val serverId = params.optString("serverId", "").trim().takeIf { it.isNotEmpty() }
        val grantId = params.optString("grantId", "").trim().takeIf { it.isNotEmpty() }
        val explicitFp = normalizePinnedFpOrNull(params.optString("fingerprint", ""))
        val expectInvited = params.optString("expectedStatus", "").equals("invited", ignoreCase = true)

        val resolvedFp = explicitFp ?: resolvePinnedFp(serverId, rawOrigin)
        val normalizedOrigin = upgradeOriginForTlsPin(rawOrigin, resolvedFp)
        val callEndpoints = parseDirectEndpointList(params.optJSONArray("endpoints"), resolvedFp)
        val callRelays = parseRelayEndpointList(params.optJSONArray("relayEndpoints"))
        val directs = mergeDirectCandidates(normalizedOrigin, callEndpoints, loadStoredEndpoints(serverId), resolvedFp)
        val relays = if (callRelays.isNotEmpty()) callRelays else loadStoredRelays(serverId)

        val pairedProbe = serverId != null &&
            isOriginVerified(serverId, normalizedOrigin) &&
            loadPeerToken(serverId, normalizedOrigin) != null

        val hs = fetchHandshake(
            logicalOrigin = normalizedOrigin,
            directOrigins = directs,
            relayEndpoints = relays,
            serverId = serverId,
            explicitGrantId = grantId,
            pinnedFp = resolvedFp,
        )

        if (hs.redirected) {
            return JSONObject().put("ok", false)
        }

        if (hs.ok) {
            val identityMatches = !pairedProbe ||
                (hs.targetHomeId == serverId && matchesStoredHostId(serverId, hs.targetHostId))
            if (pairedProbe && identityMatches && hs.mutualRevokedVerified) {
                return JSONObject()
                    .put("ok", false)
                    .put("status", hs.statusCode)
                    .put("reason", "pairing_revoked")
                    .put("authRejected", true)
                    .put("handshakeStatus", "revoked")
                    .put("mutualProofVerified", false)
                    .put("mutualRevokedVerified", true)
                    .put("mutualInvitedVerified", false)
                    .apply {
                        if (hs.targetHomeId.isNotEmpty()) put("targetHomeId", hs.targetHomeId)
                        if (hs.targetHostId.isNotEmpty()) put("targetHostId", hs.targetHostId)
                    }
            }
            if (pairedProbe && identityMatches && (hs.mutualDisabledVerified || !hs.inboundEnabled)) {
                return JSONObject()
                    .put("ok", false)
                    .put("status", hs.statusCode)
                    .put("reason", "unreachable")
                    .put("inboundEnabled", hs.inboundEnabled)
                    .put("mutualProofVerified", false)
                    .put("mutualDisabledVerified", hs.mutualDisabledVerified)
                    .put("mutualInvitedVerified", false)
                    .apply {
                        if (hs.mutualDisabledVerified) put("handshakeStatus", "inbound_disabled")
                        if (hs.targetHomeId.isNotEmpty()) put("targetHomeId", hs.targetHomeId)
                        if (hs.targetHostId.isNotEmpty()) put("targetHostId", hs.targetHostId)
                    }
            }
            if (pairedProbe && identityMatches && hs.mutualInvitedVerified) {
                return JSONObject()
                    .put("ok", expectInvited)
                    .put("status", hs.statusCode)
                    .put("inboundEnabled", hs.inboundEnabled)
                    .put("handshakeStatus", "invited")
                    .put("mutualProofVerified", false)
                    .put("mutualRevokedVerified", false)
                    .put("mutualDisabledVerified", false)
                    .put("mutualInvitedVerified", true)
                    .apply {
                        if (!expectInvited) put("reason", "pairing_required")
                        if (hs.targetLabel.isNotEmpty()) put("targetLabel", hs.targetLabel)
                        if (hs.targetHomeId.isNotEmpty()) put("targetHomeId", hs.targetHomeId)
                        if (hs.targetHostId.isNotEmpty()) put("targetHostId", hs.targetHostId)
                    }
            }
            return JSONObject()
                .put("ok", !(pairedProbe && expectInvited))
                .put("status", hs.statusCode)
                .put("inboundEnabled", hs.inboundEnabled)
                .put("mutualProofVerified", hs.mutualProofVerified)
                .put("mutualDisabledVerified", hs.mutualDisabledVerified)
                .put("mutualInvitedVerified", hs.mutualInvitedVerified)
                .apply {
                    if (pairedProbe && expectInvited) put("reason", "pairing_required")
                    hs.handshakeStatus()?.let { put("handshakeStatus", it) }
                    if (hs.targetLabel.isNotEmpty()) put("targetLabel", hs.targetLabel)
                    if (hs.targetHomeId.isNotEmpty()) put("targetHomeId", hs.targetHomeId)
                    if (hs.targetHostId.isNotEmpty()) put("targetHostId", hs.targetHostId)
                }
        }

        if (pairedProbe && (hs.statusCode == 401 || hs.statusCode == 403)) {
            if (hs.mutualInvitedVerified && expectInvited) {
                return JSONObject()
                    .put("ok", true)
                    .put("status", hs.statusCode)
                    .put("handshakeStatus", "invited")
                    .put("mutualProofVerified", false)
                    .put("mutualRevokedVerified", false)
                    .put("mutualDisabledVerified", false)
                    .put("mutualInvitedVerified", true)
            }
            val reason = when {
                hs.mutualRevokedVerified -> "pairing_revoked"
                hs.mutualInvitedVerified -> "pairing_required"
                hs.mutualDisabledVerified -> "unreachable"
                else -> "unverified_handshake_proof"
            }
            return JSONObject()
                .put("ok", false)
                .put("status", hs.statusCode)
                .put("reason", reason)
                .put("authRejected", hs.mutualRevokedVerified)
                .put("mutualProofVerified", false)
                .put("mutualRevokedVerified", hs.mutualRevokedVerified)
                .put("mutualDisabledVerified", hs.mutualDisabledVerified)
                .put("mutualInvitedVerified", hs.mutualInvitedVerified)
                .apply {
                    hs.handshakeStatus()?.let { put("handshakeStatus", it) }
                    if (hs.mutualDisabledVerified) put("inboundEnabled", false)
                }
        }

        if (PeerStreamConnector.isSyntheticRelayOrigin(normalizedOrigin)) {
            return JSONObject().put("ok", false)
        }

        val metaOk = runCatching {
            val meta = executePeerHttpRequest(
                method = "GET",
                pathAndQuery = "/api/meta",
                extraHeaders = emptyMap(),
                bodyBytes = null,
                directOrigins = directs,
                relayEndpoints = relays,
                pinnedFp = resolvedFp,
                timeoutMs = PROBE_TIMEOUT_MS,
            )
            !meta.redirected && (meta.status in 200..299 || meta.status == 401 || meta.status == 403)
        }.getOrDefault(false)
        return JSONObject().put("ok", metaOk)
    }

    private fun handleClaimPair(params: JSONObject): JSONObject {
        val rawEndpoint = normalizeOrigin(params.optString("endpoint", "").ifEmpty { params.optString("origin", "") })
        val code = params.optString("code", "").trim()
        val homeId = params.optString("homeId", "").trim()
        val hostId = params.optString("hostId", "").trim()
        val sourceLabel = params.optString("sourceLabel", "Kiki Android").trim().ifEmpty { "Kiki Android" }
        val pinnedFp = normalizePinnedFpOrNull(params.optString("fingerprint", ""))

        if (rawEndpoint == null || code.isEmpty() || homeId.isEmpty() || hostId.isEmpty()) {
            return JSONObject().put("ok", false).put("reason", "rejected")
        }

        val base = upgradeOriginForTlsPin(rawEndpoint, pinnedFp)
        val callEndpoints = parseDirectEndpointList(params.optJSONArray("endpoints"), pinnedFp)
        val callRelays = parseRelayEndpointList(params.optJSONArray("relayEndpoints"))
        val directs = mergeDirectCandidates(base, callEndpoints, emptyList(), pinnedFp)

        if (directs.isEmpty() && (pinnedFp == null || callRelays.isEmpty())) {
            return JSONObject().put("ok", false).put("reason", "rejected")
        }

        val payloadBytes = JSONObject()
            .put("code", code)
            .put(
                "source",
                JSONObject()
                    .put("homeId", homeId)
                    .put("hostId", hostId)
                    .put("protocol", 1),
            )
            .put("sourceLabel", sourceLabel)
            .put("requestBridge", false)
            .toString()
            .toByteArray(StandardCharsets.UTF_8)

        val httpRes = try {
            executePeerHttpRequest(
                method = "POST",
                pathAndQuery = "/api/remote-connections/pair/claim",
                extraHeaders = mapOf("x-kiki-pairing-rotation" to "1"),
                bodyBytes = payloadBytes,
                directOrigins = directs,
                relayEndpoints = callRelays,
                pinnedFp = pinnedFp,
                timeoutMs = CLAIM_TIMEOUT_MS,
            )
        } catch (_: Exception) {
            return JSONObject().put("ok", false).put("reason", "unreachable")
        }

        if (httpRes.redirected) {
            return JSONObject().put("ok", false).put("reason", "rejected")
        }
        if (httpRes.status !in 200..299) {
            val reason = if (httpRes.status in 400..499) "rejected" else "unreachable"
            return JSONObject().put("ok", false).put("reason", reason)
        }

        val body = runCatching { JSONObject(httpRes.body) }.getOrNull()
        val data = body?.optJSONObject("data")
        val target = data?.optJSONObject("target")
        val peerToken = data?.optString("peerToken", "")?.trim().orEmpty()
        val targetHomeId = target?.optString("homeId", "")?.trim().orEmpty()
        val targetHostId = target?.optString("hostId", "")?.trim().orEmpty()
        if (peerToken.isEmpty() || targetHomeId.isEmpty()) {
            return JSONObject().put("ok", false).put("reason", "rejected")
        }

        val canonicalOrigin = if (!httpRes.viaRelay && httpRes.directOrigin != null) httpRes.directOrigin else base
        val grantId = data?.optString("grantId", "")?.trim().orEmpty()
        val responseRelays = parseRelayEndpointList(data?.optJSONArray("relayEndpoints"))
        val finalRelays = if (responseRelays.isNotEmpty()) responseRelays else callRelays
        val responseEndpoints = parseDirectEndpointList(data?.optJSONArray("endpoints"), pinnedFp)
        val finalEndpoints = mergeDirectCandidates(canonicalOrigin, directs, responseEndpoints, pinnedFp)

        persistClaimedServer(
            serverId = targetHomeId,
            canonicalOrigin = canonicalOrigin,
            peerToken = peerToken,
            targetHostId = targetHostId,
            grantId = grantId,
            pinnedFp = pinnedFp,
            endpoints = finalEndpoints,
            relayEndpoints = finalRelays,
        )

        return JSONObject()
            .put("ok", true)
            .put("origin", canonicalOrigin)
            .put("serverId", targetHomeId)
            .put("targetHomeId", targetHomeId)
            .put("targetHostId", targetHostId)
            .put("targetLabel", data?.optString("targetLabel", "").orEmpty())
            .put("grantId", grantId)
            .put("revision", data?.optInt("revision", 0) ?: 0)
            .apply {
                if (finalEndpoints.isNotEmpty()) put("endpoints", JSONArray(finalEndpoints))
                if (finalRelays.isNotEmpty()) put("relayEndpoints", JSONArray(finalRelays))
            }
    }

    private fun handleOpen(params: JSONObject): JSONObject {
        val rawOrigin = normalizeOrigin(params.optString("origin", ""))
            ?: throw IllegalArgumentException("invalid_origin")
        val rawEntry = params.optString("entry", "$rawOrigin/").trim()
        val entryOrigin = originKey(rawEntry)
        if (entryOrigin != rawOrigin) {
            throw IllegalArgumentException("invalid_origin")
        }
        val serverId = params.optString("serverId", "").trim().takeIf { it.isNotEmpty() }
        val explicitFp = normalizePinnedFpOrNull(params.optString("fingerprint", ""))
        val resolvedFp = explicitFp ?: resolvePinnedFp(serverId, rawOrigin)
        val origin = upgradeOriginForTlsPin(rawOrigin, resolvedFp)
        val entrySuffix = if (rawEntry.startsWith(rawOrigin)) rawEntry.substring(rawOrigin.length).ifEmpty { "/" } else "/"
        val entry = "$origin$entrySuffix"

        if (serverId == null) {
            clearActivePeerSession()
            activity.runOnUiThread {
                attachedWebView?.loadUrl(entry)
            }
            return JSONObject().put("ok", true).put("origin", origin)
        }

        if (!isOriginVerified(serverId, origin) || loadPeerToken(serverId, origin) == null) {
            clearActivePeerSession()
            return JSONObject().put("ok", false).put("reason", "pairing_required")
        }

        val grantId = params.optString("grantId", "").trim().takeIf { it.isNotEmpty() }
        val opId = params.optString("opId", "").trim()
        if (!resolvedFp.isNullOrEmpty()) {
            savePinnedFp(serverId, origin, resolvedFp)
        }
        val callEndpoints = parseDirectEndpointList(params.optJSONArray("endpoints"), resolvedFp)
        val callRelays = parseRelayEndpointList(params.optJSONArray("relayEndpoints"))
        val directs = mergeDirectCandidates(origin, callEndpoints, loadStoredEndpoints(serverId), resolvedFp)
        val relays = if (callRelays.isNotEmpty()) callRelays else loadStoredRelays(serverId)
        if (directs.isNotEmpty() || relays.isNotEmpty()) {
            saveStoredEndpointsAndRelays(serverId, directs, relays)
        }

        val myEpoch = synchronized(this) {
            val ep = ++openEpoch
            pendingOpenOpId = opId.ifEmpty { "open-$ep" }
            pendingOpenCommitted = false
            ep
        }

        val hs = fetchHandshake(
            logicalOrigin = origin,
            directOrigins = directs,
            relayEndpoints = relays,
            serverId = serverId,
            explicitGrantId = grantId,
            pinnedFp = resolvedFp,
        )
        val failureReason = classifyPairedHandshakeFailure(hs, serverId, matchesStoredHostId(serverId, hs.targetHostId))
        if (failureReason != null) {
            return JSONObject().put("ok", false).put("reason", failureReason).apply {
                if (failureReason == "identity_mismatch" && hs.targetHomeId.isNotEmpty()) {
                    put("targetHomeId", hs.targetHomeId)
                }
            }
        }

        val sslFactory = if (resolvedFp != null) pinnedSslSocketFactory(resolvedFp) else HttpsURLConnection.getDefaultSSLSocketFactory()
        val certCheck: ((Certificate) -> Boolean)? = resolvedFp?.let { fp -> { cert -> certificateMatchesSpkiPin(cert, fp) } }

        val selected = try {
            PeerStreamConnector.selectReachableRoute(
                directOrigins = directs,
                relayEndpoints = relays,
                pinnedFp = resolvedFp,
                sslSocketFactory = sslFactory,
                peerCertCheck = certCheck,
                connectTimeoutMs = OPEN_TIMEOUT_MS,
            )
        } catch (_: Exception) {
            return JSONObject().put("ok", false).put("reason", "unreachable")
        }

        var newRelayHttps: PeerStreamConnector.RelayHttpsLoopbackServer? = null
        val navigationOrigin = if (selected.viaRelay) {
            if (resolvedFp == null) {
                return JSONObject().put("ok", false).put("reason", "unreachable")
            }
            newRelayHttps = PeerStreamConnector.RelayHttpsLoopbackServer(relays, OPEN_TIMEOUT_MS)
            newRelayHttps.origin
        } else {
            selected.directOrigin ?: origin
        }

        val peerToken = loadPeerToken(serverId, origin)
        val newTunnel: PinnedWsTunnel? = if (resolvedFp != null && navigationOrigin.startsWith("https://")) {
            PinnedWsTunnel(
                upstreamOrigin = navigationOrigin,
                directOrigins = directs,
                relayEndpoints = relays,
                pinnedFp = resolvedFp,
                sslSocketFactory = sslFactory,
                peerCheck = { cert -> certificateMatchesSpkiPin(cert, resolvedFp) },
            )
        } else {
            null
        }

        synchronized(this) {
            if (myEpoch != openEpoch) {
                runCatching { newTunnel?.close() }
                runCatching { newRelayHttps?.close() }
                return JSONObject().put("ok", false).put("reason", "aborted")
            }
            pendingOpenCommitted = true
            activeWsTunnel?.let { runCatching { it.close() } }
            activeRelayHttpsServer?.let { runCatching { it.close() } }
            activeWsTunnel = newTunnel
            activeRelayHttpsServer = newRelayHttps
            pendingOpenOrigin = navigationOrigin
            pendingOpenServerId = serverId
            pendingPinnedFp = resolvedFp
            stagedOrigin = navigationOrigin
            stagedToken = peerToken
        }

        if (!selected.viaRelay) {
            recordVerifiedOrigin(serverId, navigationOrigin, hs.targetHostId, grantId)
        } else {
            recordVerifiedOrigin(serverId, origin, hs.targetHostId, grantId)
        }

        val targetUrl = "$navigationOrigin$entrySuffix"
        activity.runOnUiThread {
            val wv = attachedWebView ?: return@runOnUiThread
            synchronized(this@RemotePeerShell) {
                if (myEpoch != openEpoch) return@runOnUiThread
                installPeerDocumentStartScripts(wv, navigationOrigin, peerToken, newTunnel)
            }
            wv.loadUrl(targetUrl)
        }
        return JSONObject()
            .put("ok", true)
            .put("origin", if (selected.viaRelay) origin else navigationOrigin)
    }

    private fun fetchHandshake(
        logicalOrigin: String,
        directOrigins: List<String>,
        relayEndpoints: List<String>,
        serverId: String?,
        explicitGrantId: String?,
        pinnedFp: String?,
    ): HandshakeCheckResult {
        val token = if (!serverId.isNullOrEmpty() && isOriginVerified(serverId, logicalOrigin)) {
            loadPeerToken(serverId, logicalOrigin)
        } else {
            null
        }
        val handshakeKey = token?.let(::sha256HexLower)
        val headers = LinkedHashMap<String, String>()
        var nonce: String? = null
        if (!handshakeKey.isNullOrEmpty()) {
            nonce = generateHandshakeNonce()
            val reqProof = hmacSha256HexLower(handshakeKey, "kiki-handshake-req-v1:$nonce")
            headers["x-kiki-handshake-nonce"] = nonce
            headers["x-kiki-handshake-proof"] = reqProof
            val grantId = explicitGrantId ?: resolveStoredGrantId(serverId, logicalOrigin)
            if (!grantId.isNullOrEmpty()) {
                headers["x-kiki-handshake-grant"] = grantId
            }
        }

        val res = try {
            executePeerHttpRequest(
                method = "GET",
                pathAndQuery = "/api/remote-connections/handshake",
                extraHeaders = headers,
                bodyBytes = null,
                directOrigins = directOrigins,
                relayEndpoints = relayEndpoints,
                pinnedFp = pinnedFp,
                timeoutMs = PROBE_TIMEOUT_MS,
            )
        } catch (_: Exception) {
            return HandshakeCheckResult(ok = false)
        }

        if (res.redirected) {
            return HandshakeCheckResult(ok = false, redirected = true, statusCode = res.status)
        }

        val resProof = res.headers["x-kiki-handshake-proof"]
        val resStatus = res.headers["x-kiki-handshake-status"]
        if (res.status in 200..299) {
            val body = runCatching { JSONObject(res.body) }.getOrNull()
            val data = body?.optJSONObject("data")
            val target = data?.optJSONObject("identity") ?: data?.optJSONObject("target")
            val label = data?.optString("targetLabel", "").orEmpty()
            val homeId = target?.optString("homeId", "").orEmpty()
            val hostId = target?.optString("hostId", "").orEmpty()
            val inboundEnabled = data?.optBoolean("inboundEnabled", true) ?: true
            val verifiedStatus = if (handshakeKey != null && nonce != null && homeId.isNotEmpty()) {
                verifyHandshakeDomain(resStatus, resProof, handshakeKey, "$nonce:$homeId:$hostId")
            } else {
                null
            }
            return HandshakeCheckResult(
                ok = true,
                statusCode = res.status,
                targetHomeId = homeId,
                targetHostId = hostId,
                targetLabel = label,
                mutualProofVerified = verifiedStatus == "approved",
                mutualRevokedVerified = verifiedStatus == "revoked",
                mutualDisabledVerified = verifiedStatus == "inbound_disabled",
                mutualInvitedVerified = verifiedStatus == "invited",
                inboundEnabled = inboundEnabled,
            )
        }

        var verifiedStatus: String? = null
        if ((res.status == 401 || res.status == 403) && handshakeKey != null && nonce != null && !serverId.isNullOrEmpty()) {
            val storedHostId = resolveStoredHostId(serverId)
            verifiedStatus = verifyHandshakeDomain(resStatus, resProof, handshakeKey, "$nonce:$serverId:$storedHostId")
                ?: if (storedHostId.isNotEmpty()) {
                    verifyHandshakeDomain(resStatus, resProof, handshakeKey, "$nonce:$serverId:")
                } else {
                    null
                }
        }
        val disabled = verifiedStatus == "inbound_disabled"
        return HandshakeCheckResult(
            ok = false,
            statusCode = res.status,
            mutualRevokedVerified = verifiedStatus == "revoked",
            mutualDisabledVerified = disabled,
            mutualInvitedVerified = verifiedStatus == "invited",
            inboundEnabled = !disabled,
        )
    }

    private fun classifyPairedHandshakeFailure(
        hs: HandshakeCheckResult,
        expectedServerId: String,
        hostMatches: Boolean,
    ): String? {
        if (hs.redirected) return "unreachable"
        if (hs.ok) {
            if (hs.targetHomeId.isEmpty()) return "unreachable"
            if (expectedServerId != hs.targetHomeId || !hostMatches) return "identity_mismatch"
            if (hs.mutualRevokedVerified) return "pairing_revoked"
            if (hs.mutualInvitedVerified) return "pairing_required"
            if (hs.mutualDisabledVerified || !hs.inboundEnabled) return "unreachable"
            if (!hs.mutualProofVerified) return "unverified_handshake_proof"
            return null
        }
        if (hs.statusCode == 401 || hs.statusCode == 403) {
            if (hs.mutualRevokedVerified) return "pairing_revoked"
            if (hs.mutualInvitedVerified) return "pairing_required"
            if (hs.mutualDisabledVerified) return "unreachable"
            return "unverified_handshake_proof"
        }
        return "unreachable"
    }

    private fun installPeerDocumentStartScripts(
        wv: WebView,
        navigationOrigin: String,
        token: String?,
        tunnel: PinnedWsTunnel?,
    ) {
        peerCredentialScriptHandler?.let { runCatching { it.remove() } }
        peerCredentialScriptHandler = null
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return

        val combined = buildString {
            if (tunnel != null && tunnel.matchesOrigin(navigationOrigin)) {
                append(tunnel.interceptorScript())
                append('\n')
            }
            if (!token.isNullOrEmpty()) {
                append(buildPeerTokenStageScript(navigationOrigin, token))
            }
        }
        if (combined.isNotEmpty()) {
            peerCredentialScriptHandler = WebViewCompat.addDocumentStartJavaScript(
                wv,
                combined,
                setOf(navigationOrigin),
            )
        }
    }

    private fun deliverStagedCredentialIfMatching(view: WebView, navOrigin: String) {
        val tunnel = activeWsTunnel
        if (tunnel != null && tunnel.matchesOrigin(navOrigin)) {
            view.evaluateJavascript(tunnel.interceptorScript(), null)
        }
        val token: String?
        synchronized(this) {
            if (stagedOrigin != navOrigin || stagedToken.isNullOrEmpty()) return
            token = stagedToken
            stagedToken = null
        }
        if (!token.isNullOrEmpty()) {
            view.evaluateJavascript(buildPeerTokenDeliveryFallbackScript(navOrigin, token), null)
        }
    }

    private data class PeerHttpResult(
        val status: Int,
        val redirected: Boolean,
        val body: String,
        val headers: Map<String, String>,
        val viaRelay: Boolean,
        val directOrigin: String?,
    )

    private fun executePeerHttpRequest(
        method: String,
        pathAndQuery: String,
        extraHeaders: Map<String, String>,
        bodyBytes: ByteArray?,
        directOrigins: List<String>,
        relayEndpoints: List<String>,
        pinnedFp: String?,
        timeoutMs: Int,
    ): PeerHttpResult {
        val sslFactory = if (pinnedFp != null) {
            pinnedSslSocketFactory(pinnedFp)
        } else {
            HttpsURLConnection.getDefaultSSLSocketFactory()
        }
        val certCheck: ((Certificate) -> Boolean)? = pinnedFp?.let { fp ->
            { cert -> certificateMatchesSpkiPin(cert, fp) }
        }

        val selected = PeerStreamConnector.selectReachableRoute(
            directOrigins = directOrigins,
            relayEndpoints = relayEndpoints,
            pinnedFp = pinnedFp,
            sslSocketFactory = sslFactory,
            peerCertCheck = certCheck,
            connectTimeoutMs = timeoutMs,
        )

        var tempRelayLoopback: PeerStreamConnector.RelayHttpsLoopbackServer? = null
        try {
            val baseOrigin = if (selected.viaRelay) {
                if (pinnedFp == null || certCheck == null) {
                    throw SSLPeerUnverifiedException("Relay requests require a pinned TLS SPKI fingerprint.")
                }
                tempRelayLoopback = PeerStreamConnector.RelayHttpsLoopbackServer(
                    listOfNotNull(selected.relayUrl).ifEmpty { relayEndpoints },
                    timeoutMs,
                )
                tempRelayLoopback.origin
            } else {
                selected.directOrigin ?: throw IOException("Missing direct origin")
            }

            val conn = URI.create("$baseOrigin$pathAndQuery").toURL().openConnection() as HttpURLConnection
            try {
                conn.instanceFollowRedirects = false
                conn.connectTimeout = timeoutMs
                conn.readTimeout = timeoutMs
                conn.requestMethod = method
                conn.setRequestProperty("Accept", "application/json")
                for ((k, v) in extraHeaders) {
                    conn.setRequestProperty(k, v)
                }
                if (conn is HttpsURLConnection && pinnedFp != null && certCheck != null) {
                    conn.sslSocketFactory = if (selected.viaRelay || baseOrigin.startsWith("https://127.0.0.1:")) {
                        PeerStreamConnector.PinnedPeerSslSocketFactory(sslFactory, certCheck)
                    } else {
                        sslFactory
                    }
                    conn.hostnameVerifier = javax.net.ssl.HostnameVerifier { _, session ->
                        val certs = runCatching { session.peerCertificates }.getOrNull()
                        !certs.isNullOrEmpty() && certCheck(certs[0])
                    }
                }
                if (bodyBytes != null) {
                    conn.doOutput = true
                    conn.setFixedLengthStreamingMode(bodyBytes.size)
                    conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                    conn.outputStream.use { it.write(bodyBytes) }
                }
                val code = conn.responseCode
                if (code in 300..399) {
                    return PeerHttpResult(code, true, "", emptyMap(), selected.viaRelay, selected.directOrigin)
                }
                val respHeaders = LinkedHashMap<String, String>()
                for ((k, values) in conn.headerFields) {
                    if (k != null && !values.isNullOrEmpty() && values[0] != null) {
                        respHeaders[k.lowercase(Locale.ROOT)] = values[0]
                    }
                }
                val stream = if (code in 200..299) conn.inputStream else conn.errorStream
                val text = stream?.use { readBoundedUtf8(it, 512 * 1024) }.orEmpty()
                return PeerHttpResult(code, false, text, respHeaders, selected.viaRelay, selected.directOrigin)
            } finally {
                conn.disconnect()
            }
        } finally {
            runCatching { tempRelayLoopback?.close() }
        }
    }

    private fun replyResult(replyProxy: JavaScriptReplyProxy, id: String, block: () -> JSONObject) {
        try {
            val result = block()
            replyOk(replyProxy, id, result)
        } catch (err: Throwable) {
            replyError(replyProxy, id, err.message ?: "Request failed")
        }
    }

    private fun replyOk(replyProxy: JavaScriptReplyProxy, id: String, result: JSONObject) {
        val payload = JSONObject()
            .put("id", id)
            .put("ok", true)
            .put("result", result)
            .toString()
        activity.runOnUiThread { runCatching { replyProxy.postMessage(payload) } }
    }

    private fun replyError(replyProxy: JavaScriptReplyProxy, id: String, error: String) {
        val payload = JSONObject()
            .put("id", id)
            .put("ok", false)
            .put("error", error)
            .toString()
        activity.runOnUiThread { runCatching { replyProxy.postMessage(payload) } }
    }

    // --- Keystore Vault for Paired Servers ---

    private fun getOrCreateVaultKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(KEYSTORE_ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(
                KEYSTORE_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    private fun encryptSecret(aad: String, plainText: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateVaultKey())
        cipher.updateAAD(aad.toByteArray(StandardCharsets.UTF_8))
        val iv = cipher.iv
        val ct = cipher.doFinal(plainText.toByteArray(StandardCharsets.UTF_8))
        return Base64.getEncoder().encodeToString(iv) + ":" + Base64.getEncoder().encodeToString(ct)
    }

    private fun decryptSecret(aad: String, packed: String): String? = runCatching {
        val idx = packed.indexOf(':')
        if (idx <= 0) return null
        val iv = Base64.getDecoder().decode(packed.substring(0, idx))
        val ct = Base64.getDecoder().decode(packed.substring(idx + 1))
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateVaultKey(), GCMParameterSpec(128, iv))
        cipher.updateAAD(aad.toByteArray(StandardCharsets.UTF_8))
        String(cipher.doFinal(ct), StandardCharsets.UTF_8)
    }.getOrNull()

    private fun persistClaimedServer(
        serverId: String,
        canonicalOrigin: String,
        peerToken: String,
        targetHostId: String,
        grantId: String,
        pinnedFp: String?,
        endpoints: List<String>,
        relayEndpoints: List<String>,
    ) {
        synchronized(vaultLock) {
            val verified = LinkedHashSet<String>()
            vaultPrefs.getStringSet("verified.$serverId", null)?.let(verified::addAll)
            verified.add(canonicalOrigin)
            endpoints.forEach(verified::add)

            val edit = vaultPrefs.edit()
                .putString("token.$serverId", encryptSecret("token.$serverId", peerToken))
                .putString("token.$serverId@$canonicalOrigin", encryptSecret("token.$serverId@$canonicalOrigin", peerToken))
                .putStringSet("verified.$serverId", verified)
            if (targetHostId.isNotEmpty()) edit.putString("hostId.$serverId", targetHostId)
            if (grantId.isNotEmpty()) {
                edit.putString("grantId.$serverId", grantId)
                edit.putString("grantId.$serverId@$canonicalOrigin", grantId)
            }
            if (!pinnedFp.isNullOrEmpty()) {
                edit.putString("fp.$serverId", pinnedFp)
                edit.putString("fpOrigin.$canonicalOrigin", pinnedFp)
            }
            for (ep in endpoints) {
                edit.putString("token.$serverId@$ep", encryptSecret("token.$serverId@$ep", peerToken))
                if (grantId.isNotEmpty()) edit.putString("grantId.$serverId@$ep", grantId)
                if (!pinnedFp.isNullOrEmpty()) edit.putString("fpOrigin.$ep", pinnedFp)
            }
            if (endpoints.isNotEmpty()) edit.putString("endpoints.$serverId", JSONArray(endpoints).toString())
            if (relayEndpoints.isNotEmpty()) edit.putString("relays.$serverId", JSONArray(relayEndpoints).toString())
            edit.commit()
        }
    }

    private fun loadPeerToken(serverId: String?, origin: String): String? = synchronized(vaultLock) {
        if (serverId.isNullOrEmpty()) return null
        val scopedKey = "token.$serverId@$origin"
        vaultPrefs.getString(scopedKey, null)?.let { decryptSecret(scopedKey, it) }?.let { return it }
        val baseKey = "token.$serverId"
        vaultPrefs.getString(baseKey, null)?.let { decryptSecret(baseKey, it) }
    }

    private fun isOriginVerified(serverId: String?, origin: String): Boolean = synchronized(vaultLock) {
        if (serverId.isNullOrEmpty()) return false
        val set = vaultPrefs.getStringSet("verified.$serverId", null) ?: return false
        set.contains(origin)
    }

    private fun recordVerifiedOrigin(serverId: String, origin: String, hostId: String, grantId: String?) {
        synchronized(vaultLock) {
            val next = LinkedHashSet<String>()
            vaultPrefs.getStringSet("verified.$serverId", null)?.let(next::addAll)
            next.add(origin)
            val edit = vaultPrefs.edit().putStringSet("verified.$serverId", next)
            if (hostId.isNotEmpty()) edit.putString("hostId.$serverId", hostId)
            if (!grantId.isNullOrEmpty()) edit.putString("grantId.$serverId@$origin", grantId)
            edit.apply()
        }
    }

    private fun matchesStoredHostId(serverId: String?, candidateHostId: String): Boolean = synchronized(vaultLock) {
        if (serverId.isNullOrEmpty() || candidateHostId.isEmpty()) return true
        val stored = vaultPrefs.getString("hostId.$serverId", null).orEmpty()
        stored.isEmpty() || stored == candidateHostId
    }

    private fun resolveStoredHostId(serverId: String): String = synchronized(vaultLock) {
        vaultPrefs.getString("hostId.$serverId", null).orEmpty()
    }

    private fun resolveStoredGrantId(serverId: String?, origin: String): String? = synchronized(vaultLock) {
        if (serverId.isNullOrEmpty()) return null
        vaultPrefs.getString("grantId.$serverId@$origin", null)
            ?: vaultPrefs.getString("grantId.$serverId", null)
    }

    private fun savePinnedFp(serverId: String, origin: String, fp: String) {
        synchronized(vaultLock) {
            vaultPrefs.edit()
                .putString("fp.$serverId", fp)
                .putString("fpOrigin.$origin", fp)
                .apply()
        }
    }

    private fun resolvePinnedFp(serverId: String?, origin: String): String? = synchronized(vaultLock) {
        if (!serverId.isNullOrEmpty()) {
            normalizePinnedFpOrNull(vaultPrefs.getString("fp.$serverId", null))?.let { return it }
        }
        normalizePinnedFpOrNull(vaultPrefs.getString("fpOrigin.$origin", null))
    }

    private fun saveStoredEndpointsAndRelays(serverId: String, endpoints: List<String>, relays: List<String>) {
        synchronized(vaultLock) {
            val edit = vaultPrefs.edit()
            if (endpoints.isNotEmpty()) edit.putString("endpoints.$serverId", JSONArray(endpoints).toString())
            if (relays.isNotEmpty()) edit.putString("relays.$serverId", JSONArray(relays).toString())
            edit.apply()
        }
    }

    private fun loadStoredEndpoints(serverId: String?): List<String> = synchronized(vaultLock) {
        if (serverId.isNullOrEmpty()) return emptyList()
        val raw = vaultPrefs.getString("endpoints.$serverId", null) ?: return emptyList()
        runCatching { parseDirectEndpointList(JSONArray(raw), null) }.getOrDefault(emptyList())
    }

    private fun loadStoredRelays(serverId: String?): List<String> = synchronized(vaultLock) {
        if (serverId.isNullOrEmpty()) return emptyList()
        val raw = vaultPrefs.getString("relays.$serverId", null) ?: return emptyList()
        runCatching { parseRelayEndpointList(JSONArray(raw)) }.getOrDefault(emptyList())
    }

    private fun deleteServerSecrets(serverId: String, origin: String?) {
        synchronized(vaultLock) {
            val edit = vaultPrefs.edit()
            if (serverId.isNotEmpty()) {
                for (key in vaultPrefs.all.keys.toList()) {
                    if (key.endsWith(".$serverId") || key.contains(".$serverId@")) {
                        edit.remove(key)
                    }
                }
            }
            if (!origin.isNullOrEmpty()) {
                edit.remove("fpOrigin.$origin")
            }
            edit.commit()
        }
    }

    private class SubtreeAssetHandler(
        private val appContext: Context,
        private val assetPrefix: String,
    ) : WebViewAssetLoader.PathHandler {
        override fun handle(path: String): WebResourceResponse? {
            val rel = path.trimStart('/').ifEmpty { "index.html" }
            if (rel.contains("..")) return null
            val fullAssetPath = "$assetPrefix/$rel"
            val stream = runCatching { appContext.assets.open(fullAssetPath) }.getOrNull() ?: return null
            val mime = guessMimeType(rel)
            val encoding = if (mime.startsWith("text/") || mime == "application/javascript" || mime == "application/json" || mime == "image/svg+xml") {
                "utf-8"
            } else {
                null
            }
            return WebResourceResponse(mime, encoding, stream)
        }

        private fun guessMimeType(path: String): String {
            val lower = path.lowercase(Locale.ROOT)
            return when {
                lower.endsWith(".html") -> "text/html"
                lower.endsWith(".css") -> "text/css"
                lower.endsWith(".js") || lower.endsWith(".mjs") -> "application/javascript"
                lower.endsWith(".json") -> "application/json"
                lower.endsWith(".svg") -> "image/svg+xml"
                lower.endsWith(".png") -> "image/png"
                lower.endsWith(".webp") -> "image/webp"
                lower.endsWith(".woff2") -> "font/woff2"
                else -> "application/octet-stream"
            }
        }
    }

    companion object {
        const val ASSET_DOMAIN = "appassets.androidplatform.net"
        const val LAUNCHER_ORIGIN = "https://$ASSET_DOMAIN"
        const val LAUNCHER_INDEX_URL = "$LAUNCHER_ORIGIN/launcher/index.html"

        private const val BRIDGE_OBJECT_NAME = "KikiRemoteBridge"
        private const val VAULT_PREFS = "kiki_remote_peer_vault"
        private const val KEYSTORE_ALIAS = "kiki_remote_peer_vault_v1"
        private const val PROBE_TIMEOUT_MS = 4_500
        private const val CLAIM_TIMEOUT_MS = 6_000
        private const val OPEN_TIMEOUT_MS = 6_000
        private val HEX_64_REGEX = Regex("^[0-9a-fA-F]{64}$")
        private val NONCE_RANDOM = SecureRandom()

        private val LAUNCHER_CAPACITOR_SHIM_SCRIPT: String = """
            (function() {
              if (window.location.origin !== '$LAUNCHER_ORIGIN') return;
              if (window.Capacitor && typeof window.Capacitor.nativePromise === 'function') return;
              var seq = 0;
              var pending = new Map();
              if (window.$BRIDGE_OBJECT_NAME && typeof window.$BRIDGE_OBJECT_NAME.addEventListener === 'function') {
                window.$BRIDGE_OBJECT_NAME.addEventListener('message', function(ev) {
                  try {
                    var msg = JSON.parse(ev.data);
                    var entry = pending.get(msg.id);
                    if (!entry) return;
                    pending.delete(msg.id);
                    if (msg.ok) entry.resolve(msg.result || {});
                    else entry.reject(new Error(msg.error || 'Request failed'));
                  } catch (_) {}
                });
              }
              function nativePromise(plugin, method, payload) {
                return new Promise(function(resolve, reject) {
                  if (plugin !== 'KikiShell') {
                    reject(new Error('Unsupported plugin: ' + plugin));
                    return;
                  }
                  if (!window.$BRIDGE_OBJECT_NAME || typeof window.$BRIDGE_OBJECT_NAME.postMessage !== 'function') {
                    reject(new Error('Native bridge unavailable'));
                    return;
                  }
                  var id = 'ks_' + (++seq);
                  pending.set(id, { resolve: resolve, reject: reject });
                  window.$BRIDGE_OBJECT_NAME.postMessage(JSON.stringify({ id: id, method: method, params: payload || {} }));
                });
              }
              window.Capacitor = {
                isNativePlatform: function() { return true; },
                getPlatform: function() { return 'android'; },
                isPluginAvailable: function(name) { return name === 'KikiShell'; },
                nativePromise: nativePromise
              };
            })();
        """.trimIndent()

        private fun buildPeerTokenStageScript(origin: String, token: String): String {
            val originJson = JsonPrimitive(origin).toString()
            val tokenJson = JsonPrimitive(token).toString()
            return """
                (function() {
                  if (window.location.origin !== $originJson) return;
                  var consumed = false;
                  var payload = Object.freeze({ origin: $originJson, url: $originJson, token: $tokenJson });
                  Object.defineProperty(document, '__kikiShellStagedCredential', {
                    configurable: true,
                    enumerable: false,
                    get: function() {
                      if (consumed) return undefined;
                      consumed = true;
                      window.__kikiCredentialConsumed = true;
                      try { delete document.__kikiShellStagedCredential; } catch (_) {}
                      return payload;
                    }
                  });
                })();
            """.trimIndent()
        }

        private fun buildPeerTokenDeliveryFallbackScript(origin: String, token: String): String {
            val originJson = JsonPrimitive(origin).toString()
            val tokenJson = JsonPrimitive(token).toString()
            return """
                (function() {
                  if (window.location.origin !== $originJson || window.__kikiCredentialConsumed === true) return;
                  var detail = { origin: $originJson, url: $originJson, token: $tokenJson };
                  if (!Object.getOwnPropertyDescriptor(document, '__kikiShellStagedCredential')) {
                    var consumed = false;
                    Object.defineProperty(document, '__kikiShellStagedCredential', {
                      configurable: true,
                      enumerable: false,
                      get: function() {
                        if (consumed) return undefined;
                        consumed = true;
                        window.__kikiCredentialConsumed = true;
                        try { delete document.__kikiShellStagedCredential; } catch (_) {}
                        return detail;
                      }
                    });
                  }
                  window.dispatchEvent(new CustomEvent('kiki:shell-token', { detail: detail }));
                })();
            """.trimIndent()
        }

        internal fun originKey(rawUrl: String?): String? {
            if (rawUrl.isNullOrBlank()) return null
            return runCatching {
                val u = URI.create(rawUrl.trim())
                val scheme = u.scheme?.lowercase(Locale.ROOT) ?: return null
                val host = u.host?.lowercase(Locale.ROOT) ?: return null
                val defaultPort = when (scheme) {
                    "https" -> 443
                    "http" -> 80
                    else -> -1
                }
                val portPart = if (u.port > 0 && u.port != defaultPort) ":${u.port}" else ""
                val renderedHost = if (host.contains(":") && !host.startsWith("[")) "[$host]" else host
                "$scheme://$renderedHost$portPart"
            }.getOrNull()
        }

        internal fun normalizeOrigin(raw: String?): String? {
            val trimmed = raw?.trim().orEmpty()
            if (trimmed.isEmpty()) return null
            val candidate = if (trimmed.contains("://")) trimmed else "https://$trimmed"
            return originKey(candidate)
        }

        internal fun upgradeOriginForTlsPin(origin: String, pinnedFp: String?): String {
            if (pinnedFp.isNullOrEmpty() || !origin.startsWith("http://", ignoreCase = true)) return origin
            return runCatching {
                val u = URI.create(origin)
                val port = if (u.port > 0) u.port else 80
                val host = u.host ?: return origin
                val renderedHost = if (host.contains(":") && !host.startsWith("[")) "[$host]" else host.lowercase(Locale.ROOT)
                if (port == 443) "https://$renderedHost" else "https://$renderedHost:$port"
            }.getOrDefault(origin)
        }

        internal fun normalizePinnedFpOrNull(raw: String?): String? {
            val cleaned = raw?.replace(":", "")?.trim()?.lowercase(Locale.ROOT).orEmpty()
            if (cleaned.isEmpty()) return null
            return if (HEX_64_REGEX.matches(cleaned)) cleaned else null
        }

        internal fun parseDirectEndpointList(arr: JSONArray?, pinnedFp: String?): List<String> {
            if (arr == null) return emptyList()
            val out = LinkedHashSet<String>()
            for (i in 0 until arr.length()) {
                val norm = normalizeOrigin(arr.optString(i, "")) ?: continue
                val upgraded = upgradeOriginForTlsPin(norm, pinnedFp)
                if (!PeerStreamConnector.isSyntheticRelayOrigin(upgraded)) {
                    out.add(upgraded)
                }
            }
            return out.toList()
        }

        internal fun mergeDirectCandidates(
            primary: String?,
            first: List<String>,
            second: List<String>,
            pinnedFp: String?,
        ): List<String> {
            val out = LinkedHashSet<String>()
            if (!primary.isNullOrEmpty() && !PeerStreamConnector.isSyntheticRelayOrigin(primary)) {
                out.add(upgradeOriginForTlsPin(primary, pinnedFp))
            }
            for (ep in first) {
                val up = upgradeOriginForTlsPin(ep, pinnedFp)
                if (!PeerStreamConnector.isSyntheticRelayOrigin(up)) out.add(up)
            }
            for (ep in second) {
                val up = upgradeOriginForTlsPin(ep, pinnedFp)
                if (!PeerStreamConnector.isSyntheticRelayOrigin(up)) out.add(up)
            }
            return out.toList()
        }

        internal fun parseRelayEndpointList(arr: JSONArray?): List<String> {
            if (arr == null) return emptyList()
            val out = LinkedHashSet<String>()
            for (i in 0 until arr.length()) {
                PeerStreamConnector.normalizeRelayEndpoint(arr.optString(i, ""))?.let(out::add)
            }
            return out.toList()
        }

        internal fun sha256HexLower(value: String): String =
            MessageDigest.getInstance("SHA-256")
                .digest(value.toByteArray(StandardCharsets.UTF_8))
                .joinToString("") { "%02x".format(it) }

        internal fun hmacSha256HexLower(keyAscii: String, message: String): String {
            val mac = Mac.getInstance("HmacSHA256")
            mac.init(SecretKeySpec(keyAscii.toByteArray(StandardCharsets.UTF_8), "HmacSHA256"))
            return mac.doFinal(message.toByteArray(StandardCharsets.UTF_8))
                .joinToString("") { "%02x".format(it) }
        }

        internal fun constantTimeHexEquals(a: String?, b: String?): Boolean {
            if (a.isNullOrEmpty() || b.isNullOrEmpty()) return false
            return MessageDigest.isEqual(
                a.trim().lowercase(Locale.ROOT).toByteArray(StandardCharsets.UTF_8),
                b.trim().lowercase(Locale.ROOT).toByteArray(StandardCharsets.UTF_8),
            )
        }

        internal fun generateHandshakeNonce(): String {
            val bytes = ByteArray(16)
            NONCE_RANDOM.nextBytes(bytes)
            return bytes.joinToString("") { "%02x".format(it) }
        }

        internal fun verifyHandshakeDomain(
            statusHeader: String?,
            resProof: String?,
            handshakeKey: String,
            suffix: String,
        ): String? {
            if (resProof.isNullOrEmpty() || handshakeKey.isEmpty()) return null
            if (!statusHeader.isNullOrBlank()) {
                val normStatus = statusHeader.trim().lowercase(Locale.ROOT)
                val prefix = when (normStatus) {
                    "approved" -> "kiki-handshake-res-v1:"
                    "revoked" -> "kiki-handshake-revoked-v1:"
                    "inbound_disabled" -> "kiki-handshake-disabled-v1:"
                    "invited" -> "kiki-handshake-invited-v1:"
                    else -> return null
                }
                return if (constantTimeHexEquals(resProof, hmacSha256HexLower(handshakeKey, prefix + suffix))) {
                    normStatus
                } else {
                    null
                }
            }
            if (constantTimeHexEquals(resProof, hmacSha256HexLower(handshakeKey, "kiki-handshake-res-v1:$suffix"))) {
                return "approved"
            }
            if (constantTimeHexEquals(resProof, hmacSha256HexLower(handshakeKey, "kiki-handshake-revoked-v1:$suffix"))) {
                return "revoked"
            }
            if (constantTimeHexEquals(resProof, hmacSha256HexLower(handshakeKey, "kiki-handshake-disabled-v1:$suffix"))) {
                return "inbound_disabled"
            }
            if (constantTimeHexEquals(resProof, hmacSha256HexLower(handshakeKey, "kiki-handshake-invited-v1:$suffix"))) {
                return "invited"
            }
            return null
        }

        internal fun certificateMatchesSpkiPin(cert: Certificate?, expectedFpLower: String): Boolean {
            if (cert == null) return false
            val spki = cert.publicKey?.encoded ?: return false
            val actual = MessageDigest.getInstance("SHA-256").digest(spki)
                .joinToString("") { "%02x".format(it) }
            return constantTimeHexEquals(actual, expectedFpLower)
        }

        internal fun certificateMatchesSpkiPin(sslCert: SslCertificate?, expectedFpLower: String): Boolean {
            if (sslCert == null) return false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val x509 = sslCert.x509Certificate
                if (x509 != null) return certificateMatchesSpkiPin(x509 as Certificate, expectedFpLower)
            }
            val bundle = SslCertificate.saveState(sslCert)
            val der = bundle.getByteArray("x509-certificate") ?: return false
            val parsed = runCatching {
                CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(der))
            }.getOrNull() ?: return false
            return certificateMatchesSpkiPin(parsed, expectedFpLower)
        }

        private fun pinnedSslSocketFactory(pinnedFpLower: String): SSLSocketFactory {
            val tm = object : X509TrustManager {
                override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
                override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
                    if (chain.isNullOrEmpty() || !certificateMatchesSpkiPin(chain[0], pinnedFpLower)) {
                        throw java.security.cert.CertificateException("Server certificate SPKI does not match pinned fingerprint.")
                    }
                }
                override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
            }
            val ctx = SSLContext.getInstance("TLS")
            ctx.init(null, arrayOf(tm), SecureRandom())
            return ctx.socketFactory
        }

        private fun readBoundedUtf8(input: InputStream, maxBytes: Int): String {
            val out = ByteArrayOutputStream()
            val buf = ByteArray(8 * 1024)
            var total = 0
            while (true) {
                val n = input.read(buf)
                if (n <= 0) break
                total += n
                if (total > maxBytes) throw IOException("Response exceeded limit")
                out.write(buf, 0, n)
            }
            return out.toString(StandardCharsets.UTF_8.name())
        }
    }
}
