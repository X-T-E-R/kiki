package dev.kiki.android.host.i18n

import android.content.Context
import java.util.Locale

object HostStrings {
    fun isChinese(locale: Locale?): Boolean {
        val lang = locale?.language?.lowercase(Locale.ROOT).orEmpty()
        return lang == "zh"
    }

    fun isChinese(context: Context): Boolean {
        val cfg = context.resources.configuration
        val primary = if (!cfg.locales.isEmpty) cfg.locales[0] else Locale.getDefault()
        return isChinese(primary)
    }

    fun stepLabel(toolName: String, zh: Boolean): String = if (zh) {
        when (toolName) {
            "phone_observe", "phone_list_elements", "phone_query", "phone_extract" -> "Kiki 正在查看屏幕"
            "phone_screenshot", "phone_describe", "phone_find_visually" -> "Kiki 正在截屏"
            "phone_tap" -> "Kiki 正在点击"
            "phone_scroll", "phone_swipe", "phone_find", "phone_collect" -> "Kiki 正在滑动浏览"
            "phone_type_text", "phone_clear_text" -> "Kiki 正在输入"
            "phone_launch_app", "phone_open_link" -> "Kiki 正在打开应用"
            else -> "Kiki 正在操作手机"
        }
    } else {
        when (toolName) {
            "phone_observe", "phone_list_elements", "phone_query", "phone_extract" -> "Kiki is viewing the screen"
            "phone_screenshot", "phone_describe", "phone_find_visually" -> "Kiki is capturing the screen"
            "phone_tap" -> "Kiki is tapping"
            "phone_scroll", "phone_swipe", "phone_find", "phone_collect" -> "Kiki is scrolling"
            "phone_type_text", "phone_clear_text" -> "Kiki is typing"
            "phone_launch_app", "phone_open_link" -> "Kiki is opening an app"
            else -> "Kiki is operating the phone"
        }
    }

    fun pillPausedStatus(zh: Boolean): String =
        if (zh) "Kiki 已暂停屏幕操作" else "Kiki screen actions paused"

    fun pillDefaultRunning(zh: Boolean): String =
        if (zh) "Kiki 正在操作手机" else "Kiki is operating the phone"

    fun pillBackAction(zh: Boolean): String =
        if (zh) "返回" else "Back"

    fun pillResumeAction(zh: Boolean): String =
        if (zh) "继续" else "Resume"

    fun pillStopAction(zh: Boolean): String =
        if (zh) "停止" else "Stop"

    fun pillBackAccessibilityDesc(zh: Boolean): String =
        if (zh) "返回 Kiki 并暂停屏幕操作" else "Return to Kiki and pause screen actions"

    fun pillResumeAccessibilityDesc(zh: Boolean): String =
        if (zh) "继续屏幕操作" else "Resume screen actions"

    fun pillStopAccessibilityDesc(zh: Boolean): String =
        if (zh) "停止当前执行" else "Stop active execution"
}
