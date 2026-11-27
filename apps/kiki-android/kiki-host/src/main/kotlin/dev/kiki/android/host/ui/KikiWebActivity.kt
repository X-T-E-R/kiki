package dev.kiki.android.host.ui

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.DownloadManager
import android.content.ContentValues
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Rect
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import dev.kiki.android.host.KernelState
import dev.kiki.android.host.KikiHost
import dev.kiki.android.host.KikiHostEnvironment
import dev.kiki.android.host.KikiRuntimeService
import dev.kiki.android.host.i18n.HostStrings
import dev.kiki.android.host.share.ShareIntakeBatch
import dev.kiki.android.host.share.ShareIntakeStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File

class KikiWebActivity : ComponentActivity() {

    private var host: KikiHostEnvironment? = null
    private lateinit var rootFrame: FrameLayout
    private var webView: WebView? = null
    private lateinit var splashContainer: LinearLayout
    private lateinit var splashTitle: TextView
    private lateinit var splashHint: TextView
    private lateinit var splashRetryBtn: TextView
    private var bridgeHandler: AndroidBridgeHandler? = null

    private var activeScriptHandler: ScriptHandler? = null
    private var loadedOriginAndToken: Pair<String, String>? = null
    private var pendingFileChooserCallback: ValueCallback<Array<Uri>>? = null
    private var pendingCameraOutputUri: Uri? = null
    private var pendingCameraOutputFile: File? = null
    private var lastCssInsetsScript: String = ""
    private var lastImeCssPx: Int = -1
    private var lastSysBarsBottomPx: Int = 0
    private var pageReadyForEvents: Boolean = false
    private val pendingShareBatches = ArrayDeque<ShareIntakeBatch>()

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val cb = pendingFileChooserCallback
        pendingFileChooserCallback = null
        val cameraUri = pendingCameraOutputUri
        val cameraFile = pendingCameraOutputFile
        pendingCameraOutputUri = null
        pendingCameraOutputFile = null

        if (result.resultCode != Activity.RESULT_OK) {
            runCatching { cameraFile?.delete() }
            cb?.onReceiveValue(null)
            return@registerForActivityResult
        }

