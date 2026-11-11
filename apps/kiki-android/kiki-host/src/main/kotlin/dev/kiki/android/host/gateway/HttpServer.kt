package dev.kiki.android.host.gateway

// Adapted from Mika's core/src/main/kotlin/com/wangzan101/mika/core/remote/HttpServer.kt (Apache-2.0);
// removed RemoteHost-only request ownership fields for the loopback HostGateway.
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.util.concurrent.Semaphore
import java.util.concurrent.atomic.AtomicBoolean

internal class HttpRequest(
    val method: String,
    val path: String,
    val headers: Map<String, String>,
    val body: ByteArray,
    val query: String = "",
) {
    fun header(name: String): String? = headers[name.lowercase()]
}

internal class HttpResponse(
    val status: Int,
    val body: ByteArray = ByteArray(0),
    val headers: Map<String, String> = emptyMap(),
) {
    companion object {
        fun json(status: Int, text: String, extra: Map<String, String> = emptyMap()) =
            HttpResponse(status, text.toByteArray(Charsets.UTF_8), mapOf("Content-Type" to "application/json") + extra)

        fun empty(status: Int, extra: Map<String, String> = emptyMap()) = HttpResponse(status, ByteArray(0), extra)
    }
}

private class HttpProtocolException(val status: Int, message: String) : IOException(message)

/**
 * A small HTTP/1.1 server for HostGateway. The caller supplies its bind address and connection filter;
 * HostGateway binds to IPv4 loopback and accepts only loopback peers.
 */
