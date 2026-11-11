package dev.kiki.android.host.gateway

import dev.kiki.android.host.HostMcpToolCallResult
import dev.kiki.android.host.HostMcpToolDescriptor
import dev.kiki.android.host.KikiHostEnvironment
import dev.kiki.android.host.screen.ScreenArbiter
import dev.kiki.android.host.tools.CompositeToolRegistry
import dev.kiki.android.host.tools.ToolCallContext
import dev.kiki.android.host.tools.ToolGate
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.util.Base64

interface McpBackendAdapter {
    fun listTools(): List<HostMcpToolDescriptor>
    fun allowWakeUnlock(): Boolean
    fun isToolEnabled(name: String): Boolean = true
    fun isAttended(): Boolean
    suspend fun callTool(name: String, argumentsJson: String, attended: Boolean): HostMcpToolCallResult
}

/**
 * Production [McpBackendAdapter] backed by a [CompositeToolRegistry] and user [ToolGate] checks.
 */
class RegistryMcpBackendAdapter(
    private val registry: CompositeToolRegistry,
    private val gateCheck: (ToolGate) -> Boolean,
    private val attendedCheck: () -> Boolean,
) : McpBackendAdapter {

    constructor(
        host: KikiHostEnvironment,
        attendedCheck: () -> Boolean,
    ) : this(
        registry = host.toolRegistry,
        gateCheck = host::isGateEnabled,
        attendedCheck = attendedCheck,
    )

    override fun listTools(): List<HostMcpToolDescriptor> =
        registry.tools()
            .filter { gateCheck(it.gate) }
            .map { it.descriptor }

    override fun allowWakeUnlock(): Boolean = gateCheck(ToolGate.WAKE_SCREEN)

    override fun isToolEnabled(name: String): Boolean {
        val gate = registry.gateOf(name) ?: return true
        return gateCheck(gate)
    }

    override fun isAttended(): Boolean = attendedCheck()

    override suspend fun callTool(name: String, argumentsJson: String, attended: Boolean): HostMcpToolCallResult =
        registry.call(name, argumentsJson, ToolCallContext(attended = attended))
}

/**
 * MCP JSON-RPC 2.0 Streamable-HTTP proxy for Kiki Android.
 * Enforces hard blocklists (`mika_run_task` et al. -> JSON-RPC -32601), per-tool [ToolGate] switches,
 * and routes screen tools through [ScreenArbiter].
 */
