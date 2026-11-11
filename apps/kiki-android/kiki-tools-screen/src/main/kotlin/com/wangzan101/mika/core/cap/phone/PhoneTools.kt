// Adapted from Mika (Copyright (c) wangzan101 and Mika contributors), Apache-2.0.
package com.wangzan101.mika.core.cap.phone

import com.wangzan101.mika.core.access.AppAccessDenied
import com.wangzan101.mika.core.uistate.*
import dev.kiki.android.host.HostMcpToolCallResult
import dev.kiki.android.host.tools.ToolResults
import kotlinx.serialization.json.*
import kotlin.math.roundToInt

internal class PhoneTools(private val port: ScreenPort, private val selfPackage: String) {
    private val refs = RefStabilizer(PHONE_SNAPSHOT_PREFIX)
    private var screenshotId = 0
    private val reads = PhoneReadTools(port, ::snapshot, ::read, ::scroll, ::tap)

    val handlers: Map<String, suspend (PhoneArgs) -> HostMcpToolCallResult> = mapOf(
        "observe" to { read(withImage = true) },
        "list_elements" to { read() },
        "screenshot" to ::screenshot,
        "tap" to ::tap,
        "scroll" to ::scroll,
        "swipe" to ::swipe,
        "type_text" to { edit(it, clear = false) },
        "clear_text" to { edit(it, clear = true) },
        "back" to { mutate { port.back() } },
        "press_key" to { a ->
            val key = PressKeys.resolve(a.text("key")!!) ?: throw PhoneArgError("key", "not an allowed navigation or editing key")
            if (PaymentTargets.key(port.peek(), key)) ToolResults.error("confirmation_required", "Complete the payment or order yourself on the device.")
            else mutate { port.pressKey(key) }
        },
        "diagnose" to { diagnose() },
        "query" to { a ->
            val snap = snapshot()
            HostMcpToolCallResult(JsonObject(mapOf("ok" to JsonPrimitive(true)) + PhoneAutomationEngine.find(snap, a.query(), a.int("limit") ?: 30)))
        },
        "find" to reads::find,
        "extract" to reads::extract,
        "collect" to reads::collect,
        "wait" to reads::waitFor,
        "event" to reads::event,
        "dialog" to reads::dialog,
        "gesture" to ::gesture,
        "set_wheel" to ::wheel,
    ) + PhoneAppTools(port, selfPackage, ::mutate).handlers

    suspend fun call(name: String, a: PhoneArgs): HostMcpToolCallResult = try {
        handlers.getValue(name)(a)
    } catch (e: PhoneArgError) {
        ToolResults.error("invalid_args", e.message)
    } catch (e: AppAccessDenied) {
        ToolResults.error(e.code, e.message) {
            put("retryable", false)
            e.packageName?.let { put("package", it) }
        }
    }

    private suspend fun snapshot(): ScreenSnapshot = refs.next(port.snapshot()).screen

    private suspend fun read(withImage: Boolean = false) = read(snapshot(), withImage)

    private suspend fun read(s: ScreenSnapshot, withImage: Boolean = false): HostMcpToolCallResult {
        val ocr = if (s.hasWindow && !s.protected && !s.elements.any { it.secret }) {
            port.readVisibleText()?.let { VisibleText.missing(s, VisibleText.legible(it)) }.orEmpty()
        } else emptyList()
        val (elements, omitted) = ScreenJson.elements(s, 250)
        val image = if (withImage && !s.protected) port.screenshotPng() else null
        return HostMcpToolCallResult(buildJsonObject {
            put("ok", true)
            put("snapshotId", s.snapshotId)
            put("currentApp", s.packageName ?: s.unreadableApp)
            put("width", s.width)
            put("height", s.height)
            put("elements", elements)
            put("text", ScreenText.render(s))
            if (s.windows.isNotEmpty()) put("tree", UiTreeJson.windows(s))
            if (omitted > 0) put("omitted", omitted)
            if (s.changedDuringRead) put("changedDuringRead", true)
            if (s.protected) put("protected", true)
            if (s.elements.none { it.meaningful } && ocr.isEmpty()) put("readable", false)
            s.captureError?.let { put("captureError", it) }
            if (ocr.isNotEmpty()) {
                put("visibleText", VisibleText.json(ocr))
                ScreenMap.json(s, ocr)?.let { put("screenMap", it) }
            }
            if (image != null) put("screenshotId", "s${++screenshotId}")
        }, imagePngBytes = image)
    }

