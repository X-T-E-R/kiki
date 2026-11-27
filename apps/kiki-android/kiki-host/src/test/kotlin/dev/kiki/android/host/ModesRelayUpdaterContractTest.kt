package dev.kiki.android.host

import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import dev.kiki.android.host.remote.PeerStreamConnector
import dev.kiki.android.host.remote.PinnedWsTunnel
import dev.kiki.android.host.remote.RemotePeerShell
import dev.kiki.android.host.ui.QrBitmapDecoder
import dev.kiki.android.host.updater.AndroidUpdateFeed
import dev.kiki.android.host.updater.KikiApkUpdater
import org.junit.Test
import java.io.BufferedInputStream
import java.io.Closeable
import java.io.DataInputStream
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.Base64
import java.util.Collections
import java.util.concurrent.CopyOnWriteArrayList
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLPeerUnverifiedException
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class ModesRelayUpdaterContractTest {

    @Test
    fun hostMode_defaultsToUnselected_migratesLegacyLocalHome_andPersistsChoiceOnce() {
        val freshRoot = Files.createTempDirectory("kiki-mode-fresh-").toFile()
        try {
            val store = InMemoryHostSettingsStore()
            val settings = KikiHostSettings(store, freshRoot)
            assertEquals(HostMode.UNSELECTED, settings.hostMode)

            // Selecting REMOTE_ONLY persists immediately and never falls back to UNSELECTED
            settings.hostMode = HostMode.REMOTE_ONLY
            assertEquals(HostMode.REMOTE_ONLY, settings.hostMode)
            assertEquals(HostMode.REMOTE_ONLY, KikiHostSettings(store, freshRoot).hostMode)

            // Toggling to LOCAL_HOST and back to REMOTE_ONLY persists cleanly
            settings.hostMode = HostMode.LOCAL_HOST
            assertEquals(HostMode.LOCAL_HOST, KikiHostSettings(store, freshRoot).hostMode)
            settings.hostMode = HostMode.REMOTE_ONLY
            assertEquals(HostMode.REMOTE_ONLY, KikiHostSettings(store, freshRoot).hostMode)
        } finally {
            freshRoot.deleteRecursively()
        }

        // Upgrade migration: existing config.toml or sessions dir migrates to LOCAL_HOST
        val legacyRoot = Files.createTempDirectory("kiki-mode-legacy-").toFile()
        try {
            val configToml = File(legacyRoot, "home/config.toml").apply {
                parentFile?.mkdirs()
                writeText("model = \"default\"\n", StandardCharsets.UTF_8)
            }
            assertTrue(configToml.isFile)
            val legacyStore = InMemoryHostSettingsStore()
            val migratedSettings = KikiHostSettings(legacyStore, legacyRoot)
            assertEquals(HostMode.LOCAL_HOST, migratedSettings.hostMode)
            assertEquals("local_host", legacyStore.getString(KikiHostSettings.KEY_HOST_MODE, null))
        } finally {
            legacyRoot.deleteRecursively()
        }
    }

    @Test
    fun updaterFeed_andUpgradeVerification_enforcesSignerSha256SizeAndSnoozeSkipRules() {
        val signer = "79E871A8D58BF395F76FBEACCFA2CA55111391AFB7C1B5EBDD30C04F6E2F7ACA"
        val apkBytes = "verified-apk-payload-7001".toByteArray(StandardCharsets.UTF_8)
        val sha256 = MessageDigest.getInstance("SHA-256").digest(apkBytes)
            .joinToString("") { "%02X".format(it) }

        val rawJson = """
            {
              "schemaVersion": 1,
              "channel": "portal",
              "packageName": "dev.kiki.app",
              "versionName": "0.7.1",
              "versionCode": 7001,
              "apkUrl": "https://updates.example.test/kiki/updater/stable/kiki-0.7.1.apk",
              "sha256": "${sha256.lowercase()}",
              "sizeBytes": ${apkBytes.size},
              "signerCertSha256": "$signer",
              "publishedAt": "2026-11-27T08:00:00Z",
              "notes": "Faster remote mode and in-app updater"
            }
        """.trimIndent()

        val feed = KikiApkUpdater.parseFeedJson(rawJson)
        assertEquals(7001L, feed.versionCode)
        assertEquals(sha256, feed.sha256)
        assertEquals(signer, feed.signerCertSha256)

        val settings = KikiHostSettings(InMemoryHostSettingsStore())
        val now = 1_700_000_000_000L
        assertTrue(KikiApkUpdater.shouldPromptAutoUpdate(feed, "dev.kiki.app", 7000L, settings, now))
        assertFalse(KikiApkUpdater.shouldPromptAutoUpdate(feed, "dev.kiki.app", 7001L, settings, now))

        // 24h Snooze suppresses auto-prompt until expiry
        settings.remindLaterUntilMs = now + KikiApkUpdater.SNOOZE_DURATION_MS
        assertFalse(KikiApkUpdater.shouldPromptAutoUpdate(feed, "dev.kiki.app", 7000L, settings, now + 60_000L))
        assertTrue(KikiApkUpdater.shouldPromptAutoUpdate(feed, "dev.kiki.app", 7000L, settings, now + KikiApkUpdater.SNOOZE_DURATION_MS))

        // Skip version suppresses that exact versionCode, but prompts on 7002
        settings.remindLaterUntilMs = 0L
        settings.skippedVersionCode = 7001L
        assertFalse(KikiApkUpdater.shouldPromptAutoUpdate(feed, "dev.kiki.app", 7000L, settings, now))
        assertTrue(KikiApkUpdater.shouldPromptAutoUpdate(feed.copy(versionCode = 7002L), "dev.kiki.app", 7000L, settings, now))

        // Cryptographic upgrade contract passes when all signers & versions match
        KikiApkUpdater.verifyUpgradeContract(
            expectedPackageName = "dev.kiki.app",
            currentVersionCode = 7000L,
            installedSignerSha256 = signer,
            pinnedSignerSha256 = signer,
            feed = feed,
            archivePackageName = "dev.kiki.app",
            archiveVersionCode = 7001L,
            archiveSignerSha256 = signer,
        )

        // Rejects downgrade
        assertFailsWith<SecurityException> {
            KikiApkUpdater.verifyUpgradeContract(
                expectedPackageName = "dev.kiki.app",
                currentVersionCode = 7001L,
                installedSignerSha256 = signer,
                pinnedSignerSha256 = signer,
                feed = feed,
                archivePackageName = "dev.kiki.app",
                archiveVersionCode = 7001L,
                archiveSignerSha256 = signer,
            )
        }

        // Rejects wrong signing certificate
        val attackerSigner = "A".repeat(64)
        assertFailsWith<SecurityException> {
            KikiApkUpdater.verifyUpgradeContract(
                expectedPackageName = "dev.kiki.app",
                currentVersionCode = 7000L,
                installedSignerSha256 = signer,
                pinnedSignerSha256 = signer,
                feed = feed.copy(signerCertSha256 = attackerSigner),
                archivePackageName = "dev.kiki.app",
                archiveVersionCode = 7001L,
                archiveSignerSha256 = attackerSigner,
            )
        }

        // Rejects non-HTTPS non-loopback feed URL
        assertFailsWith<IllegalArgumentException> {
            KikiHostSettings.normalizeUpdaterFeedUrl("http://example.com/android.json")
        }
        assertEquals(
            "http://127.0.0.1:18999/android.json",
            KikiHostSettings.normalizeUpdaterFeedUrl("http://127.0.0.1:18999/android.json"),
        )
    }

    @Test
    fun qrBitmapDecoder_decodesNormalAndInvertedPairingCodes() {
        val pairUri = "kiki://pair?endpoint=https%3A%2F%2F192.168.1.20%3A19410&relay=wss%3A%2F%2Frelay.example.com%2Fv1%2Fstream%3Ftarget%3D${"ab".repeat(32)}%26rt%3Dp.tok&code=PAIR123&fp=${"ab".repeat(32)}"
        val matrix = QRCodeWriter().encode(pairUri, BarcodeFormat.QR_CODE, 256, 256)
        val w = matrix.width
        val h = matrix.height
        val normalArgb = IntArray(w * h)
        val invertedY = ByteArray(w * h)
        for (y in 0 until h) {
            for (x in 0 until w) {
                val black = matrix.get(x, y)
                normalArgb[y * w + x] = if (black) 0xFF000000.toInt() else 0xFFFFFFFF.toInt()
                invertedY[y * w + x] = if (black) 240.toByte() else 16.toByte()
            }
        }
        assertEquals(pairUri, QrBitmapDecoder.decodeArgbPixels(normalArgb, w, h))
        assertEquals(pairUri, QrBitmapDecoder.decodeYuvLuminance(invertedY, w, h))
    }

    @Test
    fun kikiRelayV1_happyEyeballs_verifiesSubprotocolNoDeflateAndInnerTlsSpkiPin() {
        val tlsFixture = EphemeralTlsPeerServer.start()
        val relayServer = MockRelayWsServer.start(tlsFixture.port)
        val deadPortServer = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
        val deadPort = deadPortServer.localPort
        deadPortServer.close()

        try {
            val relayUrl = "ws://127.0.0.1:${relayServer.port}/v1/stream?target=${tlsFixture.spkiFpHex}&rt=g.persistent_ticket"
            val trustAllClientFactory = trustAllSslSocketFactory()

            // 1. Missing fp MUST reject relay connection
            assertFailsWith<SSLPeerUnverifiedException> {
                PeerStreamConnector.connectHappyEyeballs(
                    directOrigins = emptyList(),
                    relayEndpoints = listOf(relayUrl),
                    pinnedFp = null,
                    sslSocketFactory = trustAllClientFactory,
                    peerCertCheck = null,
                    connectTimeoutMs = 3_000,
                    readTimeoutMs = 3_000,
                )
            }

            // 2. Wrong fp MUST reject inner TLS handshake with SSLPeerUnverifiedException
            val wrongFp = "0".repeat(64)
            assertFailsWith<SSLPeerUnverifiedException> {
                PeerStreamConnector.connectHappyEyeballs(
                    directOrigins = emptyList(),
                    relayEndpoints = listOf(relayUrl),
                    pinnedFp = wrongFp,
                    sslSocketFactory = trustAllClientFactory,
                    peerCertCheck = { cert -> RemotePeerShell.certificateMatchesSpkiPin(cert, wrongFp) },
                    connectTimeoutMs = 3_000,
                    readTimeoutMs = 3_000,
                )
            }

            // 3. Dead direct endpoint (0ms) + dead Home relay (+300ms) -> Standby relay (+600ms) wins & passes SPKI pin!
            val deadRelayUrl = "ws://127.0.0.1:$deadPort/v1/stream?target=${tlsFixture.spkiFpHex}&rt=g.dead"
            PeerStreamConnector.connectHappyEyeballs(
                directOrigins = listOf("https://127.0.0.1:$deadPort"),
                relayEndpoints = listOf(deadRelayUrl, relayUrl),
                pinnedFp = tlsFixture.spkiFpHex,
                sslSocketFactory = trustAllClientFactory,
                peerCertCheck = { cert -> RemotePeerShell.certificateMatchesSpkiPin(cert, tlsFixture.spkiFpHex) },
                connectTimeoutMs = 3_500,
                readTimeoutMs = 3_500,
            ).use { route ->
                assertTrue(route.viaRelay)
                assertEquals(relayUrl, route.relayUrl)
                val req = "GET /api/health HTTP/1.1\r\nHost: kiki.peer\r\nConnection: close\r\n\r\n"
                route.socket.getOutputStream().write(req.toByteArray(StandardCharsets.ISO_8859_1))
                route.socket.getOutputStream().flush()
                val resp = route.socket.getInputStream().readBytes().toString(StandardCharsets.UTF_8)
                assertTrue(resp.contains("HTTP/1.1 200 OK"), "Expected inner TLS HTTP 200 over relay, got: $resp")
                assertTrue(resp.contains("\"status\":\"ok\""), "Expected health payload over relay, got: $resp")
            }

            // Verify wire headers observed by relay server: Sec-WebSocket-Protocol == kiki-relay-v1 and NO deflate
            assertTrue(relayServer.observedHeaders.isNotEmpty())
            for (hdrs in relayServer.observedHeaders) {
                assertEquals("kiki-relay-v1", hdrs["sec-websocket-protocol"])
                assertEquals(null, hdrs["sec-websocket-extensions"], "permessage-deflate must be disabled")
            }

            // 4. PinnedWsTunnel over RelayHttpsLoopbackServer upgrades WebSocket end-to-end
            PeerStreamConnector.RelayHttpsLoopbackServer(listOf(relayUrl), 3_500).use { relayHttps ->
                PinnedWsTunnel(
                    upstreamOrigin = relayHttps.origin,
                    directOrigins = emptyList(),
                    relayEndpoints = listOf(relayUrl),
                    pinnedFp = tlsFixture.spkiFpHex,
                    sslSocketFactory = trustAllClientFactory,
                    peerCheck = { cert -> RemotePeerShell.certificateMatchesSpkiPin(cert, tlsFixture.spkiFpHex) },
                ).use { tunnel ->
                    val script = tunnel.interceptorScript()
                    assertTrue(script.contains("ws://127.0.0.1:"))
                    assertNotNull(script)
                }
            }
        } finally {
            relayServer.close()
            tlsFixture.close()
        }
    }

    private fun trustAllSslSocketFactory(): SSLSocketFactory {
        val tm = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        val ctx = SSLContext.getInstance("TLS")
        ctx.init(null, arrayOf<TrustManager>(tm), SecureRandom())
        return ctx.socketFactory
    }

    private class EphemeralTlsPeerServer private constructor(
        private val serverSocket: ServerSocket,
        val spkiFpHex: String,
    ) : Closeable {
        val port: Int get() = serverSocket.localPort

        @Volatile
        private var closed = false

        init {
            Thread(::acceptLoop, "test-tls-peer").apply {
                isDaemon = true
                start()
            }
        }

        private fun acceptLoop() {
            while (!closed) {
                val client = try {
                    serverSocket.accept() as SSLSocket
                } catch (_: IOException) {
                    return
                }
                Thread(
                    {
                        client.use { ssl ->
                            runCatching {
                                ssl.soTimeout = 3_000
                                ssl.startHandshake()
                                val inStream = BufferedInputStream(ssl.inputStream)
                                readHttpHeaders(inStream)
                                val body = """{"ok":true,"data":{"status":"ok","hostname":"Desk-PC"}}"""
                                val bodyBytes = body.toByteArray(StandardCharsets.UTF_8)
                                val resp = "HTTP/1.1 200 OK\r\n" +
                                    "Content-Type: application/json\r\n" +
                                    "Content-Length: ${bodyBytes.size}\r\n" +
                                    "Connection: close\r\n\r\n"
                                ssl.outputStream.write(resp.toByteArray(StandardCharsets.ISO_8859_1))
                                ssl.outputStream.write(bodyBytes)
                                ssl.outputStream.flush()
                            }
                        }
                    },
                    "test-tls-peer-conn",
                ).apply {
                    isDaemon = true
                    start()
                }
            }
        }

        override fun close() {
            closed = true
            runCatching { serverSocket.close() }
        }

        companion object {
            fun start(): EphemeralTlsPeerServer {
                val tempDir = Files.createTempDirectory("kiki-tls-test-").toFile()
                val ksFile = File(tempDir, "peer.p12")
                val password = "testpassword"
                try {
                    val javaHome = System.getProperty("java.home").orEmpty()
                    val isWin = System.getProperty("os.name").orEmpty().lowercase().contains("win")
                    val keytoolBin = File(javaHome, if (isWin) "bin/keytool.exe" else "bin/keytool")
                    val proc = ProcessBuilder(
                        keytoolBin.absolutePath,
                        "-genkeypair",
                        "-alias", "peer",
                        "-keyalg", "EC",
                        "-groupname", "secp256r1",
                        "-sigalg", "SHA256withECDSA",
                        "-dname", "CN=kiki.peer",
                        "-validity", "2",
                        "-storetype", "PKCS12",
                        "-keystore", ksFile.absolutePath,
                        "-storepass", password,
                        "-keypass", password,
                    ).redirectErrorStream(true).start()
                    val out = proc.inputStream.readBytes().toString(StandardCharsets.UTF_8)
                    check(proc.waitFor() == 0) { "keytool failed: $out" }

                    val ks = KeyStore.getInstance("PKCS12")
                    FileInputStream(ksFile).use { ks.load(it, password.toCharArray()) }
                    val cert = ks.getCertificate("peer") as X509Certificate
                    val fp = MessageDigest.getInstance("SHA-256").digest(cert.publicKey.encoded)
                        .joinToString("") { "%02x".format(it) }

                    val kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm())
                    kmf.init(ks, password.toCharArray())
                    val sslCtx = SSLContext.getInstance("TLS")
                    sslCtx.init(kmf.keyManagers, null, SecureRandom())
                    val sslServer = sslCtx.serverSocketFactory.createServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
                    return EphemeralTlsPeerServer(sslServer, fp)
                } finally {
                    tempDir.deleteRecursively()
                }
            }
        }
    }

    private class MockRelayWsServer private constructor(
        private val serverSocket: ServerSocket,
        private val targetPort: Int,
    ) : Closeable {
        val port: Int get() = serverSocket.localPort
        val observedHeaders: MutableList<Map<String, String>> = CopyOnWriteArrayList()

        @Volatile
        private var closed = false

        init {
            Thread(::acceptLoop, "test-mock-relay").apply {
                isDaemon = true
                start()
            }
        }

        private fun acceptLoop() {
            while (!closed) {
                val wsSock = try {
                    serverSocket.accept()
                } catch (_: IOException) {
                    return
                }
                Thread({ handleRelayClient(wsSock) }, "test-mock-relay-conn").apply {
                    isDaemon = true
                    start()
                }
            }
        }

        private fun handleRelayClient(wsSock: Socket) {
            var upstream: Socket? = null
            try {
                wsSock.tcpNoDelay = true
                val wsIn = BufferedInputStream(wsSock.getInputStream())
                val wsOut = wsSock.getOutputStream()
                val rawHead = readHttpHeaders(wsIn)
                val headers = LinkedHashMap<String, String>()
                rawHead.split("\r\n").drop(1).forEach { line ->
                    val idx = line.indexOf(':')
                    if (idx > 0) {
                        headers[line.substring(0, idx).trim().lowercase()] = line.substring(idx + 1).trim()
                    }
                }
                observedHeaders.add(Collections.unmodifiableMap(headers))

                val wsKey = headers["sec-websocket-key"] ?: return
                val acceptKey = Base64.getEncoder().encodeToString(
                    MessageDigest.getInstance("SHA-1")
                        .digest((wsKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray(StandardCharsets.ISO_8859_1)),
                )
                val resp = "HTTP/1.1 101 Switching Protocols\r\n" +
                    "Upgrade: websocket\r\n" +
                    "Connection: Upgrade\r\n" +
                    "Sec-WebSocket-Accept: $acceptKey\r\n" +
                    "Sec-WebSocket-Protocol: kiki-relay-v1\r\n\r\n"
                wsOut.write(resp.toByteArray(StandardCharsets.ISO_8859_1))
                wsOut.flush()

                upstream = Socket("127.0.0.1", targetPort).apply { tcpNoDelay = true }
                val upRef = upstream
                val downThread = Thread(
                    {
                        val buf = ByteArray(8192)
                        try {
                            val upIn = upRef.getInputStream()
                            while (true) {
                                val n = upIn.read(buf)
                                if (n < 0) {
                                    writeWsFrame(wsOut, 0x8, ByteArray(0), 0)
                                    break
                                }
                                if (n > 0) {
                                    writeWsFrame(wsOut, 0x2, buf, n)
                                }
                            }
                        } catch (_: IOException) {
                        }
                    },
                    "test-relay-down",
                ).apply {
                    isDaemon = true
                    start()
                }

                val dataIn = DataInputStream(wsIn)
                val upOut = upRef.getOutputStream()
                while (true) {
                    val b0 = dataIn.read()
                    if (b0 < 0) break
                    val opcode = b0 and 0x0F
                    val b1 = dataIn.readUnsignedByte()
                    val masked = (b1 and 0x80) != 0
                    var len = (b1 and 0x7F).toLong()
                    if (len == 126L) {
                        len = dataIn.readUnsignedShort().toLong()
                    } else if (len == 127L) {
                        len = dataIn.readLong()
                    }
                    val mask = ByteArray(4)
                    if (masked) dataIn.readFully(mask)
                    val payload = ByteArray(len.toInt())
                    dataIn.readFully(payload)
                    if (masked) {
                        for (i in payload.indices) {
                            payload[i] = (payload[i].toInt() xor mask[i % 4].toInt()).toByte()
                        }
                    }
                    when (opcode) {
                        0x2, 0x0 -> {
                            upOut.write(payload)
                            upOut.flush()
                        }
                        0x8 -> {
                            runCatching { upRef.shutdownOutput() }
                            break
                        }
                        0x9 -> writeWsFrame(wsOut, 0xA, payload, payload.size)
                    }
                }
                downThread.join(2_000L)
            } catch (_: IOException) {
            } finally {
                runCatching { upstream?.close() }
                runCatching { wsSock.close() }
            }
        }

        override fun close() {
            closed = true
            runCatching { serverSocket.close() }
        }

        companion object {
            fun start(targetPort: Int): MockRelayWsServer {
                val ss = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
                return MockRelayWsServer(ss, targetPort)
            }

            @Synchronized
            private fun writeWsFrame(out: OutputStream, opcode: Int, payload: ByteArray, len: Int) {
                out.write(0x80 or (opcode and 0x0F))
                if (len <= 125) {
                    out.write(len)
                } else if (len <= 65535) {
                    out.write(126)
                    out.write((len ushr 8) and 0xFF)
                    out.write(len and 0xFF)
                } else {
                    out.write(127)
                    val l = len.toLong()
                    for (shift in 56 downTo 0 step 8) {
                        out.write(((l ushr shift) and 0xFFL).toInt())
                    }
                }
                if (len > 0) out.write(payload, 0, len)
                out.flush()
            }
        }
    }

    companion object {
        private fun readHttpHeaders(input: InputStream): String {
            val raw = ByteArray(8192)
            var len = 0
            var state = 0
            while (len < raw.size) {
                val b = input.read()
                if (b < 0) break
                raw[len++] = b.toByte()
                state = when {
                    state == 0 && b == '\r'.code -> 1
                    state == 1 && b == '\n'.code -> 2
                    state == 2 && b == '\r'.code -> 3
                    state == 3 && b == '\n'.code -> return String(raw, 0, len, StandardCharsets.ISO_8859_1)
                    b == '\r'.code -> 1
                    else -> 0
                }
            }
            return String(raw, 0, len, StandardCharsets.ISO_8859_1)
        }
    }
}
