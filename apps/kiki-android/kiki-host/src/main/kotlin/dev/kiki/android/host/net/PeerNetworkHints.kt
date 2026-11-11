package dev.kiki.android.host.net

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest

class PeerNetworkHints(
    context: Context,
    private val onNetworkChanged: (available: Boolean, metered: Boolean) -> Unit,
) {
    private val cm = context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    private var registered = false

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            val caps = cm?.getNetworkCapabilities(network)
            val metered = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) == false
            onNetworkChanged(true, metered)
        }

        override fun onLost(network: Network) {
            val active = cm?.activeNetwork
            if (active == null) {
                onNetworkChanged(false, false)
            }
        }
    }

    fun register() {
        val manager = cm ?: return
        if (registered) return
        val req = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        runCatching {
            manager.registerNetworkCallback(req, callback)
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
