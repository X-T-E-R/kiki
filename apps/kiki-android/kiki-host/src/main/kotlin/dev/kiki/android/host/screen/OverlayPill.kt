package dev.kiki.android.host.screen

import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.TextUtils
import android.util.TypedValue
import android.view.Choreographer
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.View.AccessibilityDelegate
import android.view.WindowManager
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import dev.kiki.android.host.i18n.HostStrings
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume
import kotlin.math.abs

class OverlayPill(
    private val appContext: Context,
    private val accessibilityContextProvider: () -> Context?,
    private val onPauseAndReturn: () -> Unit,
    private val onResumeAutomation: () -> Unit = {},
    private val onStopActiveTurns: () -> Unit,
) : PillOverlayController {

    private val mainHandler = Handler(Looper.getMainLooper())
    private var boundAccessibilityCtx: Context? = null
    private var windowManager: WindowManager? = null
    private var windowRoot: FrameLayout? = null
    private var pillContainer: LinearLayout? = null
    private var statusDot: View? = null
    private var statusView: TextView? = null
    private var primaryHitTarget: FrameLayout? = null
    private var primaryChip: TextView? = null
    private var stopHitTarget: FrameLayout? = null
    private var stopChip: TextView? = null
    private var layoutParams: WindowManager.LayoutParams? = null

    @Volatile
    private var currentPaused: Boolean = false

    @Volatile
    override var isShowing: Boolean = false
        private set

    override fun showOrUpdate(statusText: String, paused: Boolean) {
        runOnMain {
            currentPaused = paused
            ensureAttachedLocked()
            val zh = HostStrings.isChinese(appContext)
            statusView?.text = statusText
            statusView?.contentDescription = statusText
            (statusDot?.background as? GradientDrawable)?.setColor(
                Color.parseColor(if (paused) "#F59E0B" else "#10B981"),
            )
            primaryChip?.text = if (paused) {
                HostStrings.pillResumeAction(zh)
            } else {
                HostStrings.pillBackAction(zh)
            }
            primaryHitTarget?.contentDescription = if (paused) {
                HostStrings.pillResumeAccessibilityDesc(zh)
            } else {
                HostStrings.pillBackAccessibilityDesc(zh)
            }
            stopChip?.text = HostStrings.pillStopAction(zh)
            stopHitTarget?.contentDescription = HostStrings.pillStopAccessibilityDesc(zh)
            windowRoot?.visibility = View.VISIBLE
            pillContainer?.visibility = View.VISIBLE
        }
    }

    override fun setGesturePassThrough(passThrough: Boolean) {
        runOnMain {
            val wm = windowManager ?: return@runOnMain
            val view = windowRoot ?: return@runOnMain
            val lp = layoutParams ?: return@runOnMain
            val baseFlags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
            val desired = if (passThrough) {
                baseFlags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
            } else {
                baseFlags
            }
            if (lp.flags != desired) {
                lp.flags = desired
                runCatching { wm.updateViewLayout(view, lp) }
            }
        }
    }

    override suspend fun setHiddenForScreenshot(hidden: Boolean) {
        if (!hidden) {
            suspendCancellableCoroutine { cont ->
                mainHandler.post {
                    pillContainer?.visibility = View.VISIBLE
                    windowRoot?.invalidate()
                    if (cont.isActive) cont.resume(Unit)
                }
            }
            return
        }

        val hadPill = suspendCancellableCoroutine { cont ->
            mainHandler.post {
                val root = windowRoot
                val content = pillContainer
                if (root == null || content == null || !isShowing) {
                    if (cont.isActive) cont.resume(false)
                    return@post
                }
                content.visibility = View.INVISIBLE
                root.invalidate()
                if (cont.isActive) cont.resume(true)
            }
        }
        if (!hadPill) return

        withTimeoutOrNull(300L) {
            suspendCancellableCoroutine { cont ->
                mainHandler.post {
                    val root = windowRoot
                    if (root == null || !root.isAttachedToWindow) {
                        if (cont.isActive) cont.resume(Unit)
                        return@post
                    }
                    root.viewTreeObserver.registerFrameCommitCallback {
                        if (cont.isActive) cont.resume(Unit)
                    }
                    root.invalidate()
                }
            }
        }
        repeat(2) {
            suspendCancellableCoroutine { cont ->
                mainHandler.post {
                    Choreographer.getInstance().postFrameCallback {
                        if (cont.isActive) cont.resume(Unit)
                    }
                }
            }
        }
    }

    override fun hide() {
        runOnMain {
            detachLocked()
        }
    }

    private fun detachLocked() {
        val wm = windowManager
        val view = windowRoot
        boundAccessibilityCtx = null
        windowRoot = null
        pillContainer = null
        statusDot = null
        statusView = null
        primaryHitTarget = null
        primaryChip = null
        stopHitTarget = null
        stopChip = null
        layoutParams = null
        windowManager = null
        isShowing = false
        if (wm != null && view != null) {
            runCatching { wm.removeViewImmediate(view) }
        }
    }

    private fun ensureAttachedLocked() {
        val a11yCtx = accessibilityContextProvider()
        val existingRoot = windowRoot
        if (existingRoot != null && isShowing) {
            val stillValid = existingRoot.isAttachedToWindow &&
                (layoutParams?.type != WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY || a11yCtx === boundAccessibilityCtx)
            if (stillValid) return
            detachLocked()
        }
        val canAppOverlay = Settings.canDrawOverlays(appContext)
        val hostCtx: Context
        val windowType: Int
        if (a11yCtx != null) {
            hostCtx = a11yCtx
            windowType = WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY
        } else if (canAppOverlay) {
            hostCtx = appContext
            windowType = WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            return
        }

        val wm = hostCtx.getSystemService(Context.WINDOW_SERVICE) as? WindowManager ?: return
        val density = appContext.resources.displayMetrics.density
        fun dp(v: Int): Int = (v * density + 0.5f).toInt()
        val zh = HostStrings.isChinese(appContext)

        val root = FrameLayout(hostCtx).apply {
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
        }

        val container = LinearLayout(hostCtx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
            setPadding(dp(14), 0, dp(6), 0)
            minimumHeight = dp(MIN_TOUCH_TARGET_DP)
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(24).toFloat()
                setColor(Color.parseColor("#F5FFFFFF"))
                setStroke(dp(1), Color.parseColor("#220F172A"))
            }
            elevation = dp(6).toFloat()
        }

        val dot = View(hostCtx).apply {
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            layoutParams = LinearLayout.LayoutParams(dp(8), dp(8)).apply {
                marginEnd = dp(8)
            }
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.parseColor("#10B981"))
            }
        }

        val label = TextView(hostCtx).apply {
            text = HostStrings.pillDefaultRunning(zh)
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
            setTextColor(Color.parseColor("#0F172A"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            maxWidth = dp(190)
            setPadding(0, 0, dp(4), 0)
        }

        val buttonRoleDelegate = object : AccessibilityDelegate() {
            override fun onInitializeAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfo) {
                super.onInitializeAccessibilityNodeInfo(host, info)
                info.className = Button::class.java.name
                info.isClickable = true
            }
        }

        fun makeActionTarget(
            textLabel: String,
            a11yDesc: String,
            accentHex: String,
            textHex: String,
            onClick: () -> Unit,
        ): Pair<FrameLayout, TextView> {
            val chip = TextView(hostCtx).apply {
                text = textLabel
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
                setTextColor(Color.parseColor(textHex))
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
                typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
                setPadding(dp(10), dp(5), dp(10), dp(5))
                layoutParams = FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.WRAP_CONTENT,
                    FrameLayout.LayoutParams.WRAP_CONTENT,
                    Gravity.CENTER,
                )
                background = GradientDrawable().apply {
                    shape = GradientDrawable.RECTANGLE
                    cornerRadius = dp(14).toFloat()
                    setColor(Color.parseColor(accentHex))
                }
            }
            val hitTarget = FrameLayout(hostCtx).apply {
                minimumWidth = dp(MIN_TOUCH_TARGET_DP)
                minimumHeight = dp(MIN_TOUCH_TARGET_DP)
                isClickable = true
                isFocusable = true
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
                contentDescription = a11yDesc
                accessibilityDelegate = buttonRoleDelegate
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    dp(MIN_TOUCH_TARGET_DP),
                )
                addView(chip)
                setOnClickListener { onClick() }
            }
            return hitTarget to chip
        }

        val (primaryTarget, primaryLabel) = makeActionTarget(
            textLabel = HostStrings.pillBackAction(zh),
            a11yDesc = HostStrings.pillBackAccessibilityDesc(zh),
            accentHex = "#EEF2F6",
            textHex = "#334155",
        ) {
            if (currentPaused) {
                onResumeAutomation()
            } else {
                onPauseAndReturn()
            }
        }

        val (stopTarget, stopLabel) = makeActionTarget(
            textLabel = HostStrings.pillStopAction(zh),
            a11yDesc = HostStrings.pillStopAccessibilityDesc(zh),
            accentHex = "#FEE2E2",
            textHex = "#B91C1C",
        ) {
            onStopActiveTurns()
        }

        container.addView(dot)
        container.addView(label)
        container.addView(primaryTarget)
        container.addView(stopTarget)
        root.addView(
            container,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
            ),
        )

        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            windowType,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
            y = dp(40)
        }

        attachDragSupport(container, root, wm, params, dp(6))

        runCatching {
            wm.addView(root, params)
            boundAccessibilityCtx = if (windowType == WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY) a11yCtx else null
            windowManager = wm
            windowRoot = root
            pillContainer = container
            statusDot = dot
            statusView = label
            primaryHitTarget = primaryTarget
            primaryChip = primaryLabel
            stopHitTarget = stopTarget
            stopChip = stopLabel
            layoutParams = params
            isShowing = true
        }
    }

    private fun attachDragSupport(
        touchTarget: View,
        windowView: View,
        wm: WindowManager,
        params: WindowManager.LayoutParams,
        slopPx: Int,
    ) {
        var downRawX = 0f
        var downRawY = 0f
        var startX = 0
        var startY = 0
        var dragging = false

        touchTarget.setOnTouchListener { _, ev ->
            when (ev.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downRawX = ev.rawX
                    downRawY = ev.rawY
                    startX = params.x
                    startY = params.y
                    dragging = false
                    false
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = (ev.rawX - downRawX).toInt()
                    val dy = (ev.rawY - downRawY).toInt()
                    if (!dragging && (abs(dx) > slopPx || abs(dy) > slopPx)) {
                        dragging = true
                    }
                    if (dragging) {
                        params.x = startX + dx
                        params.y = (startY - dy).coerceAtLeast(0)
                        runCatching { wm.updateViewLayout(windowView, params) }
                        true
                    } else {
                        false
                    }
                }
                else -> dragging
            }
        }
    }

    private fun runOnMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            block()
        } else {
            mainHandler.post(block)
        }
    }

    companion object {
        const val MIN_TOUCH_TARGET_DP = 48
    }
}