    private suspend fun screenshot(a: PhoneArgs): HostMcpToolCallResult {
        if (a.text("savePath") != null) return ToolResults.error("screenshot_save_unavailable", "Saving screenshots is not available in the Android host.")
        port.checkAppAccess()
        if (port.isProtected()) return ToolResults.error("protected_content") { put("protected", true) }
        val image = port.screenshotPng() ?: return ToolResults.error("screenshot_unavailable")
        return HostMcpToolCallResult(buildJsonObject {
            put("ok", true)
            put("screenshotId", "s${++screenshotId}")
            refs.latest?.port?.let { put("width", it.width); put("height", it.height) }
        }, imagePngBytes = image)
    }

    private suspend fun diagnose(): HostMcpToolCallResult {
        val s = snapshot()
        val check = port.checkScreen() ?: ScreenDiagnosis.classify(ScreenFacts(
            s.packageName, s.hasWindow, s.elements.count { it.meaningful }, s.changedDuringRead,
            emptyList(), s.elements.filterNot { it.secret }.map { it.name }, s.elements.any { it.secret },
        ))
        return ToolResults.ok {
            put("state", check.state.wire); put("currentApp", check.currentApp); put("needsHuman", check.needsHuman)
            check.takeoverReason?.let { put("takeoverReason", it) }
            check.cause?.let { put("cause", it) }
            s.captureError?.let { put("captureError", it) }
        }
    }

    private suspend fun mutate(action: suspend () -> ActionResult): HostMcpToolCallResult {
        port.checkAppAccess()
        val before = port.peek()
        if (before.packageName == selfPackage) return ToolResults.error("self_target_blocked")
        return when (val outcome = action()) {
            is ActionResult.Failed -> ToolResults.error(outcome.reason, outcome.hint)
            is ActionResult.Ok -> {
                val current = snapshot()
                val after = read(current)
                val switched = outcome.appSwitched ?: current.packageName?.takeIf { before.packageName != null && it != before.packageName }
                fun state(s: ScreenSnapshot) = s.elements.map { e -> listOf(e.role, e.name, e.resourceId, e.bounds, e.focused, e.states) }
                val kind = when {
                    switched != null -> "place_changed"
                    outcome.verification == Verification.MATCH -> "done"
                    state(before) != state(current) || outcome.changed == true -> "small_change"
                    else -> "no_effect"
                }
                ToolResults.ok {
                    put("screen", after.content)
                    put("effect", buildJsonObject {
                        put("kind", kind)
                        switched?.let { put("to", it) }
                        outcome.textReadback?.takeUnless { outcome.secret }?.let {
                            put("readback", it.take(200))
                            put("readbackMatches", outcome.verification == Verification.MATCH)
                        }
                    })
                    outcome.changed?.let { put("changed", it) }
                    switched?.let { put("appSwitched", it) }
                    if (outcome.relocated) put("relocated", true)
                    outcome.relocatedTo?.let { put("relocatedTo", it) }
                    outcome.verification?.let { put("verification", it.wire) }
                    outcome.hint?.let { put("hint", it) }
                    outcome.coveredBy?.let { put("coveredBy", it) }
                    outcome.chooser?.let { put("chooser", it.toJson()) }
                    outcome.opened?.let { put("opened", it.toJson()) }
                }
            }
        }
    }

    private suspend fun tap(a: PhoneArgs): HostMcpToolCallResult {
        val clicks = a.int("clicks") ?: 1
        return target(a, editable = false, allowFocus = false) { target ->
            when (target) {
                is PhoneTarget.Ref -> if (clicks == 2) port.doubleTapRef(target.ref, target.snapshotId) else port.tapRef(target.ref, target.snapshotId)
                is PhoneTarget.Point -> if (clicks == 2) port.doubleTapXY(target.x, target.y) else port.tapXY(target.x, target.y)
                PhoneTarget.Focus -> error("Tap requires a target")
            }
        }
    }

