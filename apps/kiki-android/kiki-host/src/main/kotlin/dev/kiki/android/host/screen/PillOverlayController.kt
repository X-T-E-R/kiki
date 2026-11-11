package dev.kiki.android.host.screen

interface PillOverlayController {
    val isShowing: Boolean
    fun showOrUpdate(statusText: String, paused: Boolean = false)
    fun setGesturePassThrough(passThrough: Boolean)
    suspend fun setHiddenForScreenshot(hidden: Boolean)
    fun hide()
}
