package dev.kiki.android.host.boot

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import dev.kiki.android.host.HostMode
import dev.kiki.android.host.KikiHostSettings
import dev.kiki.android.host.KikiRuntimeService

class KikiBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != Intent.ACTION_BOOT_COMPLETED) return
        val settings = KikiHostSettings(context)
        if (settings.hostMode == HostMode.LOCAL_HOST && settings.bootAutostart) {
            KikiRuntimeService.ensureStarted(context)
        }
    }
}
