package dev.kiki.android.tools.screen

import com.wangzan101.mika.core.uistate.ActionResult
import com.wangzan101.mika.core.uistate.ScreenPort
import com.wangzan101.mika.core.uistate.ScreenSnapshot
import com.wangzan101.mika.core.uistate.UiElement
import dev.kiki.android.host.screen.ScreenToolRole
import dev.kiki.android.host.tools.ToolCallContext
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ScreenToolProviderTest {

    private class DisabledAccessibilityPort : ScreenPort {
        override suspend fun snapshot(): ScreenSnapshot = ScreenSnapshot(
            snapshotId = "phone-disabled-1",
            packageName = null,
            elements = emptyList(),
            width = 1080,
            height = 2400,
            hasWindow = false,
            captureError = "accessibility_disabled",
        )

        override suspend fun screenshotPng(): ByteArray? = null
        override suspend fun tapRef(ref: String, snapshotId: String): ActionResult = noA11y()
        override suspend fun tapXY(x: Int, y: Int): ActionResult = noA11y()
        override suspend fun typeText(ref: String?, snapshotId: String?, text: String): ActionResult = noA11y()
        override suspend fun clearText(ref: String?, snapshotId: String?): ActionResult = noA11y()
        override suspend fun scroll(ref: String?, snapshotId: String?, down: Boolean): ActionResult = noA11y()
        override suspend fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long): ActionResult = noA11y()
        override suspend fun back(): ActionResult = noA11y()
        override suspend fun pressKey(keyCode: Int): ActionResult = noA11y()
        override suspend fun openApp(packageName: String, cold: Boolean): ActionResult = noA11y()
        override suspend fun waitStable(timeoutMs: Long): Boolean = false
        override suspend fun listApps(): List<Pair<String, String>> = listOf("com.android.chrome" to "Chrome")

        private fun noA11y() = ActionResult.Failed("accessibility_disabled", "Accessibility service is turned off.")
    }

    @Test
    fun screenToolProvider_lists_phone_tools_excludes_shell_and_degrades_gracefully_without_accessibility() = runTest {
        val provider = ScreenToolProvider(
            screenPort = DisabledAccessibilityPort(),
            selfPackage = "dev.kiki.app",
        )
        val names = provider.tools().map { it.name }.toSet()

        assertTrue("phone_observe" in names)
        assertTrue("phone_tap" in names)
        assertTrue("phone_screenshot" in names)
        assertFalse("phone_command" in names)
        assertFalse("phone_system_command" in names)
        assertFalse("phone_run" in names)
        assertTrue(names.none { it.startsWith("mika_") })

        assertEquals(ScreenToolRole.SCREENSHOT, provider.classify("phone_observe", "{}"))
        for (name in listOf("phone_share_text", "phone_show_alarms", "phone_add_calendar_event", "phone_set_alarm", "phone_set_timer")) {
            assertEquals(ScreenToolRole.ACT, provider.classify(name, "{}"), name)
        }
        assertEquals(ScreenToolRole.ACT, provider.classify("phone_tap", """{"ref":"@e1"}"""))

        // Calling phone_back when accessibility is off returns structured failure without throwing or crashing
        val backResult = provider.call("phone_back", "{}", ToolCallContext(attended = true))
        assertTrue(backResult.isError)
        assertTrue(backResult.content.toString().contains("accessibility_disabled"))

        // Calling phone_observe when accessibility is off succeeds with captureError=accessibility_disabled
        val observeResult = provider.call("phone_observe", "{}", ToolCallContext(attended = true))
        assertTrue(observeResult.content.toString().contains("accessibility_disabled"))

        // Listing installed apps still works without accessibility service
        val appsResult = provider.call("phone_list_apps", "{}", ToolCallContext(attended = true))
        assertFalse(appsResult.isError)
        assertTrue(appsResult.content.toString().contains("com.android.chrome"))
    }

    private class RecordingPort : ScreenPort by DisabledAccessibilityPort() {
        var count = 0
        var packageName = "com.example.notes"
        var name = "Continue"
        var taps = mutableListOf<Pair<String, String>>()
        var points = mutableListOf<Pair<Int, Int>>()
        var swipes = mutableListOf<List<Int>>()
        var typed = mutableListOf<String>()
        var keys = mutableListOf<Int>()
        var bulkWrites = 0
        var protected = false
        var verification = com.wangzan101.mika.core.uistate.Verification.MATCH
        var appSwitched: String? = null
        var afterType: (() -> Unit)? = null
        var fieldValue: String? = null
        var extraElements = emptyList<UiElement>()
        override suspend fun snapshot() = ScreenSnapshot(
            "port-${++count}", packageName,
            listOf(UiElement("raw-$count", if (fieldValue == null) "button" else "textbox", fieldValue ?: name,
                50, 100, listOf(400, 400, 600, 600), "continue", true, fieldValue != null, false, focused = true)) + extraElements,
            101, 201, protected = protected,
        )
        override suspend fun peek() = snapshot()
        override suspend fun isProtected() = protected
        override suspend fun tapRef(ref: String, snapshotId: String): ActionResult {
            taps += ref to snapshotId
            return ActionResult.Ok(changed = true)
        }
        override suspend fun tapXY(x: Int, y: Int): ActionResult {
            points += x to y
            return ActionResult.Ok()
        }
        override suspend fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long): ActionResult {
            swipes += listOf(x1, y1, x2, y2, durationMs.toInt())
            return ActionResult.Ok()
        }
        override suspend fun typeText(ref: String?, snapshotId: String?, text: String): ActionResult {
            typed += text
            fieldValue = text
            afterType?.invoke()
            return ActionResult.Ok(verification = verification, appSwitched = appSwitched, textReadback = text.takeIf { verification.wire == "match" })
        }
        override suspend fun pressKey(keyCode: Int): ActionResult { keys += keyCode; return ActionResult.Ok() }
        override suspend fun bulkCalendarInsert(events: List<com.wangzan101.mika.core.uistate.SystemAction.AddCalendarEvent>): com.wangzan101.mika.core.uistate.SystemActionResult {
            bulkWrites++
            return com.wangzan101.mika.core.uistate.SystemActionResult(ActionResult.Ok(), eventUris = listOf("bad-uri"))
        }
    }

    @Test
    fun stable_refs_resolve_to_current_port_ref_and_retire_when_the_target_changes() = runTest {
        val port = RecordingPort()
        val provider = ScreenToolProvider(port, "dev.kiki.app")
        val context = ToolCallContext(true)
        val first = provider.call("phone_list_elements", "{}", context)
        val sid = first.content.getValue("snapshotId").jsonPrimitive.content
        provider.call("phone_list_elements", "{}", context)
        val tap = provider.call("phone_tap", """{"ref":"@e1","snapshotId":"$sid"}""", context)
        assertFalse(tap.isError)
        assertEquals("raw-2" to "port-2", port.taps.single())
        port.name = "Delete"
        provider.call("phone_list_elements", "{}", context)
        val stale = provider.call("phone_tap", """{"ref":"@e1","snapshotId":"$sid"}""", context)
        assertEquals("ref_expired", stale.content.getValue("error").jsonPrimitive.content)
        assertEquals(1, port.taps.size)
    }

    @Test
    fun validates_external_arguments_before_actions_and_translates_coordinates() = runTest {
        val port = RecordingPort()
        val provider = ScreenToolProvider(port, "dev.kiki.app")
        val context = ToolCallContext(true)
        for (args in listOf("[]", "{", """{"x":1000,"y":0}""", """{"x":1}""", """{"surprise":true}""")) {
            val result = provider.call("phone_tap", args, context)
            assertEquals("invalid_args", result.content.getValue("error").jsonPrimitive.content, args)
        }
        assertTrue(port.points.isEmpty())
        assertFalse(provider.call("phone_tap", """{"x":999,"y":999}""", context).isError)
        assertEquals(100 to 200, port.points.single())
        assertFalse(provider.call("phone_swipe", """{"startX":0,"startY":999,"endX":999,"endY":0,"durationMs":600}""", context).isError)
        assertEquals(listOf(0, 200, 100, 0, 600), port.swipes.single())
        port.fieldValue = ""
        assertFalse(provider.call("phone_type_text", """{"text":"hello","pressEnter":true}""", context).isError)
        assertEquals(listOf("hello"), port.typed)
        assertEquals(listOf(66), port.keys)
        assertTrue(provider.call("phone_press_key", """{"key":"KEYCODE_POWER"}""", context).isError)
        assertEquals(listOf(66), port.keys)
    }

    @Test
    fun unverified_or_switched_input_never_sends_enter_and_mismatch_is_an_error() = runTest {
        val port = RecordingPort()
        val provider = ScreenToolProvider(port, "dev.kiki.app")
        val context = ToolCallContext(true)
        port.verification = com.wangzan101.mika.core.uistate.Verification.UNKNOWN
        assertFalse(provider.call("phone_type_text", """{"text":"hello","pressEnter":true}""", context).isError)
        assertTrue(port.keys.isEmpty())
        port.verification = com.wangzan101.mika.core.uistate.Verification.MATCH
        port.appSwitched = "com.example.other"
        assertFalse(provider.call("phone_type_text", """{"text":"hello","pressEnter":true}""", context).isError)
        assertTrue(port.keys.isEmpty())
        port.appSwitched = null
        port.verification = com.wangzan101.mika.core.uistate.Verification.MISMATCH
        val failed = provider.call("phone_type_text", """{"text":"hello","pressEnter":true}""", context)
        assertEquals("action_not_applied", failed.content.getValue("error").jsonPrimitive.content)
        assertTrue(port.keys.isEmpty())
        port.verification = com.wangzan101.mika.core.uistate.Verification.MATCH
        port.afterType = { port.packageName = "com.example.other" }
        val moved = provider.call("phone_type_text", """{"text":"hello","pressEnter":true}""", context)
        assertFalse(moved.isError)
        assertTrue(port.keys.isEmpty())
        assertEquals("hello", moved.content.getValue("effect").jsonObject.getValue("readback").jsonPrimitive.content)
        port.afterType = { port.fieldValue = "different field" }
        val refocused = provider.call("phone_type_text", """{"text":"hello","pressEnter":true}""", context)
        assertFalse(refocused.isError)
        assertTrue(port.keys.isEmpty())
        assertEquals("hello", refocused.content.getValue("effect").jsonObject.getValue("readback").jsonPrimitive.content)
    }

    @Test
    fun self_payment_protected_capture_and_unconfirmed_calendar_writes_stay_blocked() = runTest {
        val port = RecordingPort()
        val provider = ScreenToolProvider(port, "dev.kiki.app")
        val context = ToolCallContext(true)
        port.packageName = "dev.kiki.app"
        assertEquals("self_target_blocked", provider.call("phone_tap", """{"x":500,"y":500}""", context).content.getValue("error").jsonPrimitive.content)
        port.packageName = "com.example.notes"
        port.name = "确认支付"
        assertEquals("confirmation_required", provider.call("phone_tap", """{"x":500,"y":500}""", context).content.getValue("error").jsonPrimitive.content)
        assertTrue(port.points.isEmpty())
        port.name = "提交订单"
        assertEquals("confirmation_required", provider.call("phone_tap", """{"x":500,"y":500}""", context).content.getValue("error").jsonPrimitive.content)
        assertEquals("confirmation_required", provider.call("phone_press_key", """{"key":"KEYCODE_ENTER"}""", context).content.getValue("error").jsonPrimitive.content)
        assertTrue(port.points.isEmpty())
        assertTrue(port.keys.isEmpty())
        port.name = "提交"
        port.extraElements = listOf(
            UiElement("method", "text", "付款方式", 10, 10, listOf(10, 10, 200, 50), null, false, false, false),
            UiElement("amount", "text", "¥25", 10, 20, listOf(10, 50, 200, 100), null, false, false, false),
        )
        assertEquals("confirmation_required", provider.call("phone_tap", """{"x":500,"y":500}""", context).content.getValue("error").jsonPrimitive.content)
        assertEquals("confirmation_required", provider.call("phone_press_key", """{"key":"KEYCODE_ENTER"}""", context).content.getValue("error").jsonPrimitive.content)
        assertTrue(port.points.isEmpty())
        assertTrue(port.keys.isEmpty())
        port.protected = true
        assertEquals("protected_content", provider.call("phone_screenshot", "{}", context).content.getValue("error").jsonPrimitive.content)
        val invalid = provider.call("phone_calendar_bulk_insert", """{"events":[{"title":"Example","start":"bad-time"}]}""", context)
        assertEquals("invalid_args", invalid.content.getValue("error").jsonPrimitive.content)
        assertEquals(0, port.bulkWrites)
        val unconfirmed = provider.call("phone_calendar_bulk_insert", """{"events":[{"title":"Example","start":"2026-11-12T10:00"}]}""", context)
        assertEquals("calendar_write_unconfirmed", unconfirmed.content.getValue("error").jsonPrimitive.content)
        assertEquals(1, port.bulkWrites)
    }

    @Test
    fun described_targets_effect_feedback_and_limited_queries_keep_their_contract() = runTest {
        val port = RecordingPort()
        val provider = ScreenToolProvider(port, "dev.kiki.app")
        val context = ToolCallContext(true)
        port.name = "Continue to details"
        val tapped = provider.call("phone_tap", """{"element":"Continue"}""", context)
        assertFalse(tapped.isError)
        assertEquals("Continue to details", tapped.content.getValue("matched").jsonObject.getValue("name").jsonPrimitive.content)
        assertEquals("small_change", tapped.content.getValue("effect").jsonObject.getValue("kind").jsonPrimitive.content)
        assertTrue("snapshotId" in tapped.content.getValue("screen").jsonObject)
        val query = provider.call("phone_query", """{"limit":1}""", context)
        assertEquals(1, query.content.getValue("matches").jsonArray.size)
        assertFalse("tree" in query.content)
        assertFalse("elements" in query.content)
        val unavailable = provider.call("phone_wait", """{"condition":"activity","value":"com.example.Activity"}""", context)
        assertEquals("activity_wait_unavailable", unavailable.content.getValue("error").jsonPrimitive.content)
        assertEquals("after_task_unavailable", provider.call("phone_app_after_task", """{"package":"com.example.notes","action":"close","reason":"done"}""", context).content.getValue("error").jsonPrimitive.content)
    }
}
