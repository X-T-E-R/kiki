package dev.kiki.android.host.tools

import dev.kiki.android.host.HostMcpToolCallResult
import dev.kiki.android.host.screen.ScreenToolRole
import kotlinx.coroutines.CancellationException

/**
 * Merges several [DeviceToolProvider]s into one tool surface.
 *
 * Providers are consulted in registration order; when two providers offer the same tool name the first one wins,
 * so a host can shadow a module's tool by registering its own provider earlier.
 */
class CompositeToolRegistry(providers: List<DeviceToolProvider>) {
    private val providers: List<DeviceToolProvider> = providers.distinctBy { it.id }

    val providerIds: List<String> get() = providers.map { it.id }

    fun tools(): List<DeviceTool> {
        val seen = HashSet<String>()
        val merged = ArrayList<DeviceTool>()
        for (provider in providers) {
            for (tool in safeTools(provider)) {
                if (seen.add(tool.name)) merged += tool
            }
        }
        return merged
    }

    fun gateOf(name: String): ToolGate? = resolve(name)?.second?.gate

    fun classify(name: String, argumentsJson: String): ScreenToolRole? {
        val (provider, tool) = resolve(name) ?: return null
        return provider.classify(name, argumentsJson) ?: tool.role
    }

    suspend fun call(name: String, argumentsJson: String, context: ToolCallContext): HostMcpToolCallResult {
        val (provider, _) = resolve(name)
            ?: return ToolResults.error("unknown_tool", "No installed device tool is named $name.") { put("tool", name) }
        return try {
            provider.call(name, argumentsJson, context)
        } catch (cancel: CancellationException) {
            throw cancel
        } catch (err: Throwable) {
            ToolResults.error("tool_failed", err.message ?: err.javaClass.simpleName) {
                put("tool", name)
                put("provider", provider.id)
            }
        }
    }

    fun close() {
        providers.forEach { runCatching { it.close() } }
    }

    private fun resolve(name: String): Pair<DeviceToolProvider, DeviceTool>? {
        for (provider in providers) {
            val tool = safeTools(provider).firstOrNull { it.name == name } ?: continue
            return provider to tool
        }
        return null
    }

    private fun safeTools(provider: DeviceToolProvider): List<DeviceTool> =
        runCatching { provider.tools() }.getOrDefault(emptyList())

    private fun kotlinx.serialization.json.JsonObjectBuilder.put(key: String, value: String) {
        put(key, kotlinx.serialization.json.JsonPrimitive(value))
    }
}
