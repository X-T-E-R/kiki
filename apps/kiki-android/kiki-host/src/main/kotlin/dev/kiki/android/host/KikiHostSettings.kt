package dev.kiki.android.host

import android.content.Context
import java.io.File
import java.net.URI

enum class HostMode(val wireValue: String) {
    UNSELECTED("unselected"),
    REMOTE_ONLY("remote_only"),
    LOCAL_HOST("local_host");

    companion object {
        fun fromWire(raw: String?): HostMode? {
            val cleaned = raw?.trim()?.lowercase() ?: return null
            return entries.firstOrNull { it.wireValue == cleaned }
        }
    }
}

/**
 * Persistent user-controlled host preferences for Kiki Android.
 * Backed by [HostSettingsStore]; production uses SharedPreferences, JVM tests use [InMemoryHostSettingsStore].
 */
interface HostSettingsStore {
    fun getBoolean(key: String, defaultValue: Boolean): Boolean
    fun putBoolean(key: String, value: Boolean)
    fun getLong(key: String, defaultValue: Long): Long = defaultValue
    fun putLong(key: String, value: Long) = Unit
    fun getString(key: String, defaultValue: String?): String?
    fun putString(key: String, value: String?)
    fun putStringImmediate(key: String, value: String?) {
        putString(key, value)
    }
}

class SharedPreferencesHostSettingsStore(context: Context) : HostSettingsStore {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    override fun getBoolean(key: String, defaultValue: Boolean): Boolean =
        prefs.getBoolean(key, defaultValue)

    override fun putBoolean(key: String, value: Boolean) {
        prefs.edit().putBoolean(key, value).apply()
    }

    override fun getLong(key: String, defaultValue: Long): Long =
        prefs.getLong(key, defaultValue)

    override fun putLong(key: String, value: Long) {
        prefs.edit().putLong(key, value).apply()
    }

    override fun getString(key: String, defaultValue: String?): String? =
        prefs.getString(key, defaultValue)

    override fun putString(key: String, value: String?) {
        prefs.edit().apply {
            if (value == null) remove(key) else putString(key, value)
        }.apply()
    }

    override fun putStringImmediate(key: String, value: String?) {
        val editor = prefs.edit()
        if (value == null) editor.remove(key) else editor.putString(key, value)
        editor.commit()
    }

    companion object {
        const val PREFS_NAME = "kiki_host_prefs"
    }
}

class InMemoryHostSettingsStore(
    initialBooleans: Map<String, Boolean> = emptyMap(),
    initialStrings: Map<String, String> = emptyMap(),
    initialLongs: Map<String, Long> = emptyMap(),
) : HostSettingsStore {
    private val bools = HashMap(initialBooleans)
    private val strings = HashMap(initialStrings)
    private val longs = HashMap(initialLongs)

    override fun getBoolean(key: String, defaultValue: Boolean): Boolean =
        synchronized(this) { bools[key] ?: defaultValue }

    override fun putBoolean(key: String, value: Boolean) {
        synchronized(this) { bools[key] = value }
    }

    override fun getLong(key: String, defaultValue: Long): Long =
        synchronized(this) { longs[key] ?: defaultValue }

    override fun putLong(key: String, value: Long) {
        synchronized(this) { longs[key] = value }
    }

    override fun getString(key: String, defaultValue: String?): String? =
        synchronized(this) { strings[key] ?: defaultValue }

    override fun putString(key: String, value: String?) {
        synchronized(this) {
            if (value == null) strings.remove(key) else strings[key] = value
        }
    }
}

