package dev.kiki.android.host.remote

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.io.Closeable
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URI
import java.security.cert.Certificate
import java.util.Collections
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.SSLPeerUnverifiedException
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

internal object PeerStreamConnector {
    const val RELAY_SUBPROTOCOL = "kiki-relay-v1"
    const val RELAY_STAGGER_MS = 300L
    private const val BUFFER_BYTES = 16 * 1024
    private const val MAX_WS_QUEUE_BYTES = 4L * 1024L * 1024L

    private val RELAY_WS_CLIENT: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .minWebSocketMessageToCompress(Long.MAX_VALUE)
        .followRedirects(false)
        .followSslRedirects(false)
        .addInterceptor { chain ->
            chain.proceed(
                chain.request()
                    .newBuilder()
                    .removeHeader("Sec-WebSocket-Extensions")
                    .build(),
            )
        }
        .build()

    class ConnectedRoute(
        val socket: Socket,
        val viaRelay: Boolean,
        val directOrigin: String?,
        val relayUrl: String?,
        val hostHeader: String,
    ) : Closeable {
        override fun close() {
            closeQuietly(socket)
        }
    }

    data class SelectedRoute(
        val viaRelay: Boolean,
        val directOrigin: String?,
        val relayUrl: String?,
    )

    class PinnedPeerSslSocketFactory(
        private val delegate: SSLSocketFactory,
        private val peerCheck: (Certificate) -> Boolean,
    ) : SSLSocketFactory() {

        override fun getDefaultCipherSuites(): Array<String> = delegate.defaultCipherSuites

        override fun getSupportedCipherSuites(): Array<String> = delegate.supportedCipherSuites

        @Throws(IOException::class)
        override fun createSocket(s: Socket, host: String?, port: Int, autoClose: Boolean): Socket =
            verifyHandshake(delegate.createSocket(s, "kiki.peer", 443, autoClose))

        @Throws(IOException::class)
        override fun createSocket(host: String, port: Int): Socket =
            verifyHandshake(delegate.createSocket(host, port))

        @Throws(IOException::class)
        override fun createSocket(host: String, port: Int, localHost: InetAddress, localPort: Int): Socket =
            verifyHandshake(delegate.createSocket(host, port, localHost, localPort))

        @Throws(IOException::class)
        override fun createSocket(host: InetAddress, port: Int): Socket =
            verifyHandshake(delegate.createSocket(host, port))

        @Throws(IOException::class)
        override fun createSocket(address: InetAddress, port: Int, localAddress: InetAddress, localPort: Int): Socket =
            verifyHandshake(delegate.createSocket(address, port, localAddress, localPort))

        @Throws(IOException::class)
        private fun verifyHandshake(raw: Socket): Socket {
            val ssl = raw as? SSLSocket ?: run {
                closeQuietly(raw)
                throw IOException("Expected SSLSocket")
            }
            return try {
                ssl.startHandshake()
                val certs = ssl.session.peerCertificates
                if (certs.isEmpty() || !peerCheck(certs[0])) {
                    throw SSLPeerUnverifiedException("Server TLS fingerprint mismatch.")
                }
                ssl
            } catch (e: IOException) {
                closeQuietly(ssl)
                throw e
            } catch (e: Exception) {
                closeQuietly(ssl)
                throw IOException("Pinned TLS verification failed", e)
            }
        }
    }

    class RelayHttpsLoopbackServer(
        private val relayEndpoints: List<String>,
        private val connectTimeoutMs: Int,
    ) : Closeable {
        private val server = ServerSocket(0, 32, InetAddress.getByName("127.0.0.1"))
        private val activeHandles: MutableSet<Closeable> = Collections.newSetFromMap(ConcurrentHashMap())

        @Volatile
        private var closed = false

        val origin: String
            get() = "https://127.0.0.1:${server.localPort}"

        init {
            require(relayEndpoints.isNotEmpty()) { "RelayHttpsLoopbackServer requires relayEndpoints" }
            Thread(::acceptLoop, "kiki-relay-https-loopback").apply {
                isDaemon = true
                start()
            }
        }

        private fun acceptLoop() {
            while (!closed) {
                val client = try {
                    server.accept()
                } catch (_: IOException) {
                    return
                }
                if (closed) {
                    closeQuietly(client)
                    return
                }
                Thread({ bridgeAcceptedClient(client) }, "kiki-relay-https-conn").apply {
                    isDaemon = true
                    start()
                }
            }
        }

        private fun bridgeAcceptedClient(client: Socket) {
            try {
                client.tcpNoDelay = true
                var bridged: Closeable? = null
                var lastErr: IOException? = null
                for (relayUrl in relayEndpoints) {
                    val normalized = normalizeRelayEndpoint(relayUrl) ?: continue
                    try {
                        bridged = attachSocketToRelayWebSocket(client, normalized, connectTimeoutMs)
                        break
                    } catch (e: IOException) {
                        lastErr = e
                    }
                }
                if (bridged == null) {
                    closeQuietly(client)
                    if (lastErr != null) throw lastErr
                    return
                }
                val handle = bridged
                activeHandles.add(handle)
                if (closed) {
                    activeHandles.remove(handle)
                    closeQuietly(handle)
                    closeQuietly(client)
                }
            } catch (_: IOException) {
                closeQuietly(client)
            }
        }

        override fun close() {
            closed = true
            closeQuietly(server)
            for (handle in activeHandles.toTypedArray()) {
                activeHandles.remove(handle)
                closeQuietly(handle)
            }
        }
    }

