// Adapted from Mika (Copyright (c) wangzan101 and Mika contributors), Apache-2.0.
package com.wangzan101.mika.core.cap.phone

import com.wangzan101.mika.core.observation.Untrusted
import com.wangzan101.mika.core.uistate.ScreenPort
import com.wangzan101.mika.core.uistate.ScreenSnapshot
import com.wangzan101.mika.core.uistate.UiTreeNode
import dev.kiki.android.host.HostMcpToolCallResult
import dev.kiki.android.host.tools.ToolResults
import kotlinx.serialization.json.*

internal class PhoneReadTools(
    private val port: ScreenPort,
    private val snapshot: suspend () -> ScreenSnapshot,
    private val read: suspend (ScreenSnapshot, Boolean) -> HostMcpToolCallResult,
    private val scroll: suspend (PhoneArgs) -> HostMcpToolCallResult,
    private val tap: suspend (PhoneArgs) -> HostMcpToolCallResult,
) {
    suspend fun find(a: PhoneArgs): HostMcpToolCallResult {
        val query = a.query()
        if (query == PhoneAutomationEngine.Query()) throw PhoneArgError("text", "give a target")
        val direction = a.text("direction")!!
        val limit = a.int("maxScrolls") ?: 30
        var app: String? = null
        var previous: Int? = null
        var unchanged = 0
        var scrolled = 0
        var stopped = "scroll_limit"
        var found: JsonObject? = null
        for (i in 0..limit) {
            val s = snapshot()
            val current = s.packageName ?: s.unreadableApp
            if (s.protected || !s.hasWindow || current == null) { stopped = "screen_needs_review"; break }
            if (app == null) app = current else if (app != current) { stopped = "app_switched"; break }
            found = PhoneAutomationEngine.find(s, query, 100)
            if (found.getValue("total").jsonPrimitive.int > 0) { stopped = "found"; break }
            val fingerprint = s.elements.map { listOf(it.role, it.name, it.resourceId, it.bounds) }.hashCode()
            unchanged = if (fingerprint == previous) unchanged + 1 else 0
            if (unchanged >= 2) { stopped = "content_unchanged"; break }
            previous = fingerprint
            if (i == limit) break
            val moved = scroll(scrollArgs(direction))
            if (moved.isError) { stopped = moved.errorCode("scroll_failed"); break }
            scrolled++
        }
        val success = stopped == "found"
        return HostMcpToolCallResult(buildJsonObject {
            put("ok", success); put("found", success); put("stoppedBecause", stopped); put("scrolls", scrolled)
            found?.forEach { (key, value) -> put(key, value) }
        }, isError = !success)
    }

    suspend fun collect(a: PhoneArgs): HostMcpToolCallResult {
        val direction = a.text("direction")!!
        val pages = a.int("pages") ?: 10
        val maxItems = a.int("maxItems") ?: 300
        val from = a.int("fromY") ?: 50; val to = a.int("toY") ?: 950
        if (from >= to) return ToolResults.error("invalid_region")
        var collected = emptyList<String>()
        var app: String? = null
        var inspected = 0
        var scrolled = 0
        var unchanged = 0
        var stopped = "page_limit"
        var lastId: String? = null
        for (i in 0 until pages) {
            val s = snapshot()
            val content = read(s, false).content
            val current = s.packageName ?: s.unreadableApp
            if (s.protected || content["readable"] == JsonPrimitive(false)) { stopped = "screen_needs_review"; break }
            if (current == null) { stopped = "no_app_open"; break }
            if (app == null) app = current else if (app != current) { stopped = "app_switched"; break }
            val lines = pageLines(s, content["visibleText"] as? JsonArray, from, to)
            val old = collected.size
            collected = if (direction == "down") PhoneAutomationEngine.appendPage(collected, lines) else PhoneAutomationEngine.prependPage(collected, lines)
            inspected++
            lastId = s.snapshotId
            unchanged = if (collected.size == old) unchanged + 1 else 0
            if (collected.size >= maxItems) { stopped = "item_limit"; break }
            if (unchanged >= 2) { stopped = "no_new_content"; break }
            if (i == pages - 1) break
            val moved = scroll(scrollArgs(direction))
            if (moved.isError) { stopped = moved.errorCode("scroll_failed"); break }
            scrolled++
        }
        val output = collected.take(maxItems)
        val joined = output.joinToString("\n")
        return HostMcpToolCallResult(buildJsonObject {
            put("ok", inspected > 0)
            if (inspected == 0) put("error", stopped)
            put("currentApp", app); put("pagesInspected", inspected); put("scrolls", scrolled)
            put("items", output.size); put("stoppedBecause", stopped)
            put("truncated", collected.size > maxItems || joined.length > 49_000)
            put("text", Untrusted.wrapWithin(joined, 50_000))
            lastId?.let { put("snapshotId", it) }
        }, isError = inspected == 0)
    }

    private fun pageLines(s: ScreenSnapshot, ocr: JsonArray?, from: Int, to: Int): List<String> {
        data class Line(val text: String, val top: Int, val bottom: Int, val left: Int)
        val out = mutableListOf<Line>()
        fun add(value: String?, bounds: List<Int>) {
            val text = value?.trim()?.replace(Regex("\\s+"), " ").orEmpty()
            val top = bounds.getOrElse(1) { 0 }; val bottom = bounds.getOrElse(3) { 999 }
            if (text.isNotEmpty() && bottom >= from && top <= to) out += Line(text, top, bottom, bounds.getOrElse(0) { 0 })
        }
        fun visit(node: UiTreeNode) {
            if (!node.secret) { add(node.text, node.bounds); add(node.description, node.bounds) }
            node.children.forEach(::visit)
        }
        s.windows.forEach { it.nodes.forEach(::visit) }
        if (out.isEmpty()) s.elements.filterNot { it.secret }.forEach { add(it.name, it.bounds) }
        ocr?.forEach { entry ->
            val obj = entry.jsonObject
            add(obj.getValue("text").jsonPrimitive.content, obj.getValue("bounds").jsonArray.map { it.jsonPrimitive.int })
        }
        val sorted = out.sortedWith(compareBy(Line::top, Line::left))
        return sorted.filterIndexed { i, line ->
            val prev = sorted.getOrNull(i - 1)
            prev == null || prev.text != line.text || minOf(prev.bottom, line.bottom) <= maxOf(prev.top, line.top)
        }.map { it.text }
    }

    suspend fun extract(a: PhoneArgs): HostMcpToolCallResult {
        val mode = a.text("mode")!!; val max = a.int("maxItems") ?: 100
        val s = snapshot()
        val records = mutableListOf<JsonObject>()
        fun text(node: UiTreeNode): List<String> = buildList {
            if (!node.secret) addAll(listOfNotNull(node.text, node.description).filter(String::isNotBlank))
            node.children.forEach { addAll(text(it)) }
        }
        fun walk(node: UiTreeNode, parents: List<String>) {
            if (records.size >= max) return
            when (mode) {
                "text" -> if (!node.secret) listOfNotNull(node.text, node.description).distinct().filter(String::isNotBlank).forEach { value ->
                    if (records.size < max) records += buildJsonObject {
                        put("text", value.take(2_000)); node.ref?.let { put("ref", it) }; put("parents", JsonArray(parents.map(::JsonPrimitive)))
                    }
                }
                "form" -> if (node.editable) records += buildJsonObject {
                    put("role", node.role); put("secret", node.secret); node.ref?.let { put("ref", it) }
                    node.resourceId?.let { put("resourceId", it) }; node.hintText?.let { put("hint", it) }
                    if (!node.secret) node.text?.let { put("value", it.take(2_000)) }
                    put("parents", JsonArray(parents.map(::JsonPrimitive)))
                }
                "list" -> if (node.scrollable || node.role.contains("RecyclerView", true) || node.role.contains("ListView", true)) {
                    node.children.forEach { row ->
                        val values = text(row).distinct()
                        if (records.size < max && values.isNotEmpty()) records += buildJsonObject {
                            put("texts", JsonArray(values.map { JsonPrimitive(it.take(2_000)) }))
                            row.ref?.let { put("ref", it) }; put("bounds", JsonArray(row.bounds.map(::JsonPrimitive)))
                        }
                    }
                    return
                }
            }
            val label = listOfNotNull(node.text.takeUnless { node.secret }, node.description).firstOrNull { it.isNotBlank() }
            val next = (parents + listOfNotNull(label)).takeLast(6)
            node.children.forEach { walk(it, next) }
        }
        s.windows.forEach { window -> window.nodes.forEach { walk(it, listOfNotNull(window.title)) } }
        return ToolResults.ok {
            put("mode", mode); put("snapshotId", s.snapshotId); put("currentApp", s.packageName ?: s.unreadableApp)
            put("items", JsonArray(records)); put("count", records.size); put("truncated", records.size == max)
        }
    }

    suspend fun waitFor(a: PhoneArgs): HostMcpToolCallResult {
        val condition = a.text("condition")!!
        val value = a.text("value")
        if (condition != "stable" && value == null) throw PhoneArgError("value", "required")
        if (condition == "activity") return ToolResults.error("activity_wait_unavailable", "Accessibility cannot reliably identify Activity classes. Wait for visible text with appear or disappear instead.")
        port.checkAppAccess()
        val met = port.waitFor(condition, value, (a.int("timeoutMs") ?: 10_000).toLong())
        return HostMcpToolCallResult(buildJsonObject {
            put("ok", met); put("met", met); put("condition", condition); if (!met) put("error", "timeout")
        }, isError = !met)
    }

    suspend fun event(a: PhoneArgs): HostMcpToolCallResult {
        port.checkAppAccess()
        val kind = a.text("kind")!!; val pkg = a.text("packageName"); val timeout = (a.int("timeoutMs") ?: 10_000).toLong()
        val watch = a.text("mode") == "watch"
        val events = if (watch) port.watchEvents(kind, pkg, timeout, a.int("maxEvents") ?: 30) else listOfNotNull(port.nextEvent(kind, pkg, timeout))
        fun eventJson(event: com.wangzan101.mika.core.uistate.ScreenEvent) = buildJsonObject {
            put("type", event.type); put("packageName", event.packageName); put("text", Untrusted.wrapWithin(event.text.orEmpty(), 2_000))
        }
        return HostMcpToolCallResult(buildJsonObject {
            put("ok", events.isNotEmpty())
            if (watch) { put("count", events.size); put("events", JsonArray(events.map(::eventJson))) }
            else events.singleOrNull()?.let { eventJson(it).forEach { (key, value) -> put(key, value) } }
            if (events.isEmpty()) put("error", "timeout")
        }, isError = events.isEmpty())
    }

    suspend fun dialog(a: PhoneArgs): HostMcpToolCallResult {
        val s = snapshot()
        val windows = s.windows.sortedByDescending { it.layer }
        fun containsDialog(node: UiTreeNode): Boolean = node.role.contains("Dialog", true) || node.children.any(::containsDialog)
        val dialog = windows.firstOrNull { w -> w.nodes.any(::containsDialog) ||
            (w.type == "system" && w.active && w.nodes.isNotEmpty()) ||
            (w.type == "application" && windows.count { it.type == "application" } > 1 && w == windows.first()) }
        val labels = mutableListOf<String>(); val buttons = mutableListOf<Pair<String, String>>()
        fun visit(node: UiTreeNode) {
            if (!node.secret) {
                node.text?.takeIf(String::isNotBlank)?.let(labels::add)
                if (node.clickable && node.ref != null) listOfNotNull(node.text, node.description).firstOrNull(String::isNotBlank)?.let { buttons += it to node.ref }
            }
            node.children.forEach(::visit)
        }
        dialog?.nodes?.forEach(::visit)
        val matches = a.text("buttonText")?.let { wanted -> buttons.filter { it.first.equals(wanted, true) } }
        val error = when {
            matches == null -> null
            dialog == null -> "dialog_not_found"
            matches.isEmpty() -> "button_not_found"
            matches.size > 1 -> "ambiguous_button"
            else -> null
        }
        val clicked = matches?.singleOrNull()?.let { (_, ref) -> tap(PhoneArgs(buildJsonObject { put("ref", ref); put("snapshotId", s.snapshotId) })) }
        val success = error == null && clicked?.isError != true
        return HostMcpToolCallResult(buildJsonObject {
            put("ok", success); put("found", dialog != null); put("snapshotId", s.snapshotId)
            dialog?.let { put("title", it.title); put("packageName", it.packageName) }
            put("text", Untrusted.wrapWithin(labels.distinct().joinToString("\n"), 8_000))
            put("buttons", JsonArray(buttons.distinctBy { it.first }.map { (label, ref) -> buildJsonObject { put("text", label); put("ref", ref) } }))
            error?.let { put("error", it) }; clicked?.let { put("action", it.content) }
        }, isError = !success)
    }

    private fun scrollArgs(direction: String) = PhoneArgs(buildJsonObject { put("direction", direction) })
    private fun HostMcpToolCallResult.errorCode(default: String) = content["error"]?.jsonPrimitive?.contentOrNull ?: default
}
