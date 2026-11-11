package dev.kiki.android.host.tools

import android.app.KeyguardManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.StatFs
import androidx.core.content.FileProvider
import dev.kiki.android.host.HostMcpToolCallResult
import dev.kiki.android.host.HostMcpToolDescriptor
import dev.kiki.android.host.KikiHostEnvironment
import dev.kiki.android.host.screen.ScreenToolRole
import dev.kiki.android.host.share.ShareIntakeBatch
import dev.kiki.android.host.share.ShareIntakeStore
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.File
import java.net.URI
import java.nio.charset.StandardCharsets
import java.time.ZoneId
import java.util.Locale
import kotlin.coroutines.resume

data class BatterySnapshot(
    val levelPercent: Int?,
    val isCharging: Boolean,
    val status: String,
    val plugged: String,
    val temperatureCelsius: Double? = null,
)

data class NetworkSnapshot(
    val connected: Boolean,
    val transport: String,
    val metered: Boolean,
    val validated: Boolean,
)

data class DisplayLockSnapshot(
    val screenInteractive: Boolean,
    val keyguardLocked: Boolean,
    val keyguardSecure: Boolean,
)

data class StorageSnapshot(
    val availableBytes: Long,
    val totalBytes: Long,
)

data class DeviceInfoSnapshot(
    val manufacturer: String,
    val model: String,
    val sdkInt: Int,
    val release: String,
    val abi: String,
    val locale: String,
    val timezone: String,
    val battery: BatterySnapshot,
    val network: NetworkSnapshot,
    val screen: DisplayLockSnapshot,
    val storage: StorageSnapshot,
    val foregroundPackage: String?,
    val accessibilityEnabled: Boolean,
)

data class ClipboardSnapshot(
    val hasContent: Boolean,
    val text: String?,
    val mimeTypes: List<String> = emptyList(),
)

data class OpenUriOutcome(
    val launched: Boolean,
    val resolvedPackage: String? = null,
    val errorCode: String? = null,
    val errorMessage: String? = null,
)

/**
 * Seam wrapping real Android OS services so [SystemToolProvider] is 100% real in production
 * and directly testable with deterministic fakes in JVM unit tests.
 */
interface SystemPlatformOps {
    val workspaceDir: File
    val selfPackage: String
    val shareIntakeStore: ShareIntakeStore

    fun readDeviceInfo(): DeviceInfoSnapshot
    suspend fun readClipboard(): ClipboardSnapshot
    suspend fun writeClipboard(text: String, label: String): Boolean
    fun openUri(action: String, uriString: String, packageName: String?): OpenUriOutcome
    fun shareChooser(text: String?, subject: String?, title: String?, files: List<File>, mimeType: String): OpenUriOutcome
    fun wakeScreen(durationMs: Long): DisplayLockSnapshot
}

/**
 * Production [SystemPlatformOps] backed directly by Android system services (BatteryManager,
 * ConnectivityManager, PowerManager, KeyguardManager, ClipboardManager, PackageManager, FileProvider).
 */
