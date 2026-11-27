package dev.kiki.android.host.ui

import android.content.Context
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import dev.kiki.android.host.i18n.HostStrings

internal object ModePickerView {

    fun create(
        context: Context,
        dark: Boolean,
        onSelectRemoteOnly: () -> Unit,
        onSelectLocalHost: () -> Unit,
        onCheckUpdates: () -> Unit,
    ): View {
        val density = context.resources.displayMetrics.density
        fun dp(v: Int): Int = (v * density + 0.5f).toInt()
        val zh = HostStrings.isChinese(context)
        val tokens = KikiPalette.of(dark)

        val scroll = ScrollView(context).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            isFillViewport = true
            setBackgroundColor(tokens.canvas)
        }

        val outer = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(24), dp(36), dp(24), dp(28))
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            )
        }

        val brandLabel = TextView(context).apply {
            text = "Kiki"
            setTextColor(tokens.accent)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            letterSpacing = 0.04f
        }
        outer.addView(brandLabel)

        val titleView = TextView(context).apply {
            text = if (zh) "选择使用方式" else "Choose how to use Kiki"
            setTextColor(tokens.ink)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 26f)
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            setPadding(0, dp(6), 0, dp(24))
        }
        outer.addView(titleView)

        fun makeOptionCard(
            primary: Boolean,
            title: String,
            body: String,
            ctaLabel: String,
            tag: String,
            onClick: () -> Unit,
        ): LinearLayout = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            this.tag = tag
            isClickable = true
            isFocusable = true
            setPadding(dp(20), dp(20), dp(20), dp(18))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply {
                bottomMargin = dp(14)
            }
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(18).toFloat()
                setColor(if (primary) tokens.panel else tokens.paper)
                setStroke(
                    dp(if (primary) 2 else 1),
                    if (primary) tokens.ink else tokens.hairline,
                )
            }
            setOnClickListener { onClick() }

            val topRow = LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }

            val cardTitle = TextView(context).apply {
                text = title
                setTextColor(tokens.ink)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
                typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }

            val ctaBadge = TextView(context).apply {
                text = ctaLabel
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f)
                typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
                setPadding(dp(12), dp(6), dp(12), dp(6))
                setTextColor(if (primary) tokens.paper else tokens.inkSoft)
                background = GradientDrawable().apply {
                    shape = GradientDrawable.RECTANGLE
                    cornerRadius = dp(14).toFloat()
                    setColor(if (primary) tokens.ink else tokens.canvas)
                    if (!primary) setStroke(dp(1), tokens.hairline)
                }
            }

            topRow.addView(cardTitle)
            topRow.addView(ctaBadge)
            addView(topRow)

            addView(TextView(context).apply {
                text = body
                setTextColor(tokens.inkSoft)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f)
                setLineSpacing(0f, 1.3f)
                setPadding(0, dp(10), 0, 0)
            })
        }

        outer.addView(
            makeOptionCard(
                primary = true,
                title = if (zh) "连接电脑 Kiki" else "Connect to Computer Kiki",
                body = if (zh) {
                    "秒开直连电脑空间，不占本机后台与电量 · 仅扫码时使用相机"
                } else {
                    "Instant connection to your computer spaces with zero background drain · Camera used only when scanning QR"
                },
                ctaLabel = if (zh) "秒开连接" else "Connect",
                tag = "mode_card_remote_only",
                onClick = onSelectRemoteOnly,
            ),
        )

        outer.addView(
            makeOptionCard(
                primary = false,
                title = if (zh) "在本机运行 Kiki" else "Run Kiki on This Phone",
                body = if (zh) {
                    "在手机上独立运行完整智能体（亦可同时连接电脑） · 需后台运行通知"
                } else {
                    "Run a standalone local agent on your phone (can also connect to computers) · Uses background notification"
                },
                ctaLabel = if (zh) "本机启动" else "Run Local",
                tag = "mode_card_local_host",
                onClick = onSelectLocalHost,
            ),
        )

        val footerNote = TextView(context).apply {
            text = if (zh) {
                "设置后自动记住 · 随时可在「设置」中开关本机运行"
            } else {
                "Saved automatically · Toggle local engine anytime in Settings"
            }
            setTextColor(tokens.inkFaint)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f)
            gravity = Gravity.CENTER
            setPadding(dp(8), dp(14), dp(8), dp(8))
        }
        outer.addView(footerNote)

        val updateLink = TextView(context).apply {
            text = if (zh) "检查更新" else "Check for updates"
            setTextColor(tokens.selectedInk)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            gravity = Gravity.CENTER
            setPadding(dp(16), dp(8), dp(16), dp(8))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply {
                gravity = Gravity.CENTER_HORIZONTAL
            }
            setOnClickListener { onCheckUpdates() }
        }
        outer.addView(updateLink)

        scroll.addView(outer)
        return scroll
    }
}