    fun isSyntheticRelayOrigin(rawOrigin: String?): Boolean {
        if (rawOrigin.isNullOrBlank()) return false
        return runCatching {
            val host = URI.create(rawOrigin.trim()).host?.lowercase(Locale.ROOT) ?: return false
            host == "kiki.peer" || host.endsWith(".kiki.peer")
        }.getOrDefault(false)
    }

    fun normalizeRelayEndpoint(raw: String?): String? {
        val trimmed = raw?.trim().orEmpty()
        if (trimmed.isEmpty()) return null
        return runCatching {
            val uri = URI.create(trimmed)
            val scheme = uri.scheme?.lowercase(Locale.ROOT).orEmpty()
            if (scheme != "wss" && scheme != "ws") return null
            if (uri.rawUserInfo != null || uri.rawFragment != null) return null
            val host = uri.host?.takeIf { it.isNotEmpty() } ?: return null
            val path = uri.rawPath?.takeIf { it.isNotEmpty() && !it.contains("//") && !it.contains("..") } ?: return null
            val cleanPath = if (path.endsWith("/") && path.length > 1) path.dropLast(1) else path
            val validStream = cleanPath == "/v1/stream" || cleanPath.endsWith("/v1/stream")
            val validConnect = cleanPath.contains("/v1/connect/") && !cleanPath.endsWith("/v1/connect")
            if (!validStream && !validConnect) return null
            val portPart = if (uri.port > 0) ":${uri.port}" else ""
            val renderedHost = if (host.contains(":") && !host.startsWith("[")) "[$host]" else host.lowercase(Locale.ROOT)
            val queryPart = uri.rawQuery?.takeIf { it.isNotEmpty() }?.let { "?$it" }.orEmpty()
            "$scheme://$renderedHost$portPart$cleanPath$queryPart"
        }.getOrNull()
    }

    @Throws(IOException::class)
    fun openRelayLoopbackSocket(relayUrl: String, connectTimeoutMs: Int): Socket {
        val normalized = normalizeRelayEndpoint(relayUrl) ?: throw IOException("Invalid relay endpoint")
        val loopback = InetAddress.getByName("127.0.0.1")
        val pairServer = ServerSocket(0, 1, loopback)
        val clientSide = Socket()
        val bridgeSideRef = AtomicReference<Socket?>()
        val acceptedLatch = CountDownLatch(1)
        Thread(
            {
                try {
                    val accepted = pairServer.accept()
                    accepted.tcpNoDelay = true
                    bridgeSideRef.set(accepted)
                } catch (_: IOException) {
                } finally {
                    closeQuietly(pairServer)
                    acceptedLatch.countDown()
                }
            },
            "kiki-relay-pair-accept",
        ).apply {
            isDaemon = true
            start()
        }

        try {
            clientSide.tcpNoDelay = true
            clientSide.connect(InetSocketAddress(loopback, pairServer.localPort), connectTimeoutMs)
            if (!acceptedLatch.await(connectTimeoutMs.toLong(), TimeUnit.MILLISECONDS) || bridgeSideRef.get() == null) {
                throw IOException("Loopback pair accept failed")
            }
            val bridgeSide = bridgeSideRef.get()!!
            attachSocketToRelayWebSocket(bridgeSide, normalized, connectTimeoutMs)
            return clientSide
        } catch (e: Exception) {
            closeQuietly(pairServer)
            closeQuietly(clientSide)
            closeQuietly(bridgeSideRef.get())
            if (e is IOException) throw e
            throw IOException("Relay socket setup failed", e)
        }
    }

