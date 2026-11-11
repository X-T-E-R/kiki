package dev.kiki.android.host

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import android.os.StatFs
import android.util.Log
import dev.kiki.android.runtime.InstalledKikiRuntime
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.File
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.time.ZoneId
import java.util.Base64
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

sealed interface KernelState {
    data object Idle : KernelState
    data class Starting(val attempt: Int) : KernelState
    data class Ready(
        val port: Int,
        val pid: Int,
        val version: String,
        val guiPath: String,
        val localOwnerToken: String,
        val gatewayPort: Int,
    ) : KernelState {
        val origin: String get() = "http://127.0.0.1:$port"
        val guiUrl: String get() = "$origin$guiPath"
    }
    data class BackingOff(val attempt: Int, val nextRetryMs: Long, val lastError: String) : KernelState
    data class CircuitBroken(val reason: String) : KernelState
    data object Stopped : KernelState
}

@Serializable
private data class LastReadyRecord(
    val port: Int,
    val pid: Int,
    val version: String,
    val guiPath: String,
    val updatedAtMs: Long,
)

class NodeSupervisor(
    private val appContext: Context,
    private val host: KikiHostEnvironment,
    private val onTurnsChanged: (KernelOutboundFrame.Turns) -> Unit = {},
    private val onAttention: (KernelOutboundFrame.Attention) -> Unit = {},
    private val onReady: (KernelState.Ready) -> Unit = {},
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val json = Json { ignoreUnknownKeys = true; prettyPrint = false }
    private val secureRandom = SecureRandom()
    private val pingSeq = AtomicLong(0L)

    private val _state = MutableStateFlow<KernelState>(KernelState.Idle)
    val state: StateFlow<KernelState> = _state.asStateFlow()

    @Volatile
    var currentSecretToken: String = randomToken32()
        private set

    @Volatile
    var currentMcpToken: String = randomToken32()
        private set

    @Volatile
    var currentLocalOwnerToken: String = randomToken32()
        private set

    @Volatile
    private var activeProcess: Process? = null

    @Volatile
    private var activeStdin: BufferedWriter? = null

    @Volatile
    private var activePid: Int = 0

    @Volatile
    private var lastPongSeq: Long = 0L

    private var supervisorJob: Job? = null

    fun rotateTokens() {
        currentSecretToken = randomToken32()
        currentMcpToken = randomToken32()
        currentLocalOwnerToken = randomToken32()
    }

    fun start(
        runtimeProvider: suspend () -> InstalledKikiRuntime,
        gatewayPortProvider: () -> Int,
    ) {
        if (supervisorJob?.isActive == true) return
        supervisorJob = scope.launch {
            runLoop(runtimeProvider, gatewayPortProvider)
        }
    }

    fun sendStdinFrame(jsonLine: String) {
        val writer = activeStdin ?: return
        DAEMON_LAUNCHER_THREAD.execute {
            runCatching {
                synchronized(writer) {
                    writer.write(jsonLine)
                    writer.write("\n")
                    writer.flush()
                }
            }
        }
    }

    fun sendNetworkHint(available: Boolean, metered: Boolean) {
        sendStdinFrame(ControlProtocol.encodeNetwork(available, metered))
    }

    fun sendTrimMemory(level: Int) {
        sendStdinFrame(ControlProtocol.encodeTrimMemory(level))
    }

    fun cancelActiveTurns(reason: String = "user_pill_stop") {
        sendStdinFrame(ControlProtocol.encodeCancelActiveTurns(reason))
    }

    suspend fun stop(graceMs: Long = 3_500L) {
        val job = supervisorJob
        supervisorJob = null
        sendStdinFrame(ControlProtocol.encodeShutdown(graceMs))
        val proc = activeProcess
        val pid = activePid
        if (proc != null) {
            val exitedGracefully = withTimeoutOrNull(graceMs) {
                while (proc.isAlive) {
                    delay(80L)
                }
                true
            } ?: false
            if (!exitedGracefully) {
                if (pid > 0) {
                    runCatching { android.os.Process.sendSignal(pid, 15) }
                } else {
                    runCatching { proc.destroy() }
                }
                val exitedTerm = withTimeoutOrNull(2_000L) {
                    while (proc.isAlive) {
                        delay(80L)
                    }
                    true
                } ?: false
                if (!exitedTerm) {
                    if (pid > 0) {
                        runCatching { android.os.Process.sendSignal(pid, 9) }
                    }
                    runCatching { proc.destroyForcibly() }
                }
            }
        }
        job?.cancelAndJoin()
        activeProcess = null
        activeStdin = null
        activePid = 0
        _state.value = KernelState.Stopped
    }

    private suspend fun runLoop(
        runtimeProvider: suspend () -> InstalledKikiRuntime,
        gatewayPortProvider: () -> Int,
    ) {
        val failureTimestamps = ArrayDeque<Long>()
        var attempt = 0

        while (scope.isActive) {
            attempt++
            _state.value = KernelState.Starting(attempt)
            try {
                val runtime = runtimeProvider()
                cleanupStaleLockProcess(runtime.runDir)
                ensureFreeSpaceOrThrow(runtime.homeDir)
                rotateTokens()

                val gatewayPort = gatewayPortProvider()
                val preferredPort = getOrCreateStickyPort()
                val caPem = exportSystemCaBundle(File(runtime.runDir, "android-ca-bundle.pem"))
                val crashLog = File(runtime.runDir, "crash/kernel-stderr.log").apply { parentFile?.mkdirs() }

                val bootstrap = BootstrapFrame(
                    localOwnerToken = currentLocalOwnerToken,
                    preferredPort = preferredPort,
                    gateway = BootstrapGatewaySpec(
                        url = "http://127.0.0.1:$gatewayPort",
                        mcpUrl = "http://127.0.0.1:$gatewayPort/mcp",
                        secretToken = currentSecretToken,
                        mcpToken = currentMcpToken,
                    ),
                    device = buildDeviceSpec(),
                )

                val readyDeferred = CompletableDeferred<KernelOutboundFrame.Ready>()
                val spawned = spawnOnLauncherThread(runtime, gatewayPort, caPem, bootstrap)
                activeProcess = spawned.process
                activeStdin = spawned.stdin

                val stdoutJob = scope.launch {
                    readStdoutLoop(spawned.stdout, runtime, gatewayPort, readyDeferred)
                }
                val stderrJob = scope.launch {
                    readStderrLoop(spawned.stderr, crashLog)
                }

                val readyFrame = withTimeoutOrNull(45_000L) {
                    readyDeferred.await()
                }
                if (readyFrame == null) {
                    runCatching { spawned.process.destroyForcibly() }
                    stdoutJob.cancelAndJoin()
                    stderrJob.cancelAndJoin()
                    val tail = tailFile(crashLog, 1_200)
                    throw IllegalStateException("Kernel ready timeout (45s). stderr: $tail")
                }

                attempt = 0
                val heartbeatJob = scope.launch {
                    heartbeatLoop(spawned.process)
                }

                val exitCode = spawned.process.waitFor()
                heartbeatJob.cancelAndJoin()
                stdoutJob.cancelAndJoin()
                stderrJob.cancelAndJoin()
                onTurnsChanged(KernelOutboundFrame.Turns(active = 0, executing = false))

                if (!scope.isActive) break
                val tail = tailFile(crashLog, 800)
                Log.w(TAG, "Kernel exited with code=$exitCode tail=$tail")
                recordFailureAndMaybeTrip(failureTimestamps, "Kernel exited (code=$exitCode): $tail")?.let { broken ->
                    _state.value = broken
                    return
                }
            } catch (t: Throwable) {
                if (!scope.isActive) break
                Log.e(TAG, "Kernel launch failure", t)
                recordFailureAndMaybeTrip(failureTimestamps, t.message ?: t.javaClass.simpleName)?.let { broken ->
                    _state.value = broken
                    return
                }
            }

            val backoffMs = (1_000L shl (attempt - 1).coerceAtMost(5)).coerceAtMost(60_000L)
            _state.value = KernelState.BackingOff(
                attempt = attempt,
                nextRetryMs = backoffMs,
                lastError = (_state.value as? KernelState.BackingOff)?.lastError ?: "restarting",
            )
            delay(backoffMs)
        }
    }

    private fun recordFailureAndMaybeTrip(
        window: ArrayDeque<Long>,
        reason: String,
    ): KernelState.CircuitBroken? {
        val now = System.currentTimeMillis()
        window.addLast(now)
        while (window.isNotEmpty() && now - window.first() > 10 * 60_000L) {
            window.removeFirst()
        }
        return if (window.size >= 5) {
            KernelState.CircuitBroken("Kernel crashed 5 times within 10 minutes: $reason")
        } else {
            null
        }
    }

    private data class SpawnedKernel(
        val process: Process,
        val stdin: BufferedWriter,
        val stdout: BufferedReader,
        val stderr: BufferedReader,
    )

    private fun spawnOnLauncherThread(
        runtime: InstalledKikiRuntime,
        gatewayPort: Int,
        caPemFile: File?,
        bootstrap: BootstrapFrame,
    ): SpawnedKernel {
        val future = DAEMON_LAUNCHER_THREAD.submit<SpawnedKernel> {
            check(runtime.nodeBinary.isFile) {
                "libkiki_node.so not found at ${runtime.nodeBinary.absolutePath}"
            }
            val heapMb = selectOldSpaceMb()
            val selinuxLinkShim = writeSelinuxLinkShim(File(runtime.runDir, "android-selinux-fs-shim.cjs"))
            val workspace = host.workspaceDir.apply { mkdirs() }
            val pb = ProcessBuilder(
                runtime.nodeBinary.absolutePath,
                "--max-old-space-size=$heapMb",
                "--require",
                selinuxLinkShim.absolutePath,
                runtime.entryMjs.absolutePath,
            ).directory(workspace)

            val env = pb.environment()
            env.clear()
            env["LD_LIBRARY_PATH"] = runtime.nativeLibraryDir.absolutePath
            env["KIKI_HOME"] = runtime.homeDir.absolutePath
            env["HOME"] = runtime.homeDir.absolutePath
            env["TMPDIR"] = runtime.tmpDir.absolutePath
            env["NODE_COMPILE_CACHE"] = runtime.compileCacheDir.absolutePath
            env["PATH"] = "/system/bin:/system/xbin"
            env["SHELL"] = "/system/bin/sh"
            System.getenv("ANDROID_ROOT")?.let { env["ANDROID_ROOT"] = it }
            System.getenv("ANDROID_DATA")?.let { env["ANDROID_DATA"] = it }
            env["LANG"] = "C.UTF-8"
            env["TZ"] = runCatching { ZoneId.systemDefault().id }.getOrDefault("UTC")
            env["KIKI_PLATFORM"] = "android"
            env["KIKI_PTY"] = "off"
            env["KIKI_SUBRUNTIME_MODE"] = "worker"
            env["KIKI_ANDROID_BOOTSTRAP_STDIN"] = "1"
            env["KIKI_SECRET_BACKEND"] = "android-broker"
            env["KIKI_SECRET_BROKER_URL"] = "http://127.0.0.1:$gatewayPort"
            env["KIKI_SECRET_BROKER_TOKEN"] = bootstrap.gateway.secretToken
            env["KIKI_ANDROID_MCP_URL"] = "http://127.0.0.1:$gatewayPort/mcp"
            env["KIKI_ANDROID_MCP_TOKEN"] = bootstrap.gateway.mcpToken
            env["KIKI_WORKSPACE_DIR"] = workspace.absolutePath
            if (caPemFile != null && caPemFile.isFile) {
                env["NODE_EXTRA_CA_CERTS"] = caPemFile.absolutePath
            }
            host.proxyUrl()?.takeIf { it.isNotBlank() }?.let { proxy ->
                env["HTTP_PROXY"] = proxy
                env["HTTPS_PROXY"] = proxy
                env["NO_PROXY"] = "127.0.0.1,localhost,::1,10.0.2.2"
                env["NODE_USE_ENV_PROXY"] = "1"
            }

            val process = pb.start()
            val stdin = BufferedWriter(OutputStreamWriter(process.outputStream, StandardCharsets.UTF_8))
            val stdout = BufferedReader(InputStreamReader(process.inputStream, StandardCharsets.UTF_8))
            val stderr = BufferedReader(InputStreamReader(process.errorStream, StandardCharsets.UTF_8))

            synchronized(stdin) {
                stdin.write(ControlProtocol.encodeBootstrap(bootstrap))
                stdin.write("\n")
                stdin.flush()
            }
            SpawnedKernel(process, stdin, stdout, stderr)
        }
        return future.get()
    }

    private fun readStdoutLoop(
        stdout: BufferedReader,
        runtime: InstalledKikiRuntime,
        gatewayPort: Int,
        readyDeferred: CompletableDeferred<KernelOutboundFrame.Ready>,
    ) {
        runCatching {
            while (true) {
                val line = stdout.readLine() ?: break
                val frame = ControlProtocol.parseStdoutLine(line)
                if (frame == null) {
                    Log.d(TAG, "[kernel:stdout] $line")
                    continue
                }
                when (frame) {
                    is KernelOutboundFrame.Ready -> {
                        activePid = frame.pid
                        writeLockAndReadyFiles(runtime.runDir, frame)
                        val readyState = KernelState.Ready(
                            port = frame.port,
                            pid = frame.pid,
                            version = frame.version,
                            guiPath = frame.guiPath,
                            localOwnerToken = currentLocalOwnerToken,
                            gatewayPort = gatewayPort,
                        )
                        _state.value = readyState
                        readyDeferred.complete(frame)
                        onReady(readyState)
                    }

                    is KernelOutboundFrame.Turns -> onTurnsChanged(frame)
                    is KernelOutboundFrame.Attention -> onAttention(frame)
                    is KernelOutboundFrame.Pong -> lastPongSeq = frame.seq
                    is KernelOutboundFrame.Recovered -> {
                        if (frame.count > 0) {
                            onAttention(
                                KernelOutboundFrame.Attention(
                                    kind = "recovered",
                                    sessionId = "",
                                    title = "${frame.count} 个未完成轮次已恢复为待确认状态",
                                ),
                            )
                        }
                    }

                    is KernelOutboundFrame.Fatal -> {
                        Log.e(TAG, "Kernel reported fatal [${frame.code}]: ${frame.message}")
                    }
                }
            }
        }
    }

    private fun readStderrLoop(stderr: BufferedReader, crashLog: File) {
        val ring = ArrayDeque<String>(200)
        runCatching {
            while (true) {
                val line = stderr.readLine() ?: break
                Log.i(TAG, "[kernel] $line")
                if (ring.size >= 200) ring.removeFirst()
                ring.addLast(line)
                if (ring.size % 10 == 0 || line.contains("Error", ignoreCase = true)) {
                    runCatching { crashLog.writeText(ring.joinToString("\n") + "\n", StandardCharsets.UTF_8) }
                }
            }
        }
        if (ring.isNotEmpty()) {
            runCatching { crashLog.writeText(ring.joinToString("\n") + "\n", StandardCharsets.UTF_8) }
        }
    }

    private suspend fun heartbeatLoop(process: Process) {
        var missed = 0
        while (scope.isActive && process.isAlive) {
            delay(15_000L)
            if (!process.isAlive) break
            val seq = pingSeq.incrementAndGet()
            sendStdinFrame(ControlProtocol.encodePing(seq))
            delay(4_000L)
            if (lastPongSeq >= seq) {
                missed = 0
            } else {
                missed++
                if (missed >= 3) {
                    Log.w(TAG, "Kernel missed 3 consecutive heartbeats; terminating")
                    runCatching { process.destroyForcibly() }
                    break
                }
            }
        }
    }

    private fun cleanupStaleLockProcess(runDir: File) {
        val lockFile = File(runDir, "kernel.lock")
        if (!lockFile.isFile) return
        val oldPid = lockFile.readText().trim().toIntOrNull() ?: return
        if (oldPid <= 0 || oldPid == android.os.Process.myPid()) return
        val cmdline = runCatching {
            File("/proc/$oldPid/cmdline").readBytes().toString(StandardCharsets.UTF_8)
        }.getOrNull().orEmpty()
        if (cmdline.contains("libkiki_node.so")) {
            Log.w(TAG, "Killing stale libkiki_node.so process pid=$oldPid")
            runCatching { android.os.Process.sendSignal(oldPid, 15) }
            Thread.sleep(500L)
            val stillThere = File("/proc/$oldPid/cmdline").exists()
            if (stillThere) {
                runCatching { android.os.Process.sendSignal(oldPid, 9) }
            }
        }
        runCatching { lockFile.delete() }
    }

    private fun writeLockAndReadyFiles(runDir: File, ready: KernelOutboundFrame.Ready) {
        runDir.mkdirs()
        if (ready.pid > 0) {
            File(runDir, "kernel.lock").writeText(ready.pid.toString(), StandardCharsets.UTF_8)
        }
        val rec = LastReadyRecord(
            port = ready.port,
            pid = ready.pid,
            version = ready.version,
            guiPath = ready.guiPath,
            updatedAtMs = System.currentTimeMillis(),
        )
        File(runDir, "last-ready.json").writeText(
            json.encodeToString(LastReadyRecord.serializer(), rec),
            StandardCharsets.UTF_8,
        )
    }

    private fun ensureFreeSpaceOrThrow(dir: File) {
        dir.mkdirs()
        val stat = StatFs(dir.absolutePath)
        val availMb = stat.availableBytes / (1024L * 1024L)
        if (availMb < 120L) {
            throw IllegalStateException("Insufficient internal storage (${availMb}MB < 120MB)")
        }
    }

    private fun getOrCreateStickyPort(): Int {
        val prefs = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val saved = prefs.getInt(KEY_STICKY_PORT, 0)
        if (saved in 40_000..48_999) return saved
        val chosen = 40_000 + secureRandom.nextInt(9_000)
        prefs.edit().putInt(KEY_STICKY_PORT, chosen).apply()
        return chosen
    }

    private fun selectOldSpaceMb(): Int {
        val am = appContext.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return 768
        val info = ActivityManager.MemoryInfo()
        am.getMemoryInfo(info)
        val totalGb = info.totalMem / (1024L * 1024L * 1024L)
        return when {
            totalGb >= 8L -> 1024
            totalGb >= 4L -> 768
            else -> 640
        }
    }

    private fun buildDeviceSpec(): BootstrapDeviceSpec {
        val sb = host.sandboxSpec()
        val abi = Build.SUPPORTED_ABIS.firstOrNull() ?: "arm64-v8a"
        return BootstrapDeviceSpec(
            abi = abi,
            sdk = Build.VERSION.SDK_INT,
            sandbox = sb.available,
            workspaceDir = sb.workspacePath ?: host.workspaceDir.absolutePath,
            rootfsDir = sb.rootfsPath,
        )
    }

    private fun exportSystemCaBundle(dest: File): File? = runCatching {
        val ks = KeyStore.getInstance("AndroidCAStore").apply { load(null) }
        val sb = StringBuilder()
        val aliases = ks.aliases()
        val enc = Base64.getMimeEncoder(64, "\n".toByteArray(StandardCharsets.US_ASCII))
        while (aliases.hasMoreElements()) {
            val alias = aliases.nextElement()
            val cert = ks.getCertificate(alias) as? X509Certificate ?: continue
            sb.append("-----BEGIN CERTIFICATE-----\n")
            sb.append(enc.encodeToString(cert.encoded))
            sb.append("\n-----END CERTIFICATE-----\n")
        }
        if (sb.isEmpty()) return null
        dest.parentFile?.mkdirs()
        dest.writeText(sb.toString(), StandardCharsets.US_ASCII)
        dest
    }.getOrNull()

    private fun writeSelinuxLinkShim(dest: File): File {
        dest.parentFile?.mkdirs()
        dest.writeText(
            """
            'use strict';
            const fs = require('node:fs');
            const fsp = require('node:fs/promises');
            const mod = require('node:module');
            const origLink = fsp.link.bind(fsp);
            const origLinkSync = fs.linkSync.bind(fs);
            const origCbLink = fs.link.bind(fs);

            fsp.link = async function androidSelinuxLink(existingPath, newPath) {
              try {
                return await origLink(existingPath, newPath);
              } catch (err) {
                if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
                  return await fsp.copyFile(existingPath, newPath, fs.constants.COPYFILE_EXCL);
                }
                throw err;
              }
            };

            fs.linkSync = function androidSelinuxLinkSync(existingPath, newPath) {
              try {
                return origLinkSync(existingPath, newPath);
              } catch (err) {
                if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
                  return fs.copyFileSync(existingPath, newPath, fs.constants.COPYFILE_EXCL);
                }
                throw err;
              }
            };

            fs.link = function androidSelinuxLinkCb(existingPath, newPath, cb) {
              origCbLink(existingPath, newPath, (err) => {
                if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
                  fs.copyFile(existingPath, newPath, fs.constants.COPYFILE_EXCL, cb);
                  return;
                }
                cb(err);
              });
            };

            if (typeof mod.syncBuiltinESMExports === 'function') {
              mod.syncBuiltinESMExports();
            }
            """.trimIndent() + "\n",
            StandardCharsets.UTF_8,
        )
        return dest
    }

    private fun tailFile(file: File, maxChars: Int): String {
        if (!file.isFile) return ""
        val text = runCatching { file.readText(StandardCharsets.UTF_8) }.getOrDefault("")
        return if (text.length <= maxChars) text else text.takeLast(maxChars)
    }

    private fun randomToken32(): String {
        val bytes = ByteArray(32)
        secureRandom.nextBytes(bytes)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }

    companion object {
        private const val TAG = "KikiHost"
        private const val PREFS_NAME = "kiki_host_prefs"
        private const val KEY_STICKY_PORT = "sticky_port"

        /**
         * Dedicated immortal single-thread executor that spawns `libkiki_node.so`.
         * Never shuts down during process lifetime so Linux `PR_SET_PDEATHSIG` (bound to caller TID) never misfires.
         */
        private val DAEMON_LAUNCHER_THREAD = Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "kiki-daemon-launcher").apply {
                isDaemon = true
            }
        }
    }
}
