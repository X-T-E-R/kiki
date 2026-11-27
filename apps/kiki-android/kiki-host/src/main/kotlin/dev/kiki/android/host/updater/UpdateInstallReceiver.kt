package dev.kiki.android.host.updater

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log
import android.widget.Toast
import dev.kiki.android.host.KikiHost
import dev.kiki.android.host.i18n.HostStrings

class UpdateInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent == null) return
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE).orEmpty()
        val sessionId = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)
        val host = runCatching { KikiHost.resolve(context) }.getOrNull()

        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirmIntent: Intent? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                } else {
                    intent.getParcelableExtra(Intent.EXTRA_INTENT)
                }
                if (confirmIntent == null) {
                    Log.w(TAG, "STATUS_PENDING_USER_ACTION missing EXTRA_INTENT (session=$sessionId)")
                    return
                }
                val fgActivity = host?.currentForegroundActivity()
                if (fgActivity != null && !fgActivity.isFinishing && !fgActivity.isDestroyed) {
                    runCatching {
                        fgActivity.startActivity(confirmIntent)
                    }.onFailure {
                        confirmIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        runCatching { context.startActivity(confirmIntent) }
                    }
                } else {
                    confirmIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    runCatching { context.startActivity(confirmIntent) }
                }
                host?.updater?.onInstallUserConfirmationLaunched(sessionId)
            }

            PackageInstaller.STATUS_SUCCESS -> {
                Log.i(TAG, "APK update session $sessionId succeeded")
                host?.updater?.onInstallCompleted(success = true, aborted = false, message = null)
            }

            PackageInstaller.STATUS_FAILURE_ABORTED -> {
                Log.i(TAG, "APK update session $sessionId cancelled by user")
                host?.updater?.onInstallCompleted(success = false, aborted = true, message = message)
            }

            else -> {
                Log.w(TAG, "APK update session $sessionId failed ($status): $message")
                host?.updater?.onInstallCompleted(success = false, aborted = false, message = message)
                val zh = HostStrings.isChinese(context)
                val text = if (zh) {
                    "更新安装未完成${if (message.isNotBlank()) "：$message" else ""}"
                } else {
                    "Update installation failed${if (message.isNotBlank()) ": $message" else ""}"
                }
                Toast.makeText(context.applicationContext, text, Toast.LENGTH_LONG).show()
            }
        }
    }

    companion object {
        private const val TAG = "KikiUpdater"
    }
}
