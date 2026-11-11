package dev.kiki.android.host.ui

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.content.ContextCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import dev.kiki.android.host.KikiHostEnvironment
import dev.kiki.android.host.KikiRuntimeService
import dev.kiki.android.host.share.SharedIntakeItem
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

class AndroidBridgeHandler(
    private val activity: Activity,
    private val webView: WebView,
    private val host: KikiHostEnvironment,
    private val requestNotificationsPermission: () -> Unit,
    private val onAppearanceChanged: (Boolean) -> Unit = {},
) {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val json = Json { ignoreUnknownKeys = true }

    @Volatile
    private var allowedOrigin: String? = null

    private var listenerRegistered = false
    private var legacyInterfaceAdded = false

    @SuppressLint("RequiresFeature")
    fun bindToOrigin(origin: String) {
        val prevOrigin = allowedOrigin
        allowedOrigin = origin

        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            if (listenerRegistered && prevOrigin != origin) {
                runCatching { WebViewCompat.removeWebMessageListener(webView, BRIDGE_OBJECT_NAME) }
                listenerRegistered = false
            }
            if (!listenerRegistered) {
                WebViewCompat.addWebMessageListener(
                    webView,
                    BRIDGE_OBJECT_NAME,
                    setOf(origin),
                ) { _, message, sourceOrigin, isMainFrame, replyProxy ->
                    if (!isMainFrame || sourceOrigin.toString() != allowedOrigin) return@addWebMessageListener
                    val text = message.data ?: return@addWebMessageListener
                    handleMessageFromJs(text, replyProxy)
                }
                listenerRegistered = true
            }
        } else if (!legacyInterfaceAdded) {
            webView.addJavascriptInterface(LegacyJsBridge(), BRIDGE_OBJECT_NAME)
            legacyInterfaceAdded = true
        }
    }

    fun pushEvent(eventType: String, data: JsonObject) {
        val origin = allowedOrigin ?: return
        mainHandler.post {
            val currentUrl = webView.url ?: return@post
            if (!currentUrl.startsWith(origin)) return@post
            val detail = buildJsonObject {
                put("type", eventType)
                put("data", data)
            }.toString()
            webView.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('kiki:android', { detail: $detail }));",
                null,
            )
        }
    }

    fun buildCapabilitiesJson(): JsonObject {
        val ctx = activity.applicationContext
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val batteryExempt = pm?.isIgnoringBatteryOptimizations(ctx.packageName) ?: false
        val notifGranted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        } else {
            true
        }
        val sb = host.sandboxSpec()
        val abi = Build.SUPPORTED_ABIS.firstOrNull() ?: "arm64-v8a"
        return buildJsonObject {
            put("platform", "android")
            put("version", host.versionName)
            put("versionName", host.versionName)
            put("sdk", Build.VERSION.SDK_INT)
            put("sdkInt", Build.VERSION.SDK_INT)
            put("abi", abi)
            put("sandbox", sb.available)
            put("sandboxAvailable", sb.available)
            put("allowWakeUnlock", host.settings.allowWakeUnlock)
            put("permissions", buildJsonObject {
                put("accessibility", host.isAccessibilityEnabled())
                put("overlay", Settings.canDrawOverlays(ctx))
                put("notifications", notifGranted)
                put("battery", batteryExempt)
                put("oemAutostart", host.settings.bootAutostart)
            })
        }
    }

    private fun handleMessageFromJs(raw: String, replyProxy: JavaScriptReplyProxy?) {
        val req = runCatching { json.parseToJsonElement(raw).jsonObject }.getOrNull() ?: return
        val id = req["id"] ?: JsonNull
        val method = req["method"]?.jsonPrimitive?.contentOrNull ?: return
        val params = req["params"] as? JsonObject ?: buildJsonObject {}

        mainHandler.post {
            val response = runCatching { executeMethod(method, params) }
                .fold(
                    onSuccess = { res ->
                        buildJsonObject {
                            put("id", id)
                            put("ok", true)
                            put("result", res)
                        }
                    },
                    onFailure = { err ->
                        buildJsonObject {
                            put("id", id)
                            put("ok", false)
                            put("error", err.message ?: "bridge_error")
                        }
                    },
                )
            val serialized = response.toString()
            if (replyProxy != null && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                replyProxy.postMessage(serialized)
            } else {
                webView.evaluateJavascript(
                    "window.__kikiAndroidBridgeReply && window.__kikiAndroidBridgeReply($serialized);",
                    null,
                )
            }
        }
    }

    internal fun executeMethod(method: String, params: JsonObject): JsonElement = dispatchMethod(
        method = method,
        params = params,
        capabilitiesProvider = ::buildCapabilitiesJson,
        openPermission = ::openPermissionScreen,
        openNativePhoneSettings = { host.openNativePhoneSettings(activity) },
        setAppearance = onAppearanceChanged,
        setAllowWakeUnlock = { allowed -> host.settings.allowWakeUnlock = allowed },
        resumeScreenAutomation = { KikiRuntimeService.instanceRef?.resumeScreenAutomation() },
        readClipboard = {
            val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
            cm?.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(activity)?.toString()
        },
        writeClipboard = { text ->
            val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
            cm?.setPrimaryClip(ClipData.newPlainText("Kiki", text))
        },
        shareText = { text ->
            if (text.isNotEmpty()) {
                val shareIntent = Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_TEXT, text)
                }
                activity.startActivity(Intent.createChooser(shareIntent, null))
            }
        },
        takeShareIntake = { intakeId -> host.shareIntakeStore.takeBatchItems(intakeId) },
    )

    @SuppressLint("BatteryLife")
    private fun openPermissionScreen(kind: String) {
        val pkgUri = Uri.parse("package:${activity.packageName}")
        val intent: Intent? = when (kind) {
            "accessibility" -> Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
            "overlay" -> Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, pkgUri)
            "notifications" -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                    ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                ) {
                    requestNotificationsPermission()
                    null
                } else {
                    Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                        putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName)
                    }
                }
            }
            "battery" -> Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkgUri)
            "native_settings", "oem_autostart" -> {
                host.openNativePhoneSettings(activity)
                null
            }
            else -> Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkgUri)
        }
        if (intent != null) {
            runCatching {
                activity.startActivity(intent)
            }.onFailure {
                runCatching {
                    activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkgUri))
                }
            }
        }
    }

    private inner class LegacyJsBridge {
        @JavascriptInterface
        fun postMessage(raw: String) {
            mainHandler.post {
                val origin = allowedOrigin ?: return@post
                val current = webView.url ?: return@post
                if (!current.startsWith(origin)) return@post
                handleMessageFromJs(raw, null)
            }
        }

        @JavascriptInterface
        fun getCapabilitiesSync(): String {
            val origin = allowedOrigin ?: return "{}"
            var result = "{}"
            val latch = java.util.concurrent.CountDownLatch(1)
            mainHandler.post {
                if (webView.url?.startsWith(origin) == true) {
                    result = buildCapabilitiesJson().toString()
                }
                latch.countDown()
            }
            runCatching { latch.await(1, java.util.concurrent.TimeUnit.SECONDS) }
            return result
        }
    }

    companion object {
        const val BRIDGE_OBJECT_NAME = "KikiAndroid"

        internal fun dispatchMethod(
            method: String,
            params: JsonObject,
            capabilitiesProvider: () -> JsonObject,
            openPermission: (String) -> Unit,
            openNativePhoneSettings: () -> Unit,
            setAppearance: (Boolean) -> Unit,
            setAllowWakeUnlock: (Boolean) -> Unit,
            resumeScreenAutomation: () -> Unit,
            readClipboard: () -> String?,
            writeClipboard: (String) -> Unit,
            shareText: (String) -> Unit,
            takeShareIntake: (String) -> List<SharedIntakeItem> = { emptyList() },
        ): JsonElement = when (method) {
            "capabilities", "getPermissions" -> capabilitiesProvider()

            "openPermission" -> {
                val kind = params["kind"]?.jsonPrimitive?.contentOrNull.orEmpty()
                openPermission(kind)
                buildJsonObject { put("opened", kind) }
            }

            "openPhoneSettings", "openNativeSettings" -> {
                openNativePhoneSettings()
                buildJsonObject { put("opened", "native_settings") }
            }

            "setAppearance" -> {
                val dark = params["dark"]?.jsonPrimitive?.booleanOrNull ?: false
                setAppearance(dark)
                buildJsonObject { put("ok", true); put("dark", dark) }
            }

            "setAllowWakeUnlock" -> {
                val allowed = params["allowed"]?.jsonPrimitive?.booleanOrNull ?: false
                setAllowWakeUnlock(allowed)
                capabilitiesProvider()
            }

            "resumeScreenAutomation" -> {
                resumeScreenAutomation()
                buildJsonObject { put("ok", true) }
            }

            "readClipboard" -> {
                val text = readClipboard()
                if (text != null) JsonPrimitive(text) else JsonNull
            }

            "writeClipboard" -> {
                val text = params["text"]?.jsonPrimitive?.contentOrNull.orEmpty()
                writeClipboard(text)
                buildJsonObject { put("ok", true) }
            }

            "share" -> {
                val text = params["text"]?.jsonPrimitive?.contentOrNull.orEmpty()
                shareText(text)
                buildJsonObject { put("ok", true) }
            }

            "takeShareIntake" -> {
                val intakeId = params["id"]?.jsonPrimitive?.contentOrNull.orEmpty()
                val items = if (intakeId.isNotEmpty()) takeShareIntake(intakeId) else emptyList()
                buildJsonArray {
                    for (item in items) {
                        add(buildJsonObject {
                            put("id", item.id)
                            put("name", item.name)
                            put("mimeType", item.mimeType)
                            item.path?.let { put("path", it) }
                            item.text?.let { put("text", it) }
                        })
                    }
                }
            }

            else -> throw IllegalArgumentException("Unknown method: $method")
        }
    }
}
