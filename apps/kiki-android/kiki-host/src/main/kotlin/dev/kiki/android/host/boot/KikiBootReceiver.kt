package dev.kiki.android.host.boot

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import dev.kiki.android.host.KikiRuntimeService

class KikiBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != Intent.ACTION_BOOT_COMPLETED) return
        val prefs = context.getSharedPreferences("kiki_host_prefs", Context.MODE_PRIVATE)
        if (prefs.getBoolean("boot_autostart", false)) {
            KikiRuntimeService.ensureStarted(context)
        }
    }
}