internal class MiniHttpServer(
    private val bind: InetSocketAddress,
    private val handler: (HttpRequest) -> HttpResponse,
    private val accept: (local: InetAddress, remote: InetAddress) -> Boolean,
    private val maxConnections: Int = 16,
    private val readTimeoutMs: Int = 30_000,
    private val onError: (Throwable) -> Unit = {},
) {
    private val running = AtomicBoolean(false)
    private val slots = Semaphore(maxConnections)
    private val open = java.util.Collections.newSetFromMap(java.util.concurrent.ConcurrentHashMap<Socket, Boolean>())
    @Volatile private var server: ServerSocket? = null

    val port: Int get() = server?.localPort ?: -1

    @Synchronized fun start() {
        check(!running.get()) { "already running" }
        val socket = ServerSocket()
        socket.reuseAddress = true
        try {
            socket.bind(bind, 32)
        } catch (e: IOException) {
            socket.close()
            throw e
        }
        server = socket
        running.set(true)
        Thread({ acceptLoop(socket) }, "host-gateway-accept").apply { isDaemon = true }.start()
    }

    @Synchronized fun stop() {
        running.set(false)
        runCatching { server?.close() }
        server = null
        open.forEach { runCatching { it.close() } }
        open.clear()
    }

    private fun acceptLoop(socket: ServerSocket) {
        while (running.get()) {
            val client = try {
                socket.accept()
            } catch (e: IOException) {
                if (running.get()) onError(e)
                break
            }
            if (!accept(client.localAddress, client.inetAddress)) {
                runCatching { client.close() }
                continue
            }
            if (!slots.tryAcquire()) {
                runCatching {
                    client.soTimeout = 2_000
                    write(client.getOutputStream(), HttpResponse.empty(503), close = true)
                    client.close()
                }
                continue
            }
            open += client
            Thread({
                try {
                    serve(client)
                } finally {
                    open -= client
                    runCatching { client.close() }
                    slots.release()
                }
            }, "host-gateway-conn").apply { isDaemon = true }.start()
        }
    }

    private fun serve(socket: Socket) {
        try {
            socket.soTimeout = readTimeoutMs
            socket.tcpNoDelay = true
            val input = BufferedInputStream(socket.getInputStream())
            val output = socket.getOutputStream()
            while (running.get()) {
                val request = try {
                    readRequest(input, output) ?: return
                } catch (e: HttpProtocolException) {
                    write(output, HttpResponse.empty(e.status), close = true)
                    return
                }
                val response = try {
                    handler(request)
                } catch (e: Exception) {
                    onError(e)
                    HttpResponse.empty(500)
                }
                val close = request.header("connection")?.split(',')
                    ?.any { it.trim().equals("close", ignoreCase = true) } == true
                write(output, response, close)
                if (close) return
            }
        } catch (_: SocketException) {
        } catch (_: java.net.SocketTimeoutException) {
        } catch (e: IOException) {
            onError(e)
        }
    }

    private fun readRequest(input: InputStream, output: OutputStream): HttpRequest? {
        val head = readHead(input) ?: return null
        val lines = head.split("\r\n")
        val parts = lines.first().split(' ')
        if (parts.size != 3 || !parts[2].startsWith("HTTP/1.")) throw HttpProtocolException(400, "bad request line")
        val headers = HashMap<String, String>()
        for (line in lines.drop(1)) {
            if (line.isEmpty()) continue
            val colon = line.indexOf(':')
            if (colon <= 0) throw HttpProtocolException(400, "bad header")
            val name = line.substring(0, colon).trim().lowercase()
            val value = line.substring(colon + 1).trim()
            headers[name] = headers[name]?.let { old ->
                if (name == "content-length" && old != value) throw HttpProtocolException(400, "conflicting length")
                if (name == "content-length") old else "$old, $value"
            } ?: value
        }
        if (headers["expect"].equals("100-continue", ignoreCase = true)) {
            output.write("HTTP/1.1 100 Continue\r\n\r\n".toByteArray(Charsets.ISO_8859_1))
            output.flush()
        }
        val body = when {
            headers["transfer-encoding"]?.lowercase()?.contains("chunked") == true -> readChunked(input)
            headers["content-length"] != null -> {
                val size = headers["content-length"]!!.toLongOrNull() ?: throw HttpProtocolException(400, "bad length")
                if (size < 0) throw HttpProtocolException(400, "bad length")
                if (size > MAX_BODY) throw HttpProtocolException(413, "body too large")
                readExactly(input, size.toInt())
            }
            else -> ByteArray(0)
        }
        val target = parts[1]
        return HttpRequest(parts[0], target.substringBefore('?'), headers, body, target.substringAfter('?', ""))
    }

    private fun readHead(input: InputStream): String? {
        val buffer = ByteArrayOutputStream()
        var matched = 0
        val end = byteArrayOf('\r'.code.toByte(), '\n'.code.toByte(), '\r'.code.toByte(), '\n'.code.toByte())
        while (matched < 4) {
            val byte = input.read()
            if (byte < 0) {
                if (buffer.size() == 0) return null
                throw HttpProtocolException(400, "truncated head")
            }
            if (buffer.size() == 0 && (byte == '\r'.code || byte == '\n'.code)) continue
            buffer.write(byte)
            if (buffer.size() > MAX_HEAD) throw HttpProtocolException(431, "head too large")
            matched = if (byte.toByte() == end[matched]) matched + 1 else if (byte.toByte() == end[0]) 1 else 0
        }
        return String(buffer.toByteArray(), 0, buffer.size() - 4, Charsets.ISO_8859_1)
    }

    private fun readExactly(input: InputStream, size: Int): ByteArray {
        val bytes = ByteArray(size)
        var offset = 0
        while (offset < size) {
            val read = input.read(bytes, offset, size - offset)
            if (read < 0) throw HttpProtocolException(400, "truncated body")
            offset += read
        }
        return bytes
    }

    private fun readLine(input: InputStream): String {
        val line = StringBuilder()
        while (true) {
            val byte = input.read()
            if (byte < 0) throw HttpProtocolException(400, "truncated chunk")
            if (byte == '\n'.code) return line.toString().trimEnd('\r')
            line.append(byte.toChar())
            if (line.length > 1024) throw HttpProtocolException(400, "chunk line too long")
        }
    }

    private fun readChunked(input: InputStream): ByteArray {
        val output = ByteArrayOutputStream()
        while (true) {
            val size = readLine(input).substringBefore(';').trim().toIntOrNull(16)
                ?: throw HttpProtocolException(400, "bad chunk")
            if (size < 0 || size > MAX_BODY - output.size()) throw HttpProtocolException(413, "body too large")
            if (size == 0) {
                while (readLine(input).isNotEmpty()) Unit
                return output.toByteArray()
            }
            output.write(readExactly(input, size))
            readLine(input)
        }
    }

    private fun write(output: OutputStream, response: HttpResponse, close: Boolean) {
        val head = StringBuilder("HTTP/1.1 ${response.status} ${REASONS[response.status] ?: "Status"}\r\n")
        response.headers.forEach { (name, value) -> head.append(name).append(": ").append(value).append("\r\n") }
        head.append("Content-Length: ").append(response.body.size).append("\r\n")
        head.append("Cache-Control: no-store\r\n")
        if (close) head.append("Connection: close\r\n")
        head.append("\r\n")
        output.write(head.toString().toByteArray(Charsets.ISO_8859_1))
        output.write(response.body)
        output.flush()
    }

    companion object {
        private const val MAX_HEAD = 16 * 1024
        private const val MAX_BODY = 256 * 1024
        private val REASONS = mapOf(
            200 to "OK", 201 to "Created", 202 to "Accepted", 400 to "Bad Request", 401 to "Unauthorized", 403 to "Forbidden",
            404 to "Not Found", 405 to "Method Not Allowed", 406 to "Not Acceptable", 409 to "Conflict", 413 to "Payload Too Large",
            415 to "Unsupported Media Type", 429 to "Too Many Requests", 431 to "Request Header Fields Too Large",
            500 to "Internal Server Error", 503 to "Service Unavailable",
        )
    }
}
