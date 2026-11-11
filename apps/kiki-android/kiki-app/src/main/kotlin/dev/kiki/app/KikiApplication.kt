package dev.kiki.app

import android.app.Application
import dev.kiki.android.host.KikiHost
import dev.kiki.android.host.KikiHostConfig
import dev.kiki.android.tools.screen.ScreenToolsModule
import dev.kiki.android.host.tools.SystemToolsModule

class KikiApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        KikiHost.install(
            appContext = this,
            config = KikiHostConfig(
                versionName = BuildConfig.VERSION_NAME,
                gitHash = BuildConfig.GIT_HASH,
                modules = listOf(
                    SystemToolsModule(),
                    ScreenToolsModule(),
                ),
            ),
        )
    }
}