    private suspend fun edit(a: PhoneArgs, clear: Boolean): HostMcpToolCallResult =
        target(a, editable = true, allowFocus = true) { target ->
            val text = a.text("text")
            val submit = a.bool("pressEnter")
            val beforeTyping = if (submit) port.peek() else null
            val inputBefore = beforeTyping?.elements?.filter { it.editable }?.singleOrNull { e ->
                when (target) {
                    is PhoneTarget.Ref -> e.ref == target.ref
                    is PhoneTarget.Point -> e.bounds.size == 4 && normalize(target.x, beforeTyping.width) in e.bounds[0]..e.bounds[2] &&
                        normalize(target.y, beforeTyping.height) in e.bounds[1]..e.bounds[3]
                    PhoneTarget.Focus -> e.focused
                }
            }
            val result = when (target) {
                is PhoneTarget.Ref -> if (clear) port.clearText(target.ref, target.snapshotId) else port.typeText(target.ref, target.snapshotId, text!!)
                is PhoneTarget.Point -> if (clear) port.clearAt(target.x, target.y) else port.typeAt(target.x, target.y, text!!)
                PhoneTarget.Focus -> if (clear) port.clearText(null, null) else port.typeText(null, null, text!!)
            }
            if (result !is ActionResult.Ok) return@target result
            if (result.verification == Verification.MISMATCH) return@target ActionResult.Failed("action_not_applied", result.hint)
            if (!submit) return@target result
            port.checkAppAccess()
            val current = port.peek()
            val focus = current.elements.singleOrNull { it.focused && it.editable }
            if (result.verification != Verification.MATCH || result.appSwitched != null || beforeTyping?.packageName == null ||
                current.packageName != beforeTyping.packageName || current.packageName == selfPackage || focus == null || inputBefore == null ||
                focus.role != inputBefore.role || focus.resourceId != inputBefore.resourceId || focus.bounds != inputBefore.bounds ||
                focus.name != result.textReadback || PaymentTargets.key(current, 66)
            ) {
                return@target result.copy(hint = "Text was entered without pressing Enter because the current submission target could not be verified.")
            }
            val enter = port.pressKey(66)
            if (enter is ActionResult.Failed) enter else result
        }

    private suspend fun target(
        a: PhoneArgs, editable: Boolean, allowFocus: Boolean, perform: suspend (PhoneTarget) -> ActionResult,
    ): HostMcpToolCallResult {
        val ref = a.text("ref"); val sid = a.text("snapshotId")
        val element = a.text("element"); val role = a.text("role")
        val x = a.int("x"); val y = a.int("y")
        if ((ref == null) != (sid == null)) throw PhoneArgError("ref", "give ref and snapshotId together")
        if ((x == null) != (y == null)) throw PhoneArgError("x", "give x and y together")
        if (role != null && element == null) throw PhoneArgError("role", "requires element")
        if (listOf(ref, element, x).count { it != null } > 1) throw PhoneArgError("target", "give only one kind of target")
        var matched: DescribedMatch.Found? = null
        val modelRef = if (element != null) {
            val s = snapshot()
            when (val found = DescribedTarget.match(s.elements, ElementQuery(element, role, editable))) {
                DescribedMatch.None -> return ToolResults.error("element_not_found")
                is DescribedMatch.Ambiguous -> return ToolResults.error("element_ambiguous") {
                    put("snapshotId", s.snapshotId)
                    put("candidates", JsonArray(found.candidates.take(20).map { e -> buildJsonObject {
                        put("ref", e.ref); put("name", e.name); put("role", e.role)
                        DescribedTarget.neighbour(e, s.elements)?.let { put("near", it) }
                    } }))
                }
                is DescribedMatch.Found -> { matched = found; found.element.ref to s.snapshotId }
            }
        } else if (ref != null) ref to sid!! else null
        val fresh = port.peek()
        val target = when {
            modelRef != null -> when (val resolved = refs.resolve(modelRef.first, modelRef.second)) {
                is Resolved.Stale -> return ToolResults.error("ref_expired") { put("cause", resolved.cause.wire) }
                is Resolved.Current -> PhoneTarget.Ref(resolved.portRef, resolved.portSnapshotId)
            }
            x != null -> PhoneTarget.Point(pixel(x, fresh.width), pixel(y!!, fresh.height))
            allowFocus -> PhoneTarget.Focus
            else -> throw PhoneArgError("target", "give a ref, element, or point")
        }
        val priorElement = modelRef?.let { pair -> refs.latest?.elements?.firstOrNull { it.ref == pair.first } }
        val targetX = x ?: priorElement?.let { normalize(it.centerX, fresh.width) }
        val targetY = y ?: priorElement?.let { normalize(it.centerY, fresh.height) }
        val blocked = PaymentTargets.tap(fresh, targetX, targetY, a.text("target")) ||
            priorElement?.let { PaymentTargets.element(refs.latest!!.screen, it) } == true ||
            a.bool("pressEnter") && PaymentTargets.key(fresh, 66)
        if (blocked) return ToolResults.error("confirmation_required", "Complete the payment or order yourself on the device.")
        val result = mutate { perform(target) }
        return matched?.let { hit -> merge(result, buildJsonObject {
            put("matched", buildJsonObject { put("ref", hit.element.ref); put("name", hit.element.name); put("exact", hit.exact) })
        }) } ?: result
    }

