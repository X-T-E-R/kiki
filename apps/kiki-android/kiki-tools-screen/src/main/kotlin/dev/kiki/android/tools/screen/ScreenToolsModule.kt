package dev.kiki.android.tools.screen

import android.accessibilityservice.AccessibilityService
import android.content.ComponentName
import android.content.Context
import android.provider.Settings
import android.view.Display
import android.view.accessibility.AccessibilityWindowInfo
import com.wangzan101.mika.core.cap.phone.PhoneArgs
import com.wangzan101.mika.core.cap.phone.PhoneArgError
import com.wangzan101.mika.core.cap.phone.PhoneTools
import com.wangzan101.mika.core.uistate.ScreenPort
import dev.kiki.android.host.HostMcpToolCallResult
import dev.kiki.android.host.HostMcpToolDescriptor
import dev.kiki.android.host.KikiHostEnvironment
import dev.kiki.android.host.screen.ScreenToolRole
import dev.kiki.android.host.tools.DeviceTool
import dev.kiki.android.host.tools.DeviceToolProvider
import dev.kiki.android.host.tools.KikiToolModule
import dev.kiki.android.host.tools.ScreenControlPort
import dev.kiki.android.host.tools.ToolCallContext
import dev.kiki.android.host.tools.ToolResults
import dev.kiki.android.tools.screen.a11y.KikiAccessibilityService
import dev.kiki.android.tools.screen.a11y.ScreenReader
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*

/** Optional screen tools remain available when accessibility is disabled, returning structured failures on use. */
class ScreenToolsModule : KikiToolModule {
    override val id: String = "kiki.screen"

    override fun providers(context: Context, host: KikiHostEnvironment): List<DeviceToolProvider> {
        val appCtx = context.applicationContext
        return listOf(ScreenToolProvider(KikiMainScreenPort(appCtx), appCtx.packageName))
    }

    override fun screenControl(context: Context): ScreenControlPort = KikiScreenControlPort(context.applicationContext)
}

internal class KikiScreenControlPort(private val appContext: Context) : ScreenControlPort {
    override fun isAccessibilityEnabled(): Boolean {
        if (KikiAccessibilityService.instance.value != null) return true
        val expected = ComponentName(appContext.packageName, KikiAccessibilityService::class.java.name)
        val enabled = runCatching {
            Settings.Secure.getString(appContext.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
        }.getOrNull().orEmpty()
        return enabled.split(':').any { ComponentName.unflattenFromString(it) == expected }
    }

    override fun foregroundPackage(): String? {
        val a11y = KikiAccessibilityService.instance.value ?: return null
        val windows = a11y.windowsOn(Display.DEFAULT_DISPLAY).filter { w ->
            KikiMainScreenPort.shouldIncludeWindowInSnapshot(w.root?.packageName?.toString(), w.type, appContext.packageName)
        }
        return ScreenReader.topPackage(windows)
    }

    override fun isSplitScreenWithOtherAppVisible(): Boolean {
        val a11y = KikiAccessibilityService.instance.value ?: return false
        val windows = ScreenReader.contentWindows(a11y.windowsOn(Display.DEFAULT_DISPLAY))
            .filter { it.type == AccessibilityWindowInfo.TYPE_APPLICATION }
        return windows.mapNotNull { it.root?.packageName?.toString() }.distinct().size >= 2
    }

    override fun overlayContext(): Context? = KikiAccessibilityService.instance.value

    override fun goHome(): Boolean {
        val a11y = KikiAccessibilityService.instance.value ?: return false
        return runCatching { a11y.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME) }.getOrDefault(false)
    }
}

class ScreenToolProvider(screenPort: ScreenPort, selfPackage: String) : DeviceToolProvider {
    override val id: String = "kiki.screen"
    private val mutex = Mutex()
    private val phone = PhoneTools(screenPort, selfPackage)
    private val schemas = catalog.associate { it.getValue("name").jsonPrimitive.content to it.getValue("inputSchema").jsonObject }
    private val cachedTools = catalog.map { spec ->
        val name = spec.getValue("name").jsonPrimitive.content
        DeviceTool(
            HostMcpToolDescriptor(name, spec.getValue("description").jsonPrimitive.content, spec.getValue("inputSchema").toString()),
            screenRole(name),
        )
    }

    init {
        check(schemas.keys == phone.handlers.keys.mapTo(HashSet()) { "phone_$it" }) { "Phone catalog and execution handlers must match" }
    }

    override fun tools(): List<DeviceTool> = cachedTools

    override fun classify(name: String, argumentsJson: String): ScreenToolRole? =
        if (name in schemas) screenRole(name) else null

    private fun screenRole(name: String): ScreenToolRole = when (name) {
        "phone_observe", "phone_screenshot" -> ScreenToolRole.SCREENSHOT
        "phone_list_elements", "phone_diagnose", "phone_query", "phone_extract", "phone_wait", "phone_event" -> ScreenToolRole.READ
        "phone_list_apps", "phone_app_after_task", "phone_calendar_bulk_insert" -> ScreenToolRole.NONE
        else -> ScreenToolRole.ACT
    }

    override suspend fun call(name: String, argumentsJson: String, context: ToolCallContext): HostMcpToolCallResult = mutex.withLock {
        val schema = schemas[name] ?: return@withLock ToolResults.error("unknown_tool", "Screen tool is not offered: $name")
        val args = try { PhoneArgs.parse(argumentsJson, schema) }
        catch (e: PhoneArgError) { return@withLock ToolResults.error("invalid_args", e.message) }
        phone.call(name.removePrefix("phone_"), args)
    }

    companion object {
        private val catalog: List<JsonObject> = ScreenToolProvider::class.java
            .getResourceAsStream("phone-tools.json")!!.bufferedReader().use { input ->
                Json.parseToJsonElement(input.readText()).jsonArray.map { it.jsonObject }
            }
        val EXCLUDED_SHELL_TOOLS = setOf("phone_command", "phone_system_command", "phone_run")
    }
}
