/*
 * Adapted from Mika (https://github.com/wangzan101/Mika), licensed under Apache-2.0.
 * Modified package namespace for Kiki Android screen module.
 */
package dev.kiki.android.tools.screen.a11y

import android.graphics.Rect
import android.os.Bundle
import android.view.accessibility.AccessibilityNodeInfo
import com.wangzan101.mika.core.cap.phone.WheelDrags
import com.wangzan101.mika.core.cap.phone.WheelMath
import com.wangzan101.mika.core.cap.phone.WheelSteps
import com.wangzan101.mika.core.uistate.VisibleTextLine
import com.wangzan101.mika.core.uistate.WheelOutcome
import kotlinx.coroutines.delay
import kotlin.math.abs
import kotlin.math.roundToInt

internal class WheelDriver(
    private val width: Int,
    private val height: Int,
    private val quiet: suspend (quietMs: Long, capMs: Long) -> Unit,
    private val drag: suspend (points: List<Pair<Int, Int>>, slow: Boolean) -> Boolean,
    private val ocr: suspend () -> List<VisibleTextLine>?,
    private val imeShown: () -> Boolean,
    private val back: () -> Boolean,
) {
    private var attempts = 0

    private class Reading(val current: String?, val items: List<WheelMath.Item>, val selected: Int) {
        val texts get() = items.map { it.text }
    }

    private class Column(
        val root: AccessibilityNodeInfo,
        val box: Rect,
        val left: Int,
        val right: Int,
        val mid: Int,
        val rowHeight: Int,
    )

    suspend fun set(start: AccessibilityNodeInfo, value: String): WheelOutcome {
        val startBox = Rect().also(start::getBoundsInScreen)
        if (startBox.isEmpty) return outcome(false, null, null, "none", "not_a_wheel")
        val wheel = scrollableWheel(start, startBox)
        val col = columnOf(start, startBox, wheel)
        var now = read(col)
        val from = now.current
        if (from == null && now.items.size < 2) {
            val scrollable = wheel != null || start.isScrollable
            return outcome(false, null, null, "none", if (scrollable) "unknown_value" else "not_a_wheel")
        }
        if (WheelMath.matches(from, value)) return outcome(true, from, from, "none")

        editableOf(wheel ?: start)?.let { field ->
            if (typeInto(field, value)) {
                now = settled(col)
                if (WheelMath.matches(now.current, value)) return outcome(true, now.current, from, "text")
            }
        }

        if (wheel != null && canStep(wheel)) {
            val steps = WheelSteps(value, cap = MAX_STEPS)
            var stopped: String? = null
            var rechecks = 0
            loop@ while (true) {
                when (val s = steps.next(now.current, now.texts)) {
                    WheelSteps.Step.Done -> {
                        now = settled(col)
                        if (WheelMath.matches(now.current, value)) return outcome(true, now.current, from, "actions")
                        if (++rechecks > MAX_RECHECKS) {
                            stopped = "not_reached"
                            break@loop
                        }
                    }
                    is WheelSteps.Step.Stop -> {
                        stopped = s.reason
                        break@loop
                    }
                    is WheelSteps.Step.Act -> {
                        val action = if (s.forward) {
                            AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
                        } else {
                            AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
                        }
                        var done = 0
                        repeat(s.count) { if (wheel.performAction(action)) done++ }
                        attempts += s.count
                        quiet(STEP_QUIET_MS, STEP_CAP_MS)
                        wheel.refresh()
                        now = settled(col)
                        if (done == 0 && !WheelMath.matches(now.current, value)) {
                            stopped = "at_end"
                            break@loop
                        }
                    }
                }
            }
            if (stopped == "at_end" || stopped == "unknown_value") {
                return outcome(false, now.current, from, "actions", stopped)
            }
        }

        return dragTo(col, value, from, now)
    }

    private suspend fun dragTo(col: Column, value: String, from: String?, first: Reading): WheelOutcome {
        var now = first
        val plan = WheelDrags(value, rowHeight = col.rowHeight)
        var dragged = 0
        var rechecks = 0
        while (true) {
            when (val s = plan.next(now.texts, now.selected, now.items.map { it.centerY }, dragged)) {
                WheelDrags.Step.Done -> {
                    now = settled(col)
                    if (WheelMath.matches(now.current, value)) return outcome(true, now.current, from, "drag")
                    if (++rechecks > MAX_RECHECKS) return outcome(false, now.current, from, "drag", "not_reached")
                }
                is WheelDrags.Step.Stop -> return outcome(false, now.current, from, "drag", s.reason)
                is WheelDrags.Step.Drag -> {
                    dragged = dragSteps(col, now, s.steps, plan.itemHeight, s.boost, s.slow)
                        ?: return outcome(false, now.current, from, "drag", "not_reached")
                    now = settled(col)
                }
            }
        }
    }

    private suspend fun dragSteps(
        col: Column,
        r: Reading,
        steps: Int,
        itemHeight: Int,
        boost: Double,
        slow: Boolean,
    ): Int? {
        val h = itemHeight.coerceAtLeast(1)
        val x = r.items.map { it.centerX }.sorted().getOrNull(r.items.size / 2) ?: (col.left + col.right) / 2
        val top = r.items.minOfOrNull { it.centerY - h / 2 } ?: (col.mid - h / 2)
        val bottom = r.items.maxOfOrNull { it.centerY + h / 2 } ?: (col.mid + h / 2)
        val maxDrag = maxOf(bottom - top - h, h * MIN_DRAG_ROWS)
        var dragged = 0
        for (piece in WheelMath.drags(steps, h, maxDrag)) {
            val len = maxOf((abs(piece) * boost).roundToInt(), MIN_DRAG_PX)
            val up = piece > 0
            val y0 = (if (up) bottom - h / 2 else top + h / 2).coerceIn(
                maxOf(top + 1, 1),
                minOf(bottom - 1, height - 2).coerceAtLeast(maxOf(top + 1, 1)),
            )
            val y1 = (if (up) y0 - len else y0 + len).coerceIn(1, height - 2)
            if (!drag(listOf(x.coerceIn(0, width - 1) to y0, x.coerceIn(0, width - 1) to y1), slow)) return null
            attempts++
            dragged += y0 - y1
            quiet(DRAG_QUIET_MS, DRAG_CAP_MS)
        }
        return dragged
    }

    private suspend fun typeInto(field: AccessibilityNodeInfo, value: String): Boolean {
        val imeBefore = imeShown()
        field.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value)
        }
        val set = field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        attempts++
        field.performAction(AccessibilityNodeInfo.ACTION_CLEAR_FOCUS)
        quiet(STEP_QUIET_MS, STEP_CAP_MS)
        if (!imeBefore && imeShown()) {
            back()
            quiet(STEP_QUIET_MS, STEP_CAP_MS)
        }
        return set
    }

    private suspend fun settled(col: Column): Reading {
        var last = read(col)
        repeat(MAX_SETTLE_READS - 1) {
            delay(SETTLE_MS)
            val again = read(col)
            if (again.current == last.current) return again
            last = again
        }
        return last
    }

    private suspend fun read(col: Column): Reading {
        col.root.refresh()
        col.root.getBoundsInScreen(col.box)
        val found = treeItems(col)
        if (found.isNotEmpty()) {
            val h = WheelMath.itemHeight(found.map { it.centerY })
            val anchor = WheelMath.selectedIndex(found, col.mid, h)
            val items = if (anchor >= 0) WheelMath.column(found, anchor) else found
            val i = WheelMath.selectedIndex(items, col.mid, WheelMath.itemHeight(items.map { it.centerY }) ?: h)
            if (i >= 0) return Reading(items[i].text, items, i)
            val below = items.indexOfFirst { it.centerY > col.mid }
            val mid = (if (below > 0) WheelMath.between(items[below - 1].text, items[below].text) else null) ?: run {
                val j = WheelMath.selected(items.map { it.centerY }, col.mid, WheelMath.itemHeight(items.map { it.centerY }) ?: h)
                return Reading(items.getOrNull(j)?.text, items, j)
            }
            val withMid = items.toMutableList().apply {
                add(below, WheelMath.Item(mid, (items[below - 1].centerX + items[below].centerX) / 2, col.mid, selected = true))
            }
            return Reading(mid, withMid, below)
        }
        val lines = ocr().orEmpty().mapNotNull { l ->
            val cx = px((l.bounds[0] + l.bounds[2]) / 2, width)
            val cy = px((l.bounds[1] + l.bounds[3]) / 2, height)
            if (!col.box.contains(cx, cy) || cx !in col.left..col.right || l.text.isBlank() || l.text.trim().length > MAX_ITEM_CHARS) {
                null
            } else {
                WheelMath.Item(l.text.trim(), cx, cy)
            }
        }.sortedBy { it.centerY }
        val i = WheelMath.selected(lines.map { it.centerY }, col.mid, WheelMath.itemHeight(lines.map { it.centerY }))
        return Reading(lines.getOrNull(i)?.text, lines, i)
    }

    @Suppress("DEPRECATION")
    private fun treeItems(col: Column): List<WheelMath.Item> {
        val out = mutableListOf<WheelMath.Item>()
        val r = Rect()
        fun add(n: AccessibilityNodeInfo): Boolean {
            val label = itemLabel(n) ?: return false
            n.getBoundsInScreen(r)
            if (r.isEmpty || !col.box.contains(r.centerX(), r.centerY()) || r.centerX() !in col.left..col.right) return false
            if (out.none { it.text == label && abs(it.centerY - r.centerY()) < 4 }) {
                out += WheelMath.Item(label, r.centerX(), r.centerY(), n.isSelected, r.height())
            }
            return true
        }
        fun walk(n: AccessibilityNodeInfo, depth: Int) {
            for (i in 0 until n.childCount) {
                val c = n.getChild(i) ?: continue
                if (!c.isVisibleToUser) continue
                if (!add(c) && depth < MAX_DOWN) walk(c, depth + 1)
            }
        }
        if (col.root.childCount == 0) add(col.root) else walk(col.root, 0)
        return out.sortedBy { it.centerY }
    }

    private fun itemLabel(n: AccessibilityNodeInfo): String? {
        var label = ScreenReader.ownLabel(n) ?: return null
        val state = n.stateDescription?.toString()?.trim()
        if (!state.isNullOrEmpty() && label != state && label.contains(state)) {
            label = label.replace(state, "").trim { it.isWhitespace() || !it.isLetterOrDigit() }.ifEmpty { label }
        }
        return label.takeIf { it.length <= MAX_ITEM_CHARS }
    }

    private fun scrollableWheel(start: AccessibilityNodeInfo, startBox: Rect): AccessibilityNodeInfo? {
        if (scrollable(start)) return start
        val r = Rect()
        var p = start.parent
        var depth = 0
        while (p != null && depth++ < MAX_UP) {
            if (scrollable(p)) {
                p.getBoundsInScreen(r)
                return p.takeIf { r.centerX() in startBox.left..startBox.right }
            }
            p = p.parent
        }
        val queue = ArrayDeque<AccessibilityNodeInfo>().apply { add(start) }
        var visited = 0
        while (queue.isNotEmpty() && visited++ < 60) {
            val c = queue.removeFirst()
            if (scrollable(c)) return c
            for (i in 0 until c.childCount) c.getChild(i)?.let(queue::add)
        }
        return null
    }

    private fun columnOf(start: AccessibilityNodeInfo, startBox: Rect, wheel: AccessibilityNodeInfo?): Column {
        val ownHeight = startBox.height().coerceAtLeast(1)
        if (wheel != null && wheel != start && Rect().also(wheel::getBoundsInScreen).let { it.width() <= startBox.width() * 2 }) {
            val box = Rect().also(wheel::getBoundsInScreen)
            return Column(wheel, box, box.left, box.right, startBox.centerY(), ownHeight)
        }
        if (start.childCount > 0) {
            val own = Column(start, Rect(startBox), startBox.left, startBox.right, startBox.centerY(), startBox.height() / ASSUMED_ROWS)
            if (treeItems(own).size >= 2) return own
        }
        var best: Column? = null
        var p = start.parent
        var depth = 0
        while (p != null && depth++ < MAX_UP) {
            val box = Rect().also(p::getBoundsInScreen)
            val c = Column(p, box, startBox.left, startBox.right, startBox.centerY(), ownHeight)
            val n = treeItems(c).size
            if (n >= 3) return c
            if (n >= 2 && best == null) best = c
            p = p.parent
        }
        return best ?: Column(start, Rect(startBox), startBox.left, startBox.right, startBox.centerY(), ownHeight)
    }

    private fun scrollable(n: AccessibilityNodeInfo): Boolean = n.isScrollable || canStep(n)

    private fun canStep(n: AccessibilityNodeInfo): Boolean = n.actionList.any {
        it.id == AccessibilityNodeInfo.ACTION_SCROLL_FORWARD || it.id == AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
    }

    private fun editableOf(wheel: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        if (wheel.isEditable) return wheel
        for (i in 0 until wheel.childCount) {
            val c = wheel.getChild(i) ?: continue
            if (c.isEditable && c.isVisibleToUser) return c
        }
        return null
    }

    private fun px(n: Int, size: Int) = (n * (size - 1) / 999.0).roundToInt()

    private fun outcome(
        reached: Boolean,
        value: String?,
        from: String?,
        method: String,
        error: String? = null,
    ) = WheelOutcome(
        reached,
        WheelMath.clean(value),
        WheelMath.clean(from),
        attempts,
        method,
        if (reached) null else error ?: "not_reached",
    )

    private companion object {
        const val MAX_STEPS = 80
        const val MAX_UP = 5
        const val MAX_DOWN = 4
        const val MAX_ITEM_CHARS = 24
        const val ASSUMED_ROWS = 5
        const val MIN_DRAG_ROWS = 3
        const val MIN_DRAG_PX = 48
        const val SETTLE_MS = 350L
        const val MAX_SETTLE_READS = 5
        const val MAX_RECHECKS = 2
        const val STEP_QUIET_MS = 150L
        const val STEP_CAP_MS = 700L
        const val DRAG_QUIET_MS = 300L
        const val DRAG_CAP_MS = 1_500L
    }
}
