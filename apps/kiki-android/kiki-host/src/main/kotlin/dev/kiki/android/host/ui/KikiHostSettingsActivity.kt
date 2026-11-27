package dev.kiki.android.host.ui

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import dev.kiki.android.host.HostMode
import dev.kiki.android.host.KikiHost
import dev.kiki.android.host.KikiHostEnvironment
import dev.kiki.android.host.KikiHostSettings
import dev.kiki.android.host.KikiRuntimeService
import dev.kiki.android.host.i18n.HostStrings
import kotlinx.coroutines.launch

/**
 * Pure Kiki Android device settings screen: operating mode ("在本机运行 Kiki"),
 * app updates, tiered permissions, tool switches, proxy, and open-source notices.
 */
class KikiHostSettingsActivity : ComponentActivity() {

    private lateinit var host: KikiHostEnvironment
    private var localHostSwitch: Switch? = null
    private var localOnlyContainer: LinearLayout? = null
    private var a11yStatusBadge: TextView? = null
    private var overlayStatusBadge: TextView? = null
    private var notifStatusBadge: TextView? = null
    private var batteryStatusBadge: TextView? = null
    private var proxyValueLabel: TextView? = null
    private var updateChannelBadge: TextView? = null
    private var darkMode: Boolean = false
    private var suppressLocalSwitchCallback: Boolean = false

    private val notifPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { _ ->
        refreshPermissionBadges()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        host = KikiHost.resolve(applicationContext)

        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT

        darkMode = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.isAppearanceLightStatusBars = !darkMode
        controller.isAppearanceLightNavigationBars = !darkMode

        buildLayout(KikiPalette.of(darkMode))
    }

    override fun onResume() {
        super.onResume()
        syncModeStateUi()
        refreshPermissionBadges()
        host.updater.onActivityResumed(this)
    }