class AndroidSystemPlatformOps(
    private val appContext: Context,
    private val host: KikiHostEnvironment,
) : SystemPlatformOps {

    private val mainHandler = Handler(Looper.getMainLooper())

    override val workspaceDir: File get() = host.workspaceDir
    override val selfPackage: String get() = appContext.packageName
    override val shareIntakeStore: ShareIntakeStore get() = host.shareIntakeStore

    override fun readDeviceInfo(): DeviceInfoSnapshot {
        val battery = queryBattery()
        val network = queryNetwork()
        val screen = queryScreenAndLock()
        val storage = queryStorage()
        val locale = if (!appContext.resources.configuration.locales.isEmpty) {
            appContext.resources.configuration.locales[0].toLanguageTag()
        } else {
            Locale.getDefault().toLanguageTag()
        }
        val tz = runCatching { ZoneId.systemDefault().id }.getOrDefault("UTC")
        return DeviceInfoSnapshot(
            manufacturer = Build.MANUFACTURER.orEmpty(),
            model = Build.MODEL.orEmpty(),
            sdkInt = Build.VERSION.SDK_INT,
            release = Build.VERSION.RELEASE.orEmpty(),
            abi = Build.SUPPORTED_ABIS.firstOrNull() ?: "arm64-v8a",
            locale = locale,
            timezone = tz,
            battery = battery,
            network = network,
            screen = screen,
            storage = storage,
            foregroundPackage = host.foregroundPackage(),
            accessibilityEnabled = host.isAccessibilityEnabled(),
        )
    }

    override suspend fun readClipboard(): ClipboardSnapshot = runOnMainThread {
        val cm = appContext.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
            ?: return@runOnMainThread ClipboardSnapshot(hasContent = false, text = null)
        val clip = cm.primaryClip ?: return@runOnMainThread ClipboardSnapshot(hasContent = false, text = null)
        if (clip.itemCount <= 0) {
            return@runOnMainThread ClipboardSnapshot(hasContent = false, text = null)
        }
        val desc = clip.description
        val mimes = if (desc != null) {
            (0 until desc.mimeTypeCount).mapNotNull { desc.getMimeType(it) }
        } else {
            emptyList()
        }
        val item = clip.getItemAt(0)
        val text = item.text?.toString() ?: item.coerceToText(appContext)?.toString()
        ClipboardSnapshot(
            hasContent = !text.isNullOrEmpty() || item.uri != null,
            text = text,
            mimeTypes = mimes,
        )
    }

    override suspend fun writeClipboard(text: String, label: String): Boolean = runOnMainThread {
        val cm = appContext.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
            ?: return@runOnMainThread false
        cm.setPrimaryClip(ClipData.newPlainText(label.ifBlank { "Kiki" }, text))
        true
    }

    override fun openUri(action: String, uriString: String, packageName: String?): OpenUriOutcome {
        val uri = runCatching { Uri.parse(uriString) }.getOrNull()
            ?: return OpenUriOutcome(false, errorCode = "invalid_uri", errorMessage = "Malformed URI: $uriString")
        val intent = Intent(action, uri).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (!packageName.isNullOrBlank()) {
                setPackage(packageName)
            }
        }
        val resolvedPkg = runCatching {
            intent.resolveActivity(appContext.packageManager)?.packageName
        }.getOrNull()
        return runCatching {
            appContext.startActivity(intent)
            OpenUriOutcome(launched = true, resolvedPackage = resolvedPkg ?: packageName)
        }.getOrElse { err ->
            OpenUriOutcome(
                launched = false,
                resolvedPackage = resolvedPkg,
                errorCode = "activity_not_found",
                errorMessage = err.message ?: "No installed app can handle $uriString",
            )
        }
    }

    override fun shareChooser(
        text: String?,
        subject: String?,
        title: String?,
        files: List<File>,
        mimeType: String,
    ): OpenUriOutcome {
        val authority = "${appContext.packageName}.fileprovider"
        val uris = ArrayList<Uri>(files.size)
        for (file in files) {
            val contentUri = runCatching {
                FileProvider.getUriForFile(appContext, authority, file)
            }.getOrElse { err ->
                return OpenUriOutcome(
                    launched = false,
                    errorCode = "file_provider_error",
                    errorMessage = err.message ?: "Cannot grant content URI for ${file.name}",
                )
            }
            uris += contentUri
        }

        val sendIntent = if (uris.size <= 1) {
            Intent(Intent.ACTION_SEND).apply {
                type = mimeType
                if (!text.isNullOrEmpty()) putExtra(Intent.EXTRA_TEXT, text)
                if (!subject.isNullOrEmpty()) putExtra(Intent.EXTRA_SUBJECT, subject)
                if (uris.size == 1) {
                    putExtra(Intent.EXTRA_STREAM, uris[0])
                    clipData = ClipData.newRawUri("shared", uris[0])
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
            }
        } else {
            Intent(Intent.ACTION_SEND_MULTIPLE).apply {
                type = mimeType
                if (!text.isNullOrEmpty()) putExtra(Intent.EXTRA_TEXT, text)
                if (!subject.isNullOrEmpty()) putExtra(Intent.EXTRA_SUBJECT, subject)
                putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
                val clip = ClipData.newRawUri("shared", uris[0])
                for (i in 1 until uris.size) {
                    clip.addItem(ClipData.Item(uris[i]))
                }
                clipData = clip
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
        }

        val chooser = Intent.createChooser(sendIntent, title).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (uris.isNotEmpty()) addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        return runCatching {
            appContext.startActivity(chooser)
            OpenUriOutcome(launched = true)
        }.getOrElse { err ->
            OpenUriOutcome(
                launched = false,
                errorCode = "share_failed",
                errorMessage = err.message ?: "Unable to open system share sheet",
            )
        }
    }

    @Suppress("DEPRECATION")
    override fun wakeScreen(durationMs: Long): DisplayLockSnapshot {
        val pm = appContext.getSystemService(Context.POWER_SERVICE) as? PowerManager
        if (pm != null && !pm.isInteractive) {
            val flags = PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP
            val wl = pm.newWakeLock(flags, "KikiHost::DeviceWake").apply {
                setReferenceCounted(false)
            }
            runCatching { wl.acquire(durationMs.coerceIn(1_000L, 15_000L)) }
        }
        return queryScreenAndLock()
    }

    private fun queryBattery(): BatterySnapshot {
        val sticky = runCatching {
            appContext.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        }.getOrNull()
        val level = sticky?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = sticky?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val pct = if (level >= 0 && scale > 0) ((level * 100f) / scale).toInt().coerceIn(0, 100) else null
        val statusInt = sticky?.getIntExtra(BatteryManager.EXTRA_STATUS, BatteryManager.BATTERY_STATUS_UNKNOWN)
            ?: BatteryManager.BATTERY_STATUS_UNKNOWN
        val pluggedInt = sticky?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
        val tempTenths = sticky?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE) ?: Int.MIN_VALUE

        val statusName = when (statusInt) {
            BatteryManager.BATTERY_STATUS_CHARGING -> "charging"
            BatteryManager.BATTERY_STATUS_DISCHARGING -> "discharging"
            BatteryManager.BATTERY_STATUS_FULL -> "full"
            BatteryManager.BATTERY_STATUS_NOT_CHARGING -> "not_charging"
            else -> "unknown"
        }
        val pluggedName = when (pluggedInt) {
            BatteryManager.BATTERY_PLUGGED_AC -> "ac"
            BatteryManager.BATTERY_PLUGGED_USB -> "usb"
            BatteryManager.BATTERY_PLUGGED_WIRELESS -> "wireless"
            BatteryManager.BATTERY_PLUGGED_DOCK -> "dock"
            0 -> "unplugged"
            else -> "other"
        }
        val charging = statusInt == BatteryManager.BATTERY_STATUS_CHARGING ||
            statusInt == BatteryManager.BATTERY_STATUS_FULL ||
            pluggedInt != 0
        val tempC = if (tempTenths > -500 && tempTenths < 1500) tempTenths / 10.0 else null

        return BatterySnapshot(
            levelPercent = pct,
            isCharging = charging,
            status = statusName,
            plugged = pluggedName,
            temperatureCelsius = tempC,
        )
    }

    private fun queryNetwork(): NetworkSnapshot {
        val cm = appContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return NetworkSnapshot(connected = false, transport = "none", metered = false, validated = false)
        val active = cm.activeNetwork
            ?: return NetworkSnapshot(connected = false, transport = "none", metered = false, validated = false)
        val caps = cm.getNetworkCapabilities(active)
            ?: return NetworkSnapshot(connected = false, transport = "none", metered = cm.isActiveNetworkMetered, validated = false)

        val internet = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        val validated = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        val metered = !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
        val transport = when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_BLUETOOTH) -> "bluetooth"
            else -> "other"
        }
        return NetworkSnapshot(
            connected = internet,
            transport = transport,
            metered = metered,
            validated = validated,
        )
    }

    private fun queryScreenAndLock(): DisplayLockSnapshot {
        val pm = appContext.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val km = appContext.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
        return DisplayLockSnapshot(
            screenInteractive = pm?.isInteractive ?: true,
            keyguardLocked = km?.isKeyguardLocked ?: false,
            keyguardSecure = km?.isDeviceSecure ?: false,
        )
    }

    private fun queryStorage(): StorageSnapshot {
        val dir = appContext.filesDir.apply { mkdirs() }
        val stat = StatFs(dir.absolutePath)
        return StorageSnapshot(
            availableBytes = stat.availableBytes,
            totalBytes = stat.totalBytes,
        )
    }

    private suspend fun <T> runOnMainThread(block: () -> T): T {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            return block()
        }
        return suspendCancellableCoroutine { cont ->
            mainHandler.post {
                val res = runCatching(block)
                if (cont.isActive) {
                    res.fold(
                        onSuccess = { cont.resume(it) },
                        onFailure = { err -> throw err },
                    )
                }
            }
        }
    }
}

