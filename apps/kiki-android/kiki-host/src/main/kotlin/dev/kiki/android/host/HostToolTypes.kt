package dev.kiki.android.host

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

@Serializable
data class HostMcpToolDescriptor(
    val name: String,
    val description: String,
    val inputSchemaJson: String,
)

data class HostMcpToolCallResult(
    val content: JsonObject,
    val imagePngBytes: ByteArray? = null,
    val isError: Boolean = false,
)

data class SandboxDeviceSpec(
    val available: Boolean,
    val rootfsPath: String? = null,
    val workspacePath: String? = null,
)
