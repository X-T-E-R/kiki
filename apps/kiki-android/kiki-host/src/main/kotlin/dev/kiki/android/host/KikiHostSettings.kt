package dev.kiki.android.host

import android.content.Context
import java.net.URI

/**
 * Persistent user-controlled host preferences for Kiki Android.
 * Backed by [HostSettingsStore]; production uses SharedPreferences, JVM tests use [InMemoryHostSettingsStore].
 */
interface HostSettingsStore {
    fun getBoolean(key: String, defaultValue: Boolean): Boolean
    fun putBoolean(key: String, value: Boolean)
    fun getString(key: String, defaultValue: String?): String?
    fun putString(key: String, value: String?)
}

class SharedPreferencesHostSettingsStore(context: Context) : HostSettingsStore {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    override fun getBoolean(key: String, defaultValue: Boolean): Boolean =
        prefs.getBoolean(key, defaultValue)

    override fun putBoolean(key: String, value: Boolean) {
        prefs.edit().putBoolean(key, value).apply()
    }

    override fun getString(key: String, defaultValue: String?): String? =
        prefs.getString(key, defaultValue)

    override fun putString(key: String, value: String?) {
        prefs.edit().apply {
            if (value == null) remove(key) else putString(key, value)
        }.apply()
    }

    companion object {
        const val PREFS_NAME = "kiki_host_prefs"
    }
}

class InMemoryHostSettingsStore(
    initialBooleans: Map<String, Boolean> = emptyMap(),
    initialStrings: Map<String, String> = emptyMap(),
) : HostSettingsStore {
    private val bools = HashMap(initialBooleans)
    private val strings = HashMap(initialStrings)

    override fun getBoolean(key: String, defaultValue: Boolean): Boolean =
        synchronized(this) { bools[key] ?: defaultValue }

    override fun putBoolean(key: String, value: Boolean) {
        synchronized(this) { bools[key] = value }
    }

    override fun getString(key: String, defaultValue: String?): String? =
        synchronized(this) { strings[key] ?: defaultValue }

    override fun putString(key: String, value: String?) {
        synchronized(this) {
            if (value == null) strings.remove(key) else strings[key] = value
        }
    }
}

class KikiHostSettings(private val store: HostSettingsStore) {

    constructor(context: Context) : this(SharedPreferencesHostSettingsStore(context))

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
        const val KEY_ALLOW_WAKE_UNLOCK = "allow_wake_unlock"
        const val KEY_ALLOW_CLIPBOARD_READ = "allow_clipboard_read"
        const val KEY_ALLOW_CLIPBOARD_WRITE = "allow_clipboard_write"
        const val KEY_BOOT_AUTOSTART = "boot_autostart"
        const val KEY_PROXY_URL = "proxy_url"

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
