package dev.kiki.android.host

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import dev.kiki.android.host.share.ShareIntakeStore
import dev.kiki.android.host.tools.CompositeToolRegistry
import dev.kiki.android.host.tools.KikiToolModule
import dev.kiki.android.host.tools.ScreenControlPort
import dev.kiki.android.host.tools.SystemToolsModule
import dev.kiki.android.host.tools.ToolGate
import dev.kiki.android.host.ui.KikiHostSettingsActivity
import dev.kiki.android.host.updater.KikiApkUpdater
import java.io.File
import java.lang.ref.WeakReference
import java.util.ServiceLoader
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

data class KikiHostConfig(
    val versionName: String = "0.7.0",
    val versionCode: Long = 7000L,
    val gitHash: String = "dev",
    val distributionChannel: String = "official",
    val updaterFeedUrl: String = "https://github.com/X-T-E-R/kiki/releases/latest/download/android.json",
    val expectedSignerSha256: String = "",
    val modules: List<KikiToolModule> = emptyList(),
)

/**
 * Runtime environment owned by the Kiki Android host.
 * Replaces the legacy Mika ServiceLoader bindings with composable [KikiToolModule]s.
 */
class KikiHostEnvironment internal constructor(
    private val appContext: Context,
    val versionName: String,
    val versionCode: Long,
    val gitHash: String,
    val distributionChannel: String,
    val settings: KikiHostSettings,
    val workspaceDir: File,
    val shareIntakeStore: ShareIntakeStore,
    val updater: KikiApkUpdater,
    private val screenControlProvider: () -> ScreenControlPort?,
    private val activityProvider: () -> Activity?,
    private val toolRegistryFactory: (KikiHostEnvironment) -> CompositeToolRegistry,
) {
    private val mainHandler = Handler(Looper.getMainLooper())
    private var toolRegistryInitialized = false

    val toolRegistry: CompositeToolRegistry by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        toolRegistryInitialized = true
        toolRegistryFactory(this)
    }

    fun sandboxSpec(): SandboxDeviceSpec = SandboxDeviceSpec(
        available = false,
        rootfsPath = null,
        workspacePath = workspaceDir.absolutePath,
    )

    fun proxyUrl(): String? = settings.proxyUrl

    fun isAccessibilityEnabled(): Boolean =
        screenControlProvider()?.isAccessibilityEnabled() ?: false

    fun foregroundPackage(): String? {
        val fromA11y = screenControlProvider()?.foregroundPackage()
        if (fromA11y != null) return fromA11y
        return if (activityProvider() != null) appContext.packageName else null
    }

    fun currentForegroundActivity(): Activity? = activityProvider()

    fun isSplitScreenWithOtherAppVisible(): Boolean =
        screenControlProvider()?.isSplitScreenWithOtherAppVisible() ?: false

    fun accessibilityOverlayContext(): Context? =
        screenControlProvider()?.overlayContext()

    fun yieldSelfToBackground(): Boolean {
        val activity = activityProvider()
        var moved = false
        if (activity != null) {
            val latch = CountDownLatch(1)
            mainHandler.post {
                moved = runCatching { activity.moveTaskToBack(true) }.getOrDefault(false)
                latch.countDown()
            }
            runCatching { latch.await(800L, TimeUnit.MILLISECONDS) }
        }
        if (!moved) {
            moved = screenControlProvider()?.goHome() ?: false
        }
        return moved
    }

    fun openNativePhoneSettings(caller: Context) {
        val intent = Intent(caller, KikiHostSettingsActivity::class.java).apply {
            if (caller !is Activity) {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
        }
        runCatching { caller.startActivity(intent) }
    }

    fun isGateEnabled(gate: ToolGate): Boolean = when (gate) {
        ToolGate.NONE -> true
        ToolGate.WAKE_SCREEN -> settings.allowWakeUnlock
        ToolGate.CLIPBOARD_READ -> settings.allowClipboardRead
        ToolGate.CLIPBOARD_WRITE -> settings.allowClipboardWrite
    }

    fun close() {
        if (toolRegistryInitialized) {
            toolRegistry.close()
        }
    }
}

object KikiHost {