class KikiHostSettings(
    private val store: HostSettingsStore,
    private val kikiRootDir: File? = null,
) {

    constructor(context: Context) : this(
        store = SharedPreferencesHostSettingsStore(context),
        kikiRootDir = File(context.applicationContext.filesDir, "kiki"),
    )

    var hostMode: HostMode
        get() {
            val saved = HostMode.fromWire(store.getString(KEY_HOST_MODE, null))
            if (saved != null) return saved
            if (hasExistingLocalHostData(kikiRootDir)) {
                store.putStringImmediate(KEY_HOST_MODE, HostMode.LOCAL_HOST.wireValue)
                return HostMode.LOCAL_HOST
            }
            return HostMode.UNSELECTED
        }
        set(value) {
            store.putStringImmediate(KEY_HOST_MODE, value.wireValue)
        }

    var localNotifPromptedOnce: Boolean
        get() = store.getBoolean(KEY_LOCAL_NOTIF_PROMPTED, false)
        set(value) = store.putBoolean(KEY_LOCAL_NOTIF_PROMPTED, value)

    var autoCheckUpdates: Boolean
        get() = store.getBoolean(KEY_AUTO_CHECK_UPDATES, true)
        set(value) = store.putBoolean(KEY_AUTO_CHECK_UPDATES, value)

    var skippedVersionCode: Long
        get() = store.getLong(KEY_SKIPPED_VERSION_CODE, 0L)
        set(value) = store.putLong(KEY_SKIPPED_VERSION_CODE, value)

    var remindLaterUntilMs: Long
        get() = store.getLong(KEY_REMIND_LATER_UNTIL_MS, 0L)
        set(value) = store.putLong(KEY_REMIND_LATER_UNTIL_MS, value)

    var updaterFeedUrlOverride: String?
        get() = store.getString(KEY_UPDATER_FEED_URL_OVERRIDE, null)?.trim()?.takeIf { it.isNotEmpty() }
        set(value) {
            val normalized = normalizeUpdaterFeedUrl(value)
            store.putString(KEY_UPDATER_FEED_URL_OVERRIDE, normalized)
        }

    var allowWakeUnlock: Boolean
        get() = store.getBoolean(KEY_ALLOW_WAKE_UNLOCK, false)
        set(value) = store.putBoolean(KEY_ALLOW_WAKE_UNLOCK, value)

    var allowClipboardRead: Boolean
        get() = store.getBoolean(KEY_ALLOW_CLIPBOARD_READ, true)
        set(value) = store.putBoolean(KEY_ALLOW_CLIPBOARD_READ, value)

    var allowClipboardWrite: Boolean
        get() = store.getBoolean(KEY_ALLOW_CLIPBOARD_WRITE, true)
        set(value) = store.putBoolean(KEY_ALLOW_CLIPBOARD_WRITE, value)

    var bootAutostart: Boolean
        get() = store.getBoolean(KEY_BOOT_AUTOSTART, false)
        set(value) = store.putBoolean(KEY_BOOT_AUTOSTART, value)

    var proxyUrl: String?
        get() = store.getString(KEY_PROXY_URL, null)?.trim()?.takeIf { it.isNotEmpty() }
        set(value) {
            val normalized = normalizeProxyUrl(value)
            store.putString(KEY_PROXY_URL, normalized)
        }

    companion object {
        const val KEY_HOST_MODE = "host_mode"
        const val KEY_LOCAL_NOTIF_PROMPTED = "local_notif_prompted_once"
        const val KEY_AUTO_CHECK_UPDATES = "auto_check_updates"
        const val KEY_SKIPPED_VERSION_CODE = "updater_skipped_version_code"
        const val KEY_REMIND_LATER_UNTIL_MS = "updater_remind_later_until_ms"
        const val KEY_UPDATER_FEED_URL_OVERRIDE = "updater_feed_url_override"
        const val KEY_ALLOW_WAKE_UNLOCK = "allow_wake_unlock"
        const val KEY_ALLOW_CLIPBOARD_READ = "allow_clipboard_read"
        const val KEY_ALLOW_CLIPBOARD_WRITE = "allow_clipboard_write"
        const val KEY_BOOT_AUTOSTART = "boot_autostart"
        const val KEY_PROXY_URL = "proxy_url"

        fun hasExistingLocalHostData(kikiRootDir: File?): Boolean {
            if (kikiRootDir == null || !kikiRootDir.isDirectory) return false
            val homeDir = File(kikiRootDir, "home")
            if (!homeDir.isDirectory) return false
            val configToml = File(homeDir, "config.toml")
            if (configToml.isFile && configToml.length() > 0L) return true
            val sessionsDir = File(homeDir, "sessions")
            return sessionsDir.isDirectory && (sessionsDir.list()?.isNotEmpty() == true)
        }

        fun normalizeUpdaterFeedUrl(raw: String?): String? {
            val trimmed = raw?.trim().orEmpty()
            if (trimmed.isEmpty()) return null
            val uri = try {
                URI(trimmed)
            } catch (e: Exception) {
                throw IllegalArgumentException("Invalid updater feed URL: $trimmed", e)
            }
            val scheme = uri.scheme?.lowercase().orEmpty()
            val host = uri.host?.trim()?.lowercase().orEmpty()
            require(host.isNotEmpty()) { "Updater feed URL is missing a host" }
            val isLoopback = host == "127.0.0.1" || host == "localhost" || host == "::1" || host == "[::1]"
            require(scheme == "https" || (scheme == "http" && isLoopback)) {
                "Updater feed URL must use https:// (or http://127.0.0.1 for local verification)"
            }
            return trimmed
        }

        /**
         * Validates an HTTP/HTTPS/SOCKS5 proxy URL. Null or blank clears the proxy.
         * Throws [IllegalArgumentException] when the URL has an unsupported scheme or missing host:port.
         */
        fun normalizeProxyUrl(raw: String?): String? {
            val trimmed = raw?.trim().orEmpty()
            if (trimmed.isEmpty()) return null
            val uri = try {
                URI(trimmed)
            } catch (e: Exception) {
                throw IllegalArgumentException("Invalid proxy URL: $trimmed", e)
            }
            val scheme = uri.scheme?.lowercase().orEmpty()
            require(scheme in ALLOWED_PROXY_SCHEMES) {
                "Unsupported proxy scheme '$scheme' (use http://, https://, or socks5://)"
            }
            val host = uri.host?.trim().orEmpty()
            require(host.isNotEmpty()) { "Proxy URL is missing a host" }
            val port = uri.port
            require(port in 1..65535) { "Proxy URL must specify a valid port (1..65535)" }
            return trimmed
        }

        private val ALLOWED_PROXY_SCHEMES = setOf("http", "https", "socks5", "socks5h")
    }
}
