/*
 * Adapted from Mika (https://github.com/wangzan101/Mika), licensed under Apache-2.0.
 * Modified package namespace for Kiki Android screen module.
 */
package dev.kiki.android.tools.screen.a11y

import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import com.wangzan101.mika.core.cap.phone.WheelMath
import com.wangzan101.mika.core.uistate.ElementLocator
import com.wangzan101.mika.core.uistate.UiElement
import com.wangzan101.mika.core.uistate.UiStates
import com.wangzan101.mika.core.uistate.UiTreeNode
import com.wangzan101.mika.core.uistate.UiWindowTree
import com.wangzan101.mika.core.uistate.ambiguousFieldReadback
import com.wangzan101.mika.core.uistate.normalize

internal class ScreenRead(
    val entries: List<NodeEntry>,
    val hash: Long,
    val texts: List<String>,
    val passwordField: Boolean,
    val hasAppWindow: Boolean,
    val topPackage: String?,
    val windows: List<UiWindowTree> = emptyList(),
    val anyAppWindow: Boolean = hasAppWindow,
)

internal object ScreenReader {
    private const val MIN_SIZE = 5
    private const val MAX_DEPTH = 80
    private const val AGGREGATE_MAX = 60

    private val SKIPPED_TYPES = setOf(
        AccessibilityWindowInfo.TYPE_INPUT_METHOD,
        AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY,
        AccessibilityWindowInfo.TYPE_MAGNIFICATION_OVERLAY,
        AccessibilityWindowInfo.TYPE_SPLIT_SCREEN_DIVIDER,
    )

    fun contentWindows(windows: List<AccessibilityWindowInfo>): List<AccessibilityWindowInfo> =
        windows.filter { it.type !in SKIPPED_TYPES }.sortedByDescending { it.layer }

    fun topPackage(windows: List<AccessibilityWindowInfo>): String? =
        contentWindows(windows).filter { it.type == AccessibilityWindowInfo.TYPE_APPLICATION }
            .firstNotNullOfOrNull { it.root?.packageName?.toString() }

