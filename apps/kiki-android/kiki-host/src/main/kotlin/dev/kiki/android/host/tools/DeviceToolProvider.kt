package dev.kiki.android.host.tools

import android.content.Context
import dev.kiki.android.host.HostMcpToolCallResult
import dev.kiki.android.host.HostMcpToolDescriptor
import dev.kiki.android.host.KikiHostEnvironment
import dev.kiki.android.host.screen.ScreenToolRole
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** User-controlled switch a tool needs before it is listed or callable. */
enum class ToolGate {
    NONE,
    WAKE_SCREEN,
    CLIPBOARD_READ,
    CLIPBOARD_WRITE,
}

/** One tool offered by a [DeviceToolProvider], with the screen role the arbiter applies to it. */
data class DeviceTool(
    val descriptor: HostMcpToolDescriptor,
    val role: ScreenToolRole = ScreenToolRole.NONE,
    val gate: ToolGate = ToolGate.NONE,
) {
    val name: String get() = descriptor.name
}

data class ToolCallContext(val attended: Boolean)

/**
 * A pluggable source of device tools that Kiki exposes to its kernel over the loopback MCP gateway.
 *
 * Providers carry no Android types in their contract, so a registry of them can be exercised on the JVM.
 * Screen-touching tools declare a [ScreenToolRole]; the host's ScreenArbiter yields Kiki's own window
 * before such a tool runs.
 */
interface DeviceToolProvider {
    val id: String

    fun tools(): List<DeviceTool>

    /** Argument-aware role override (for example a read that also captures a screenshot); null keeps the declared role. */
    fun classify(name: String, argumentsJson: String): ScreenToolRole? = null

    suspend fun call(name: String, argumentsJson: String, context: ToolCallContext): HostMcpToolCallResult

    fun close() {}
}

/** Screen facts the host needs from whichever module can observe other apps (for example an accessibility service). */
interface ScreenControlPort {
    fun isAccessibilityEnabled(): Boolean

    /** Foreground application package on the main display, ignoring Kiki's own overlay windows. */
    fun foregroundPackage(): String?

    fun isSplitScreenWithOtherAppVisible(): Boolean = false

    /** Context able to add TYPE_ACCESSIBILITY_OVERLAY windows when the overlay permission is missing. */
    fun overlayContext(): Context? = null

    /** Global HOME action used when Kiki cannot move its own task to the back. */
    fun goHome(): Boolean = false
}

/** A bundle of providers (and optionally a [ScreenControlPort]) that an app installs into the Kiki host. */
interface KikiToolModule {
    val id: String

    fun providers(context: Context, host: KikiHostEnvironment): List<DeviceToolProvider>

    fun screenControl(context: Context): ScreenControlPort? = null
}

object ToolResults {
    fun ok(build: JsonObjectBuilder.() -> Unit = {}): HostMcpToolCallResult =
        HostMcpToolCallResult(content = buildJsonObject {
            put("ok", true)
            build()
        })

    fun error(code: String, message: String? = null, build: JsonObjectBuilder.() -> Unit = {}): HostMcpToolCallResult =
        HostMcpToolCallResult(
            content = buildJsonObject {
                put("ok", false)
                put("error", code)
                if (message != null) put("message", message)
                build()
            },
            isError = true,
        )
}
