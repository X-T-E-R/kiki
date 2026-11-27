package dev.kiki.android.host.updater

import android.app.Activity
import android.app.AlertDialog
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import dev.kiki.android.host.KikiHostSettings
import dev.kiki.android.host.i18n.HostStrings
import dev.kiki.android.host.ui.KikiPalette
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URI
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

@Serializable
data class AndroidUpdateFeed(
    val schemaVersion: Int = 1,
    val channel: String = "stable",
    val packageName: String,
    val versionName: String,
    val versionCode: Long,
    val apkUrl: String,
    val sha256: String,
    val sizeBytes: Long,
    val signerCertSha256: String,
    val publishedAt: String = "",
    val notes: String = "",
)

data class ManualUpdateCheckOutcome(
    val ok: Boolean,
    val updateAvailable: Boolean,
    val latestVersionName: String? = null,
    val latestVersionCode: Long? = null,
    val error: String? = null,
)

class KikiApkUpdater(
    private val appContext: Context,
    private val settings: KikiHostSettings,
    val currentVersionName: String,
    val currentVersionCode: Long,
    val distributionChannel: String,
    val defaultFeedUrl: String,
    val expectedSignerSha256: String,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val autoCheckedThisProcess = AtomicBoolean(false)

    @Volatile
    private var activeDownloadJob: Job? = null

    @Volatile
    private var pendingInstallAfterPermission: VerifiedApkCandidate? = null

    private data class VerifiedApkCandidate(
        val file: File,
        val feed: AndroidUpdateFeed,
    )

    fun effectiveFeedUrl(): String =
        settings.updaterFeedUrlOverride ?: defaultFeedUrl

    fun maybeAutoCheckOnLaunch(activity: Activity) {
        if (!settings.autoCheckUpdates) return
        if (!autoCheckedThisProcess.compareAndSet(false, true)) return
        val feedUrl = effectiveFeedUrl().trim()
        if (feedUrl.isEmpty()) return

        scope.launch {
            val feed = withContext(Dispatchers.IO) {
                runCatching { fetchFeed(feedUrl) }.getOrNull()
            } ?: return@launch

            if (!shouldPromptAutoUpdate(
                    feed = feed,
                    currentPackage = appContext.packageName,
                    currentVersionCode = currentVersionCode,
                    settings = settings,
                    nowMs = System.currentTimeMillis(),
                )
            ) {
                return@launch
            }
            if (!activity.isFinishing && !activity.isDestroyed) {
                showUpdatePromptDialog(activity, feed)
            }
        }
    }

    suspend fun checkAndPrompt(
        activity: Activity,
        manual: Boolean = true,
        feedUrlOverride: String? = null,
    ): ManualUpdateCheckOutcome {
        val zh = HostStrings.isChinese(activity)
        val feedUrl = (feedUrlOverride?.let { KikiHostSettings.normalizeUpdaterFeedUrl(it) } ?: effectiveFeedUrl()).trim()
        if (feedUrl.isEmpty()) {
            val msg = if (zh) "未配置更新源地址" else "Update feed URL is not configured"
            if (manual) Toast.makeText(activity, msg, Toast.LENGTH_SHORT).show()
            return ManualUpdateCheckOutcome(ok = false, updateAvailable = false, error = msg)
        }

        val feedResult = withContext(Dispatchers.IO) {
            runCatching { fetchFeed(feedUrl) }
        }
        val feed = feedResult.getOrElse { err ->
            Log.w(TAG, "Update feed check failed ($feedUrl)", err)
            val msg = if (zh) {
                "检查更新失败：${err.message ?: "网络不可用"}"
            } else {
                "Update check failed: ${err.message ?: "network error"}"
            }
            if (manual && !activity.isFinishing && !activity.isDestroyed) {
                Toast.makeText(activity, msg, Toast.LENGTH_LONG).show()
            }
            return ManualUpdateCheckOutcome(ok = false, updateAvailable = false, error = err.message ?: "fetch_failed")
        }

        if (feed.packageName != appContext.packageName) {
            val msg = if (zh) {
                "更新源包名不匹配（${feed.packageName}）"
            } else {
                "Update package mismatch (${feed.packageName})"
            }
            if (manual && !activity.isFinishing && !activity.isDestroyed) {
                Toast.makeText(activity, msg, Toast.LENGTH_LONG).show()
            }
            return ManualUpdateCheckOutcome(ok = false, updateAvailable = false, error = "package_mismatch")
        }

        if (feed.versionCode <= currentVersionCode) {
            if (manual && !activity.isFinishing && !activity.isDestroyed) {
                val upToDate = if (zh) {
                    "当前已是最新版本 v$currentVersionName"
                } else {
                    "Kiki v$currentVersionName is up to date"
                }
                Toast.makeText(activity, upToDate, Toast.LENGTH_SHORT).show()
            }
            return ManualUpdateCheckOutcome(
                ok = true,
                updateAvailable = false,
                latestVersionName = feed.versionName,
                latestVersionCode = feed.versionCode,
            )
        }

        if (!activity.isFinishing && !activity.isDestroyed) {
            showUpdatePromptDialog(activity, feed)
        }
        return ManualUpdateCheckOutcome(
            ok = true,
            updateAvailable = true,
            latestVersionName = feed.versionName,
            latestVersionCode = feed.versionCode,
        )
    }

    fun onActivityResumed(activity: Activity) {
        val pending = pendingInstallAfterPermission ?: return
        if (!appContext.packageManager.canRequestPackageInstalls()) return
        pendingInstallAfterPermission = null
        if (!pending.file.isFile) return
        scope.launch {
            commitVerifiedApk(activity, pending.file, pending.feed)
        }
    }

    internal fun onInstallUserConfirmationLaunched(sessionId: Int) {
        Log.i(TAG, "System install confirmation sheet opened for session=$sessionId")
    }

    internal fun onInstallCompleted(success: Boolean, aborted: Boolean, message: String?) {
        if (success) {
            cleanupCachedApks()
        } else if (!aborted) {
            Log.w(TAG, "Install session ended with error: $message")
        }
    }

    private fun showUpdatePromptDialog(activity: Activity, feed: AndroidUpdateFeed) {
        val dark = (activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        val tokens = KikiPalette.of(dark)
        val zh = HostStrings.isChinese(activity)
        val density = activity.resources.displayMetrics.density
        fun dp(v: Int): Int = (v * density + 0.5f).toInt()

        val root = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(22), dp(18), dp(22), dp(14))
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(18).toFloat()
                setColor(tokens.paper)
                setStroke(dp(1), tokens.hairline)
            }
        }

        val titleView = TextView(activity).apply {
            text = if (zh) "发现新版本 ${feed.versionName}" else "Kiki ${feed.versionName} Available"
            setTextColor(tokens.ink)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        }
        root.addView(titleView)

        val metaView = TextView(activity).apply {
            val sizeLabel = formatSizeBytes(feed.sizeBytes)
            text = if (zh) {
                "当前 v$currentVersionName · 升级包 $sizeLabel"
            } else {
                "Current v$currentVersionName · $sizeLabel APK"
            }
            setTextColor(tokens.inkFaint)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setPadding(0, dp(4), 0, dp(10))
        }
        root.addView(metaView)

        val cleanedNotes = feed.notes.trim()
        if (cleanedNotes.isNotEmpty()) {
            val notesScroll = ScrollView(activity).apply {
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ).apply {
                    bottomMargin = dp(14)
                }
                background = GradientDrawable().apply {
                    shape = GradientDrawable.RECTANGLE
                    cornerRadius = dp(12).toFloat()
                    setColor(tokens.canvas)
                    setStroke(dp(1), tokens.hairline)
                }
            }
            val notesText = TextView(activity).apply {
                text = cleanedNotes
                setTextColor(tokens.inkSoft)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f)
                setLineSpacing(0f, 1.25f)
                setPadding(dp(14), dp(12), dp(14), dp(12))
                maxLines = 10
            }
            notesScroll.addView(notesText)
            root.addView(notesScroll)
        }

        val actionsRow = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END or Gravity.CENTER_VERTICAL
        }

        lateinit var dialog: AlertDialog

        fun makeActionChip(label: String, primary: Boolean, onClick: () -> Unit): TextView =
            TextView(activity).apply {
                text = label
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f)
                typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
                setPadding(dp(14), dp(9), dp(14), dp(9))
                setTextColor(if (primary) tokens.paper else tokens.inkSoft)
                background = GradientDrawable().apply {
                    shape = GradientDrawable.RECTANGLE
                    cornerRadius = dp(16).toFloat()
                    setColor(if (primary) tokens.ink else tokens.canvas)
                    if (!primary) setStroke(dp(1), tokens.hairline)
                }
                setOnClickListener { onClick() }
            }

        val skipBtn = makeActionChip(if (zh) "跳过此版本" else "Skip", primary = false) {
            settings.skippedVersionCode = feed.versionCode
            dialog.dismiss()
        }
        val snoozeBtn = makeActionChip(if (zh) "稍后提醒" else "Later", primary = false) {
            settings.remindLaterUntilMs = System.currentTimeMillis() + SNOOZE_DURATION_MS
            dialog.dismiss()
        }.apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply {
                marginStart = dp(8)
                marginEnd = dp(8)
            }
        }
        val updateBtn = makeActionChip(if (zh) "立即更新" else "Update", primary = true) {
            settings.skippedVersionCode = 0L
            settings.remindLaterUntilMs = 0L
            dialog.dismiss()
            startDownloadAndInstall(activity, feed)
        }

        actionsRow.addView(skipBtn)
        actionsRow.addView(snoozeBtn)
        actionsRow.addView(updateBtn)
        root.addView(actionsRow)

        dialog = AlertDialog.Builder(activity)
            .setView(root)
            .create()
        dialog.window?.setBackgroundDrawableResource(android.R.color.transparent)
        dialog.show()
    }

    fun startDownloadAndInstall(activity: Activity, feed: AndroidUpdateFeed) {
        activeDownloadJob?.cancel()
        val dark = (activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        val tokens = KikiPalette.of(dark)
        val zh = HostStrings.isChinese(activity)
        val density = activity.resources.displayMetrics.density
        fun dp(v: Int): Int = (v * density + 0.5f).toInt()

        val progressBar = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 1000
            progress = 0
            isIndeterminate = false
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(8)).apply {
                topMargin = dp(12)
                bottomMargin = dp(8)
            }
        }
        val statusLabel = TextView(activity).apply {
            text = if (zh) "正在准备下载…" else "Preparing download…"
            setTextColor(tokens.inkFaint)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        }
        val cancelBtn = TextView(activity).apply {
            text = if (zh) "取消" else "Cancel"
            setTextColor(tokens.inkSoft)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f)
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            setPadding(dp(14), dp(8), dp(14), dp(8))
            gravity = Gravity.CENTER
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(16).toFloat()
                setColor(tokens.canvas)
                setStroke(dp(1), tokens.hairline)
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply {
                gravity = Gravity.END
                topMargin = dp(8)
            }
        }
        val container = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(22), dp(18), dp(22), dp(14))
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(18).toFloat()
                setColor(tokens.paper)
                setStroke(dp(1), tokens.hairline)
            }
            addView(TextView(activity).apply {
                text = if (zh) "正在下载 Kiki ${feed.versionName}" else "Downloading Kiki ${feed.versionName}"
                setTextColor(tokens.ink)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 16.5f)
                typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            })
            addView(progressBar)
            addView(statusLabel)
            addView(cancelBtn)
        }

        val progressDialog = AlertDialog.Builder(activity)
            .setView(container)
            .setCancelable(false)
            .create()
        progressDialog.window?.setBackgroundDrawableResource(android.R.color.transparent)
        if (!activity.isFinishing && !activity.isDestroyed) {
            progressDialog.show()
        }

        val job = scope.launch {
            try {
                val apkFile = withContext(Dispatchers.IO) {
                    downloadAndVerifyApk(feed) { downloadedBytes, totalBytes ->
                        scope.launch {
                            if (totalBytes > 0L) {
                                val permille = ((downloadedBytes * 1000L) / totalBytes).toInt().coerceIn(0, 1000)
                                progressBar.isIndeterminate = false
                                progressBar.progress = permille
                                statusLabel.text = "${formatSizeBytes(downloadedBytes)} / ${formatSizeBytes(totalBytes)}"
                            } else {
                                progressBar.isIndeterminate = true
                                statusLabel.text = formatSizeBytes(downloadedBytes)
                            }
                        }
                    }
                }
                if (progressDialog.isShowing) runCatching { progressDialog.dismiss() }
                proceedWithVerifiedApk(activity, apkFile, feed)
            } catch (ce: CancellationException) {
                if (progressDialog.isShowing) runCatching { progressDialog.dismiss() }
                throw ce
            } catch (err: Throwable) {
                Log.w(TAG, "APK update download/verification failed", err)
                if (progressDialog.isShowing) runCatching { progressDialog.dismiss() }
                if (!activity.isFinishing && !activity.isDestroyed) {
                    val msg = if (zh) {
                        "更新校验未通过：${err.message ?: "未知错误"}"
                    } else {
                        "Update verification failed: ${err.message ?: "unknown error"}"
                    }
                    Toast.makeText(activity, msg, Toast.LENGTH_LONG).show()
                }
            }
        }
        activeDownloadJob = job
        cancelBtn.setOnClickListener {
            job.cancel()
            if (progressDialog.isShowing) runCatching { progressDialog.dismiss() }
        }
    }

    private suspend fun proceedWithVerifiedApk(
        activity: Activity,
        apkFile: File,
        feed: AndroidUpdateFeed,
    ) {
        if (!appContext.packageManager.canRequestPackageInstalls()) {
            pendingInstallAfterPermission = VerifiedApkCandidate(apkFile, feed)
            if (activity.isFinishing || activity.isDestroyed) return
            val zh = HostStrings.isChinese(activity)
            AlertDialog.Builder(activity)
                .setTitle(if (zh) "允许应用内安装更新" else "Allow In-App Updates")
                .setMessage(
                    if (zh) {
                        "安装包已通过签名与完整性校验。请在接下来的系统页面开启「允许来自此来源的应用」，返回后将自动继续安装。"
                    } else {
                        "The update APK passed cryptographic signature verification. Enable 'Allow from this source' on the next screen to continue."
                    },
                )
                .setPositiveButton(if (zh) "前往开启" else "Open Settings") { _, _ ->
                    val intent = Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:${appContext.packageName}"),
                    )
                    runCatching { activity.startActivity(intent) }
                }
                .setNegativeButton(if (zh) "取消" else "Cancel") { _, _ ->
                    pendingInstallAfterPermission = null
                }
                .show()
            return
        }
        commitVerifiedApk(activity, apkFile, feed)
    }

    private suspend fun commitVerifiedApk(
        activity: Activity,
        apkFile: File,
        feed: AndroidUpdateFeed,
    ) {
        val zh = HostStrings.isChinese(activity)
        val commitResult = withContext(Dispatchers.IO) {
            runCatching {
                commitPackageInstallerSession(apkFile)
            }
        }
        commitResult.onFailure { err ->
            Log.e(TAG, "Failed to commit PackageInstaller session for v${feed.versionName}", err)
            if (!activity.isFinishing && !activity.isDestroyed) {
                val text = if (zh) {
                    "无法启动系统安装器：${err.message ?: "未知错误"}"
                } else {
                    "Could not start system installer: ${err.message ?: "unknown error"}"
                }
                Toast.makeText(activity, text, Toast.LENGTH_LONG).show()
            }
        }
    }

    internal fun fetchFeed(feedUrl: String): AndroidUpdateFeed {
        val validatedUrl = KikiHostSettings.normalizeUpdaterFeedUrl(feedUrl)
            ?: throw IllegalArgumentException("Empty updater feed URL")
        val client = buildHttpClient()
        val req = Request.Builder()
            .url(validatedUrl)
            .header("Accept", "application/json")
            .header("Cache-Control", "no-cache")
            .build()
        client.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) {
                throw IllegalStateException("HTTP ${resp.code}")
            }
            val body = resp.body?.string() ?: throw IllegalStateException("Empty feed response")
            return parseFeedJson(body)
        }
    }

    internal fun downloadAndVerifyApk(
        feed: AndroidUpdateFeed,
        onProgress: (downloadedBytes: Long, totalBytes: Long) -> Unit = { _, _ -> },
    ): File {
        val validatedApkUrl = KikiHostSettings.normalizeUpdaterFeedUrl(feed.apkUrl)
            ?: throw IllegalArgumentException("Empty APK URL")
        val updatesDir = File(appContext.cacheDir, "updates").apply { mkdirs() }
        val finalFile = File(updatesDir, "update-${feed.versionCode}.apk")
        val partFile = File(updatesDir, "update-${feed.versionCode}.apk.part")

        if (finalFile.isFile && finalFile.length() == feed.sizeBytes) {
            val cachedValid = runCatching {
                verifyDownloadedApkFile(finalFile, feed)
                true
            }.getOrDefault(false)
            if (cachedValid) {
                onProgress(feed.sizeBytes, feed.sizeBytes)
                return finalFile
            }
            runCatching { finalFile.delete() }
        }
        runCatching { partFile.delete() }

        val client = buildHttpClient(readTimeoutSec = 180L)
        val req = Request.Builder()
            .url(validatedApkUrl)
            .header("Accept", "application/vnd.android.package-archive, application/octet-stream")
            .build()

        client.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) {
                throw IllegalStateException("APK download HTTP ${resp.code}")
            }
            val body = resp.body ?: throw IllegalStateException("Empty APK response body")
            val digest = MessageDigest.getInstance("SHA-256")
            var downloaded = 0L
            var lastReported = 0L
            FileOutputStream(partFile).use { out ->
                val buf = ByteArray(32 * 1024)
                body.byteStream().use { input ->
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        downloaded += n
                        if (downloaded > feed.sizeBytes) {
                            throw SecurityException("APK size exceeded declared sizeBytes (${feed.sizeBytes})")
                        }
                        digest.update(buf, 0, n)
                        out.write(buf, 0, n)
                        if (downloaded - lastReported >= 64 * 1024 || downloaded == feed.sizeBytes) {
                            lastReported = downloaded
                            onProgress(downloaded, feed.sizeBytes)
                        }
                    }
                }
                out.fd.sync()
            }

            if (downloaded != feed.sizeBytes) {
                runCatching { partFile.delete() }
                throw SecurityException("APK size mismatch ($downloaded != ${feed.sizeBytes})")
            }
            val actualSha256 = digest.digest().toHexUpper()
            if (!actualSha256.equals(feed.sha256, ignoreCase = true)) {
                runCatching { partFile.delete() }
                throw SecurityException("APK SHA-256 mismatch")
            }
        }

        try {
            verifyArchivePackageAndSignature(partFile, feed)
        } catch (t: Throwable) {
            runCatching { partFile.delete() }
            throw t
        }

        runCatching { finalFile.delete() }
        if (!partFile.renameTo(finalFile)) {
            partFile.copyTo(finalFile, overwrite = true)
            runCatching { partFile.delete() }
        }
        onProgress(feed.sizeBytes, feed.sizeBytes)
        return finalFile
    }

    internal fun verifyDownloadedApkFile(apkFile: File, feed: AndroidUpdateFeed) {
        if (!apkFile.isFile || apkFile.length() != feed.sizeBytes) {
            throw SecurityException("APK size mismatch (${apkFile.length()} != ${feed.sizeBytes})")
        }
        val sha256 = sha256FileHex(apkFile)
        if (!sha256.equals(feed.sha256, ignoreCase = true)) {
            throw SecurityException("APK SHA-256 mismatch")
        }
        verifyArchivePackageAndSignature(apkFile, feed)
    }

    private fun verifyArchivePackageAndSignature(apkFile: File, feed: AndroidUpdateFeed) {
        val pm = appContext.packageManager
        val archiveInfo: PackageInfo = getArchiveInfoWithSigners(pm, apkFile.absolutePath)
            ?: throw SecurityException("Downloaded file is not a valid APK archive")
        val installedInfo: PackageInfo = getInstalledInfoWithSigners(pm, appContext.packageName)

        val archiveSigners = extractSingleSignerSetSha256(archiveInfo)
        val installedSigners = extractSingleSignerSetSha256(installedInfo)

        verifyUpgradeContract(
            expectedPackageName = appContext.packageName,
            currentVersionCode = currentVersionCode,
            installedSignerSha256 = installedSigners,
            pinnedSignerSha256 = expectedSignerSha256,
            feed = feed,
            archivePackageName = archiveInfo.packageName.orEmpty(),
            archiveVersionCode = archiveInfo.longVersionCode,
            archiveSignerSha256 = archiveSigners,
        )
    }

    private fun commitPackageInstallerSession(apkFile: File): Int {
        val installer = appContext.packageManager.packageInstaller
        val now = System.currentTimeMillis()
        for (existing in installer.mySessions) {
            if (!existing.isActive && now - existing.updatedMillis > STALE_SESSION_TTL_MS) {
                runCatching { installer.abandonSession(existing.sessionId) }
            }
        }

        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(appContext.packageName)
            setSize(apkFile.length())
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            }
        }

        val sessionId = installer.createSession(params)
        var committed = false
        try {
            installer.openSession(sessionId).use { session ->
                session.openWrite("base.apk", 0L, apkFile.length()).use { out ->
                    FileInputStream(apkFile).use { input ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n <= 0) break
                            out.write(buf, 0, n)
                        }
                    }
                    session.fsync(out)
                }

                val callbackIntent = Intent(appContext, UpdateInstallReceiver::class.java).apply {
                    setPackage(appContext.packageName)
                }
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
                val pendingIntent = PendingIntent.getBroadcast(
                    appContext,
                    sessionId,
                    callbackIntent,
                    flags,
                )
                session.commit(pendingIntent.intentSender)
                committed = true
            }
            return sessionId
        } finally {
            if (!committed) {
                runCatching { installer.abandonSession(sessionId) }
            }
        }
    }

    private fun cleanupCachedApks() {
        val dir = File(appContext.cacheDir, "updates")
        dir.listFiles()?.forEach { runCatching { it.delete() } }
    }

    private fun buildHttpClient(readTimeoutSec: Long = 20L): OkHttpClient {
        val builder = SHARED_HTTP_CLIENT.newBuilder()
            .connectTimeout(12L, TimeUnit.SECONDS)
            .readTimeout(readTimeoutSec, TimeUnit.SECONDS)
        val proxyRaw = settings.proxyUrl
        if (!proxyRaw.isNullOrBlank()) {
            runCatching {
                val uri = URI(proxyRaw)
                val scheme = uri.scheme?.lowercase(Locale.ROOT).orEmpty()
                val type = if (scheme.startsWith("socks")) Proxy.Type.SOCKS else Proxy.Type.HTTP
                if (!uri.host.isNullOrBlank() && uri.port in 1..65535) {
                    builder.proxy(Proxy(type, InetSocketAddress.createUnresolved(uri.host, uri.port)))
                }
            }
        }
        return builder.build()
    }

    companion object {
        private const val TAG = "KikiUpdater"
        const val SNOOZE_DURATION_MS: Long = 24L * 60L * 60L * 1000L
        private const val STALE_SESSION_TTL_MS: Long = 24L * 60L * 60L * 1000L
        private val HEX_64_REGEX = Regex("^[0-9a-fA-F]{64}$")

        private val FEED_JSON = Json {
            ignoreUnknownKeys = true
            isLenient = false
        }

        private val SHARED_HTTP_CLIENT = OkHttpClient.Builder()
            .followRedirects(true)
            .followSslRedirects(true)
            .build()

        fun normalizeHex64(raw: String, fieldName: String): String {
            val cleaned = raw.replace(":", "").trim().uppercase(Locale.ROOT)
            require(HEX_64_REGEX.matches(cleaned)) { "Invalid 64-hex $fieldName" }
            return cleaned
        }

        fun parseFeedJson(rawJson: String): AndroidUpdateFeed {
            val parsed = FEED_JSON.decodeFromString(AndroidUpdateFeed.serializer(), rawJson)
            require(parsed.schemaVersion == 1) { "Unsupported android.json schemaVersion=${parsed.schemaVersion}" }
            require(parsed.packageName.isNotBlank()) { "android.json missing packageName" }
            require(parsed.versionName.isNotBlank()) { "android.json missing versionName" }
            require(parsed.versionCode > 0L) { "android.json versionCode must be positive" }
            require(parsed.sizeBytes > 0L) { "android.json sizeBytes must be positive" }
            val normalizedUrl = KikiHostSettings.normalizeUpdaterFeedUrl(parsed.apkUrl)
                ?: throw IllegalArgumentException("android.json missing apkUrl")
            val sha256 = normalizeHex64(parsed.sha256, "sha256")
            val signer = normalizeHex64(parsed.signerCertSha256, "signerCertSha256")
            return parsed.copy(
                apkUrl = normalizedUrl,
                sha256 = sha256,
                signerCertSha256 = signer,
            )
        }

        fun shouldPromptAutoUpdate(
            feed: AndroidUpdateFeed,
            currentPackage: String,
            currentVersionCode: Long,
            settings: KikiHostSettings,
            nowMs: Long,
        ): Boolean {
            if (!settings.autoCheckUpdates) return false
            if (feed.packageName != currentPackage) return false
            if (feed.versionCode <= currentVersionCode) return false
            if (settings.skippedVersionCode == feed.versionCode) return false
            if (nowMs < settings.remindLaterUntilMs) return false
            return true
        }

        fun verifyUpgradeContract(
            expectedPackageName: String,
            currentVersionCode: Long,
            installedSignerSha256: String,
            pinnedSignerSha256: String,
            feed: AndroidUpdateFeed,
            archivePackageName: String,
            archiveVersionCode: Long,
            archiveSignerSha256: String,
        ) {
            if (archivePackageName != expectedPackageName || feed.packageName != expectedPackageName) {
                throw SecurityException("APK packageName '$archivePackageName' does not match '$expectedPackageName'")
            }
            if (archiveVersionCode != feed.versionCode) {
                throw SecurityException("APK versionCode ($archiveVersionCode) does not match feed (${feed.versionCode})")
            }
            if (archiveVersionCode <= currentVersionCode) {
                throw SecurityException("Downgrade or same-version install rejected ($archiveVersionCode <= $currentVersionCode)")
            }
            val normArchiveSigner = normalizeHex64(archiveSignerSha256, "archiveSignerSha256")
            val normInstalledSigner = normalizeHex64(installedSignerSha256, "installedSignerSha256")
            val normFeedSigner = normalizeHex64(feed.signerCertSha256, "feed.signerCertSha256")

            if (normArchiveSigner != normInstalledSigner) {
                throw SecurityException("APK signing certificate ($normArchiveSigner) does not match installed app ($normInstalledSigner)")
            }
            if (normArchiveSigner != normFeedSigner) {
                throw SecurityException("APK signing certificate ($normArchiveSigner) does not match feed signerCertSha256 ($normFeedSigner)")
            }
            if (pinnedSignerSha256.isNotBlank()) {
                val normPinned = normalizeHex64(pinnedSignerSha256, "expectedSignerSha256")
                if (normArchiveSigner != normPinned) {
                    throw SecurityException("APK signing certificate ($normArchiveSigner) does not match pinned release certificate ($normPinned)")
                }
            }
        }

        fun sha256FileHex(file: File): String {
            val digest = MessageDigest.getInstance("SHA-256")
            FileInputStream(file).use { input ->
                val buf = ByteArray(32 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n <= 0) break
                    digest.update(buf, 0, n)
                }
            }
            return digest.digest().toHexUpper()
        }

        fun formatSizeBytes(bytes: Long): String {
            if (bytes < 1024L) return "$bytes B"
            val kb = bytes / 1024.0
            if (kb < 1024.0) return String.format(Locale.US, "%.1f KB", kb)
            val mb = kb / 1024.0
            return String.format(Locale.US, "%.1f MB", mb)
        }

        private fun ByteArray.toHexUpper(): String =
            joinToString("") { "%02X".format(it) }

        @Suppress("DEPRECATION")
        private fun getArchiveInfoWithSigners(pm: PackageManager, archivePath: String): PackageInfo? =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                pm.getPackageArchiveInfo(
                    archivePath,
                    PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES.toLong()),
                )
            } else {
                pm.getPackageArchiveInfo(archivePath, PackageManager.GET_SIGNING_CERTIFICATES)
            }

        @Suppress("DEPRECATION")
        private fun getInstalledInfoWithSigners(pm: PackageManager, packageName: String): PackageInfo =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                pm.getPackageInfo(
                    packageName,
                    PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES.toLong()),
                )
            } else {
                pm.getPackageInfo(packageName, PackageManager.GET_SIGNING_CERTIFICATES)
            }

        private fun extractSingleSignerSetSha256(info: PackageInfo): String {
            val signingInfo = info.signingInfo
                ?: throw SecurityException("Package signingInfo missing")
            if (signingInfo.hasMultipleSigners()) {
                throw SecurityException("Multi-signer APKs are not permitted")
            }
            val certs = signingInfo.apkContentsSigners?.takeIf { it.isNotEmpty() }
                ?: signingInfo.signingCertificateHistory
                ?: throw SecurityException("No signing certificates found on APK")
            if (certs.isEmpty()) {
                throw SecurityException("Empty signing certificate list")
            }
            val leafBytes = certs[0].toByteArray()
            return MessageDigest.getInstance("SHA-256").digest(leafBytes).toHexUpper()
        }
    }
}