    fun read(windows: List<AccessibilityWindowInfo>, width: Int, height: Int): ScreenRead {
        val content = contentWindows(windows)
        val entries = mutableListOf<NodeEntry>()
        val texts = mutableListOf<String>()
        val seen = HashSet<String>()
        var hash = FNV_OFFSET
        var password = false
        var lastLabel: String? = null
        val rect = Rect()

        fun visit(n: AccessibilityNodeInfo, depth: Int, inList: Boolean): List<UiTreeNode> {
            if (depth > MAX_DEPTH) return emptyList()
            val visible = n.isVisibleToUser
            val editable = visible && canSetText(n)
            var ref: String? = null
            var clippedBounds = listOf(0, 0, 0, 0)
            if (visible) {
                n.getBoundsInScreen(rect)
                hash = mix(hash, n.className, n.text, n.contentDescription, rect.flattenToString(), states(n))
                if (n.isPassword) password = true
                val own = if (n.isPassword) n.hintText?.toString()?.trim()?.ifEmpty { null } else ownLabel(n)
                own?.let(texts::add)
                clip(rect, width, height)
                clippedBounds = listOf(
                    normalize(rect.left, width),
                    normalize(rect.top, height),
                    normalize(rect.right, width),
                    normalize(rect.bottom, height),
                )
                val usable = rect.width() >= MIN_SIZE && rect.height() >= MIN_SIZE
                val interactive = n.isClickable || editable || n.isScrollable
                if (usable && (own != null || interactive)) {
                    val label = labelOf(n, own)
                    val role = roleOf(n)
                    if (seen.add("$role|$label|${rect.flattenToString()}")) {
                        val id = "@e${entries.size + 1}"
                        ref = id
                        val rid = n.viewIdResourceName
                        val element = UiElement(
                            ref = id,
                            role = role,
                            name = label,
                            centerX = rect.centerX(),
                            centerY = rect.centerY(),
                            bounds = listOf(
                                normalize(rect.left, width),
                                normalize(rect.top, height),
                                normalize(rect.right, width),
                                normalize(rect.bottom, height),
                            ),
                            resourceId = if (label.isEmpty() || editable) readableResourceId(rid) else null,
                            clickable = n.isClickable,
                            editable = editable,
                            scrollable = n.isScrollable,
                            hint = own != null && showingHint(n),
                            focused = n.isFocused,
                            secret = n.isPassword,
                            placeholder = if (editable) n.hintText?.toString()?.trim()?.ifEmpty { null } else null,
                            searchField = editable && n.className?.toString()?.contains("Search", ignoreCase = true) == true,
                            states = uiStates(n),
                        )
                        val locator = ElementLocator(role, label, rid, rect.centerX(), rect.centerY(), lastLabel, element.hint, inList)
                        entries += NodeEntry(element, locator, n)
                        if (label.isNotEmpty()) lastLabel = label
                    }
                }
            }
            val childrenInList = inList || isList(n)
            val children = buildList {
                for (i in 0 until n.childCount) n.getChild(i)?.let { addAll(visit(it, depth + 1, childrenInList)) }
            }
            if (!visible) return children
            @Suppress("DEPRECATION")
            return listOf(
                UiTreeNode(
                    role = roleOf(n),
                    bounds = clippedBounds,
                    ref = ref,
                    text = n.text?.toString()?.takeUnless { n.isPassword || it.isBlank() },
                    description = n.contentDescription?.toString()?.takeUnless { n.isPassword || it.isBlank() },
                    hintText = n.hintText?.toString()?.takeUnless { it.isBlank() },
                    resourceId = n.viewIdResourceName,
                    clickable = n.isClickable,
                    editable = editable,
                    scrollable = n.isScrollable,
                    checkable = n.isCheckable,
                    checked = n.isChecked,
                    selected = n.isSelected,
                    enabled = n.isEnabled,
                    focused = n.isFocused,
                    secret = n.isPassword,
                    wheel = isWheel(n),
                    children = children,
                ),
            )
        }

        val trees = content.map { w ->
            val root = w.root
            UiWindowTree(
                id = w.id,
                type = when (w.type) {
                    AccessibilityWindowInfo.TYPE_APPLICATION -> "application"
                    AccessibilityWindowInfo.TYPE_SYSTEM -> "system"
                    else -> "other"
                },
                layer = w.layer,
                title = w.title?.toString(),
                packageName = root?.packageName?.toString(),
                active = w.isActive,
                focused = w.isFocused,
                nodes = root?.let { visit(it, 0, false) }.orEmpty(),
            )
        }
        return ScreenRead(
            entries = entries,
            hash = hash,
            texts = texts,
            passwordField = password,
            hasAppWindow = content.any { it.type == AccessibilityWindowInfo.TYPE_APPLICATION && it.root != null },
            anyAppWindow = content.any { it.type == AccessibilityWindowInfo.TYPE_APPLICATION },
            topPackage = topPackage(windows),
            windows = trees,
        )
    }

    fun isWheel(n: AccessibilityNodeInfo): Boolean {
        if (n.className?.toString()?.endsWith("NumberPicker") == true) return true
        if (!n.isScrollable || n.childCount !in 3..12) return false
        val box = Rect().also(n::getBoundsInScreen)
        val r = Rect()
        val items = mutableListOf<WheelMath.Item>()
        for (i in 0 until n.childCount) {
            val c = n.getChild(i) ?: continue
            if (!c.isVisibleToUser) continue
            val label = ownLabel(c) ?: c.takeIf { it.childCount == 1 }?.getChild(0)?.let(::ownLabel) ?: return false
            c.getBoundsInScreen(r)
            items += WheelMath.Item(label, r.centerX(), r.centerY())
        }
        return WheelMath.looksLikeWheel(items.sortedBy { it.centerY }, box.left, box.right)
    }

    private fun isList(n: AccessibilityNodeInfo): Boolean {
        if (n.collectionInfo != null) return true
        val cls = n.className?.toString() ?: return false
        return cls.endsWith("RecyclerView") || cls.endsWith("ListView") || cls.endsWith("GridView")
    }

    private fun clip(rect: Rect, width: Int, height: Int) {
        if (!rect.intersect(0, 0, width, height)) rect.setEmpty()
    }

