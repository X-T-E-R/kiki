package dev.kiki.android.host.net

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities

class PeerNetworkHints(
    context: Context,
    private val onNetworkChanged: (available: Boolean, metered: Boolean) -> Unit,
) {
    private val cm = context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    private val stateLock = Any()
    private var registered = false
    private var lastNetwork: Network? = null
    private var lastAvailable: Boolean? = null
    private var lastMetered: Boolean? = null

    private fun isMetered(caps: NetworkCapabilities?): Boolean {
        return caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) == false
    }

    private fun emit(network: Network?, available: Boolean, metered: Boolean, force: Boolean = false) {
        synchronized(stateLock) {
            val changed = force ||
                lastAvailable != available ||
                lastMetered != metered ||
                (available && network != null && network != lastNetwork)
            if (changed) {
                lastNetwork = if (available) network else null
                lastAvailable = available
                lastMetered = metered
                onNetworkChanged(available, metered)
            }
        }
    }

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            synchronized(stateLock) {
                val caps = cm?.getNetworkCapabilities(network)
                emit(network, available = true, metered = isMetered(caps), force = true)
            }
        }

        override fun onCapabilitiesChanged(network: Network, networkCapabilities: NetworkCapabilities) {
            synchronized(stateLock) {
                if (cm?.activeNetwork != network) return
                emit(network, available = true, metered = isMetered(networkCapabilities))
            }
        }

        override fun onLost(network: Network) {
            synchronized(stateLock) {
                val active = cm?.activeNetwork
                if (active == null) {
                    emit(null, available = false, metered = false)
                } else if (active != network) {
                    val caps = cm?.getNetworkCapabilities(active)
                    emit(active, available = true, metered = isMetered(caps))
                }
            }
        }
    }

    fun emitCurrentState() {
        val manager = cm ?: return
        synchronized(stateLock) {
            val active = manager.activeNetwork
            if (active == null) {
                emit(null, available = false, metered = false, force = true)
            } else {
                val caps = manager.getNetworkCapabilities(active)
                emit(active, available = true, metered = isMetered(caps), force = true)
            }
        }
    }

    fun register() {
        val manager = cm ?: return
        if (registered) return
        runCatching {
            manager.registerDefaultNetworkCallback(callback)
            registered = true
        }
    }

    fun unregister() {
        val manager = cm ?: return
        if (!registered) return
        runCatching { manager.unregisterNetworkCallback(callback) }
        registered = false
    }
}
