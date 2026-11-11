/*
 * Adapted from Mika (https://github.com/wangzan101/Mika), licensed under Apache-2.0.
 * Modified for Kiki Android: removed legacy MikaApp/OverlayHost/TeachEvents coupling.
 */
package dev.kiki.android.tools.screen.a11y

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.accessibilityservice.GestureDescription
import android.app.Notification
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Path
import android.os.Build
import android.util.Log
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityWindowInfo
import com.wangzan101.mika.core.uistate.ScreenEvent
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.suspendCancellableCoroutine
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.resume

class KikiAccessibilityService : AccessibilityService() {

    private class DisplayEvent(val displayId: Int, val event: AccessibilityEvent)

    override fun onServiceConnected() {
        super.onServiceConnected()
        serviceInfo?.let { info ->
            if (info.flags and AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS == 0) {
                info.flags = info.flags or AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
                serviceInfo = info
            }
        }
        _instance.value = this
        Log.i(TAG, "Kiki accessibility service connected")
    }

    override fun onUnbind(intent: Intent?): Boolean {
        Log.i(TAG, "Kiki accessibility service unbound")
        clearInstance()
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        clearInstance()
        super.onDestroy()
    }

    private fun clearInstance() {
        _instance.compareAndSet(this, null)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (instance.value !== this) return
        if (event.eventType == AccessibilityEvent.TYPE_WINDOWS_CHANGED) windowChanges.tryEmit(Unit)
        if (event.eventType == AccessibilityEvent.TYPE_WINDOWS_CHANGED ||
            event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
        ) {
            windowGeneration.incrementAndGet()
        }
        if (event.eventType == AccessibilityEvent.TYPE_NOTIFICATION_STATE_CHANGED && notifications.subscriptionCount.value > 0) {
            val notification = event.parcelableData as? Notification
            val title = notification?.extras?.getCharSequence(Notification.EXTRA_TITLE)?.toString()
            val body = notification?.extras?.getCharSequence(Notification.EXTRA_TEXT)?.toString()
            val text = listOfNotNull(title, body).joinToString(" ").ifBlank { event.text.joinToString(" ") }
            notifications.tryEmit(ScreenEvent("notification", event.packageName?.toString(), text.take(2_000)))
        }
        if (events.subscriptionCount.value == 0) return
        val displayId = displayOf(event)
        if (displayId == Display.INVALID_DISPLAY) return
        @Suppress("DEPRECATION")
        val copy = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) event else AccessibilityEvent.obtain(event)
        events.tryEmit(DisplayEvent(displayId, copy))
    }

    override fun onInterrupt() = Unit

    fun windowsOn(displayId: Int): List<AccessibilityWindowInfo> =
        instance.value?.windowsOnAllDisplays?.get(displayId).orEmpty()

    suspend fun gesture(displayId: Int, path: Path, durationMs: Long): Boolean =
        gesture(displayId, listOf(path), durationMs)

    suspend fun gesture(displayId: Int, paths: List<Path>, durationMs: Long): Boolean =
        dispatch(displayId, paths.map { GestureDescription.StrokeDescription(it, 0, durationMs.coerceAtLeast(1)) })

    suspend fun taps(displayId: Int, x: Float, y: Float, count: Int, holdMs: Long, gapMs: Long): Boolean {
        val at = Path().apply { moveTo(x, y) }
        return dispatch(
            displayId,
            (0 until count).map { i ->
                GestureDescription.StrokeDescription(at, i * (holdMs + gapMs), holdMs.coerceAtLeast(1))
            },
        )
    }

    private suspend fun dispatch(displayId: Int, strokes: List<GestureDescription.StrokeDescription>): Boolean {
        val service = instance.value ?: return false
        val gesture = GestureDescription.Builder()
            .setDisplayId(displayId)
            .apply { strokes.forEach(::addStroke) }
            .build()
        return suspendCancellableCoroutine { cont ->
            val callback = object : GestureResultCallback() {
                override fun onCompleted(gestureDescription: GestureDescription) {
                    if (cont.isActive) cont.resume(true)
                }

                override fun onCancelled(gestureDescription: GestureDescription) {
                    if (cont.isActive) cont.resume(false)
                }
            }
            if (!service.dispatchGesture(gesture, callback, null) && cont.isActive) {
                cont.resume(false)
            }
        }
    }

    sealed interface MainShot {
        class Ok(val bitmap: Bitmap) : MainShot
        data object Secure : MainShot
        data class Failed(val code: Int) : MainShot
    }

    suspend fun takeMainScreenshot(): MainShot {
        val first = screenshotOnce()
        if (first !is MainShot.Failed || first.code != ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT) return first
        delay(SCREENSHOT_INTERVAL_MS)
        return screenshotOnce()
    }

    private suspend fun screenshotOnce(): MainShot = suspendCancellableCoroutine { cont ->
        val service = instance.value
        if (service == null) {
            cont.resume(MainShot.Failed(ERROR_TAKE_SCREENSHOT_NO_ACCESSIBILITY_ACCESS))
            return@suspendCancellableCoroutine
        }
        service.takeScreenshot(Display.DEFAULT_DISPLAY, service.mainExecutor, object : TakeScreenshotCallback {
            override fun onSuccess(result: ScreenshotResult) {
                val shot = runCatching {
                    result.hardwareBuffer.use { buffer ->
                        val hw = Bitmap.wrapHardwareBuffer(buffer, result.colorSpace) ?: return@runCatching null
                        hw.copy(Bitmap.Config.ARGB_8888, false).also { hw.recycle() }
                    }
                }.getOrNull()
                if (cont.isActive) {
                    cont.resume(shot?.let(MainShot::Ok) ?: MainShot.Failed(ERROR_TAKE_SCREENSHOT_INTERNAL_ERROR))
                }
            }

            override fun onFailure(errorCode: Int) {
                val secure = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE &&
                    errorCode == ERROR_TAKE_SCREENSHOT_SECURE_WINDOW
                if (cont.isActive) {
                    cont.resume(if (secure) MainShot.Secure else MainShot.Failed(errorCode))
                }
            }
        })
    }

    fun eventsFor(displayId: Int): Flow<AccessibilityEvent> =
        events.filter { it.displayId == displayId }.map { it.event }

    fun notificationEvents(): Flow<ScreenEvent> = notifications

    fun windowChanges(): Flow<Unit> = windowChanges

    private fun displayOf(event: AccessibilityEvent): Int {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return event.displayId
        val windowId = event.windowId
        if (windowId == -1) return Display.INVALID_DISPLAY
        val all = windowsOnAllDisplays
        for (i in 0 until all.size()) {
            if (all.valueAt(i).any { it.id == windowId }) return all.keyAt(i)
        }
        return Display.INVALID_DISPLAY
    }

    companion object {
        private const val EVENT_BUFFER = 64
        private const val SCREENSHOT_INTERVAL_MS = 1_000L
        private const val TAG = "KikiScreenA11y"

        private val events = MutableSharedFlow<DisplayEvent>(
            extraBufferCapacity = EVENT_BUFFER,
            onBufferOverflow = BufferOverflow.DROP_OLDEST,
        )
        private val windowChanges = MutableSharedFlow<Unit>(
            extraBufferCapacity = 1,
            onBufferOverflow = BufferOverflow.DROP_OLDEST,
        )
        private val windowGeneration = AtomicLong()

        fun windowGeneration(): Long = windowGeneration.get()

        private val notifications = MutableSharedFlow<ScreenEvent>(
            extraBufferCapacity = EVENT_BUFFER,
            onBufferOverflow = BufferOverflow.DROP_OLDEST,
        )

        private val _instance = MutableStateFlow<KikiAccessibilityService?>(null)
        val instance: StateFlow<KikiAccessibilityService?> = _instance.asStateFlow()
    }
}