    @Volatile
    private var installedEnv: KikiHostEnvironment? = null

    @Volatile
    private var lifecycleRegistered = false

    @Volatile
    private var activeActivityRef: WeakReference<Activity>? = null

    /**
     * Installs the host configuration and registers activity lifecycle tracking.
     * Called from `KikiApplication.onCreate()`; idempotent if invoked again.
     */
    fun install(appContext: Context, config: KikiHostConfig = KikiHostConfig()): KikiHostEnvironment {
        synchronized(this) {
            installedEnv?.let { return it }
            val app = appContext.applicationContext
            ensureActivityTrackingLocked(app)
            val env = createEnvironment(app, config)
            installedEnv = env
            return env
        }
    }

    /**
     * Resolves the active [KikiHostEnvironment], falling back to built-in [SystemToolsModule]
     * plus any `META-INF/services/dev.kiki.android.host.tools.KikiToolModule` entries if [install]
     * has not yet been called.
     */
    fun resolve(context: Context): KikiHostEnvironment {
        installedEnv?.let { return it }
        synchronized(this) {
            installedEnv?.let { return it }
            val app = context.applicationContext
            ensureActivityTrackingLocked(app)
            val discovered = runCatching {
                ServiceLoader.load(KikiToolModule::class.java, KikiToolModule::class.java.classLoader).toList()
            }.getOrDefault(emptyList())
            val env = createEnvironment(app, KikiHostConfig(modules = discovered))
            installedEnv = env
            return env
        }
    }

    private fun ensureActivityTrackingLocked(appContext: Context) {
        if (lifecycleRegistered) return
        val app = appContext as? Application ?: return
        lifecycleRegistered = true
        app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityResumed(activity: Activity) {
                activeActivityRef = WeakReference(activity)
                installedEnv?.updater?.onActivityResumed(activity)
            }

            override fun onActivityPaused(activity: Activity) {
                if (activeActivityRef?.get() === activity) {
                    activeActivityRef = null
                }
            }

            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
            override fun onActivityStarted(activity: Activity) = Unit
            override fun onActivityStopped(activity: Activity) = Unit
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
            override fun onActivityDestroyed(activity: Activity) = Unit
        })
    }

    private fun createEnvironment(appContext: Context, config: KikiHostConfig): KikiHostEnvironment {
        val workspaceDir = File(appContext.filesDir, "kiki/workspace")
        val shareInboxDir = File(workspaceDir, "shared-inbox")
        val settings = KikiHostSettings(appContext)
        val shareStore = ShareIntakeStore(
            inboxRootDir = shareInboxDir,
            selfPackage = appContext.packageName,
        )

        val allModules = buildList {
            // Built-in native system tools always come first unless an explicit module with same id was supplied
            if (config.modules.none { it.id == "kiki.system" }) {
                add(SystemToolsModule())
            }
            addAll(config.modules)
        }.distinctBy { it.id }

        val screenControlLazy = lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
            allModules.firstNotNullOfOrNull { module ->
                runCatching { module.screenControl(appContext) }.getOrNull()
            }
        }

        val updater = KikiApkUpdater(
            appContext = appContext,
            settings = settings,
            currentVersionName = config.versionName,
            currentVersionCode = config.versionCode,
            distributionChannel = config.distributionChannel,
            defaultFeedUrl = config.updaterFeedUrl,
            expectedSignerSha256 = config.expectedSignerSha256,
        )

        return KikiHostEnvironment(
            appContext = appContext,
            versionName = config.versionName,
            versionCode = config.versionCode,
            gitHash = config.gitHash,
            distributionChannel = config.distributionChannel,
            settings = settings,
            workspaceDir = workspaceDir,
            shareIntakeStore = shareStore,
            updater = updater,
            screenControlProvider = { screenControlLazy.value },
            activityProvider = { activeActivityRef?.get() },
            toolRegistryFactory = { env ->
                workspaceDir.mkdirs()
                shareInboxDir.mkdirs()
                val providers = allModules.flatMap { module ->
                    runCatching { module.providers(appContext, env) }.getOrDefault(emptyList())
                }
                CompositeToolRegistry(providers)
            },
        )
    }
}