class KikiToolProxy(
    private val backend: McpBackendAdapter,
    private val arbiter: ScreenArbiter,
    private val serverVersion: String = "0.1.0",
) {
    private val json = Json { ignoreUnknownKeys = true }

    fun visibleTools(): List<HostMcpToolDescriptor> {
        val wakeAllowed = backend.allowWakeUnlock()
        return backend.listTools().filter { tool ->
            isToolPermitted(tool.name, wakeAllowed)
        }
    }

    suspend fun handleJsonRpc(rawBody: String): JsonElement? {
        val parsed = runCatching { json.parseToJsonElement(rawBody) }.getOrElse {
            return rpcError(JsonNull, -32700, "Parse error")
        }
        return when (parsed) {
            is JsonArray -> {
                val responses = mutableListOf<JsonElement>()
                for (item in parsed) {
                    val obj = item as? JsonObject
                    if (obj == null) {
                        responses += rpcError(JsonNull, -32600, "Invalid Request")
                    } else {
                        handleSingle(obj)?.let { responses += it }
                    }
                }
                if (responses.isEmpty()) null else JsonArray(responses)
            }
            is JsonObject -> handleSingle(parsed)
            else -> rpcError(JsonNull, -32600, "Invalid Request")
        }
    }

    private suspend fun handleSingle(req: JsonObject): JsonObject? {
        val id = req["id"]
        val method = req["method"]?.jsonPrimitive?.contentOrNull
            ?: return rpcError(id ?: JsonNull, -32600, "Missing method")

        if (id == null) {
            // JSON-RPC notification (e.g. notifications/initialized, notifications/cancelled)
            return null
        }

        return when (method) {
            "initialize" -> {
                val clientProto = req["params"]
                    ?.let { it as? JsonObject }
                    ?.get("protocolVersion")
                    ?.jsonPrimitive
                    ?.contentOrNull
                val protocolVersion = if (clientProto in SUPPORTED_PROTOCOLS) clientProto!! else DEFAULT_PROTOCOL
                rpcResult(id, buildJsonObject {
                    put("protocolVersion", protocolVersion)
                    put("capabilities", buildJsonObject {
                        put("tools", buildJsonObject { put("listChanged", false) })
                    })
                    put("serverInfo", buildJsonObject {
                        put("name", "kiki-android-tools")
                        put("version", serverVersion)
                    })
                })
            }

            "ping" -> rpcResult(id, buildJsonObject {})

            "tools/list" -> {
                val toolsArray = buildJsonArray {
                    for (tool in visibleTools()) {
                        val schemaElement = runCatching { json.parseToJsonElement(tool.inputSchemaJson) }
                            .getOrElse { buildJsonObject { put("type", "object") } }
                        add(buildJsonObject {
                            put("name", tool.name)
                            put("description", tool.description)
                            put("inputSchema", schemaElement)
                        })
                    }
                }
                rpcResult(id, buildJsonObject {
                    put("tools", toolsArray)
                })
            }

            "tools/call" -> handleToolsCall(id, req["params"] as? JsonObject)

            else -> rpcError(id, -32601, "Method not found: $method")
        }
    }

    private suspend fun handleToolsCall(id: JsonElement, params: JsonObject?): JsonObject {
        val toolName = params?.get("name")?.jsonPrimitive?.contentOrNull
            ?: return rpcError(id, -32602, "Missing tool name")

        if (!isToolPermitted(toolName, backend.allowWakeUnlock())) {
            return rpcError(id, -32601, "Tool is disabled by Kiki Android host policy: $toolName")
        }

        val argsObj = (params["arguments"] as? JsonObject) ?: buildJsonObject {}
        if (toolName == "phone_open_link") {
            val url = (argsObj["url"] ?: argsObj["uri"])?.jsonPrimitive?.contentOrNull?.trim().orEmpty()
            val lower = url.lowercase()
            if (lower.startsWith("intent:") || lower.startsWith("file:") || lower.startsWith("javascript:") || lower.startsWith("content:")) {
                val blocked = buildJsonObject {
                    put("ok", false)
                    put("error", "blocked_scheme")
                    put("message", "Scheme is blocked by Kiki Android security policy.")
                }
                return rpcResult(id, formatMcpToolResult(HostMcpToolCallResult(blocked, isError = true)))
            }
        }

        val argsJson = argsObj.toString()
        val callResult = arbiter.withArbitration(
            toolName = toolName,
            argumentsJson = argsJson,
            block = {
                backend.callTool(toolName, argsJson, attended = backend.isAttended())
            },
            onBlocked = { blocked ->
                HostMcpToolCallResult(content = blocked.toJson(), isError = true)
            },
        )
        return rpcResult(id, formatMcpToolResult(callResult))
    }

    private fun formatMcpToolResult(result: HostMcpToolCallResult): JsonObject {
        val okFlag = result.content["ok"]?.jsonPrimitive?.booleanOrNull
        val isErr = result.isError || okFlag == false
        val contentBlocks = buildJsonArray {
            add(buildJsonObject {
                put("type", "text")
                put("text", result.content.toString())
            })
            val png = result.imagePngBytes
            if (png != null && png.isNotEmpty()) {
                add(buildJsonObject {
                    put("type", "image")
                    put("data", Base64.getEncoder().encodeToString(png))
                    put("mimeType", "image/png")
                })
            }
        }
        return buildJsonObject {
            put("content", contentBlocks)
            put("structuredContent", result.content)
            put("isError", isErr)
        }
    }

    private fun isToolPermitted(name: String, allowWakeUnlock: Boolean): Boolean {
        if (name in PERMANENTLY_BLOCKED_TOOLS) return false
        if (!allowWakeUnlock && name in WAKE_UNLOCK_TOOLS) return false
        if (name in DEFAULT_DISABLED_EXEC_TOOLS) return false
        if (!backend.isToolEnabled(name)) return false
        return true
    }

    private fun rpcResult(id: JsonElement, result: JsonObject): JsonObject = buildJsonObject {
        put("jsonrpc", "2.0")
        put("id", id)
        put("result", result)
    }

    private fun rpcError(id: JsonElement, code: Int, message: String): JsonObject = buildJsonObject {
        put("jsonrpc", "2.0")
        put("id", id)
        put("error", buildJsonObject {
            put("code", code)
            put("message", message)
        })
    }

    companion object {
        private const val DEFAULT_PROTOCOL = "2025-03-26"
        private val SUPPORTED_PROTOCOLS = setOf("2025-06-18", "2025-03-26", "2024-11-05")

        val PERMANENTLY_BLOCKED_TOOLS = setOf(
            "mika_run_task",
            "mika_steer_task",
            "mika_wait_task",
            "mika_task_status",
            "mika_answer",
            "mika_cancel_task",
            "mika_list_tasks",
        )

        val WAKE_UNLOCK_TOOLS = setOf(
            "device_wake",
            "device_unlock",
            "mika_wake_device",
            "mika_unlock_device",
        )

        val DEFAULT_DISABLED_EXEC_TOOLS = setOf(
            "phone_command",
            "phone_system_command",
            "phone_run",
        )
    }
}
