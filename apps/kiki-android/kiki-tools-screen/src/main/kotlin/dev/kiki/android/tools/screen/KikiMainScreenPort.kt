/*
 * Adapted from Mika HostMainScreenPort, licensed under Apache-2.0.
 * Modified for Kiki Android: binds to KikiAccessibilityService + PhoneOcr, degrades cleanly when Accessibility is off.
 */
package dev.kiki.android.tools.screen

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.view.Display
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import com.wangzan101.mika.core.access.AppAccessPolicy
import com.wangzan101.mika.core.uistate.ActionResult
import com.wangzan101.mika.core.uistate.DOUBLE_TAP_GAP_MS
import com.wangzan101.mika.core.uistate.Relocation
import com.wangzan101.mika.core.uistate.ScreenCheck
import com.wangzan101.mika.core.uistate.ScreenDiagnosis
import com.wangzan101.mika.core.uistate.ScreenEvent
import com.wangzan101.mika.core.uistate.ScreenFacts
import com.wangzan101.mika.core.uistate.ScreenPort
import com.wangzan101.mika.core.uistate.ScreenSnapshot
import com.wangzan101.mika.core.uistate.SystemAction
import com.wangzan101.mika.core.uistate.SystemActionResult
import com.wangzan101.mika.core.uistate.Verification
import com.wangzan101.mika.core.uistate.VisibleTextLine
import com.wangzan101.mika.core.uistate.WheelOutcome
import com.wangzan101.mika.core.uistate.relocate
import dev.kiki.android.tools.screen.a11y.KikiAccessibilityService
import dev.kiki.android.tools.screen.a11y.NodeIds
import dev.kiki.android.tools.screen.a11y.NodeSnapshot
import dev.kiki.android.tools.screen.a11y.PhoneOcr
import dev.kiki.android.tools.screen.a11y.ScreenReader
import dev.kiki.android.tools.screen.a11y.SystemIntents
import dev.kiki.android.tools.screen.a11y.WheelDriver
import dev.kiki.android.tools.screen.a11y.launchableApps
import dev.kiki.android.tools.screen.a11y.snapshotId
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.flow.merge
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.ByteArrayOutputStream
import kotlin.math.min

