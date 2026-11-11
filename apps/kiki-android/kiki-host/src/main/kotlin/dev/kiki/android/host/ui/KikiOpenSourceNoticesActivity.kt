package dev.kiki.android.host.ui

import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import dev.kiki.android.host.i18n.HostStrings
import java.nio.charset.StandardCharsets

/**
 * Renders bundled `THIRD_PARTY_NOTICES.md` inside the Kiki Android host.
 */
class KikiOpenSourceNoticesActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT

        val dark = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        val tokens = KikiPalette.of(dark)
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.isAppearanceLightStatusBars = !dark
        controller.isAppearanceLightNavigationBars = !dark

        val density = resources.displayMetrics.density
        fun dp(v: Int): Int = (v * density + 0.5f).toInt()
        val zh = HostStrings.isChinese(this)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(tokens.paper)
        }

        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(14), dp(16), dp(14))
        }

        val backBtn = TextView(this).apply {
            text = if (zh) "返回" else "Back"
            setTextColor(tokens.inkSoft)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setPadding(dp(12), dp(6), dp(12), dp(6))
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(16).toFloat()
                setColor(tokens.canvas)
            }
            setOnClickListener { finish() }
        }

        val titleView = TextView(this).apply {
            text = if (zh) "开源致谢" else "Open-Source Notices"
            setTextColor(tokens.ink)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginStart = dp(14)
            }
        }

        header.addView(backBtn)
        header.addView(titleView)

        val scroll = ScrollView(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f,
            )
            isFillViewport = true
        }

        val noticesText = loadBundledNotices()
        val bodyView = TextView(this).apply {
            text = noticesText
            setTextColor(tokens.inkSoft)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f)
            typeface = Typeface.MONOSPACE
            setLineSpacing(0f, 1.35f)
            setTextIsSelectable(true)
            setPadding(dp(20), dp(8), dp(20), dp(32))
        }
        scroll.addView(bodyView)

        root.addView(header)
        root.addView(scroll)

        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        setContentView(root)
    }

    private fun loadBundledNotices(): String {
        for (assetPath in CANDIDATE_ASSETS) {
            val content = runCatching {
                assets.open(assetPath).use { it.readBytes().toString(StandardCharsets.UTF_8) }
            }.getOrNull()
            if (!content.isNullOrBlank()) return content
        }
        return "Third-party open-source notices are available in THIRD_PARTY_NOTICES.md in the source repository."
    }

    companion object {
        private val CANDIDATE_ASSETS = listOf(
            "kiki/THIRD_PARTY_NOTICES.md",
            "THIRD_PARTY_NOTICES.md",
        )
    }
}
