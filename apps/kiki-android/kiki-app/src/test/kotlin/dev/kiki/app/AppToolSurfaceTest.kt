package dev.kiki.app

import com.wangzan101.mika.core.uistate.ActionResult
import com.wangzan101.mika.core.uistate.ScreenPort
import com.wangzan101.mika.core.uistate.ScreenSnapshot
import dev.kiki.android.host.tools.CompositeToolRegistry
import dev.kiki.android.host.tools.SystemToolProvider
import dev.kiki.android.tools.screen.ScreenToolProvider
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Test
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class AppToolSurfaceTest {

    private val prettyJson = Json { prettyPrint = true }

    private class StubScreenPort : ScreenPort {
        override suspend fun snapshot() = ScreenSnapshot("phone-stub", null, emptyList(), 1080, 2400)
        override suspend fun screenshotPng(): ByteArray? = null
        override suspend fun tapRef(ref: String, snapshotId: String) = ActionResult.Failed("accessibility_disabled")
        override suspend fun tapXY(x: Int, y: Int) = ActionResult.Failed("accessibility_disabled")
        override suspend fun typeText(ref: String?, snapshotId: String?, text: String) = ActionResult.Failed("accessibility_disabled")
        override suspend fun clearText(ref: String?, snapshotId: String?) = ActionResult.Failed("accessibility_disabled")
        override suspend fun scroll(ref: String?, snapshotId: String?, down: Boolean) = ActionResult.Failed("accessibility_disabled")
        override suspend fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long) = ActionResult.Failed("accessibility_disabled")
        override suspend fun back() = ActionResult.Failed("accessibility_disabled")
        override suspend fun pressKey(keyCode: Int) = ActionResult.Failed("accessibility_disabled")
        override suspend fun openApp(packageName: String, cold: Boolean) = ActionResult.Failed("accessibility_disabled")
        override suspend fun waitStable(timeoutMs: Long) = false
        override suspend fun listApps(): List<Pair<String, String>> = emptyList()
    }

    @Test
    fun composedKikiToolSurface_has_system_and_screen_tools_without_legacy_mika_names_and_matches_snapshot() {
        val systemStub = object : dev.kiki.android.host.tools.DeviceToolProvider {
            override val id = "kiki.system"
            override fun tools() = SystemToolProvider.TOOL_DEFINITIONS
            override suspend fun call(
                name: String,
                argumentsJson: String,
                context: dev.kiki.android.host.tools.ToolCallContext,
            ) = error("unused")
        }
        val screenProvider = ScreenToolProvider(StubScreenPort(), "dev.kiki.app")
        val registry = CompositeToolRegistry(listOf(systemStub, screenProvider))

        val tools = registry.tools()
        val names = tools.map { it.name }

        assertTrue("device_info" in names)
        assertTrue("clipboard_read" in names)
        assertTrue("clipboard_write" in names)
        assertTrue("open_uri" in names)
        assertTrue("share_content" in names)
        assertTrue("shared_inbox" in names)
        assertTrue("device_wake" in names)
        assertTrue("phone_observe" in names)
        assertFalse(names.any { it.startsWith("mika_") }, "No legacy mika_* tool names may appear in Kiki")

        val snapshotFile = File("../kiki-host/src/main/assets/kiki/android-tools.snapshot.json")
        val payload = buildJsonObject {
            put("tools", buildJsonArray {
                for (tool in tools) add(buildJsonObject {
                    put("name", tool.name)
                    put("description", tool.descriptor.description)
                    put("inputSchema", prettyJson.parseToJsonElement(tool.descriptor.inputSchemaJson))
                })
            })
        }
        if (System.getProperty("updateToolsSnapshot") == "true") {
            snapshotFile.writeText(prettyJson.encodeToString(kotlinx.serialization.json.JsonObject.serializer(), payload) + "\n")
        }
        assertTrue(snapshotFile.isFile, "Expected snapshot asset at ${snapshotFile.path}")
        assertEquals(prettyJson.parseToJsonElement(snapshotFile.readText()), payload)
    }
}