    private suspend fun scroll(a: PhoneArgs): HostMcpToolCallResult {
        val direction = a.text("direction")!!
        val amount = a.int("amount") ?: 3
        val x = a.int("x"); val y = a.int("y")
        if ((x == null) != (y == null)) throw PhoneArgError("x", "give x and y together")
        val distance = minOf(650, amount * 100)
        val dx = when (direction) { "left" -> distance; "right" -> -distance; else -> 0 }
        val dy = when (direction) { "up" -> distance; "down" -> -distance; else -> 0 }
        fun bound(value: Double) = value.roundToInt().coerceIn(50, 949)
        val cx = x ?: 500; val cy = y ?: 500
        val result = if (dy != 0 && x == null && amount == 3) mutate { port.scroll(null, null, direction == "down") }
        else swipe(bound(cx - dx / 2.0), bound(cy - dy / 2.0), bound(cx + dx / 2.0), bound(cy + dy / 2.0), DEFAULT_SWIPE_MS)
        if (result.isError) return result
        return merge(result, buildJsonObject {
            put("direction", direction)
            put("fingerMoved", when (direction) { "left" -> "right"; "right" -> "left"; "up" -> "down"; else -> "up" })
            if (result.content["changed"] == JsonPrimitive(false)) put("atEnd", true)
        })
    }

    private suspend fun swipe(a: PhoneArgs): HostMcpToolCallResult = swipe(
        a.int("startX")!!, a.int("startY")!!, a.int("endX")!!, a.int("endY")!!, a.int("durationMs")?.toLong() ?: DEFAULT_SWIPE_MS,
    )

    private suspend fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long): HostMcpToolCallResult = mutate {
        val s = port.peek()
        port.swipe(pixel(x1, s.width), pixel(y1, s.height), pixel(x2, s.width), pixel(y2, s.height), durationMs)
    }

    private suspend fun gesture(a: PhoneArgs): HostMcpToolCallResult = mutate {
        val s = port.peek()
        val paths = a.array("paths")!!.map { path -> path.jsonArray.map { point ->
            val (x, y) = point.jsonArray
            pixel(x.jsonPrimitive.int, s.width) to pixel(y.jsonPrimitive.int, s.height)
        } }
        port.gesture(paths, (a.int("durationMs") ?: 500).toLong())
    }

    private suspend fun wheel(a: PhoneArgs): HostMcpToolCallResult {
        val ref = a.text("ref")!!; val sid = a.text("snapshotId")!!; val value = a.text("value")!!.trim()
        val target = refs.resolve(ref, sid)
        if (target is Resolved.Stale) return ToolResults.error("ref_expired") { put("cause", target.cause.wire) }
        target as Resolved.Current
        var outcome: WheelOutcome? = null
        val result = mutate {
            port.setWheel(target.portRef, target.portSnapshotId, value).also { outcome = it }.let { o ->
                if (o.reached) ActionResult.Ok(changed = o.attempts > 0 && o.from != o.value, hint = o.hint)
                else ActionResult.Failed(when (o.error) {
                    "not_a_wheel", "ref_expired", "no_app_open", "accessibility_disabled" -> o.error
                    "at_end" -> "wheel_at_end"
                    "unknown_value" -> "wheel_unreadable"
                    "not_moving" -> "wheel_not_moving"
                    else -> "wheel_not_reached"
                }, o.hint)
            }
        }
        return outcome?.let { o -> merge(result, buildJsonObject {
            put("target", value); o.value?.let { put("value", it) }; o.from?.let { put("from", it) }
            put("attempts", o.attempts); put("method", o.method)
        }) } ?: result
    }

}

private sealed interface PhoneTarget {
    data class Ref(val ref: String, val snapshotId: String) : PhoneTarget
    data class Point(val x: Int, val y: Int) : PhoneTarget
    data object Focus : PhoneTarget
}

private fun pixel(normalized: Int, size: Int): Int = (normalized * (size - 1) / 999.0).roundToInt()

internal fun merge(result: HostMcpToolCallResult, more: JsonObject): HostMcpToolCallResult =
    result.copy(content = JsonObject(result.content + more))

internal fun PhoneArgs.query() = PhoneAutomationEngine.Query(text("text"), text("resourceId"), text("role"))