    private fun roleOf(n: AccessibilityNodeInfo) =
        n.className?.toString()?.substringAfterLast('.')?.ifEmpty { null } ?: "View"

    fun labelOf(n: AccessibilityNodeInfo, own: String? = ownLabel(n)) =
        own ?: if (n.isClickable) descendantLabel(n) else ""

    @Suppress("DEPRECATION")
    private fun uiStates(n: AccessibilityNodeInfo): Set<String> = buildSet {
        if (n.isChecked) add(UiStates.CHECKED)
        if (n.isSelected) add(UiStates.SELECTED)
        if (!n.isEnabled) add(UiStates.DISABLED)
    }

    @Suppress("DEPRECATION")
    private fun states(n: AccessibilityNodeInfo) =
        "${n.isChecked}${n.isSelected}${n.isEnabled}${n.isFocused}${n.textSelectionStart}:${n.textSelectionEnd}"

    fun ownLabel(n: AccessibilityNodeInfo): String? {
        val text = n.text?.toString()?.trim()
        if (!text.isNullOrEmpty()) return text
        val desc = n.contentDescription?.toString()?.trim()
        if (!desc.isNullOrEmpty()) return desc
        return n.hintText?.toString()?.trim()?.ifEmpty { null }
    }

    private fun showingHint(n: AccessibilityNodeInfo): Boolean {
        if (n.isShowingHintText) return true
        val hint = n.hintText?.toString()?.trim()
        if (hint.isNullOrEmpty()) return false
        val text = n.text?.toString()?.trim()
        return if (text.isNullOrEmpty()) n.contentDescription.isNullOrBlank() else text == hint
    }

    fun canSetText(n: AccessibilityNodeInfo): Boolean =
        n.isEditable || n.actionList.any { it.id == AccessibilityNodeInfo.ACTION_SET_TEXT }

    fun fieldText(n: AccessibilityNodeInfo, placeholder: String? = null, typing: String? = null): String? {
        if (n.isPassword) return null
        if (n.isShowingHintText) return ""
        val text = n.text?.toString() ?: return ""
        val shown = text.trim()
        if (typing != null && shown == typing.trim()) return text
        if (showingHint(n) || (placeholder != null && shown == placeholder)) return ""
        if (ambiguousFieldReadback(shown, placeholder, typing)) return null
        return text
    }

    private fun descendantLabel(n: AccessibilityNodeInfo): String {
        val parts = mutableListOf<String>()
        fun walk(c: AccessibilityNodeInfo, depth: Int) {
            if (depth > 6 || parts.joinToString(" ").length > AGGREGATE_MAX) return
            for (i in 0 until c.childCount) {
                val child = c.getChild(i) ?: continue
                if (!child.isVisibleToUser) continue
                ownLabel(child)?.let { if (it !in parts) parts += it }
                walk(child, depth + 1)
            }
        }
        walk(n, 0)
        val joined = parts.joinToString(" ")
        return if (joined.length > AGGREGATE_MAX) joined.take(AGGREGATE_MAX) + "…" else joined
    }

    private fun readableResourceId(id: String?): String? {
        val short = id?.substringAfterLast('/') ?: return null
        return short.takeIf { Regex("^[A-Za-z0-9_]{4,}$").matches(it) && Regex("[A-Za-z]{3}").containsMatchIn(it) }
    }

    private const val FNV_OFFSET = -0x340d631b7bdddcdbL
    private const val FNV_PRIME = 0x100000001b3L

    private fun mix(h0: Long, vararg parts: Any?): Long {
        var h = h0
        for (p in parts) {
            val s = p?.toString() ?: "\u0000"
            for (c in s) h = (h xor c.code.toLong()) * FNV_PRIME
            h = (h xor 0x1f) * FNV_PRIME
        }
        return h
    }
}

@Suppress("DEPRECATION")
internal fun launchableApps(pm: PackageManager, ownPackage: String): List<Pair<String, String>> {
    val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
    return pm.queryIntentActivities(launcher, 0)
        .map { it.activityInfo.packageName to it.loadLabel(pm).toString() }
        .filter { it.first != ownPackage }
        .distinctBy { it.first }
        .sortedBy { it.second }
}
