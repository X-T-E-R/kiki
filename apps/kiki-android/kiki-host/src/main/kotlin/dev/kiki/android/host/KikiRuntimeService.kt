package dev.kiki.android.host

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import dev.kiki.android.host.gateway.HostGateway
import dev.kiki.android.host.gateway.KeystoreSecretBroker
import dev.kiki.android.host.gateway.KikiToolProxy
import dev.kiki.android.host.gateway.RegistryMcpBackendAdapter
import dev.kiki.android.host.i18n.HostStrings
import dev.kiki.android.host.net.PeerNetworkHints
import dev.kiki.android.host.screen.OverlayPill
import dev.kiki.android.host.screen.ScreenArbiter
import dev.kiki.android.host.ui.KikiWebActivity
import dev.kiki.android.runtime.RuntimeInstaller
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File

class KikiRuntimeService : Service() {

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private lateinit var host: KikiHostEnvironment
    private lateinit var installer: RuntimeInstaller
    private lateinit var secretBroker: KeystoreSecretBroker
    private lateinit var overlayPill: OverlayPill
    private lateinit var screenArbiter: ScreenArbiter
    private lateinit var toolProxy: KikiToolProxy
    private lateinit var hostGateway: HostGateway
    private lateinit var supervisor: NodeSupervisor
    private lateinit var networkHints: PeerNetworkHints

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureNotificationChannels()
        startInForeground(if (HostStrings.isChinese(this)) "正在启动 Kiki 内核" else "Starting Kiki kernel")

        val appCtx = applicationContext
        serviceScope.launch(Dispatchers.Default) {
            host = KikiHost.resolve(appCtx)
            installer = RuntimeInstaller(appCtx)
            secretBroker = KeystoreSecretBroker(
                vaultFile = File(installer.secureDir, "secrets.bin"),
            )

            overlayPill = OverlayPill(
                appContext = appCtx,
                accessibilityContextProvider = { host.accessibilityOverlayContext() },
                onPauseAndReturn = {
                    screenArbiter.onUserReturnedToKiki()
                    val launch = Intent(appCtx, KikiWebActivity::class.java).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                    }
                    runCatching { startActivity(launch) }
                },
                onResumeAutomation = {
                    screenArbiter.resumeFromUserOrNewTurn()
                },
                onStopActiveTurns = {
                    supervisor.cancelActiveTurns("user_pill_stop")
                    screenArbiter.release()
                },
            )

            screenArbiter = ScreenArbiter(
                selfPackage = appCtx.packageName,
                foregroundPackageProvider = { host.foregroundPackage() },
                isSplitScreenCoexisting = { host.isSplitScreenWithOtherAppVisible() },
                yieldSelfToBackground = { host.yieldSelfToBackground() },
                pill = overlayPill,
                isChineseProvider = { HostStrings.isChinese(appCtx) },
                roleClassifier = { name, argsJson -> host.toolRegistry.classify(name, argsJson) },
                auditLogFile = File(installer.runDir, "screen-audit.log"),
            )

            val mcpBackend = RegistryMcpBackendAdapter(
                host = host,
                attendedCheck = { isWebActivityResumed },
            )

            toolProxy = KikiToolProxy(
                backend = mcpBackend,
                arbiter = screenArbiter,
                serverVersion = host.versionName,
            )

            supervisor = NodeSupervisor(
                appContext = appCtx,
                host = host,
                onTurnsChanged = ::handleTurnsChanged,
                onAttention = ::handleAttention,
                onReady = ::handleReady,
            )

            hostGateway = HostGateway(
                secretTokenProvider = { supervisor.currentSecretToken },
                mcpTokenProvider = { supervisor.currentMcpToken },
                secretBroker = secretBroker,
                toolProxy = toolProxy,
                port = 0,
                onError = { err -> Log.w(TAG, "HostGateway error", err) },
            )

            networkHints = PeerNetworkHints(appCtx) { available, metered ->
                supervisor.sendNetworkHint(available, metered)
            }
            networkHints.register()

            instanceRef = this@KikiRuntimeService

            launch(Dispatchers.Main.immediate) {
                supervisor.state.collect { st ->
                    _kernelState.value = st
                    val zh = HostStrings.isChinese(appCtx)
                    when (st) {
                        is KernelState.Starting -> updateForegroundNotification(
                            if (zh) "正在准备 Kiki 运行时" else "Preparing Kiki runtime",
                        )
                        is KernelState.Ready -> {
                            writeDebugGatewayState(st)
                            updateForegroundNotification(if (zh) "Kiki 运行中" else "Kiki running")
                        }
                        is KernelState.BackingOff -> updateForegroundNotification(
                            if (zh) "Kiki 正在重连内核" else "Reconnecting Kiki kernel",
                        )
                        is KernelState.CircuitBroken -> updateForegroundNotification(
                            if (zh) "Kiki 内核已暂停，点按打开查看" else "Kiki kernel paused — tap to open",
                        )
                        else -> Unit
                    }
                }
            }