    @Throws(IOException::class)
    private fun attachSocketToRelayWebSocket(
        socketSide: Socket,
        normalizedRelayUrl: String,
        connectTimeoutMs: Int,
    ): Closeable {
        val openLatch = CountDownLatch(1)
        val opened = AtomicBoolean(false)
        val errorRef = AtomicReference<Throwable?>()
        val closed = AtomicBoolean(false)

        val request = Request.Builder()
            .url(normalizedRelayUrl)
            .header("Sec-WebSocket-Protocol", RELAY_SUBPROTOCOL)
            .build()

        val ws = RELAY_WS_CLIENT.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    val ext = response.header("Sec-WebSocket-Extensions")
                    if (!ext.isNullOrBlank()) {
                        errorRef.compareAndSet(null, IOException("Unexpected WebSocket extension negotiated: $ext"))
                        webSocket.cancel()
                        closeQuietly(socketSide)
                        openLatch.countDown()
                        return
                    }
                    opened.set(true)
                    openLatch.countDown()
                }

                override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                    if (bytes.size == 0) return
                    try {
                        val out = socketSide.getOutputStream()
                        out.write(bytes.toByteArray())
                        out.flush()
                    } catch (_: IOException) {
                        webSocket.cancel()
                        closeQuietly(socketSide)
                    }
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(1000, null)
                    try {
                        socketSide.shutdownOutput()
                    } catch (_: IOException) {
                        closeQuietly(socketSide)
                    }
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    closed.set(true)
                    closeQuietly(socketSide)
                    openLatch.countDown()
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    closed.set(true)
                    errorRef.compareAndSet(null, t)
                    closeQuietly(socketSide)
                    openLatch.countDown()
                }
            },
        )

        val connected = try {
            openLatch.await(connectTimeoutMs.toLong(), TimeUnit.MILLISECONDS) && opened.get()
        } catch (ie: InterruptedException) {
            Thread.currentThread().interrupt()
            ws.cancel()
            closeQuietly(socketSide)
            throw IOException("Relay WebSocket connect interrupted", ie)
        }

        if (!connected) {
            ws.cancel()
            closeQuietly(socketSide)
            val err = errorRef.get()
            if (err is IOException) throw err
            if (err != null) throw IOException("Relay WebSocket failed: ${err.message}", err)
            throw IOException("Relay WebSocket connect timed out")
        }

        Thread(
            {
                val buf = ByteArray(BUFFER_BYTES)
                try {
                    val input = socketSide.getInputStream()
                    while (!closed.get()) {
                        val n = input.read(buf)
                        if (n < 0) {
                            ws.close(1000, null)
                            break
                        }
                        if (n == 0) continue
                        var waitLoops = 0
                        while (ws.queueSize() > MAX_WS_QUEUE_BYTES && !closed.get() && waitLoops < 200) {
                            try {
                                Thread.sleep(10L)
                            } catch (_: InterruptedException) {
                                Thread.currentThread().interrupt()
                                ws.cancel()
                                return@Thread
                            }
                            waitLoops++
                        }
                        if (!ws.send(buf.toByteString(0, n))) break
                    }
                } catch (_: IOException) {
                    ws.cancel()
                } finally {
                    closeQuietly(socketSide)
                }
            },
            "kiki-relay-sock-to-ws",
        ).apply {
            isDaemon = true
            start()
        }

        return Closeable {
            closed.set(true)
            ws.cancel()
            closeQuietly(socketSide)
        }
    }

    @Throws(IOException::class)
    fun connectHappyEyeballs(
        directOrigins: List<String>?,
        relayEndpoints: List<String>?,
        pinnedFp: String?,
        sslSocketFactory: SSLSocketFactory,
        peerCertCheck: ((Certificate) -> Boolean)?,
        connectTimeoutMs: Int,
        readTimeoutMs: Int,
    ): ConnectedRoute {
        val directs = directOrigins.orEmpty()
            .map { it.trim() }
            .filter { it.isNotEmpty() && !isSyntheticRelayOrigin(it) }
            .distinct()

        val relays = relayEndpoints.orEmpty()
            .mapNotNull(::normalizeRelayEndpoint)
            .distinct()

        if (relays.isNotEmpty() && (pinnedFp.isNullOrBlank() || peerCertCheck == null)) {
            if (directs.isEmpty()) {
                throw SSLPeerUnverifiedException("Relay connections require a pinned TLS SPKI fingerprint (fp).")
            }
        }
        val usableRelays = if (!pinnedFp.isNullOrBlank() && peerCertCheck != null) relays else emptyList()

        val totalCandidates = directs.size + usableRelays.size
        if (totalCandidates == 0) {
            throw IOException("No reachable direct or relay endpoints configured.")
        }

        val winnerRef = AtomicReference<ConnectedRoute?>()
        val firstTlsMismatch = AtomicReference<SSLPeerUnverifiedException?>()
        val lastError = AtomicReference<IOException?>()
        val remaining = AtomicInteger(totalCandidates)
        val doneLatch = CountDownLatch(1)
        val cancelled = AtomicBoolean(false)
        val workers = ArrayList<Thread>(totalCandidates)

        for (origin in directs) {
            val t = Thread(
                {
                    try {
                        val route = dialDirectOrigin(
                            origin = origin,
                            sslSocketFactory = sslSocketFactory,
                            peerCertCheck = peerCertCheck,
                            connectTimeoutMs = connectTimeoutMs,
                            readTimeoutMs = readTimeoutMs,
                        )
                        if (winnerRef.compareAndSet(null, route)) {
                            cancelled.set(true)
                            doneLatch.countDown()
                        } else {
                            closeQuietly(route)
                        }
                    } catch (tlsErr: SSLPeerUnverifiedException) {
                        firstTlsMismatch.compareAndSet(null, tlsErr)
                    } catch (ioErr: IOException) {
                        lastError.set(ioErr)
                    } finally {
                        if (remaining.decrementAndGet() == 0) {
                            doneLatch.countDown()
                        }
                    }
                },
                "kiki-he-direct",
            ).apply {
                isDaemon = true
                start()
            }
            workers.add(t)
        }

        val baseStep = if (directs.isEmpty()) 0 else 1
        usableRelays.forEachIndexed { i, relayUrl ->
            val delayMs = (baseStep + i) * RELAY_STAGGER_MS
            val t = Thread(
                {
                    try {
                        if (delayMs > 0L) {
                            val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(delayMs)
                            while (!cancelled.get()) {
                                val remNs = deadline - System.nanoTime()
                                if (remNs <= 0L) break
                                if (directs.isNotEmpty() && remaining.get() <= usableRelays.size) break
                                Thread.sleep(minOf(25L, TimeUnit.NANOSECONDS.toMillis(remNs) + 1L))
                            }
                        }
                        if (cancelled.get() || winnerRef.get() != null) return@Thread
                        val route = dialRelayEndpoint(
                            relayUrl = relayUrl,
                            sslSocketFactory = sslSocketFactory,
                            peerCertCheck = peerCertCheck!!,
                            connectTimeoutMs = connectTimeoutMs,
                            readTimeoutMs = readTimeoutMs,
                        )
                        if (winnerRef.compareAndSet(null, route)) {
                            cancelled.set(true)
                            doneLatch.countDown()
                        } else {
                            closeQuietly(route)
                        }
                    } catch (_: InterruptedException) {
                        Thread.currentThread().interrupt()
                    } catch (tlsErr: SSLPeerUnverifiedException) {
                        firstTlsMismatch.compareAndSet(null, tlsErr)
                    } catch (ioErr: IOException) {
                        lastError.set(ioErr)
                    } finally {
                        if (remaining.decrementAndGet() == 0) {
                            doneLatch.countDown()
                        }
                    }
                },
                "kiki-he-relay-$i",
            ).apply {
                isDaemon = true
                start()
            }
            workers.add(t)
        }

        val totalWaitMs = connectTimeoutMs.toLong() + (usableRelays.size * RELAY_STAGGER_MS) + 1_500L
        try {
            doneLatch.await(totalWaitMs, TimeUnit.MILLISECONDS)
        } catch (ie: InterruptedException) {
            Thread.currentThread().interrupt()
            cancelled.set(true)
            for (w in workers) w.interrupt()
            winnerRef.getAndSet(null)?.let(::closeQuietly)
            throw IOException("Connection interrupted", ie)
        }

        cancelled.set(true)
        val winner = winnerRef.get()
        if (winner != null) {
            for (w in workers) {
                if (w.isAlive) w.interrupt()
            }
            return winner
        }

        firstTlsMismatch.get()?.let { throw it }
        lastError.get()?.let { throw it }
        throw IOException("Timed out connecting to peer endpoints.")
    }

    @Throws(IOException::class)
    fun selectReachableRoute(
        directOrigins: List<String>?,
        relayEndpoints: List<String>?,
        pinnedFp: String?,
        sslSocketFactory: SSLSocketFactory,
        peerCertCheck: ((Certificate) -> Boolean)?,
        connectTimeoutMs: Int,
    ): SelectedRoute {
        connectHappyEyeballs(
            directOrigins = directOrigins,
            relayEndpoints = relayEndpoints,
            pinnedFp = pinnedFp,
            sslSocketFactory = sslSocketFactory,
            peerCertCheck = peerCertCheck,
            connectTimeoutMs = connectTimeoutMs,
            readTimeoutMs = connectTimeoutMs,
        ).use { route ->
            return SelectedRoute(route.viaRelay, route.directOrigin, route.relayUrl)
        }
    }

    @Throws(IOException::class)
    private fun dialDirectOrigin(
        origin: String,
        sslSocketFactory: SSLSocketFactory,
        peerCertCheck: ((Certificate) -> Boolean)?,
        connectTimeoutMs: Int,
        readTimeoutMs: Int,
    ): ConnectedRoute {
        val uri = URI.create(origin)
        val scheme = uri.scheme?.lowercase(Locale.ROOT).orEmpty()
        val tls = scheme == "https" || scheme == "wss"
        val host = uri.host?.takeIf { it.isNotEmpty() } ?: throw IOException("Endpoint missing host")
        val port = if (uri.port > 0) uri.port else if (tls) 443 else 80
        val defaultPort = if (tls) 443 else 80
        val renderedHost = if (host.contains(":") && !host.startsWith("[")) "[$host]" else host
        val hostHeader = if (port == defaultPort) renderedHost else "$renderedHost:$port"

        val tcp = Socket()
        try {
            tcp.tcpNoDelay = true
            tcp.connect(InetSocketAddress(host, port), connectTimeoutMs)
            tcp.soTimeout = readTimeoutMs
            if (!tls) {
                if (peerCertCheck != null) {
                    closeQuietly(tcp)
                    throw SSLPeerUnverifiedException("Pinned peer requires TLS.")
                }
                return ConnectedRoute(tcp, false, origin, null, hostHeader)
            }
            val ssl = sslSocketFactory.createSocket(tcp, host, port, true) as SSLSocket
            ssl.soTimeout = readTimeoutMs
            ssl.startHandshake()
            if (peerCertCheck != null) {
                val certs = ssl.session.peerCertificates
                if (certs.isEmpty() || !peerCertCheck(certs[0])) {
                    closeQuietly(ssl)
                    throw SSLPeerUnverifiedException("Server TLS fingerprint mismatch.")
                }
            }
            return ConnectedRoute(ssl, false, origin, null, hostHeader)
        } catch (e: Exception) {
            closeQuietly(tcp)
            if (e is IOException) throw e
            throw IOException("Direct endpoint connection failed", e)
        }
    }

    @Throws(IOException::class)
    private fun dialRelayEndpoint(
        relayUrl: String,
        sslSocketFactory: SSLSocketFactory,
        peerCertCheck: (Certificate) -> Boolean,
        connectTimeoutMs: Int,
        readTimeoutMs: Int,
    ): ConnectedRoute {
        val rawLoopback = openRelayLoopbackSocket(relayUrl, connectTimeoutMs)
        try {
            rawLoopback.soTimeout = readTimeoutMs
            val ssl = sslSocketFactory.createSocket(rawLoopback, "kiki.peer", 443, true) as SSLSocket
            ssl.soTimeout = readTimeoutMs
            ssl.startHandshake()
            val certs = ssl.session.peerCertificates
            if (certs.isEmpty() || !peerCertCheck(certs[0])) {
                closeQuietly(ssl)
                throw SSLPeerUnverifiedException("Server TLS fingerprint mismatch.")
            }
            return ConnectedRoute(ssl, true, null, relayUrl, "kiki.peer")
        } catch (e: Exception) {
            closeQuietly(rawLoopback)
            if (e is IOException) throw e
            throw IOException("Relay TLS handshake failed", e)
        }
    }

    private fun closeQuietly(closeable: Closeable?) {
        if (closeable == null) return
        try {
            closeable.close()
        } catch (_: IOException) {
        }
    }
}