        val data = result.data
        val uris = buildList<Uri> {
            val clip = data?.clipData
            if (clip != null && clip.itemCount > 0) {
                for (i in 0 until clip.itemCount) {
                    clip.getItemAt(i)?.uri?.let { add(it) }
                }
            } else if (data?.data != null) {
                add(data.data!!)
            } else if (cameraUri != null && cameraFile != null && cameraFile.exists() && cameraFile.length() > 0L) {
                add(cameraUri)
            }
        }
        if (uris.isEmpty() || (cameraUri != null && !uris.contains(cameraUri))) {
            runCatching { cameraFile?.delete() }
        }
        cb?.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
    }

    private val requestNotifLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { _ ->
        pushPermissionSnapshot()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        val systemDark = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

        setupSplashViews(systemDark)
        applySystemBarsAppearance(dark = systemDark)
        setupInsetsForwarding()
        setupBackNavigation()

        KikiRuntimeService.ensureStarted(applicationContext)

        lifecycleScope.launch {
            val resolvedHost = withContext(Dispatchers.Default) {
                KikiHost.resolve(applicationContext)
            }
            host = resolvedHost
            if (savedInstanceState == null) {
                ingestShareIntentIfPresent(intent, resolvedHost)
            }
            KikiRuntimeService.kernelState.collect { state ->
                renderKernelState(state)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val route = intent.getStringExtra(KikiRuntimeService.EXTRA_SESSION_ROUTE)
        if (!route.isNullOrBlank()) {
            bridgeHandler?.pushEvent("navigate", buildJsonObject { put("route", route) })
        }
        lifecycleScope.launch {
            val resolvedHost = host ?: withContext(Dispatchers.Default) {
                KikiHost.resolve(applicationContext).also { host = it }
            }
            ingestShareIntentIfPresent(intent, resolvedHost)
        }
    }

    override fun onResume() {
        super.onResume()
        KikiRuntimeService.instanceRef?.notifyWebActivityResumed()
        pushPermissionSnapshot()
    }

    override fun onPause() {
        KikiRuntimeService.instanceRef?.notifyWebActivityPaused()
        super.onPause()
    }

    override fun onDestroy() {
        activeScriptHandler?.let { runCatching { it.remove() } }
        activeScriptHandler = null
        pendingFileChooserCallback?.onReceiveValue(null)
        pendingFileChooserCallback = null
        pendingCameraOutputUri = null
        runCatching { pendingCameraOutputFile?.delete() }
        pendingCameraOutputFile = null
        pageReadyForEvents = false
        webView?.let { wv ->
            wv.stopLoading()
            rootFrame.removeView(wv)
            wv.destroy()
        }
        webView = null
        bridgeHandler = null
        super.onDestroy()
    }

    private suspend fun ingestShareIntentIfPresent(incomingIntent: Intent?, resolvedHost: KikiHostEnvironment) {
        val action = incomingIntent?.action ?: return
        if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return
        val batch = withContext(Dispatchers.IO) {
            val payload = ShareIntakeStore.extractFromAndroidIntent(this@KikiWebActivity, incomingIntent)
                ?: return@withContext null
            resolvedHost.shareIntakeStore.stageIncoming(payload)
        }
        // Clear action so configuration recreation does not stage the same share twice.
        incomingIntent.action = Intent.ACTION_MAIN
        if (batch != null) {
            pendingShareBatches.addLast(batch)
            flushPendingShareBatches()
        }
    }

    private fun flushPendingShareBatches() {
        if (!pageReadyForEvents) return
        val bh = bridgeHandler ?: return
        while (pendingShareBatches.isNotEmpty()) {
            val batch = pendingShareBatches.removeFirst()
            val draftText = ShareIntakeStore.formatComposerDraft(batch)
            bh.pushEvent(
                "share-intake",
                buildJsonObject {
                    put("id", batch.id)
                    if (draftText.isNotEmpty()) {
                        put("draft", draftText)
                    }
                },
            )
        }
    }

    private fun applySystemBarsAppearance(dark: Boolean) {
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.isAppearanceLightStatusBars = !dark
        controller.isAppearanceLightNavigationBars = !dark
        val tokens = KikiPalette.of(dark)
        if (::rootFrame.isInitialized) {
            rootFrame.setBackgroundColor(tokens.paper)
        }
        webView?.setBackgroundColor(tokens.paper)
    }

    private fun setupSplashViews(dark: Boolean) {
        val density = resources.displayMetrics.density
        fun dp(v: Int): Int = (v * density + 0.5f).toInt()
        val zh = HostStrings.isChinese(this)
        val tokens = KikiPalette.of(dark)

        rootFrame = FrameLayout(this).apply {
            setBackgroundColor(tokens.paper)
        }

        splashContainer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            setPadding(dp(32), dp(32), dp(32), dp(32))
            setBackgroundColor(tokens.paper)
        }

        val progress = ProgressBar(this).apply {
            isIndeterminate = true
            layoutParams = LinearLayout.LayoutParams(dp(26), dp(26)).apply {
                bottomMargin = dp(20)
            }
        }

        splashTitle = TextView(this).apply {
            text = "Kiki"
            setTextColor(tokens.ink)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            gravity = Gravity.CENTER
        }

        splashHint = TextView(this).apply {
            text = if (zh) "正在启动本机内核" else "Starting local kernel"
            setTextColor(tokens.inkFaint)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply {
                topMargin = dp(8)
            }
        }

        splashRetryBtn = TextView(this).apply {
            text = if (zh) "重试启动" else "Retry"
            setTextColor(tokens.paper)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setPadding(dp(20), dp(10), dp(20), dp(10))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply {
                topMargin = dp(20)
            }
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(18).toFloat()
                setColor(tokens.ink)
            }
            visibility = View.GONE
            setOnClickListener {
                loadedOriginAndToken = null
                splashHint.text = if (zh) "正在重启本机内核…" else "Restarting local kernel…"
                visibility = View.GONE
                KikiRuntimeService.restartKernel(applicationContext)
            }
        }

        val nativeSettingsBtn = TextView(this).apply {
            text = if (zh) "设备设置" else "Phone settings"
            setTextColor(tokens.inkSoft)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setPadding(dp(16), dp(8), dp(16), dp(8))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply {
                topMargin = dp(16)
            }
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(18).toFloat()
                setColor(tokens.canvas)
                setStroke(dp(1), tokens.hairline)
            }
            setOnClickListener {
                (host ?: KikiHost.resolve(applicationContext)).openNativePhoneSettings(this@KikiWebActivity)
            }
        }

        splashContainer.addView(progress)
        splashContainer.addView(splashTitle)
        splashContainer.addView(splashHint)
        splashContainer.addView(splashRetryBtn)
        splashContainer.addView(nativeSettingsBtn)

        rootFrame.addView(splashContainer)
        setContentView(rootFrame)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun ensureWebViewCreated(): WebView {
        webView?.let { return it }
        val resolvedHost = host ?: KikiHost.resolve(applicationContext).also { host = it }
        val systemDark = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        val wv = WebView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            setBackgroundColor(KikiPalette.of(systemDark).paper)
            visibility = View.INVISIBLE
        }

        with(wv.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            mediaPlaybackRequiresUserGesture = false
            val baseUa = userAgentString ?: ""
            if (!baseUa.contains("KikiApp/android")) {
                userAgentString = "$baseUa KikiApp/android KikiEmbedded/1".trim()
            }
        }

        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url ?: return false
                val scheme = uri.scheme?.lowercase() ?: return true
                if (scheme == "kiki-shell") {
                    handleShellUri(uri)
                    return true
                }
                val currentReady = KikiRuntimeService.kernelState.value as? KernelState.Ready
                val requestOrigin = "${scheme}://${uri.host}${if (uri.port != -1) ":${uri.port}" else ""}"
                if (currentReady != null && requestOrigin == currentReady.origin) {
                    return false
                }
                if (scheme == "http" || scheme == "https") {
                    runCatching {
                        startActivity(Intent(Intent.ACTION_VIEW, uri))
                    }
                }
                return true
            }

            override fun onPageCommitVisible(view: WebView, url: String) {
                super.onPageCommitVisible(view, url)
                val ready = KikiRuntimeService.kernelState.value as? KernelState.Ready ?: return
                if (!url.startsWith(ready.origin)) return
                injectRuntimeHelpersAndTokenFallback(view, ready)
                applyLatestCssInsets()
                splashContainer.visibility = View.GONE
                splashRetryBtn.visibility = View.GONE
                view.visibility = View.VISIBLE
                pageReadyForEvents = true
                pushPermissionSnapshot()
                flushPendingShareBatches()
            }

            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                val ready = KikiRuntimeService.kernelState.value as? KernelState.Ready ?: return
                if (!url.startsWith(ready.origin)) return
                applyLatestCssInsets()
                splashContainer.visibility = View.GONE
                splashRetryBtn.visibility = View.GONE
                view.visibility = View.VISIBLE
                pageReadyForEvents = true
                flushPendingShareBatches()
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError,
            ) {
                super.onReceivedError(view, request, error)
                if (!request.isForMainFrame) return
                val zh = HostStrings.isChinese(this@KikiWebActivity)
                loadedOriginAndToken = null
                pageReadyForEvents = false
                splashHint.text = if (zh) {
                    "本机 Kiki 服务未响应，请稍候或点按重试。"
                } else {
                    "Local Kiki service is not responding yet. Wait a moment or tap Retry."
                }
                splashRetryBtn.visibility = View.VISIBLE
                splashContainer.visibility = View.VISIBLE
                view.visibility = View.INVISIBLE
            }
        }

        wv.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            handleWebDownload(wv, url, userAgent, contentDisposition, mimeType)
        }

        wv.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams,
            ): Boolean {
                pendingFileChooserCallback?.onReceiveValue(null)
                pendingFileChooserCallback = filePathCallback
                pendingCameraOutputUri = null
                runCatching { pendingCameraOutputFile?.delete() }
                pendingCameraOutputFile = null

                val mimeTypes = normalizeAcceptMimeTypes(fileChooserParams.acceptTypes)
                val allowImage = acceptsImages(mimeTypes)
                val captureEnabled = fileChooserParams.isCaptureEnabled
                val cameraIntent = if (allowImage) createCameraCaptureIntent() else null

                val launchIntent: Intent = if (shouldLaunchCameraDirectly(captureEnabled, mimeTypes) && cameraIntent != null) {
                    cameraIntent
                } else {
                    val docIntent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = if (mimeTypes.size == 1) mimeTypes[0] else "*/*"
                        if (mimeTypes.size > 1) {
                            putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes)
                        }
                        if (fileChooserParams.mode == FileChooserParams.MODE_OPEN_MULTIPLE) {
                            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                        }
                    }
                    if (cameraIntent != null) {
                        Intent.createChooser(docIntent, null).apply {
                            putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(cameraIntent))
                        }
                    } else {
                        docIntent
                    }
                }

                return runCatching {
                    fileChooserLauncher.launch(launchIntent)
                    true
                }.getOrElse {
                    pendingFileChooserCallback = null
                    pendingCameraOutputUri = null
                    runCatching { pendingCameraOutputFile?.delete() }
                    pendingCameraOutputFile = null
                    false
                }
            }
        }

        setupLeftEdgeGestureExclusion(wv)
        rootFrame.addView(wv, 0)
        webView = wv
        bridgeHandler = AndroidBridgeHandler(
            activity = this,
            webView = wv,
            host = resolvedHost,
            requestNotificationsPermission = {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    requestNotifLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                }
            },
            onAppearanceChanged = ::applySystemBarsAppearance,
            onSaveDownload = ::saveDownloadToDevice,
        )
        return wv
    }

    private fun setupLeftEdgeGestureExclusion(wv: WebView) {
        val applyExclusion = { view: View, viewHeight: Int ->
            if (viewHeight > 0) {
                val density = resources.displayMetrics.density.coerceAtLeast(1f)
                val bandPx = (196f * density + 0.5f).toInt().coerceAtMost(viewHeight)
                val widthPx = (44f * density + 0.5f).toInt()
                val topY = ((viewHeight - bandPx) / 2).coerceAtLeast(0)
                val bottomY = (topY + bandPx).coerceAtMost(viewHeight)
                ViewCompat.setSystemGestureExclusionRects(
                    view,
                    if (bottomY > topY && widthPx > 0) listOf(Rect(0, topY, widthPx, bottomY)) else emptyList(),
                )
            }
        }
        wv.addOnLayoutChangeListener { view, _, top, _, bottom, _, _, _, _ ->
            applyExclusion(view, bottom - top)
        }
        if (wv.height > 0) {
            applyExclusion(wv, wv.height)
        }
    }

    private fun createCameraCaptureIntent(): Intent? {
        return runCatching {
            val captureDir = File(cacheDir, "camera").apply { mkdirs() }
            val photoFile = File.createTempFile("kiki_capture_", ".jpg", captureDir)
            val uri = FileProvider.getUriForFile(this, "${packageName}.fileprovider", photoFile)
            val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
                putExtra(MediaStore.EXTRA_OUTPUT, uri)
                addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            if (intent.resolveActivity(packageManager) == null) {
                runCatching { photoFile.delete() }
                return null
            }
            pendingCameraOutputFile = photoFile
            pendingCameraOutputUri = uri
            intent
        }.getOrNull()
    }

    private fun handleWebDownload(
        wv: WebView,
        url: String?,
        userAgent: String?,
        contentDisposition: String?,
        mimeType: String?,
    ) {
        if (url.isNullOrBlank()) return
        val effectiveMime = mimeType?.takeIf { it.isNotBlank() } ?: "application/octet-stream"
        val guessed = sanitizeDownloadFilename(
            URLUtil.guessFileName(url, contentDisposition, effectiveMime),
            effectiveMime,
        )
        if (url.startsWith("blob:", ignoreCase = true) || url.startsWith("data:", ignoreCase = true)) {
            wv.evaluateJavascript(buildBlobDownloadScript(url, guessed, effectiveMime), null)
            return
        }
        val uri = runCatching { Uri.parse(url) }.getOrNull() ?: return
        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") return
        val dm = getSystemService(DOWNLOAD_SERVICE) as? DownloadManager ?: return
        runCatching {
            val req = DownloadManager.Request(uri).apply {
                setMimeType(effectiveMime)
                val cookies = CookieManager.getInstance().getCookie(url)
                if (!cookies.isNullOrBlank()) addRequestHeader("Cookie", cookies)
                if (!userAgent.isNullOrBlank()) addRequestHeader("User-Agent", userAgent)
                setTitle(guessed)
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, guessed)
            }
            dm.enqueue(req)
            val zh = HostStrings.isChinese(this)
            Toast.makeText(
                this,
                if (zh) "开始下载 $guessed" else "Downloading $guessed",
                Toast.LENGTH_SHORT,
            ).show()
        }
    }

    private fun saveDownloadToDevice(filename: String, mimeType: String, base64: String): Boolean {
        val effectiveMime = mimeType.ifBlank { "application/octet-stream" }
        val safeName = sanitizeDownloadFilename(filename, effectiveMime)
        return runCatching {
            val bytes = Base64.decode(base64, Base64.DEFAULT)
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, safeName)
                put(MediaStore.MediaColumns.MIME_TYPE, effectiveMime)
                put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val resolver = contentResolver
            val itemUri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: return false
            try {
                resolver.openOutputStream(itemUri)?.use { out ->
                    out.write(bytes)
                } ?: run {
                    resolver.delete(itemUri, null, null)
                    return false
                }
                val doneValues = ContentValues().apply {
                    put(MediaStore.MediaColumns.IS_PENDING, 0)
                }
                resolver.update(itemUri, doneValues, null, null)
            } catch (t: Throwable) {
                resolver.delete(itemUri, null, null)
                throw t
            }
            val zh = HostStrings.isChinese(this)
            runOnUiThread {
                Toast.makeText(
                    this,
                    if (zh) "已保存到下载：$safeName" else "Saved to Downloads: $safeName",
                    Toast.LENGTH_SHORT,
                ).show()
            }
            true
        }.getOrDefault(false)
    }

    private fun setupInsetsForwarding() {
        ViewCompat.setOnApplyWindowInsetsListener(rootFrame) { _, windowInsets ->
            val sysBars = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            val ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime())
            lastSysBarsBottomPx = sysBars.bottom
            val density = resources.displayMetrics.density.coerceAtLeast(1f)
            val imeCssPx = ((ime.bottom - sysBars.bottom).coerceAtLeast(0) / density).toInt()

            // The frame keeps the WebView clear of the system bars and display
            // cutout (so `--kiki-safe-*` are omitted to avoid double bar bands).
            // IME occlusion is forwarded solely via `--kiki-ime-height` (and
            // WindowInsetsAnimationCompat) rather than mutating native bottom
            // padding, preventing double-compensation and per-frame relayout.
            rootFrame.setPadding(sysBars.left, sysBars.top, sysBars.right, sysBars.bottom)

            publishImeHeightCss(imeCssPx)
            WindowInsetsCompat.CONSUMED
        }

        ViewCompat.setWindowInsetsAnimationCallback(
            rootFrame,
            object : WindowInsetsAnimationCompat.Callback(DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
                override fun onProgress(
                    insets: WindowInsetsCompat,
                    runningAnimations: MutableList<WindowInsetsAnimationCompat>,
                ): WindowInsetsCompat {
                    val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
                    val sysBottom = insets.getInsets(
                        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
                    ).bottom.takeIf { it > 0 } ?: lastSysBarsBottomPx
                    val density = resources.displayMetrics.density.coerceAtLeast(1f)
                    val imeCssPx = ((ime.bottom - sysBottom).coerceAtLeast(0) / density).toInt()
                    publishImeHeightCss(imeCssPx)
                    return insets
                }

                override fun onEnd(animation: WindowInsetsAnimationCompat) {
                    ViewCompat.requestApplyInsets(rootFrame)
                }
            },
        )
    }

    private fun publishImeHeightCss(imeCssPx: Int) {
        if (imeCssPx == lastImeCssPx && lastCssInsetsScript.isNotEmpty()) return
        lastImeCssPx = imeCssPx
        lastCssInsetsScript = buildImeHeightScript(imeCssPx)
        applyLatestCssInsets()
    }

    private fun applyLatestCssInsets() {
        val wv = webView ?: return
        if (lastCssInsetsScript.isNotEmpty()) {
            wv.evaluateJavascript(lastCssInsetsScript, null)
        }
    }

    private fun setupBackNavigation() {
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    val wv = webView
                    if (wv == null || wv.visibility != View.VISIBLE) {
                        moveTaskToBack(true)
                        return
                    }
                    wv.evaluateJavascript(HOST_BACK_DISPATCH_SCRIPT) { result ->
                        if (result == "false") {
                            return@evaluateJavascript
                        }
                        if (wv.canGoBack()) {
                            wv.goBack()
                        } else {
                            moveTaskToBack(true)
                        }
                    }
                }
            },
        )
    }

    @SuppressLint("RequiresFeature")
    private fun renderKernelState(state: KernelState) {
        val zh = HostStrings.isChinese(this)
        when (state) {
            is KernelState.Idle, is KernelState.Starting -> {
                splashHint.text = if (zh) "正在启动本机内核…" else "Starting local kernel…"
                splashRetryBtn.visibility = View.GONE
            }

            is KernelState.BackingOff -> {
                splashHint.text = if (zh) {
                    "本机 Kiki 内核启动中（第 ${state.attempt} 次重试）…"
                } else {
                    "Reconnecting local kernel (attempt ${state.attempt})…"
                }
                splashRetryBtn.visibility = View.VISIBLE
                splashContainer.visibility = View.VISIBLE
            }

            is KernelState.CircuitBroken -> {
                splashHint.text = if (zh) {
                    "本机 Kiki 服务未能启动：${state.reason}"
                } else {
                    "Local Kiki service failed to start: ${state.reason}"
                }
                splashRetryBtn.visibility = View.VISIBLE
                splashContainer.visibility = View.VISIBLE
            }

            is KernelState.Stopped -> {
                splashHint.text = if (zh) "本机内核已停止" else "Local kernel stopped"
                splashRetryBtn.visibility = View.VISIBLE
                splashContainer.visibility = View.VISIBLE
            }

            is KernelState.Ready -> {
                splashRetryBtn.visibility = View.GONE
                val pair = state.origin to state.localOwnerToken
                if (loadedOriginAndToken != pair) {
                    loadedOriginAndToken = pair
                    pageReadyForEvents = false
                    val wv = ensureWebViewCreated()
                    bridgeHandler?.bindToOrigin(state.origin)
                    installDocumentStartCredential(wv, state.origin, state.localOwnerToken)
                    val route = intent?.getStringExtra(KikiRuntimeService.EXTRA_SESSION_ROUTE)
                    val normalizedRoute = normalizeInitialSessionRoute(route)
                    val initialUrl = if (normalizedRoute != null) {
                        "${state.origin}$normalizedRoute"
                    } else {
                        "${state.origin}/m/assistant"
                    }
                    wv.loadUrl(initialUrl)
                }
            }
        }
    }

    @SuppressLint("RequiresFeature")
    private fun installDocumentStartCredential(wv: WebView, origin: String, token: String) {
        activeScriptHandler?.let { runCatching { it.remove() } }
        activeScriptHandler = null

        val credScript = buildDocumentStartScript(origin, token)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            activeScriptHandler = WebViewCompat.addDocumentStartJavaScript(
                wv,
                credScript,
                setOf(origin),
            )
        }
    }

    private fun injectRuntimeHelpersAndTokenFallback(wv: WebView, ready: KernelState.Ready) {
        val originJson = JsonPrimitive(ready.origin).toString()
        val tokenJson = JsonPrimitive(ready.localOwnerToken).toString()
        val script = """
            (function() {
              if (window.location.origin !== $originJson) return;
              if (!window.kikiAndroid && window.KikiAndroid) {
                var seq = 0;
                var pending = new Map();
                if (typeof window.KikiAndroid.addEventListener === 'function') {
                  window.KikiAndroid.addEventListener('message', function(ev) {
                    try {
                      var msg = JSON.parse(ev.data);
                      var entry = pending.get(msg.id);
                      if (!entry) return;
                      pending.delete(msg.id);
                      if (msg.ok) entry.resolve(msg.result);
                      else entry.reject(new Error(msg.error || 'bridge_error'));
                    } catch (_) {}
                  });
                } else {
                  window.__kikiAndroidBridgeReply = function(msg) {
                    var entry = pending.get(msg.id);
                    if (!entry) return;
                    pending.delete(msg.id);
                    if (msg.ok) entry.resolve(msg.result);
                    else entry.reject(new Error(msg.error || 'bridge_error'));
                  };
                }
                function callNative(method, params) {
                  return new Promise(function(resolve, reject) {
                    var id = 'kh_' + (++seq);
                    pending.set(id, { resolve: resolve, reject: reject });
                    window.KikiAndroid.postMessage(JSON.stringify({ id: id, method: method, params: params || {} }));
                  });
                }
                window.kikiAndroid = {
                  call: callNative,
                  capabilities: function() { return callNative('capabilities', {}); },
                  openPermission: function(kind) { return callNative('openPermission', { kind: kind }); },
                  openPhoneSettings: function() { return callNative('openPhoneSettings', {}); },
                  openNativeSettings: function() { return callNative('openNativeSettings', {}); },
                  setAppearance: function(dark) { return callNative('setAppearance', { dark: !!dark }); },
                  readClipboard: function() { return callNative('readClipboard', {}); },
                  writeClipboard: function(text) { return callNative('writeClipboard', { text: String(text || '') }); },
                  share: function(payload) { return callNative('share', payload || {}); },
                  takeShareIntake: function(id) { return callNative('takeShareIntake', { id: String(id || '') }); },
                  saveDownload: function(payload) { return callNative('saveDownload', payload || {}); }
                };
              }
              if (!window.__kikiBlobDownloadHookInstalled) {
                window.__kikiBlobDownloadHookInstalled = true;
                var pendingDownloads = new Map();
                window.__kikiPendingBlobDownloads = pendingDownloads;
                document.addEventListener('click', function(ev) {
                  var target = ev.target;
                  var anchor = target && typeof target.closest === 'function' ? target.closest('a[download]') : null;
                  if (!anchor) return;
                  var href = anchor.href || '';
                  if (href.indexOf('blob:') === 0) {
                    pendingDownloads.set(href, anchor.getAttribute('download') || '');
                  }
                }, true);
                if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
                  var origRevoke = URL.revokeObjectURL.bind(URL);
                  URL.revokeObjectURL = function(url) {
                    if (typeof url === 'string' && pendingDownloads.has(url)) {
                      setTimeout(function() {
                        pendingDownloads.delete(url);
                        try { origRevoke(url); } catch (_) {}
                      }, 5000);
                      return;
                    }
                    return origRevoke(url);
                  };
                }
              }
              if (!window.__kikiAppearanceObserverInstalled && window.KikiAndroid && typeof window.KikiAndroid.postMessage === 'function') {
                window.__kikiAppearanceObserverInstalled = true;
                var lastDark = null;
                function syncNativeAppearance() {
                  var root = document.documentElement;
                  if (!root) return;
                  var dsTheme = root.dataset ? root.dataset.theme : null;
                  var isDark = dsTheme === 'dark' ||
                    (dsTheme !== 'light' && (root.classList.contains('dark') ||
                      (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches && !dsTheme)));
                  if (isDark === lastDark) return;
                  lastDark = isDark;
                  try {
                    window.KikiAndroid.postMessage(JSON.stringify({
                      id: 'theme_' + Date.now(),
                      method: 'setAppearance',
                      params: { dark: isDark }
                    }));
                  } catch (_) {}
                }
                syncNativeAppearance();
                if (typeof MutationObserver === 'function' && document.documentElement) {
                  new MutationObserver(syncNativeAppearance).observe(document.documentElement, {
                    attributes: true,
                    attributeFilter: ['data-theme', 'class', 'style']
                  });
                }
              }
              if (window.__kikiCredentialConsumed !== true) {
                var detail = { origin: $originJson, url: $originJson, token: $tokenJson };
                if (!Object.getOwnPropertyDescriptor(document, '__kikiShellStagedCredential')) {
                  var consumed = false;
                  Object.defineProperty(document, '__kikiShellStagedCredential', {
                    configurable: true,
                    enumerable: false,
                    get: function() {
                      if (consumed) return undefined;
                      consumed = true;
                      window.__kikiCredentialConsumed = true;
                      try { delete document.__kikiShellStagedCredential; } catch (_) {}
                      return detail;
                    }
                  });
                }
                window.dispatchEvent(new CustomEvent('kiki:shell-token', { detail: detail }));
              }
            })();
        """.trimIndent()
        wv.evaluateJavascript(script, null)
    }

    private fun handleShellUri(uri: Uri) {
        when (uri.host?.lowercase()) {
            "settings", "permissions", "connect" -> {
                (host ?: KikiHost.resolve(applicationContext)).openNativePhoneSettings(this)
            }
        }
    }

    private fun pushPermissionSnapshot() {
        val bh = bridgeHandler ?: return
        bh.pushEvent("permissions", bh.buildCapabilitiesJson())
    }

    companion object {
        const val HOST_BACK_DISPATCH_SCRIPT: String =
            "(function(){try{return window.dispatchEvent(new CustomEvent('kiki:host-back',{cancelable:true}));}catch(_){return true;}})()"

        fun buildImeHeightScript(imeCssPx: Int): String {
            val safePx = imeCssPx.coerceAtLeast(0)
            return "(function(){var r=document.documentElement;if(r)r.style.setProperty('--kiki-ime-height','${safePx}px');})();"
        }

        fun normalizeAcceptMimeTypes(acceptTypes: Array<out String?>?): Array<String> {
            val cleaned = acceptTypes
                .orEmpty()
                .filterNotNull()
                .flatMap { it.split(",") }
                .map { it.trim() }
                .filter { it.isNotEmpty() && it.contains("/") }
                .distinct()
            return if (cleaned.isEmpty()) arrayOf("*/*") else cleaned.toTypedArray()
        }

        fun acceptsImages(mimeTypes: Array<String>): Boolean =
            mimeTypes.any { it.equals("*/*", ignoreCase = true) || it.startsWith("image/", ignoreCase = true) }

        fun shouldLaunchCameraDirectly(isCaptureEnabled: Boolean, mimeTypes: Array<String>): Boolean =
            isCaptureEnabled && acceptsImages(mimeTypes)

        fun sanitizeDownloadFilename(rawName: String?, mimeType: String?): String {
            val cleaned = (rawName ?: "")
                .substringAfterLast('/')
                .substringAfterLast('\\')
                .replace(Regex("[\\r\\n\\t\\u0000<>:\"|?*]"), "_")
                .trim()
                .trim('.')
            if (cleaned.isNotEmpty()) return cleaned
            val ext = when {
                mimeType?.contains("png", ignoreCase = true) == true -> "png"
                mimeType?.contains("jpeg", ignoreCase = true) == true -> "jpg"
                mimeType?.contains("json", ignoreCase = true) == true -> "json"
                mimeType?.contains("markdown", ignoreCase = true) == true -> "md"
                mimeType?.contains("pdf", ignoreCase = true) == true -> "pdf"
                mimeType?.contains("text/", ignoreCase = true) == true -> "txt"
                else -> "bin"
            }
            return "kiki-download.$ext"
        }

        fun buildBlobDownloadScript(url: String, fallbackFilename: String, mimeType: String): String {
            val urlJson = JsonPrimitive(url).toString()
            val nameJson = JsonPrimitive(fallbackFilename).toString()
            val mimeJson = JsonPrimitive(mimeType).toString()
            return """
                (function() {
                  var url = $urlJson;
                  var fallbackName = $nameJson;
                  var fallbackMime = $mimeJson;
                  var map = window.__kikiPendingBlobDownloads;
                  var pickedName = (map && typeof map.get === 'function' && map.get(url)) || fallbackName;
                  fetch(url).then(function(r) { return r.blob(); }).then(function(blob) {
                    var reader = new FileReader();
                    reader.onloadend = function() {
                      var res = typeof reader.result === 'string' ? reader.result : '';
                      var comma = res.indexOf(',');
                      var b64 = comma >= 0 ? res.slice(comma + 1) : '';
                      if (!b64 || !window.kikiAndroid || typeof window.kikiAndroid.saveDownload !== 'function') return;
                      window.kikiAndroid.saveDownload({
                        filename: pickedName,
                        mimeType: blob.type || fallbackMime,
                        base64: b64
                      });
                    };
                    reader.readAsDataURL(blob);
                  }).catch(function() {});
                })();
            """.trimIndent()
        }

        fun buildDocumentStartScript(origin: String, token: String): String {
            val originJson = JsonPrimitive(origin).toString()
            val tokenJson = JsonPrimitive(token).toString()
            return """
                (function() {
                  if (window.location.origin !== $originJson) return;
                  var consumed = false;
                  var payload = Object.freeze({ origin: $originJson, url: $originJson, token: $tokenJson });
                  Object.defineProperty(document, '__kikiShellStagedCredential', {
                    configurable: true,
                    enumerable: false,
                    get: function() {
                      if (consumed) return undefined;
                      consumed = true;
                      window.__kikiCredentialConsumed = true;
                      try { delete document.__kikiShellStagedCredential; } catch (_) {}
                      return payload;
                    }
                  });
                })();
            """.trimIndent()
        }

        /**
         * Normalizes incoming notification/deep-link routes so legacy `/sessions/<id>`
         * links resolve into the mobile native conversation route `/m/c/local/<id>`.
         */
        fun normalizeInitialSessionRoute(rawRoute: String?): String? {
            if (rawRoute.isNullOrBlank()) return null
            val trimmed = rawRoute.trim()
            if (trimmed.startsWith("/sessions/")) {
                val id = trimmed.removePrefix("/sessions/").substringBefore('?').substringBefore('#')
                if (id.isNotEmpty()) return "/m/c/local/$id"
            }
            return if (trimmed.startsWith("/")) trimmed else "/$trimmed"
        }

        /**
         * Builds the `share-intake` bridge event payload delivered via `kiki:android`
         * so the GUI consumes shared text/files through session-core drafts without DOM scraping.
         */
        fun buildShareIntakeEventPayload(batchId: String, draftText: String): kotlinx.serialization.json.JsonObject =
            buildJsonObject {
                put("id", batchId)
                if (draftText.isNotEmpty()) {
                    put("draft", draftText)
                }
            }
    }
}