/**
 * Built-in native Android system tool module installed automatically by [dev.kiki.android.host.KikiHost].
 */
class SystemToolsModule : KikiToolModule {
    override val id: String = "kiki.system"

    override fun providers(context: Context, host: KikiHostEnvironment): List<DeviceToolProvider> =
        listOf(SystemToolProvider(AndroidSystemPlatformOps(context.applicationContext, host)))
}

class SystemToolProvider(
    private val ops: SystemPlatformOps,
) : DeviceToolProvider {

    override val id: String = "kiki.system"

    private val json = Json { ignoreUnknownKeys = true }

    override fun tools(): List<DeviceTool> = TOOL_DEFINITIONS

    override suspend fun call(name: String, argumentsJson: String, context: ToolCallContext): HostMcpToolCallResult {
        val args = parseObjectOrNull(argumentsJson)
            ?: return ToolResults.error("invalid_arguments", "Tool arguments must be a JSON object.")
        return when (name) {
            TOOL_DEVICE_INFO -> handleDeviceInfo(args)
            TOOL_CLIPBOARD_READ -> handleClipboardRead(args, context)
            TOOL_CLIPBOARD_WRITE -> handleClipboardWrite(args)
            TOOL_OPEN_URI -> handleOpenUri(args)
            TOOL_SHARE_CONTENT -> handleShareContent(args)
            TOOL_SHARED_INBOX -> handleSharedInbox(args)
            TOOL_DEVICE_WAKE -> handleDeviceWake(args)
            else -> ToolResults.error("unknown_tool", "Unknown system tool: $name")
        }
    }

    private fun handleDeviceInfo(args: JsonObject): HostMcpToolCallResult {
        if (args.isNotEmpty()) {
            return ToolResults.error("invalid_arguments", "device_info accepts no arguments.")
        }
        val info = ops.readDeviceInfo()
        return ToolResults.ok {
            put("device", buildJsonObject {
                put("manufacturer", info.manufacturer)
                put("model", info.model)
                put("sdkInt", info.sdkInt)
                put("androidRelease", info.release)
                put("abi", info.abi)
                put("locale", info.locale)
                put("timezone", info.timezone)
            })
            put("battery", buildJsonObject {
                if (info.battery.levelPercent != null) {
                    put("levelPercent", info.battery.levelPercent)
                }
                put("charging", info.battery.isCharging)
                put("status", info.battery.status)
                put("plugged", info.battery.plugged)
                info.battery.temperatureCelsius?.let { put("temperatureCelsius", it) }
            })
            put("network", buildJsonObject {
                put("connected", info.network.connected)
                put("transport", info.network.transport)
                put("metered", info.network.metered)
                put("validated", info.network.validated)
            })
            put("screen", buildJsonObject {
                put("interactive", info.screen.screenInteractive)
                put("keyguardLocked", info.screen.keyguardLocked)
                put("keyguardSecure", info.screen.keyguardSecure)
            })
            put("storage", buildJsonObject {
                put("availableBytes", info.storage.availableBytes)
                put("totalBytes", info.storage.totalBytes)
                put("availableMb", info.storage.availableBytes / (1024L * 1024L))
            })
            if (info.foregroundPackage != null) {
                put("foregroundPackage", info.foregroundPackage)
            }
            put("accessibilityEnabled", info.accessibilityEnabled)
        }
    }

    private suspend fun handleClipboardRead(args: JsonObject, context: ToolCallContext): HostMcpToolCallResult {
        if (args.isNotEmpty()) {
            return ToolResults.error("invalid_arguments", "clipboard_read accepts no arguments.")
        }
        if (!context.attended) {
            return ToolResults.error(
                "unavailable_in_background",
                "Android restricts clipboard reads when Kiki is not in the foreground. Ask the user to bring Kiki to the foreground or paste directly.",
            )
        }
        val snap = ops.readClipboard()
        return ToolResults.ok {
            put("hasContent", snap.hasContent)
            if (snap.text != null) {
                put("text", snap.text)
            }
            put("mimeTypes", JsonArray(snap.mimeTypes.map(::JsonPrimitive)))
        }
    }

    private suspend fun handleClipboardWrite(args: JsonObject): HostMcpToolCallResult {
        val unknown = args.keys - setOf("text", "label")
        if (unknown.isNotEmpty()) {
            return ToolResults.error("invalid_arguments", "Unknown arguments: ${unknown.joinToString()}")
        }
        val text = args["text"]?.jsonPrimitive?.contentOrNull
            ?: return ToolResults.error("invalid_arguments", "Missing required string 'text'.")
        if (text.length > MAX_CLIPBOARD_CHARS) {
            return ToolResults.error("invalid_arguments", "Clipboard text exceeds maximum length ($MAX_CLIPBOARD_CHARS chars).")
        }
        val label = args["label"]?.jsonPrimitive?.contentOrNull?.take(64) ?: "Kiki"
        val written = ops.writeClipboard(text, label)
        if (!written) {
            return ToolResults.error("clipboard_unavailable", "System ClipboardManager is unavailable.")
        }
        return ToolResults.ok {
            put("chars", text.length)
            put("bytes", text.toByteArray(StandardCharsets.UTF_8).size)
        }
    }

    private fun handleOpenUri(args: JsonObject): HostMcpToolCallResult {
        val unknown = args.keys - setOf("uri", "packageName")
        if (unknown.isNotEmpty()) {
            return ToolResults.error("invalid_arguments", "Unknown arguments: ${unknown.joinToString()}")
        }
        val rawUri = args["uri"]?.jsonPrimitive?.contentOrNull?.trim().orEmpty()
        if (rawUri.isEmpty()) {
            return ToolResults.error("invalid_arguments", "Missing required non-empty 'uri'.")
        }
        val pkg = args["packageName"]?.jsonPrimitive?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }
        if (pkg == ops.selfPackage) {
            return ToolResults.error("own_app", "Cannot target Kiki itself with open_uri.")
        }

        val parsed = try {
            URI(rawUri)
        } catch (_: Exception) {
            null
        }
        val scheme = (parsed?.scheme ?: rawUri.substringBefore(':', "")).lowercase(Locale.ROOT).trim()
        if (scheme.isEmpty() || !SCHEME_PATTERN.matches(scheme)) {
            return ToolResults.error("invalid_uri", "URI must start with an explicit scheme (e.g. https://, tel:, mailto:).")
        }
        if (scheme in BLOCKED_URI_SCHEMES) {
            return ToolResults.error(
                "blocked_scheme",
                "URI scheme '$scheme' is blocked by Kiki Android security policy.",
            )
        }

        val action = when (scheme) {
            "tel" -> Intent.ACTION_DIAL
            "sms", "smsto", "mms", "mmsto", "mailto" -> Intent.ACTION_SENDTO
            else -> Intent.ACTION_VIEW
        }
        val out = ops.openUri(action, rawUri, pkg)
        if (!out.launched) {
            return ToolResults.error(
                out.errorCode ?: "launch_failed",
                out.errorMessage ?: "Failed to open URI: $rawUri",
            )
        }
        return ToolResults.ok {
            put("uri", rawUri)
            put("scheme", scheme)
            put("action", action)
            out.resolvedPackage?.let { put("handledBy", it) }
        }
    }

    private fun handleShareContent(args: JsonObject): HostMcpToolCallResult {
        val unknown = args.keys - setOf("text", "subject", "title", "files", "mimeType")
        if (unknown.isNotEmpty()) {
            return ToolResults.error("invalid_arguments", "Unknown arguments: ${unknown.joinToString()}")
        }
        val text = args["text"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotEmpty() }
        val subject = args["subject"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotEmpty() }
        val title = args["title"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotEmpty() }
        val rawFiles = (args["files"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.contentOrNull?.trim() }
            ?.filter { it.isNotEmpty() }
            .orEmpty()

        if (text == null && rawFiles.isEmpty()) {
            return ToolResults.error("invalid_arguments", "Provide non-empty 'text' or at least one workspace file path in 'files'.")
        }
        if (rawFiles.size > 12) {
            return ToolResults.error("invalid_arguments", "Cannot share more than 12 files at once.")
        }

        val canonicalWorkspace = ops.workspaceDir.canonicalFile
        val resolvedFiles = ArrayList<File>(rawFiles.size)
        for (rawPath in rawFiles) {
            val candidate = File(rawPath).let { f ->
                if (f.isAbsolute) f else File(canonicalWorkspace, rawPath)
            }.canonicalFile
            if (!isUnderDirectory(candidate, canonicalWorkspace)) {
                return ToolResults.error(
                    "path_outside_workspace",
                    "Shared files must reside inside the Kiki workspace directory (${canonicalWorkspace.path}): $rawPath",
                )
            }
            if (!candidate.isFile) {
                return ToolResults.error("file_not_found", "Workspace file does not exist: ${candidate.path}")
            }
            resolvedFiles += candidate
        }

        val mimeType = args["mimeType"]?.jsonPrimitive?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }
            ?: inferShareMimeType(resolvedFiles, hasText = text != null)

        val out = ops.shareChooser(text = text, subject = subject, title = title, files = resolvedFiles, mimeType = mimeType)
        if (!out.launched) {
            return ToolResults.error(out.errorCode ?: "share_failed", out.errorMessage ?: "Failed to open system share chooser.")
        }
        return ToolResults.ok {
            put("sharedFiles", resolvedFiles.size)
            put("mimeType", mimeType)
        }
    }

    private fun handleSharedInbox(args: JsonObject): HostMcpToolCallResult {
        val unknown = args.keys - setOf("action", "limit")
        if (unknown.isNotEmpty()) {
            return ToolResults.error("invalid_arguments", "Unknown arguments: ${unknown.joinToString()}")
        }
        val action = args["action"]?.jsonPrimitive?.contentOrNull?.trim()?.lowercase(Locale.ROOT) ?: "list"
        return when (action) {
            "list" -> {
                val limit = args["limit"]?.jsonPrimitive?.intOrNull?.coerceIn(1, 20) ?: 10
                val batches = ops.shareIntakeStore.listBatches(limit)
                ToolResults.ok {
                    put("count", batches.size)
                    put("batches", buildJsonArray {
                        for (b in batches) {
                            add(encodeBatch(b))
                        }
                    })
                }
            }
            "clear" -> {
                val cleared = ops.shareIntakeStore.clearAll()
                ToolResults.ok {
                    put("clearedBatches", cleared)
                }
            }
            else -> ToolResults.error("invalid_arguments", "Unsupported shared_inbox action '$action' (expected 'list' or 'clear').")
        }
    }

    private fun handleDeviceWake(args: JsonObject): HostMcpToolCallResult {
        if (args.isNotEmpty()) {
            return ToolResults.error("invalid_arguments", "device_wake accepts no arguments.")
        }
        val state = ops.wakeScreen(5_000L)
        return ToolResults.ok {
            put("interactive", state.screenInteractive)
            put("keyguardLocked", state.keyguardLocked)
            put("keyguardSecure", state.keyguardSecure)
        }
    }

    private fun encodeBatch(batch: ShareIntakeBatch): JsonObject = buildJsonObject {
        put("id", batch.id)
        put("createdAtMs", batch.createdAtMs)
        batch.subject?.let { put("subject", it) }
        put("items", buildJsonArray {
            for (item in batch.items) {
                add(buildJsonObject {
                    put("id", item.id)
                    put("name", item.name)
                    put("mimeType", item.mimeType)
                    put("bytes", item.bytes)
                    item.path?.let { put("path", it) }
                    item.text?.let { put("text", it) }
                })
            }
        })
    }

    private fun parseObjectOrNull(raw: String): JsonObject? {
        if (raw.isBlank()) return JsonObject(emptyMap())
        return runCatching { json.parseToJsonElement(raw) as? JsonObject }.getOrNull()
    }

    private fun isUnderDirectory(file: File, root: File): Boolean {
        val filePath = file.toPath().normalize()
        val rootPath = root.toPath().normalize()
        return filePath.startsWith(rootPath)
    }

    private fun inferShareMimeType(files: List<File>, hasText: Boolean): String {
        if (files.isEmpty()) return "text/plain"
        val mimes = files.map { extMime(it.extension) }.distinct()
        if (mimes.size == 1 && !hasText) return mimes.single()
        val prefixes = mimes.map { it.substringBefore('/') }.distinct()
        return if (prefixes.size == 1 && !hasText) "${prefixes.single()}/*" else "*/*"
    }

    private fun extMime(ext: String): String = when (ext.lowercase(Locale.ROOT)) {
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "webp" -> "image/webp"
        "gif" -> "image/gif"
        "pdf" -> "application/pdf"
        "txt", "log" -> "text/plain"
        "md" -> "text/markdown"
        "json" -> "application/json"
        "csv" -> "text/csv"
        "mp4" -> "video/mp4"
        "mp3" -> "audio/mpeg"
        else -> "application/octet-stream"
    }

    companion object {
        const val TOOL_DEVICE_INFO = "device_info"
        const val TOOL_CLIPBOARD_READ = "clipboard_read"
        const val TOOL_CLIPBOARD_WRITE = "clipboard_write"
        const val TOOL_OPEN_URI = "open_uri"
        const val TOOL_SHARE_CONTENT = "share_content"
        const val TOOL_SHARED_INBOX = "shared_inbox"
        const val TOOL_DEVICE_WAKE = "device_wake"

        private const val MAX_CLIPBOARD_CHARS = 256_000
        private val SCHEME_PATTERN = Regex("^[a-z][a-z0-9+.-]*$")

        val BLOCKED_URI_SCHEMES = setOf(
            "intent",
            "android-app",
            "file",
            "content",
            "javascript",
            "data",
            "about",
            "blob",
            "kiki-shell",
        )

        private val EMPTY_OBJECT_SCHEMA = """{"type":"object","properties":{},"required":[],"additionalProperties":false}"""

        val TOOL_DEFINITIONS: List<DeviceTool> = listOf(
            DeviceTool(
                descriptor = HostMcpToolDescriptor(
                    name = TOOL_DEVICE_INFO,
                    description = "Read real-time Android phone status: battery level/charging/temperature, active network transport and metered state, screen interactive and keyguard lock state, internal storage, OS/ABI, locale/timezone, and accessibility state.",
                    inputSchemaJson = EMPTY_OBJECT_SCHEMA,
                ),
                role = ScreenToolRole.NONE,
                gate = ToolGate.NONE,
            ),
            DeviceTool(
                descriptor = HostMcpToolDescriptor(
                    name = TOOL_CLIPBOARD_READ,
                    description = "Read plain text currently on the Android system clipboard when Kiki is in the foreground.",
                    inputSchemaJson = EMPTY_OBJECT_SCHEMA,
                ),
                role = ScreenToolRole.NONE,
                gate = ToolGate.CLIPBOARD_READ,
            ),
            DeviceTool(
                descriptor = HostMcpToolDescriptor(
                    name = TOOL_CLIPBOARD_WRITE,
                    description = "Copy plain text to the Android system clipboard.",
                    inputSchemaJson = """{"type":"object","properties":{"text":{"type":"string","description":"Text to copy to the clipboard."},"label":{"type":"string","description":"Optional short clip label."}},"required":["text"],"additionalProperties":false}""",
                ),
                role = ScreenToolRole.NONE,
                gate = ToolGate.CLIPBOARD_WRITE,
            ),
            DeviceTool(
                descriptor = HostMcpToolDescriptor(
                    name = TOOL_OPEN_URI,
                    description = "Open an external URL, deep link, dialer (tel: opens dialer without placing a call), SMS/email composer (sms:/mailto:), or geo: map URI in the appropriate Android app.",
                    inputSchemaJson = """{"type":"object","properties":{"uri":{"type":"string","description":"URI with explicit scheme (e.g. https://example.com, tel:+123456, mailto:a@example.com, geo:0,0?q=Tokyo)."},"packageName":{"type":"string","description":"Optional target Android application package name."}},"required":["uri"],"additionalProperties":false}""",
                ),
                role = ScreenToolRole.NONE,
                gate = ToolGate.NONE,
            ),
            DeviceTool(
                descriptor = HostMcpToolDescriptor(
                    name = TOOL_SHARE_CONTENT,
                    description = "Open the Android system share sheet with text and/or files from the Kiki workspace so the user can choose the receiving app.",
                    inputSchemaJson = """{"type":"object","properties":{"text":{"type":"string","description":"Text or link to share."},"subject":{"type":"string","description":"Optional share subject line."},"title":{"type":"string","description":"Optional chooser sheet title."},"files":{"type":"array","items":{"type":"string"},"description":"Workspace-relative or absolute paths inside the Kiki workspace to share via FileProvider."},"mimeType":{"type":"string","description":"Optional explicit MIME type."}},"required":[],"additionalProperties":false}""",
                ),
                role = ScreenToolRole.NONE,
                gate = ToolGate.NONE,
            ),
            DeviceTool(
                descriptor = HostMcpToolDescriptor(
                    name = TOOL_SHARED_INBOX,
                    description = "List or clear items recently shared into Kiki from other Android apps via system Share (ACTION_SEND).",
                    inputSchemaJson = """{"type":"object","properties":{"action":{"type":"string","enum":["list","clear"],"description":"Whether to list recent shared batches or clear staged shared files."},"limit":{"type":"integer","minimum":1,"maximum":20,"description":"Maximum number of recent share batches to return."}},"required":[],"additionalProperties":false}""",
                ),
                role = ScreenToolRole.NONE,
                gate = ToolGate.NONE,
            ),
            DeviceTool(
                descriptor = HostMcpToolDescriptor(
                    name = TOOL_DEVICE_WAKE,
                    description = "Wake the phone display when screen wake is enabled in Kiki Android settings, returning current interactive and keyguard lock status.",
                    inputSchemaJson = EMPTY_OBJECT_SCHEMA,
                ),
                role = ScreenToolRole.NONE,
                gate = ToolGate.WAKE_SCREEN,
            ),
        )
    }
}