            supervisor.start(
                runtimeProvider = {
                    val installed = installer.ensureReady()
                    installer.cleanupOldRuntimes(installed.runtimeDir)
                    installed
                },
                gatewayPortProvider = { hostGateway.port },
            )
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP_TURNS -> {
                if (::supervisor.isInitialized) supervisor.cancelActiveTurns("notification_stop")
                if (::screenArbiter.isInitialized) screenArbiter.release()
            }
            ACTION_RESUME_ARBITER -> {
                if (::screenArbiter.isInitialized) screenArbiter.resumeFromUserOrNewTurn()
            }
        }
        return START_STICKY
    }

    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        if (level >= ComponentCallbacks2.TRIM_MEMORY_BACKGROUND && ::supervisor.isInitialized) {
            supervisor.sendTrimMemory(level)
        }
    }

    override fun onDestroy() {
        instanceRef = null
        serviceScope.cancel()
        if (::networkHints.isInitialized) networkHints.unregister()
        if (::overlayPill.isInitialized) overlayPill.hide()
        releaseWakeLock()
        if (::supervisor.isInitialized) {
            runBlocking {
                runCatching { supervisor.stop(2_000L) }
            }
        }
        if (::hostGateway.isInitialized) runCatching { hostGateway.close() }
        super.onDestroy()
    }

    fun notifyWebActivityResumed() {
        isWebActivityResumed = true
        if (::screenArbiter.isInitialized) screenArbiter.onUserReturnedToKiki()
    }

    fun notifyWebActivityPaused() {
        isWebActivityResumed = false
        if (::screenArbiter.isInitialized) screenArbiter.onUserLeftKikiWhilePaused()
    }

    fun resumeScreenAutomation() {
        if (::screenArbiter.isInitialized) screenArbiter.resumeFromUserOrNewTurn()
    }

    private fun handleReady(ready: KernelState.Ready) {
        Log.i(TAG, "Kernel ready on 127.0.0.1:${ready.port} (gateway=127.0.0.1:${ready.gatewayPort}, pid=${ready.pid}, v=${ready.version})")
    }

    private var previousActiveTurns: Int = 0

    private fun handleTurnsChanged(turns: KernelOutboundFrame.Turns) {
        val zh = HostStrings.isChinese(this)
        if (turns.active > 0 || turns.executing) {
            if (previousActiveTurns == 0 && ::screenArbiter.isInitialized) {
                screenArbiter.resumeFromUserOrNewTurn()
            }
            previousActiveTurns = turns.active.coerceAtLeast(1)
            acquireOrRenewWakeLock()
            updateForegroundNotification(
                if (zh) "Kiki 正在执行 (${turns.active})" else "Kiki executing (${turns.active})",
            )
        } else {
            previousActiveTurns = 0
            releaseWakeLock()
            if (::screenArbiter.isInitialized) screenArbiter.onTurnsIdle()
            updateForegroundNotification(if (zh) "Kiki 运行中" else "Kiki running")
        }
    }

    private fun handleAttention(attention: KernelOutboundFrame.Attention) {
        if (isWebActivityResumed) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        val zh = HostStrings.isChinese(this)
        val openIntent = Intent(this, KikiWebActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            if (attention.sessionId.isNotEmpty()) {
                putExtra(EXTRA_SESSION_ROUTE, "/sessions/${attention.sessionId}")
            }
        }
        val pi = PendingIntent.getActivity(
            this,
            attention.sessionId.hashCode(),
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val title = if (zh) {
            when (attention.kind) {
                "approval" -> "等待确认"
                "error" -> "执行遇到问题"
                "done" -> "任务已完成"
                else -> "Kiki 提醒"
            }
        } else {
            when (attention.kind) {
                "approval" -> "Approval needed"
                "error" -> "Execution issue"
                "done" -> "Task completed"
                else -> "Kiki update"
            }
        }
        val n = Notification.Builder(this, ATTENTION_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(title)
            .setContentText(attention.title.ifBlank { if (zh) "点按返回 Kiki 查看" else "Tap to open Kiki" })
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build()
        nm.notify(ATTENTION_NOTIFICATION_BASE_ID + (attention.sessionId.hashCode() and 0xFF), n)
    }

    private fun writeDebugGatewayState(ready: KernelState.Ready) {
        val isDebuggable = (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
        if (!isDebuggable) return
        runCatching {
            val file = File(installer.runDir, "debug-endpoints.json")
            file.parentFile?.mkdirs()
            val payload = buildJsonObject {
                put("kernelPort", ready.port)
                put("kernelUrl", ready.guiUrl)
                put("localOwnerToken", ready.localOwnerToken)
                put("gatewayPort", ready.gatewayPort)
                put("mcpUrl", hostGateway.mcpUrl)
                put("mcpToken", supervisor.currentMcpToken)
                put("secretToken", supervisor.currentSecretToken)
                put("pid", ready.pid)
                put("version", ready.version)
            }
            file.writeText(payload.toString(), Charsets.UTF_8)
        }
    }

    private fun acquireOrRenewWakeLock() {
        val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
        val wl = wakeLock ?: pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "KikiHost::ActiveTurn").apply {
            setReferenceCounted(false)
            wakeLock = this
        }
        runCatching { wl.acquire(10 * 60_000L) }
    }

    private fun releaseWakeLock() {
        val wl = wakeLock ?: return
        if (wl.isHeld) {
            runCatching { wl.release() }
        }
    }

    private fun ensureNotificationChannels() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        val zh = HostStrings.isChinese(this)
        val runtimeChannel = NotificationChannel(
            RUNTIME_CHANNEL_ID,
            if (zh) "Kiki 运行服务" else "Kiki Runtime",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = if (zh) "保持本机 Kiki 内核在后台稳定运行" else "Keeps the local Kiki kernel active"
            setShowBadge(false)
        }
        val attentionChannel = NotificationChannel(
            ATTENTION_CHANNEL_ID,
            if (zh) "Kiki 会话通知" else "Kiki Session Alerts",
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = if (zh) "任务完成与操作确认提醒" else "Task completion and approval alerts"
        }
        nm.createNotificationChannel(runtimeChannel)
        nm.createNotificationChannel(attentionChannel)
    }

    private fun buildRuntimeNotification(text: String): Notification {
        val zh = HostStrings.isChinese(this)
        val openIntent = Intent(this, KikiWebActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        val openPi = PendingIntent.getActivity(
            this,
            1,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stopIntent = Intent(this, KikiRuntimeService::class.java).apply {
            action = ACTION_STOP_TURNS
        }
        val stopPi = PendingIntent.getService(
            this,
            2,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, RUNTIME_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
            .setContentTitle("Kiki")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(openPi)
            .addAction(Notification.Action.Builder(null, if (zh) "打开" else "Open", openPi).build())
            .addAction(Notification.Action.Builder(null, if (zh) "停止轮次" else "Stop", stopPi).build())
            .build()
    }

    private fun startInForeground(text: String) {
        val notification = buildRuntimeNotification(text)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                RUNTIME_NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
        } else {
            startForeground(RUNTIME_NOTIFICATION_ID, notification)
        }
    }

    private fun updateForegroundNotification(text: String) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        nm.notify(RUNTIME_NOTIFICATION_ID, buildRuntimeNotification(text))
    }

    companion object {
        private const val TAG = "KikiHost"
        private const val RUNTIME_CHANNEL_ID = "kiki_runtime_status"
        private const val ATTENTION_CHANNEL_ID = "kiki_attention"
        private const val RUNTIME_NOTIFICATION_ID = 4721
        private const val ATTENTION_NOTIFICATION_BASE_ID = 4800

        const val ACTION_STOP_TURNS = "dev.kiki.android.host.STOP_TURNS"
        const val ACTION_RESUME_ARBITER = "dev.kiki.android.host.RESUME_ARBITER"
        const val EXTRA_SESSION_ROUTE = "kiki.route"

        private val _kernelState = MutableStateFlow<KernelState>(KernelState.Idle)
        val kernelState: StateFlow<KernelState> = _kernelState.asStateFlow()

        @Volatile
        var instanceRef: KikiRuntimeService? = null
            private set

        @Volatile
        var isWebActivityResumed: Boolean = false
            private set

        fun ensureStarted(context: Context) {
            val appCtx = context.applicationContext
            val intent = Intent(appCtx, KikiRuntimeService::class.java)
            runCatching {
                appCtx.startForegroundService(intent)
            }.onFailure {
                runCatching { appCtx.startService(intent) }
            }
        }
    }
}