    @SuppressLint("BatteryLife", "UseSwitchCompatOrMaterialCode")
    private fun buildLayout(tokens: KikiPalette.Tokens) {
        val density = resources.displayMetrics.density
        fun dp(v: Int): Int = (v * density + 0.5f).toInt()
        val zh = HostStrings.isChinese(this)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(tokens.canvas)
        }

        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(20), dp(14), dp(20), dp(10))
        }

        val backBtn = TextView(this).apply {
            text = if (zh) "返回" else "Back"
            setTextColor(tokens.inkSoft)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setPadding(dp(12), dp(6), dp(12), dp(6))
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(16).toFloat()
                setColor(tokens.paper)
                setStroke(dp(1), tokens.hairline)
            }
            setOnClickListener { finish() }
        }

        val titleView = TextView(this).apply {
            text = if (zh) "设置" else "Settings"
            setTextColor(tokens.ink)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 19f)
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginStart = dp(14)
            }
        }
        header.addView(backBtn)
        header.addView(titleView)

        val scroll = ScrollView(this).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
            isFillViewport = true
        }

        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(8), dp(20), dp(36))
        }

        fun makeSectionHeading(text: String): TextView = TextView(this).apply {
            this.text = text
            setTextColor(tokens.inkFaint)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f)
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            setPadding(dp(4), dp(18), dp(4), dp(8))
        }

        fun makeGroupSheet(): LinearLayout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(14).toFloat()
                setColor(tokens.paper)
                setStroke(dp(1), tokens.hairline)
            }
        }

        fun addDivider(sheet: LinearLayout) {
            sheet.addView(View(this).apply {
                setBackgroundColor(tokens.hairline)
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)).apply {
                    marginStart = dp(16)
                    marginEnd = dp(16)
                }
            })
        }

        fun makeStatusRow(
            title: String,
            subtitle: String,
            onLongClick: (() -> Unit)? = null,
            onClick: () -> Unit,
        ): Pair<LinearLayout, TextView> {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                minimumHeight = dp(56)
                setPadding(dp(16), dp(12), dp(16), dp(12))
                isClickable = true
                isFocusable = true
                setOnClickListener { onClick() }
                if (onLongClick != null) {
                    setOnLongClickListener {
                        onLongClick()
                        true
                    }
                }
            }
            val textCol = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                    marginEnd = dp(12)
                }
            }
            textCol.addView(TextView(this).apply {
                text = title
                setTextColor(tokens.ink)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
                typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            })
            if (subtitle.isNotEmpty()) {
                textCol.addView(TextView(this).apply {
                    text = subtitle
                    setTextColor(tokens.inkFaint)
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f)
                    setPadding(0, dp(2), 0, 0)
                })
            }
            val badge = TextView(this).apply {
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f)
                typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
                setPadding(dp(10), dp(4), dp(10), dp(4))
            }
            row.addView(textCol)
            row.addView(badge)
            return row to badge
        }

        fun makeSwitchRow(
            title: String,
            subtitle: String,
            checked: Boolean,
            onToggle: (Boolean) -> Unit,
        ): Pair<LinearLayout, Switch> {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                minimumHeight = dp(56)
                setPadding(dp(16), dp(12), dp(16), dp(12))
            }
            val textCol = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                    marginEnd = dp(12)
                }
            }
            textCol.addView(TextView(this).apply {
                text = title
                setTextColor(tokens.ink)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
                typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            })
            if (subtitle.isNotEmpty()) {
                textCol.addView(TextView(this).apply {
                    text = subtitle
                    setTextColor(tokens.inkFaint)
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f)
                    setPadding(0, dp(2), 0, 0)
                })
            }
            val sw = Switch(this).apply {
                isChecked = checked
                thumbTintList = ColorStateList.valueOf(if (checked) tokens.selectedInk else tokens.inkFaint)
                trackTintList = ColorStateList.valueOf(if (checked) tokens.selectedBg else tokens.hairline)
                setOnCheckedChangeListener { _, isChecked ->
                    thumbTintList = ColorStateList.valueOf(if (isChecked) tokens.selectedInk else tokens.inkFaint)
                    trackTintList = ColorStateList.valueOf(if (isChecked) tokens.selectedBg else tokens.hairline)
                    onToggle(isChecked)
                }
            }
            row.setOnClickListener { sw.isChecked = !sw.isChecked }
            row.addView(textCol)
            row.addView(sw)
            return row to sw
        }

        val pkgUri = Uri.parse("package:$packageName")
        val isLocalInitially = host.settings.hostMode == HostMode.LOCAL_HOST

        // Section 0: Standalone "在本机运行 Kiki" Operating Mode Switch
        column.addView(makeSectionHeading(if (zh) "运行模式" else "Operating Mode"))
        val modeSheet = makeGroupSheet()
        val (localModeRow, localModeSw) = makeSwitchRow(
            title = if (zh) "在本机运行 Kiki" else "Run Kiki on This Phone",
            subtitle = if (zh) {
                "在手机本地启动独立智能体引擎；关闭则停止后台服务，仅连接电脑 Kiki"
            } else {
                "Starts a standalone local engine on this phone; turn off for zero-background remote mode"
            },
            checked = isLocalInitially,
        ) { enabled ->
            if (!suppressLocalSwitchCallback) {
                handleLocalHostModeToggle(enabled)
            }
        }
        localHostSwitch = localModeSw
        modeSheet.addView(localModeRow)
        column.addView(modeSheet)

        // Section 1: App Updates (always available in both REMOTE_ONLY & LOCAL_HOST)
        column.addView(makeSectionHeading(if (zh) "应用更新" else "App Updates"))
        val updateSheet = makeGroupSheet()
        val (autoUpdateRow, _) = makeSwitchRow(
            title = if (zh) "自动检查更新" else "Check for Updates Automatically",
            subtitle = if (zh) "启动时静默检查新版本并校验数字签名" else "Check signed release feed on launch",
            checked = host.settings.autoCheckUpdates,
        ) { enabled ->
            host.settings.autoCheckUpdates = enabled
        }
        val (checkNowRow, checkNowBadge) = makeStatusRow(
            title = if (zh) "检查更新" else "Check for Updates",
            subtitle = if (zh) {
                "当前 v${host.versionName} (${host.distributionChannel})"
            } else {
                "Current v${host.versionName} (${host.distributionChannel})"
            },
            onLongClick = { showUpdaterFeedDialog(tokens, zh) },
        ) {
            lifecycleScope.launch {
                host.updater.checkAndPrompt(this@KikiHostSettingsActivity, manual = true)
            }
        }
        updateChannelBadge = checkNowBadge
        updateSheet.addView(autoUpdateRow)
        addDivider(updateSheet)
        updateSheet.addView(checkNowRow)
        column.addView(updateSheet)

        // Section 2: Network Proxy (applies to updater & local runtime)
        column.addView(makeSectionHeading(if (zh) "网络连接" else "Network"))
        val netSheet = makeGroupSheet()
        val (proxyRow, proxyBadge) = makeStatusRow(
            title = if (zh) "网络代理" else "Network Proxy",
            subtitle = if (zh) "用于更新检查与本机内核网络请求" else "Used for update checks and local kernel requests",
        ) {
            showProxyDialog(tokens, zh)
        }
        proxyValueLabel = proxyBadge
        netSheet.addView(proxyRow)
        column.addView(netSheet)

        // Container for Local-Host-Only Sections (hidden when "在本机运行 Kiki" is OFF)
        val localSections = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = if (isLocalInitially) View.VISIBLE else View.GONE
        }
        localOnlyContainer = localSections

        // Local Group A: Background & Notifications
        localSections.addView(makeSectionHeading(if (zh) "本机后台保活" else "Local Runtime"))
        val runtimeSheet = makeGroupSheet()
        val (notifRow, notifBadge) = makeStatusRow(
            title = if (zh) "通知提醒" else "Notifications",
            subtitle = if (zh) "后台轮次完成或需要确认时提醒" else "Alerts when background turns finish or need approval",
        ) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
            ) {
                notifPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            } else {
                safeLaunch(
                    Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                        putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                    },
                    pkgUri,
                )
            }
        }
        notifStatusBadge = notifBadge
        val (batteryRow, batteryBadge) = makeStatusRow(
            title = if (zh) "后台省电豁免（可选）" else "Unrestricted Battery (Optional)",
            subtitle = if (zh) "避免长耗时任务在锁屏后被系统挂起" else "Prevents Android from freezing active local sessions",
        ) {
            safeLaunch(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkgUri), pkgUri)
        }
        batteryStatusBadge = batteryBadge

        val (autostartRow, _) = makeSwitchRow(
            title = if (zh) "开机自动启动内核" else "Start Kernel on Boot",
            subtitle = if (zh) "设备重启后恢复本机 Kiki 服务" else "Launch local Kiki service after device reboot",
            checked = host.settings.bootAutostart,
        ) { allowed ->
            host.settings.bootAutostart = allowed
        }

        runtimeSheet.addView(notifRow)
        addDivider(runtimeSheet)
        runtimeSheet.addView(batteryRow)
        addDivider(runtimeSheet)
        runtimeSheet.addView(autostartRow)
        localSections.addView(runtimeSheet)

        // Local Group B: Screen Control (Deferred Optional)
        localSections.addView(makeSectionHeading(if (zh) "屏幕辅助（执行手机自动化时按需开启）" else "Screen Control (On Demand)"))
        val screenSheet = makeGroupSheet()
        val (a11yRow, a11yBadge) = makeStatusRow(
            title = if (zh) "无障碍服务" else "Accessibility Service",
            subtitle = if (zh) "需要读屏或跨应用点击时开启" else "Enable only if Kiki should inspect or tap other apps",
        ) {
            safeLaunch(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS), pkgUri)
        }
        a11yStatusBadge = a11yBadge
        val (overlayRow, overlayBadge) = makeStatusRow(
            title = if (zh) "悬浮状态胶囊" else "Overlay Pill",
            subtitle = if (zh) "跨应用执行时显示暂停与返回按钮" else "Shows pause and return controls above other apps",
        ) {
            safeLaunch(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, pkgUri), pkgUri)
        }
        overlayStatusBadge = overlayBadge
        screenSheet.addView(a11yRow)
        addDivider(screenSheet)
        screenSheet.addView(overlayRow)
        localSections.addView(screenSheet)

        // Local Group C: Device Tool Switches
        localSections.addView(makeSectionHeading(if (zh) "原生工具权限" else "Device Tool Access"))
        val toolsSheet = makeGroupSheet()
        toolsSheet.addView(makeSwitchRow(
            title = if (zh) "读取剪贴板" else "Read Clipboard",
            subtitle = if (zh) "仅在 Kiki 前台可见时允许工具读取" else "Allows clipboard_read while Kiki is in the foreground",
            checked = host.settings.allowClipboardRead,
        ) { allowed ->
            host.settings.allowClipboardRead = allowed
        }.first)
        addDivider(toolsSheet)
        toolsSheet.addView(makeSwitchRow(
            title = if (zh) "写入剪贴板" else "Write Clipboard",
            subtitle = if (zh) "允许工具将文本复制到系统剪贴板" else "Allows clipboard_write to copy text",
            checked = host.settings.allowClipboardWrite,
        ) { allowed ->
            host.settings.allowClipboardWrite = allowed
        }.first)
        addDivider(toolsSheet)
        toolsSheet.addView(makeSwitchRow(
            title = if (zh) "唤醒屏幕" else "Wake Screen",
            subtitle = if (zh) "允许 device_wake 点亮熄灭的屏幕" else "Allows device_wake to turn on the display",
            checked = host.settings.allowWakeUnlock,
        ) { allowed ->
            host.settings.allowWakeUnlock = allowed
        }.first)
        localSections.addView(toolsSheet)

        column.addView(localSections)

        // Section 4: About & Open-Source Notices
        column.addView(makeSectionHeading(if (zh) "关于" else "About"))
        val aboutSheet = makeGroupSheet()
        val (noticesRow, noticesBadge) = makeStatusRow(
            title = if (zh) "开源致谢" else "Open-Source Notices",
            subtitle = "THIRD_PARTY_NOTICES.md",
        ) {
            startActivity(Intent(this, KikiOpenSourceNoticesActivity::class.java))
        }
        styleNeutralBadge(noticesBadge, if (zh) "查看" else "View", tokens)
        aboutSheet.addView(noticesRow)
        column.addView(aboutSheet)

        val versionFooter = TextView(this).apply {
            text = "Kiki ${host.versionName} (${host.gitHash}) · $packageName"
            setTextColor(tokens.inkFaint)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            gravity = Gravity.CENTER
            setPadding(0, dp(24), 0, dp(8))
        }
        column.addView(versionFooter)

        scroll.addView(column)
        root.addView(header)
        root.addView(scroll)

        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        setContentView(root)
        refreshPermissionBadges()
    }

    private fun handleLocalHostModeToggle(enabled: Boolean) {
        if (enabled) {
            host.settings.hostMode = HostMode.LOCAL_HOST
            localOnlyContainer?.visibility = View.VISIBLE
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                !host.settings.localNotifPromptedOnce &&
                ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
            ) {
                host.settings.localNotifPromptedOnce = true
                notifPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
            KikiRuntimeService.ensureStarted(applicationContext)
            refreshPermissionBadges()
        } else {
            host.settings.hostMode = HostMode.REMOTE_ONLY
            localOnlyContainer?.visibility = View.GONE
            lifecycleScope.launch {
                KikiRuntimeService.stopAndTeardown(applicationContext)
            }
        }
    }

    private fun syncModeStateUi() {
        val isLocal = host.settings.hostMode == HostMode.LOCAL_HOST
        val sw = localHostSwitch
        if (sw != null && sw.isChecked != isLocal) {
            suppressLocalSwitchCallback = true
            sw.isChecked = isLocal
            suppressLocalSwitchCallback = false
        }
        localOnlyContainer?.visibility = if (isLocal) View.VISIBLE else View.GONE
    }

    private fun refreshPermissionBadges() {
        val tokens = KikiPalette.of(darkMode)
        val zh = HostStrings.isChinese(this)
        val a11yOn = host.isAccessibilityEnabled()
        val overlayOn = Settings.canDrawOverlays(this)
        val notifOn = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        } else {
            true
        }
        val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
        val batteryOn = pm?.isIgnoringBatteryOptimizations(packageName) ?: false

        a11yStatusBadge?.let { styleStatusBadge(it, a11yOn, zh, tokens) }
        overlayStatusBadge?.let { styleStatusBadge(it, overlayOn, zh, tokens) }
        notifStatusBadge?.let { styleStatusBadge(it, notifOn, zh, tokens) }
        batteryStatusBadge?.let { styleStatusBadge(it, batteryOn, zh, tokens) }

        val proxy = host.settings.proxyUrl
        proxyValueLabel?.let { badge ->
            styleNeutralBadge(badge, proxy ?: if (zh) "直连" else "Direct", tokens)
        }
        updateChannelBadge?.let { badge ->
            val hasCustom = host.settings.updaterFeedUrlOverride != null
            val label = if (hasCustom) {
                if (zh) "自定义源" else "Custom"
            } else {
                if (zh) "检查" else "Check"
            }
            styleNeutralBadge(badge, label, tokens)
        }
    }

    private fun styleStatusBadge(view: TextView, granted: Boolean, zh: Boolean, tokens: KikiPalette.Tokens) {
        val density = resources.displayMetrics.density
        val r = (12 * density + 0.5f)
        view.text = if (granted) {
            if (zh) "已开启" else "Enabled"
        } else {
            if (zh) "去设置" else "Set up"
        }
        view.setTextColor(if (granted) tokens.success else tokens.selectedInk)
        view.background = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = r
            setColor(if (granted) tokens.canvas else tokens.selectedBg)
        }
    }

    private fun styleNeutralBadge(view: TextView, label: String, tokens: KikiPalette.Tokens) {
        val density = resources.displayMetrics.density
        val r = (12 * density + 0.5f)
        view.text = label
        view.setTextColor(tokens.inkSoft)
        view.background = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = r
            setColor(tokens.canvas)
        }
    }

    private fun showProxyDialog(tokens: KikiPalette.Tokens, zh: Boolean) {
        val density = resources.displayMetrics.density
        fun dp(v: Int): Int = (v * density + 0.5f).toInt()
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            hint = "http://127.0.0.1:7890"
            setText(host.settings.proxyUrl.orEmpty())
            setSingleLine(true)
        }
        val errorLabel = TextView(this).apply {
            setTextColor(tokens.danger)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f)
            visibility = View.GONE
            setPadding(0, dp(6), 0, 0)
        }
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(22), dp(14), dp(22), dp(4))
            addView(input)
            addView(errorLabel)
        }

        val dialog = AlertDialog.Builder(this)
            .setTitle(if (zh) "网络代理" else "Network Proxy")
            .setView(container)
            .setPositiveButton(if (zh) "保存" else "Save", null)
            .setNeutralButton(if (zh) "清除" else "Clear") { _, _ ->
                host.settings.proxyUrl = null
                refreshPermissionBadges()
            }
            .setNegativeButton(if (zh) "取消" else "Cancel", null)
            .create()

        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val candidate = input.text?.toString().orEmpty()
                try {
                    val normalized = KikiHostSettings.normalizeProxyUrl(candidate)
                    host.settings.proxyUrl = normalized
                    refreshPermissionBadges()
                    dialog.dismiss()
                } catch (e: IllegalArgumentException) {
                    errorLabel.text = e.message
                    errorLabel.visibility = View.VISIBLE
                }
            }
        }
        dialog.show()
    }

    private fun showUpdaterFeedDialog(tokens: KikiPalette.Tokens, zh: Boolean) {
        val density = resources.displayMetrics.density
        fun dp(v: Int): Int = (v * density + 0.5f).toInt()
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            hint = host.updater.defaultFeedUrl
            setText(host.settings.updaterFeedUrlOverride.orEmpty())
            setSingleLine(true)
        }
        val errorLabel = TextView(this).apply {
            setTextColor(tokens.danger)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f)
            visibility = View.GONE
            setPadding(0, dp(6), 0, 0)
        }
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(22), dp(14), dp(22), dp(4))
            addView(input)
            addView(errorLabel)
        }

        val dialog = AlertDialog.Builder(this)
            .setTitle(if (zh) "更新源地址" else "Update Feed URL")
            .setView(container)
            .setPositiveButton(if (zh) "保存并检查" else "Save & Check", null)
            .setNeutralButton(if (zh) "恢复默认" else "Reset") { _, _ ->
                host.settings.updaterFeedUrlOverride = null
                refreshPermissionBadges()
            }
            .setNegativeButton(if (zh) "取消" else "Cancel", null)
            .create()

        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val candidate = input.text?.toString().orEmpty()
                try {
                    val normalized = KikiHostSettings.normalizeUpdaterFeedUrl(candidate)
                    host.settings.updaterFeedUrlOverride = normalized
                    refreshPermissionBadges()
                    dialog.dismiss()
                    lifecycleScope.launch {
                        host.updater.checkAndPrompt(this@KikiHostSettingsActivity, manual = true)
                    }
                } catch (e: IllegalArgumentException) {
                    errorLabel.text = e.message
                    errorLabel.visibility = View.VISIBLE
                }
            }
        }
        dialog.show()
    }

    private fun safeLaunch(intent: Intent, fallbackPkgUri: Uri) {
        runCatching { startActivity(intent) }.onFailure {
            runCatching { startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, fallbackPkgUri)) }
        }
    }
}
