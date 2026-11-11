package dev.kiki.android.host

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

@Serializable
data class BootstrapGatewaySpec(
    val url: String,
    val mcpUrl: String,
    val secretToken: String,
    val mcpToken: String,
)

@Serializable
data class BootstrapDeviceSpec(
    val abi: String,
    val sdk: Int,
    val sandbox: Boolean,
    val workspaceDir: String? = null,
    val rootfsDir: String? = null,
)

@Serializable
data class BootstrapFrame(
    val v: Int = 1,
    val type: String = "bootstrap",
    val localOwnerToken: String,
    val preferredPort: Int,
    val gateway: BootstrapGatewaySpec,
    val device: BootstrapDeviceSpec,
)

sealed interface KernelOutboundFrame {
    data class Ready(
        val port: Int,
        val pid: Int,
        val version: String,
        val guiPath: String = "/",
    ) : KernelOutboundFrame

    data class Turns(
        val active: Int,
        val executing: Boolean = active > 0,
        val pendingInteraction: Boolean = false,
    ) : KernelOutboundFrame

    data class Attention(
        val kind: String,
        val sessionId: String,
        val title: String,
    ) : KernelOutboundFrame

    data class Recovered(
        val count: Int,
    ) : KernelOutboundFrame

    data class Pong(
        val seq: Long,
    ) : KernelOutboundFrame

    data class Fatal(
        val code: String,
        val message: String,
    ) : KernelOutboundFrame
}

object ControlProtocol {
    const val FRAME_PREFIX = "@@kiki "

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    fun encodeBootstrap(frame: BootstrapFrame): String =
        json.encodeToString(BootstrapFrame.serializer(), frame)

    fun encodePing(seq: Long): String = buildJsonObject {
        put("type", "ping")
        put("seq", seq)
    }.toString()

    fun encodeNetwork(available: Boolean, metered: Boolean): String = buildJsonObject {
        put("type", "network")
        put("state", if (available) "available" else "lost")
        put("metered", metered)
    }.toString()

    fun encodeTrimMemory(level: Int): String = buildJsonObject {
        put("type", "trim_memory")
        put("level", level)
    }.toString()

    fun encodeCancelActiveTurns(reason: String = "user_pill_stop"): String = buildJsonObject {
        put("type", "cancel_active_turns")
        put("reason", reason)
    }.toString()

    fun encodeShutdown(graceMs: Long = 5_000L): String = buildJsonObject {
        put("type", "shutdown")
        put("graceMs", graceMs)
    }.toString()

    fun parseStdoutLine(line: String): KernelOutboundFrame? {
        if (!line.startsWith(FRAME_PREFIX)) return null
        val payload = line.substring(FRAME_PREFIX.length).trim()
        if (payload.isEmpty()) return null
        val obj = runCatching { json.parseToJsonElement(payload) as? JsonObject }.getOrNull() ?: return null
        return when (obj["type"]?.jsonPrimitive?.contentOrNull) {
            "ready" -> {
                val port = obj["port"]?.jsonPrimitive?.intOrNull ?: return null
                val pid = obj["pid"]?.jsonPrimitive?.intOrNull ?: 0
                val version = obj["version"]?.jsonPrimitive?.contentOrNull ?: "unknown"
                val guiPath = obj["guiPath"]?.jsonPrimitive?.contentOrNull?.takeIf { it.startsWith("/") } ?: "/"
                KernelOutboundFrame.Ready(port = port, pid = pid, version = version, guiPath = guiPath)
            }

            "turns" -> {
                val active = obj["active"]?.jsonPrimitive?.intOrNull ?: 0
                val executing = obj["executing"]?.jsonPrimitive?.booleanOrNull ?: (active > 0)
                val pending = obj["pendingInteraction"]?.jsonPrimitive?.booleanOrNull ?: false
                KernelOutboundFrame.Turns(active = active, executing = executing, pendingInteraction = pending)
            }

            "attention" -> {
                val kind = obj["kind"]?.jsonPrimitive?.contentOrNull ?: "info"
                val sessionId = obj["sessionId"]?.jsonPrimitive?.contentOrNull ?: ""
                val title = obj["title"]?.jsonPrimitive?.contentOrNull ?: ""
                KernelOutboundFrame.Attention(kind = kind, sessionId = sessionId, title = title)
            }

            "recovered" -> {
                val count = obj["interrupted"]?.runCatching { jsonArray.size }?.getOrNull() ?: 0
                KernelOutboundFrame.Recovered(count = count)
            }

            "pong" -> {
                val seq = obj["seq"]?.jsonPrimitive?.longOrNull ?: 0L
                KernelOutboundFrame.Pong(seq = seq)
            }

            "fatal" -> {
                val code = obj["code"]?.jsonPrimitive?.contentOrNull ?: "fatal"
                val message = obj["message"]?.jsonPrimitive?.contentOrNull ?: ""
                KernelOutboundFrame.Fatal(code = code, message = message)
            }

            else -> null
        }
    }
}