internal class KikiMainScreenPort(
    private val appContext: Context,
    override val appAccess: AppAccessPolicy = AppAccessPolicy.ALLOW,
) : ScreenPort {

    private val nodeIds = NodeIds()

    private fun service(): KikiAccessibilityService? = KikiAccessibilityService.instance.value

    private fun metrics(): Pair<Int, Int> {
        val dm = appContext.resources.displayMetrics
        return dm.widthPixels.coerceAtLeast(1) to dm.heightPixels.coerceAtLeast(1)
    }

    private fun mainWindows(a11y: KikiAccessibilityService): List<AccessibilityWindowInfo> =
        a11y.windowsOn(Display.DEFAULT_DISPLAY).filter { w ->
            shouldIncludeWindowInSnapshot(
                windowPackage = w.root?.packageName?.toString(),
                windowType = w.type,
                selfPackage = appContext.packageName,
            )
        }

    override suspend fun checkAppAccess() {
        val a11y = service() ?: return
        val top = ScreenReader.topPackage(mainWindows(a11y)) ?: return
        appAccess.current().denial(top)?.let { throw it }
    }

    override suspend fun snapshot(): ScreenSnapshot = readSnapshot(registerRefs = true)

    override suspend fun peek(): ScreenSnapshot = readSnapshot(registerRefs = false)

    private suspend fun readSnapshot(registerRefs: Boolean): ScreenSnapshot = withContext(Dispatchers.IO) {
        val (w, h) = metrics()
        val a11y = service()
        if (a11y == null) {
            return@withContext ScreenSnapshot(
                snapshotId = snapshotId(),
                packageName = null,
                elements = emptyList(),
                width = w,
                height = h,
                hasWindow = false,
                captureError = "accessibility_disabled",
            )
        }
        val windows = mainWindows(a11y)
        val firstGen = KikiAccessibilityService.windowGeneration()
        val read = ScreenReader.read(windows, w, h)
        val secondGen = KikiAccessibilityService.windowGeneration()
        read.topPackage?.let { pkg -> appAccess.current().denial(pkg)?.let { throw it } }

        val id = snapshotId()
        if (registerRefs) {
            nodeIds.put(NodeSnapshot(id, read.entries))
        }
        ScreenSnapshot(
            snapshotId = id,
            packageName = read.topPackage,
            elements = read.entries.map { it.element },
            width = w,
            height = h,
            changedDuringRead = firstGen != secondGen,
            protected = false,
            hasWindow = read.anyAppWindow,
            windows = read.windows,
        )
    }

    override suspend fun screenshotPng(): ByteArray? = withContext(Dispatchers.IO) {
        val a11y = service() ?: return@withContext null
        when (val shot = a11y.takeMainScreenshot()) {
            is KikiAccessibilityService.MainShot.Ok -> {
                val out = ByteArrayOutputStream()
                val ok = shot.bitmap.compress(Bitmap.CompressFormat.PNG, 92, out)
                shot.bitmap.recycle()
                if (ok) out.toByteArray() else null
            }
            else -> null
        }
    }

    override suspend fun readVisibleText(): List<VisibleTextLine>? = withContext(Dispatchers.IO) {
        val a11y = service() ?: return@withContext null
        when (val shot = a11y.takeMainScreenshot()) {
            is KikiAccessibilityService.MainShot.Ok -> runCatching { PhoneOcr.read(shot.bitmap) }.getOrNull()
            else -> null
        }
    }

    override suspend fun tapRef(ref: String, snapshotId: String): ActionResult = withContext(Dispatchers.IO) {
        val a11y = service() ?: return@withContext noA11y()
        val resolved = resolveNode(a11y, ref, snapshotId) ?: return@withContext ActionResult.Failed("ref_expired")
        val (node, relocatedTo) = resolved
        val beforeHash = currentHash(a11y)
        val clicked = clickNodeOrGesture(a11y, node)
        if (!clicked) return@withContext ActionResult.Failed("action_failed")
        waitStable(900L)
        ActionResult.Ok(
            changed = currentHash(a11y) != beforeHash,
            relocated = relocatedTo != null,
            relocatedTo = relocatedTo,
        )
    }

    override suspend fun tapXY(x: Int, y: Int): ActionResult = withContext(Dispatchers.IO) {
        val a11y = service() ?: return@withContext noA11y()
        val beforeHash = currentHash(a11y)
        val ok = a11y.taps(Display.DEFAULT_DISPLAY, x.toFloat(), y.toFloat(), count = 1, holdMs = 55L, gapMs = 0L)
        if (!ok) return@withContext ActionResult.Failed("action_failed")
        waitStable(900L)
        ActionResult.Ok(changed = currentHash(a11y) != beforeHash)
    }

    override suspend fun doubleTapRef(ref: String, snapshotId: String): ActionResult = withContext(Dispatchers.IO) {
        val a11y = service() ?: return@withContext noA11y()
        val (node, relocatedTo) = resolveNode(a11y, ref, snapshotId) ?: return@withContext ActionResult.Failed("ref_expired")
        val rect = Rect().also(node::getBoundsInScreen)
        val beforeHash = currentHash(a11y)
        val ok = a11y.taps(
            Display.DEFAULT_DISPLAY,
            rect.exactCenterX(),
            rect.exactCenterY(),
            count = 2,
            holdMs = 45L,
            gapMs = DOUBLE_TAP_GAP_MS,
        )
        if (!ok) return@withContext ActionResult.Failed("action_failed")
        waitStable(900L)
        ActionResult.Ok(
            changed = currentHash(a11y) != beforeHash,
            relocated = relocatedTo != null,
            relocatedTo = relocatedTo,
        )
    }

    override suspend fun doubleTapXY(x: Int, y: Int): ActionResult = withContext(Dispatchers.IO) {
        val a11y = service() ?: return@withContext noA11y()
        val beforeHash = currentHash(a11y)
        val ok = a11y.taps(Display.DEFAULT_DISPLAY, x.toFloat(), y.toFloat(), count = 2, holdMs = 45L, gapMs = DOUBLE_TAP_GAP_MS)
        if (!ok) return@withContext ActionResult.Failed("action_failed")
        waitStable(900L)
        ActionResult.Ok(changed = currentHash(a11y) != beforeHash)
    }

    override suspend fun typeText(ref: String?, snapshotId: String?, text: String): ActionResult = withContext(Dispatchers.IO) {
        val a11y = service() ?: return@withContext noA11y()
        val target = findEditableTarget(a11y, ref, snapshotId) ?: return@withContext ActionResult.Failed("no_focus")
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        target.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        val setOk = target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        if (!setOk) return@withContext ActionResult.Failed("input_not_sent")
        delay(180L)
        val refreshed = target.refresh()
        val secret = target.isPassword
        val actual = if (refreshed && !secret) {
            if (target.isShowingHintText) "" else target.text?.toString()
        } else null
        val verification = when (actual) {
            null -> Verification.UNKNOWN
            text -> Verification.MATCH
            else -> Verification.MISMATCH
        }
        ActionResult.Ok(changed = true, verification = verification, secret = secret, textReadback = actual)
    }

    override suspend fun clearText(ref: String?, snapshotId: String?): ActionResult =
        typeText(ref, snapshotId, "")

    override suspend fun scroll(ref: String?, snapshotId: String?, down: Boolean): ActionResult = withContext(Dispatchers.IO) {
        val a11y = service() ?: return@withContext noA11y()
        val beforeHash = currentHash(a11y)
        if (ref != null && snapshotId != null) {
            val resolved = resolveNode(a11y, ref, snapshotId)
            if (resolved != null) {
                val scrollable = ancestorOrSelf(resolved.first) { it.isScrollable }
                if (scrollable != null) {
                    val act = if (down) AccessibilityNodeInfo.ACTION_SCROLL_FORWARD else AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
                    if (scrollable.performAction(act)) {
                        waitStable(800L)
                        return@withContext ActionResult.Ok(changed = currentHash(a11y) != beforeHash)
                    }
                }
            }
        }
        val (w, h) = metrics()
        val cx = w / 2
        val yStart = if (down) (h * 0.72).toInt() else (h * 0.28).toInt()
        val yEnd = if (down) (h * 0.28).toInt() else (h * 0.72).toInt()
        swipe(cx, yStart, cx, yEnd, 360L)
    }

    override suspend fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long): ActionResult = withContext(Dispatchers.IO) {
        val a11y = service() ?: return@withContext noA11y()
        val beforeHash = currentHash(a11y)
        val path = Path().apply {
            moveTo(x1.toFloat(), y1.toFloat())
            lineTo(x2.toFloat(), y2.toFloat())
        }
        val ok = a11y.gesture(Display.DEFAULT_DISPLAY, path, durationMs.coerceAtLeast(50L))
        if (!ok) return@withContext ActionResult.Failed("action_failed")
        waitStable(800L)
        ActionResult.Ok(changed = currentHash(a11y) != beforeHash)
    }

    override suspend fun gesture(paths: List<List<Pair<Int, Int>>>, durationMs: Long): ActionResult = withContext(Dispatchers.IO) {
        val a11y = service() ?: return@withContext noA11y()
        if (paths.isEmpty() || paths.any { it.isEmpty() }) return@withContext ActionResult.Failed("invalid_gesture")
        val beforeHash = currentHash(a11y)
        val androidPaths = paths.map { pts ->
            Path().apply {
                moveTo(pts.first().first.toFloat(), pts.first().second.toFloat())
                pts.drop(1).forEach { (px, py) -> lineTo(px.toFloat(), py.toFloat()) }
            }
        }
        val ok = a11y.gesture(Display.DEFAULT_DISPLAY, androidPaths, durationMs.coerceAtLeast(50L))
        if (!ok) return@withContext ActionResult.Failed("action_failed")
        waitStable(800L)
        ActionResult.Ok(changed = currentHash(a11y) != beforeHash)
    }

    override suspend fun back(): ActionResult = withContext(Dispatchers.IO) {
        val a11y = service() ?: return@withContext noA11y()
        val beforeHash = currentHash(a11y)
        val ok = a11y.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
        if (!ok) return@withContext ActionResult.Failed("action_failed")
        waitStable(800L)
        ActionResult.Ok(changed = currentHash(a11y) != beforeHash)
    }

    override suspend fun pressKey(keyCode: Int): ActionResult = withContext(Dispatchers.IO) {
        val a11y = service() ?: return@withContext noA11y()
        when (keyCode) {
            KeyEvent.KEYCODE_BACK -> back()
            KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> {
                val focused = findFocusedInput(a11y)
                val imeEnter = AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id
                val ok = focused?.performAction(imeEnter) == true ||
                    focused?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true
                if (ok) {
                    waitStable(600L)
                    ActionResult.Ok(changed = true)
                } else {
                    ActionResult.Failed("unsupported")
                }
            }
            else -> ActionResult.Failed("unsupported")
        }
    }

    override suspend fun openApp(packageName: String, cold: Boolean): ActionResult = withContext(Dispatchers.IO) {
        if (packageName == appContext.packageName) {
            return@withContext ActionResult.Failed("own_app", "Cannot launch Kiki itself from phone_launch_app.")
        }
        appAccess.current().denial(packageName)?.let { throw it }
        val launch = appContext.packageManager.getLaunchIntentForPackage(packageName)?.apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (cold) addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK)
        } ?: return@withContext ActionResult.Failed("app_not_found")

        runCatching { appContext.startActivity(launch) }.getOrElse {
            return@withContext ActionResult.Failed("launch_failed", it.message)
        }
        awaitPackageInFront(packageName, 3_500L)
        ActionResult.Ok(changed = true)
    }

    override suspend fun openLink(action: String?, uri: String?, packageName: String?): ActionResult = withContext(Dispatchers.IO) {
        packageName?.let { appAccess.current().denial(it)?.let { d -> throw d } }
        val intent = Intent(action ?: Intent.ACTION_VIEW).apply {
            if (!uri.isNullOrBlank()) data = Uri.parse(uri)
            if (!packageName.isNullOrBlank()) setPackage(packageName)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        runCatching { appContext.startActivity(intent) }.getOrElse {
            return@withContext ActionResult.Failed("link_unresolved", it.message)
        }
        waitStable(1_200L)
        ActionResult.Ok(changed = true)
    }

    override suspend fun shareText(packageName: String, text: String): ActionResult = withContext(Dispatchers.IO) {
        appAccess.current().denial(packageName)?.let { throw it }
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, text)
            setPackage(packageName)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        runCatching { appContext.startActivity(intent) }.getOrElse {
            return@withContext ActionResult.Failed("cannot_share", it.message)
        }
        waitStable(1_000L)
        ActionResult.Ok(changed = true)
    }

    override suspend fun systemAction(action: SystemAction): SystemActionResult = withContext(Dispatchers.IO) {
        val intent = SystemIntents.toIntent(SystemIntents.spec(action))
        val resolved = intent.resolveActivity(appContext.packageManager)
            ?: return@withContext SystemActionResult(ActionResult.Failed(SystemActionResult.NOT_SUPPORTED))
        appAccess.current().denial(resolved.packageName)?.let { throw it }
        runCatching { appContext.startActivity(intent) }.getOrElse {
            return@withContext SystemActionResult(ActionResult.Failed("launch_failed", it.message), resolved.packageName)
        }
        waitStable(900L)
        SystemActionResult(ActionResult.Ok(changed = true), handledBy = resolved.packageName)
    }

    override suspend fun setWheel(ref: String, snapshotId: String, value: String): WheelOutcome = withContext(Dispatchers.IO) {
        val a11y = service() ?: return@withContext WheelOutcome(false, null, null, 0, "none", error = "accessibility_disabled")
        val (node, _) = resolveNode(a11y, ref, snapshotId)
            ?: return@withContext WheelOutcome(false, null, null, 0, "none", error = "ref_expired")
        val (w, h) = metrics()
        val driver = WheelDriver(
            w,
            h,
            quiet = { q, cap -> waitStable(min(q + 200L, cap)) },
            drag = { pts, slow ->
                val path = Path().apply {
                    moveTo(pts.first().first.toFloat(), pts.first().second.toFloat())
                    pts.drop(1).forEach { (px, py) -> lineTo(px.toFloat(), py.toFloat()) }
                }
                a11y.gesture(Display.DEFAULT_DISPLAY, path, if (slow) 900L else 380L)
            },
            ocr = { readVisibleText() },
            imeShown = { a11y.windowsOn(Display.DEFAULT_DISPLAY).any { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD } },
            back = { a11y.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK) },
        )
        driver.set(node, value)
    }

    override suspend fun waitStable(timeoutMs: Long): Boolean = withContext(Dispatchers.IO) {
        val a11y = service() ?: return@withContext false
        val deadline = SystemClock.uptimeMillis() + timeoutMs.coerceAtLeast(100L)
        var prev = currentHash(a11y)
        var stableSince = SystemClock.uptimeMillis()
        while (SystemClock.uptimeMillis() < deadline) {
            delay(90L)
            val now = currentHash(a11y)
            if (now == prev) {
                if (SystemClock.uptimeMillis() - stableSince >= 240L) return@withContext true
            } else {
                prev = now
                stableSince = SystemClock.uptimeMillis()
            }
        }
        false
    }

    override suspend fun waitFor(condition: String, value: String?, timeoutMs: Long): Boolean = withContext(Dispatchers.IO) {
        if (condition == "stable") return@withContext waitStable(timeoutMs)
        val needle = value?.trim().orEmpty()
        if (needle.isEmpty()) return@withContext false
        val deadline = SystemClock.uptimeMillis() + timeoutMs.coerceAtLeast(100L)
        while (SystemClock.uptimeMillis() < deadline) {
            val a11y = service() ?: return@withContext false
            val (w, h) = metrics()
            val read = ScreenReader.read(mainWindows(a11y), w, h)
            val matched = when (condition) {
                "appear" -> read.texts.any { it.contains(needle, ignoreCase = true) }
                "disappear" -> read.texts.none { it.contains(needle, ignoreCase = true) }
                else -> false
            }
            if (matched) return@withContext true
            delay(150L)
        }
        false
    }

    override suspend fun nextEvent(kind: String, packageName: String?, timeoutMs: Long): ScreenEvent? = withContext(Dispatchers.IO) {
        val a11y = service() ?: return@withContext null
        withTimeoutOrNull(timeoutMs) { screenEvents(a11y, kind, packageName).firstOrNull() }
    }

    override suspend fun watchEvents(kind: String, packageName: String?, durationMs: Long, maxEvents: Int): List<ScreenEvent> = withContext(Dispatchers.IO) {
        val a11y = service() ?: return@withContext emptyList()
        val events = mutableListOf<ScreenEvent>()
        withTimeoutOrNull(durationMs) {
            screenEvents(a11y, kind, packageName).take(maxEvents).collect { events += it }
        }
        events
    }

    private fun screenEvents(a11y: KikiAccessibilityService, kind: String, packageName: String?): Flow<ScreenEvent> {
        val windows = a11y.eventsFor(Display.DEFAULT_DISPLAY).mapNotNull { event ->
            val type = when (event.eventType) {
                AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED, AccessibilityEvent.TYPE_WINDOWS_CHANGED -> "window"
                AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED, AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED,
                AccessibilityEvent.TYPE_VIEW_SCROLLED, AccessibilityEvent.TYPE_VIEW_SELECTED -> "content"
                else -> null
            } ?: return@mapNotNull null
            ScreenEvent(type, event.packageName?.toString(), event.text.joinToString(" ").take(1_000))
        }
        val events = when (kind) {
            "notification" -> a11y.notificationEvents()
            "any" -> merge(windows, a11y.notificationEvents())
            else -> windows.filter { it.type == kind }
        }
        return events.filter { it.packageName != appContext.packageName && (packageName == null || it.packageName == packageName) }
    }

    override suspend fun listApps(): List<Pair<String, String>> = withContext(Dispatchers.IO) {
        launchableApps(appContext.packageManager, appContext.packageName)
    }

    override suspend fun checkScreen(): ScreenCheck? = withContext(Dispatchers.IO) {
        val a11y = service() ?: return@withContext null
        val (w, h) = metrics()
        val firstGen = KikiAccessibilityService.windowGeneration()
        val read = ScreenReader.read(mainWindows(a11y), w, h)
        val secondGen = KikiAccessibilityService.windowGeneration()
        ScreenDiagnosis.classify(
            ScreenFacts(
                currentApp = read.topPackage,
                hasWindow = read.hasAppWindow,
                readableElements = read.entries.size,
                changing = firstGen != secondGen,
                blackFrames = emptyList(),
                texts = read.texts,
                passwordField = read.passwordField,
                anyWindow = read.anyAppWindow,
            ),
        )
    }

    private suspend fun awaitPackageInFront(expectedPkg: String, timeoutMs: Long) {
        val a11y = service() ?: return
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (ScreenReader.topPackage(mainWindows(a11y)) == expectedPkg) {
                waitStable(500L)
                return
            }
            delay(100L)
        }
    }

    private fun currentHash(a11y: KikiAccessibilityService): Long {
        val (w, h) = metrics()
        return ScreenReader.read(mainWindows(a11y), w, h).hash
    }

    private fun resolveNode(a11y: KikiAccessibilityService, ref: String, snapshotId: String): Pair<AccessibilityNodeInfo, String?>? {
        val (w, h) = metrics()
        val (entry, snap) = when (val l = nodeIds.lookup(ref, snapshotId)) {
            is NodeIds.Lookup.Unknown -> return null
            is NodeIds.Lookup.Current -> {
                if (l.entry.node.refresh()) return l.entry.node to null
                l.entry to l.snapshot
            }
            is NodeIds.Lookup.Old -> l.entry to l.snapshot
        }
        val now = ScreenReader.read(mainWindows(a11y), w, h)
        return when (val r = relocate(entry.locator, snap.locators, now.entries.map { it.locator }, min(w, h))) {
            is Relocation.Found -> now.entries[r.index].let { it.node to it.element.name }
            else -> null
        }
    }

    private suspend fun clickNodeOrGesture(a11y: KikiAccessibilityService, node: AccessibilityNodeInfo): Boolean {
        val clickable = ancestorOrSelf(node) {
            it.isEnabled && (it.isClickable || it.actionList.any { a -> a.id == AccessibilityNodeInfo.ACTION_CLICK })
        }
        if (clickable != null && clickable.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
            return true
        }
        val rect = Rect().also(node::getBoundsInScreen)
        if (rect.isEmpty) return false
        return a11y.taps(Display.DEFAULT_DISPLAY, rect.exactCenterX(), rect.exactCenterY(), 1, 55L, 0L)
    }

    private suspend fun findEditableTarget(
        a11y: KikiAccessibilityService,
        ref: String?,
        snapshotId: String?,
    ): AccessibilityNodeInfo? {
        if (ref != null && snapshotId != null) {
            val (node, _) = resolveNode(a11y, ref, snapshotId) ?: return null
            if (ScreenReader.canSetText(node)) return node
            descendant(node) { ScreenReader.canSetText(it) }?.let { return it }
            if (clickNodeOrGesture(a11y, node)) {
                delay(350L)
                findFocusedInput(a11y)?.let { return it }
            }
            return null
        }
        return findFocusedInput(a11y)
    }

    private fun findFocusedInput(a11y: KikiAccessibilityService): AccessibilityNodeInfo? {
        val windows = ScreenReader.contentWindows(mainWindows(a11y))
        for (win in windows) {
            val focus = win.root?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: continue
            if (ScreenReader.canSetText(focus)) return focus
            descendant(focus) { ScreenReader.canSetText(it) }?.let { return it }
        }
        return null
    }

    private inline fun ancestorOrSelf(
        node: AccessibilityNodeInfo,
        predicate: (AccessibilityNodeInfo) -> Boolean,
    ): AccessibilityNodeInfo? {
        var cur: AccessibilityNodeInfo? = node
        var depth = 0
        while (cur != null && depth++ < 10) {
            if (predicate(cur)) return cur
            cur = cur.parent
        }
        return null
    }

    private fun descendant(
        root: AccessibilityNodeInfo,
        predicate: (AccessibilityNodeInfo) -> Boolean,
    ): AccessibilityNodeInfo? {
        val queue = ArrayDeque<AccessibilityNodeInfo>().apply { add(root) }
        var seen = 0
        while (queue.isNotEmpty() && seen++ < 300) {
            val cur = queue.removeFirst()
            if (predicate(cur)) return cur
            for (i in 0 until cur.childCount) {
                cur.getChild(i)?.let(queue::add)
            }
        }
        return null
    }

    private fun noA11y() = ActionResult.Failed(
        "accessibility_disabled",
        "Enable Kiki Screen Helper in Android Accessibility Settings to inspect or control other apps.",
    )

    companion object {
        internal fun shouldIncludeWindowInSnapshot(
            windowPackage: String?,
            windowType: Int,
            selfPackage: String,
        ): Boolean = !(windowPackage == selfPackage && windowType != AccessibilityWindowInfo.TYPE_APPLICATION)
    }
}
