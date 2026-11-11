package dev.kiki.android.host.gateway

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.Closeable
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.UUID

/**
 * Loopback-only Host Gateway bound to `127.0.0.1:<Ph>`.
 * Serves:
 * - `/v1/secret/{get,put,delete}` + `GET /v1/secret/list` (Bearer `secretToken`)
 * - `/mcp` (Bearer `mcpToken`)
 */
class HostGateway(
    private val secretTokenProvider: () -> String,
    private val mcpTokenProvider: () -> String,
    private val secretBroker: KeystoreSecretBroker,
    private val toolProxy: KikiToolProxy,
    port: Int = 0,
    onError: (Throwable) -> Unit = {},
) : Closeable {

    private val json = Json { ignoreUnknownKeys = true }

    @Volatile
    private var mcpSessionId: String = UUID.randomUUID().toString()

    private val server = MiniHttpServer(
        bind = InetSocketAddress(InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)), port),
        handler = ::dispatch,
        accept = { local, remote -> local.isLoopbackAddress && remote.isLoopbackAddress },
        onError = onError,
    ).also {
        it.start()
    }

    val port: Int get() = server.port
    val baseUrl: String get() = "http://127.0.0.1:${server.port}"
    val mcpUrl: String get() = "$baseUrl/mcp"

    override fun close() {
        server.stop()
    }

    private fun dispatch(req: HttpRequest): HttpResponse {
        val rawPath = req.path
        val pathOnly = rawPath.substringBefore('?')
        return when {
            pathOnly.startsWith("/v1/secret/") -> handleSecret(req, pathOnly, rawPath)
            pathOnly == "/mcp" -> handleMcp(req)
            pathOnly == "/healthz" -> HttpResponse(
                status = 200,
                body = "ok".toByteArray(StandardCharsets.UTF_8),
                headers = mapOf("Content-Type" to "text/plain; charset=utf-8"),
            )
            else -> jsonResponse(404, buildJsonObject { put("error", "not_found") })
        }
    }

    private fun handleSecret(req: HttpRequest, pathOnly: String, rawPath: String): HttpResponse {
        if (!verifyBearer(req, secretTokenProvider())) {
            return jsonResponse(401, buildJsonObject { put("error", "unauthorized") })
        }
        return try {
            when {
                req.method == "POST" && pathOnly == "/v1/secret/get" -> {
                    val body = parseBodyJson(req) ?: return badRequest("invalid_json")
                    val service = body.str("service") ?: return badRequest("missing_service")
                    val account = body.str("account") ?: return badRequest("missing_account")
                    val value = secretBroker.get(service, account)
                        ?: return jsonResponse(404, buildJsonObject { put("error", "not_found") })
                    jsonResponse(200, buildJsonObject { put("value", value) })
                }

                req.method == "POST" && pathOnly == "/v1/secret/put" -> {
                    val body = parseBodyJson(req) ?: return badRequest("invalid_json")
                    val service = body.str("service") ?: return badRequest("missing_service")
                    val account = body.str("account") ?: return badRequest("missing_account")
                    val value = body.str("value") ?: return badRequest("missing_value")
                    secretBroker.put(service, account, value)
                    HttpResponse.empty(204)
                }

                req.method == "POST" && pathOnly == "/v1/secret/delete" -> {
                    val body = parseBodyJson(req) ?: return badRequest("invalid_json")
                    val service = body.str("service") ?: return badRequest("missing_service")
                    val account = body.str("account") ?: return badRequest("missing_account")
                    val deleted = secretBroker.delete(service, account)
                    jsonResponse(200, buildJsonObject { put("deleted", deleted) })
                }

                req.method == "GET" && pathOnly == "/v1/secret/list" -> {
                    val query = req.query.ifEmpty { rawPath.substringAfter('?', "") }
                    val service = parseQueryParam(query, "service")
                        ?: return badRequest("missing_service")
                    val accounts = secretBroker.listAccounts(service)
                    jsonResponse(200, buildJsonObject {
                        put("accounts", buildJsonArray { accounts.forEach { add(JsonPrimitive(it)) } })
                    })
                }

                else -> jsonResponse(405, buildJsonObject { put("error", "method_not_allowed") })
            }
        } catch (e: IllegalArgumentException) {
            badRequest(e.message ?: "invalid_request")
        }
    }

    private fun handleMcp(req: HttpRequest): HttpResponse {
        if (!verifyBearer(req, mcpTokenProvider())) {
            return jsonResponse(401, buildJsonObject { put("error", "unauthorized") })
        }
        return when (req.method) {
            "POST" -> {
                val bodyText = req.body.toString(StandardCharsets.UTF_8)
                val rpcOut = runBlocking { toolProxy.handleJsonRpc(bodyText) }
                if (rpcOut == null) {
                    HttpResponse.empty(202, mapOf("Mcp-Session-Id" to mcpSessionId))
                } else {
                    HttpResponse.json(200, rpcOut.toString(), mapOf("Mcp-Session-Id" to mcpSessionId))
                }
            }

            "DELETE" -> {
                mcpSessionId = UUID.randomUUID().toString()
                HttpResponse.empty(204)
            }

            "GET" -> HttpResponse.json(405, """{"error":"sse_stream_not_required"}""")

            else -> HttpResponse.empty(405)
        }
    }

    private fun verifyBearer(req: HttpRequest, expectedToken: String): Boolean {
        if (expectedToken.isEmpty()) return false
        val auth = req.header("authorization")?.trim() ?: return false
        if (!auth.startsWith("Bearer ", ignoreCase = true)) return false
        val provided = auth.substring(7).trim()
        return MessageDigest.isEqual(
            provided.toByteArray(StandardCharsets.UTF_8),
            expectedToken.toByteArray(StandardCharsets.UTF_8),
        )
    }

    private fun parseBodyJson(req: HttpRequest): JsonObject? = runCatching {
        json.parseToJsonElement(req.body.toString(StandardCharsets.UTF_8)) as? JsonObject
    }.getOrNull()

    private fun JsonObject.str(key: String): String? =
        this[key]?.jsonPrimitive?.contentOrNull

    private fun parseQueryParam(query: String, name: String): String? {
        if (query.isEmpty()) return null
        for (pair in query.split('&')) {
            val idx = pair.indexOf('=')
            val k = if (idx >= 0) pair.substring(0, idx) else pair
            if (URLDecoder.decode(k, StandardCharsets.UTF_8) == name) {
                val v = if (idx >= 0) pair.substring(idx + 1) else ""
                return URLDecoder.decode(v, StandardCharsets.UTF_8)
            }
        }
        return null
    }

    private fun badRequest(code: String): HttpResponse =
        jsonResponse(400, buildJsonObject { put("error", code) })

    private fun jsonResponse(status: Int, payload: JsonObject): HttpResponse =
        HttpResponse.json(status, payload.toString())
}
