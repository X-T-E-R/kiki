package dev.kiki.android.host.remote

import kotlinx.serialization.json.JsonPrimitive
import java.io.BufferedInputStream
import java.io.Closeable
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URI
import java.nio.charset.StandardCharsets
import java.security.SecureRandom
import java.security.cert.Certificate
import java.util.Base64
import java.util.Collections
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import javax.net.ssl.SSLPeerUnverifiedException
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

internal class PinnedWsTunnel private constructor(
    private val upstreamOrigin: String,
    private val dialer: UpstreamDialer,
) : Closeable {

    data class UpstreamConnection(
        val socket: Socket,
        val hostHeader: String,
    ) : Closeable {
        override fun close() {
            closeQuietly(socket)
        }
    }

    fun interface UpstreamDialer {
        @Throws(IOException::class)
        fun dial(): UpstreamConnection
    }

    private val secret: String
    private val server: ServerSocket
    private val activeSockets: MutableSet<Socket> = Collections.newSetFromMap(ConcurrentHashMap())

    @Volatile
    private var closed = false

    constructor(
        upstreamOrigin: String,
        sslSocketFactory: SSLSocketFactory,
        peerCheck: (Certificate) -> Boolean,
    ) : this(upstreamOrigin, directDialer(upstreamOrigin, sslSocketFactory, peerCheck))

    constructor(
        upstreamOrigin: String,
        directOrigins: List<String>?,
        relayEndpoints: List<String>?,
        pinnedFp: String?,
        sslSocketFactory: SSLSocketFactory,
        peerCheck: (Certificate) -> Boolean,
    ) : this(
        upstreamOrigin,
        UpstreamDialer {
            val route = PeerStreamConnector.connectHappyEyeballs(
                directOrigins = directOrigins,
                relayEndpoints = relayEndpoints,
                pinnedFp = pinnedFp,
                sslSocketFactory = sslSocketFactory,
                peerCertCheck = peerCheck,
                connectTimeoutMs = CONNECT_TIMEOUT_MS,
                readTimeoutMs = HANDSHAKE_TIMEOUT_MS,
            )
            UpstreamConnection(route.socket, route.hostHeader)
        },
    )

    init {
        val raw = ByteArray(24)
        SecureRandom().nextBytes(raw)
        secret = Base64.getUrlEncoder().withoutPadding().encodeToString(raw)
        server = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
        Thread(::acceptLoop, "kiki-pinned-ws-tunnel").apply {
            isDaemon = true
            start()
        }
    }

    fun matchesOrigin(origin: String): Boolean = upstreamOrigin == origin

    fun interceptorScript(): String {
        val targetOrigin = JsonPrimitive(upstreamOrigin).toString()
        val localBase = JsonPrimitive("ws://127.0.0.1:${server.localPort}$TUNNEL_PREFIX$secret").toString()
        return "(function(){" +
            "var targetOrigin=" + targetOrigin + ";" +
            "var localBase=" + localBase + ";" +
            "if(window.location.origin!==targetOrigin||window.__kikiPinnedWsInstalled)return;" +
            "window.__kikiPinnedWsInstalled=true;" +
            "var NativeWS=window.WebSocket;" +
            "if(typeof NativeWS!=='function')return;" +
            "function rewrite(raw){" +
            "try{" +
            "var parsed=new URL(String(raw),window.location.href);" +
            "if(parsed.protocol!=='wss:')return raw;" +
            "if(('https://'+parsed.host)!==targetOrigin)return raw;" +
            "return localBase+parsed.pathname+parsed.search;" +
            "}catch(_){return raw;}" +
            "}" +
            "function PatchedWS(url,protocols){" +
            "var actual=rewrite(url);" +
            "return arguments.length>1?new NativeWS(actual,protocols):new NativeWS(actual);" +
            "}" +
            "PatchedWS.prototype=NativeWS.prototype;" +
            "Object.setPrototypeOf(PatchedWS,NativeWS);" +
            "['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(function(k){" +
            "try{Object.defineProperty(PatchedWS,k,{value:NativeWS[k],enumerable:true});}catch(_){}" +
            "});" +
            "window.WebSocket=PatchedWS;" +
            "})();"
    }

    override fun close() {
        closed = true
        closeQuietly(server)
        for (socket in activeSockets.toTypedArray()) {
            activeSockets.remove(socket)
            closeQuietly(socket)
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
            trackSocket(client)
            Thread({ handleClient(client) }, "kiki-pinned-ws-client").apply {
                isDaemon = true
                start()
            }
        }
    }

    private fun handleClient(client: Socket) {
        var upstream: Socket? = null
        try {
            client.soTimeout = HANDSHAKE_TIMEOUT_MS
            client.tcpNoDelay = true
            val clientIn = BufferedInputStream(client.getInputStream())
            val clientOut = client.getOutputStream()

            val requestHead = readHttpHeaderBlock(clientIn)
            val lines = requestHead.split("\r\n")
            if (lines.isEmpty()) {
                writeSimpleResponse(clientOut, 400, "Bad Request")
                return
            }

            val reqParts = lines[0].split(" ", limit = 3)
            if (reqParts.size < 3 || reqParts[0] != "GET") {
                writeSimpleResponse(clientOut, 405, "Method Not Allowed")
                return
            }

            val expectedPrefix = "$TUNNEL_PREFIX$secret"
            val rawTarget = reqParts[1]
            if (!rawTarget.startsWith(expectedPrefix)) {
                writeSimpleResponse(clientOut, 403, "Forbidden")
                return
            }
            var forwardTarget = rawTarget.substring(expectedPrefix.length)
            if (forwardTarget.isEmpty()) forwardTarget = "/"
            if (!forwardTarget.startsWith("/") ||
                forwardTarget.contains("\r") ||
                forwardTarget.contains("\n") ||
                forwardTarget.contains(" ")
            ) {
                writeSimpleResponse(clientOut, 400, "Bad Request")
                return
            }

            var browserOriginOk = false
            val forwardHeaders = StringBuilder()
            for (i in 1 until lines.size) {
                val line = lines[i]
                if (line.isEmpty()) continue
                val colon = line.indexOf(':')
                if (colon <= 0) continue
                val name = line.substring(0, colon).trim()
                val lower = name.lowercase(Locale.ROOT)
                val value = line.substring(colon + 1).trim()
                if (lower == "host") continue
                if (lower == "origin") {
                    if (value != upstreamOrigin) {
                        writeSimpleResponse(clientOut, 403, "Forbidden Origin")
                        return
                    }
                    browserOriginOk = true
                    continue
                }
                if (ALLOWED_CLIENT_HEADERS.contains(lower)) {
                    forwardHeaders.append(name).append(": ").append(value).append("\r\n")
                }
            }
            if (!browserOriginOk) {
                writeSimpleResponse(clientOut, 403, "Missing Origin")
                return
            }

            val dialed = dialer.dial()
            upstream = dialed.socket
            upstream.tcpNoDelay = true
            upstream.soTimeout = HANDSHAKE_TIMEOUT_MS
            trackSocket(upstream)

            val upstreamOut = upstream.getOutputStream()
            val upstreamIn = BufferedInputStream(upstream.getInputStream())
            val upstreamRequest = "GET $forwardTarget HTTP/1.1\r\n" +
                "Host: ${dialed.hostHeader}\r\n" +
                "Origin: $upstreamOrigin\r\n" +
                forwardHeaders +
                "\r\n"
            upstreamOut.write(upstreamRequest.toByteArray(StandardCharsets.ISO_8859_1))
            upstreamOut.flush()

            val responseHead = readHttpHeaderBlock(upstreamIn)
            clientOut.write(responseHead.toByteArray(StandardCharsets.ISO_8859_1))
            clientOut.flush()

            val statusLine = responseHead.lineSequence().firstOrNull().orEmpty()
            if (!statusLine.startsWith("HTTP/1.1 101 ") && !statusLine.startsWith("HTTP/1.0 101 ")) {
                return
            }

            client.soTimeout = 0
            upstream.soTimeout = 0
            val upSocket = upstream
            val reversePump = Thread(
                { pump(upstreamIn, clientOut, client, upSocket) },
                "kiki-pinned-ws-down",
            ).apply {
                isDaemon = true
                start()
            }
            pump(clientIn, upstreamOut, upSocket, client)
            reversePump.join(2_000L)
        } catch (_: Exception) {
        } finally {
            untrackAndClose(upstream)
            untrackAndClose(client)
        }
    }

    private fun trackSocket(socket: Socket?) {
        if (socket == null) return
        activeSockets.add(socket)
        if (closed) {
            activeSockets.remove(socket)
            closeQuietly(socket)
        }
    }

    private fun untrackAndClose(socket: Socket?) {
        if (socket == null) return
        activeSockets.remove(socket)
        closeQuietly(socket)
    }

    companion object {
        private const val TUNNEL_PREFIX = "/__kiki_ws/"
        private const val MAX_HEADER_BYTES = 16 * 1024
        private const val CONNECT_TIMEOUT_MS = 8_000
        private const val HANDSHAKE_TIMEOUT_MS = 12_000
        private const val BUFFER_BYTES = 16 * 1024

        private val ALLOWED_CLIENT_HEADERS = setOf(
            "upgrade",
            "connection",
            "sec-websocket-key",
            "sec-websocket-version",
            "sec-websocket-protocol",
            "authorization",
            "user-agent",
            "accept-language",
            "cookie",
        )

        private fun directDialer(
            upstreamOrigin: String,
            sslSocketFactory: SSLSocketFactory,
            peerCheck: (Certificate) -> Boolean,
        ): UpstreamDialer {
            val parsed = URI.create(upstreamOrigin)
            require(parsed.scheme.equals("https", ignoreCase = true)) { "PinnedWsTunnel requires an https origin" }
            val host = parsed.host?.takeIf { it.isNotEmpty() } ?: throw IllegalArgumentException("Missing host")
            val port = if (parsed.port > 0) parsed.port else 443
            val renderedHost = if (host.contains(":") && !host.startsWith("[")) "[$host]" else host
            val hostHeader = if (port == 443) renderedHost else "$renderedHost:$port"
            return UpstreamDialer {
                val tcp = Socket()
                try {
                    tcp.connect(InetSocketAddress(host, port), CONNECT_TIMEOUT_MS)
                    val ssl = sslSocketFactory.createSocket(tcp, host, port, true) as SSLSocket
                    ssl.soTimeout = HANDSHAKE_TIMEOUT_MS
                    ssl.startHandshake()
                    val certs = ssl.session.peerCertificates
                    if (certs.isEmpty() || !peerCheck(certs[0])) {
                        closeQuietly(ssl)
                        throw SSLPeerUnverifiedException("Server TLS fingerprint mismatch.")
                    }
                    UpstreamConnection(ssl, hostHeader)
                } catch (e: Exception) {
                    closeQuietly(tcp)
                    if (e is IOException) throw e
                    throw IOException("Direct dial failed", e)
                }
            }
        }

        private fun pump(input: InputStream, out: OutputStream, writePeer: Socket, readPeer: Socket) {
            val buf = ByteArray(BUFFER_BYTES)
            try {
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    if (n > 0) {
                        out.write(buf, 0, n)
                        out.flush()
                    }
                }
            } catch (_: IOException) {
            } finally {
                try {
                    writePeer.shutdownOutput()
                } catch (_: IOException) {
                    closeQuietly(writePeer)
                }
                try {
                    readPeer.shutdownInput()
                } catch (_: IOException) {
                }
            }
        }

        @Throws(IOException::class)
        private fun readHttpHeaderBlock(input: InputStream): String {
            val raw = ByteArray(MAX_HEADER_BYTES)
            var len = 0
            var state = 0
            while (len < MAX_HEADER_BYTES) {
                val b = input.read()
                if (b < 0) throw IOException("Unexpected EOF during HTTP handshake")
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
            throw IOException("HTTP header exceeded limit")
        }

        @Throws(IOException::class)
        private fun writeSimpleResponse(out: OutputStream, status: Int, reason: String) {
            val resp = "HTTP/1.1 $status $reason\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
            out.write(resp.toByteArray(StandardCharsets.ISO_8859_1))
            out.flush()
        }

        private fun closeQuietly(closeable: Closeable?) {
            if (closeable == null) return
            try {
                closeable.close()
            } catch (_: IOException) {
            }
        }
    }
}
