package dev.kiki.android.host.ui

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
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

class KikiWebActivity : ComponentActivity() {

    private var host: KikiHostEnvironment? = null
    private lateinit var rootFrame: FrameLayout
    private var webView: WebView? = null
    private lateinit var splashContainer: LinearLayout
    private lateinit var splashTitle: TextView
    private lateinit var splashHint: TextView
    private var bridgeHandler: AndroidBridgeHandler? = null

    private var activeScriptHandler: ScriptHandler? = null
    private var loadedOriginAndToken: Pair<String, String>? = null
    private var pendingFileChooserCallback: ValueCallback<Array<Uri>>? = null
    private var lastCssInsetsScript: String = ""
    private var pageReadyForEvents: Boolean = false
    private val pendingShareBatches = ArrayDeque<ShareIntakeBatch>()

    private val openDocumentsLauncher = registerForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris ->
        val cb = pendingFileChooserCallback
        pendingFileChooserCallback = null
        cb?.onReceiveValue(uris.toTypedArray())
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
        val wv = webView ?: return
        val bh = bridgeHandler ?: return
        while (pendingShareBatches.isNotEmpty()) {
            val batch = pendingShareBatches.removeFirst()
            bh.pushEvent("share-intake", buildJsonObject { put("id", batch.id) })
            val draftText = ShareIntakeStore.formatComposerDraft(batch)
            if (draftText.isNotEmpty()) {
                wv.evaluateJavascript(buildShareDraftInjectionScript(draftText), null)
            }
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

        val nativeSettingsBtn = TextView(this).apply {
            text = if (zh) "设备设置" else "Phone settings"
            setTextColor(tokens.inkSoft)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setPadding(dp(16), dp(8), dp(16), dp(8))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply {
                topMargin = dp(28)
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
                view.visibility = View.VISIBLE
                pageReadyForEvents = true
                flushPendingShareBatches()
            }
        }

        wv.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams,
            ): Boolean {
                pendingFileChooserCallback?.onReceiveValue(null)
                pendingFileChooserCallback = filePathCallback
                val accept = fileChooserParams.acceptTypes
                    ?.map { it.trim() }
                    ?.filter { it.isNotEmpty() && it.contains("/") }
                    ?.toTypedArray()
                    ?.takeIf { it.isNotEmpty() }
                    ?: arrayOf("*/*")
                return runCatching {
                    openDocumentsLauncher.launch(accept)
                    true
                }.getOrElse {
                    pendingFileChooserCallback = null
                    false
                }
            }
        }

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
        )
        return wv
    }

    private fun setupInsetsForwarding() {
        ViewCompat.setOnApplyWindowInsetsListener(rootFrame) { _, windowInsets ->
            val sysBars = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            val ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime())
            val density = resources.displayMetrics.density.coerceAtLeast(1f)

            val imeCssPx = ((ime.bottom - sysBars.bottom).coerceAtLeast(0) / density).toInt()

            // The frame keeps the WebView clear of the system bars, cutout and
            // keyboard, so the page never sits under any of them. The bar
            // insets are therefore not published as `--kiki-safe-*`: the GUI
            // pads by those variables (`--kiki-safe-top-inset`), and would add
            // an empty band the height of each bar inside the WebView.
            rootFrame.setPadding(sysBars.left, sysBars.top, sysBars.right, maxOf(sysBars.bottom, ime.bottom))

            lastCssInsetsScript = """
                (function() {
                  var r = document.documentElement;
                  if (!r) return;
                  r.style.setProperty('--kiki-ime-height', '${imeCssPx}px');
                })();
            """.trimIndent()
            applyLatestCssInsets()
            WindowInsetsCompat.CONSUMED
        }
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
                    if (wv != null && wv.visibility == View.VISIBLE && wv.canGoBack()) {
                        wv.goBack()
                    } else {
                        moveTaskToBack(true)
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
                splashHint.text = if (zh) "正在启动本机内核" else "Starting local kernel"
            }

            is KernelState.BackingOff -> {
                splashHint.text = if (zh) "正在重连内核" else "Reconnecting to kernel"
                splashContainer.visibility = View.VISIBLE
            }

            is KernelState.CircuitBroken -> {
                splashHint.text = state.reason
                splashContainer.visibility = View.VISIBLE
            }

            is KernelState.Stopped -> {
                splashHint.text = if (zh) "内核已停止" else "Kernel stopped"
                splashContainer.visibility = View.VISIBLE
            }

            is KernelState.Ready -> {
                val pair = state.origin to state.localOwnerToken
                if (loadedOriginAndToken != pair) {
                    loadedOriginAndToken = pair
                    pageReadyForEvents = false
                    val wv = ensureWebViewCreated()
                    bridgeHandler?.bindToOrigin(state.origin)
                    installDocumentStartCredential(wv, state.origin, state.localOwnerToken)
                    val route = intent?.getStringExtra(KikiRuntimeService.EXTRA_SESSION_ROUTE)
                    val initialUrl = if (!route.isNullOrBlank() && route.startsWith("/")) {
                        "${state.origin}$route"
                    } else {
                        state.guiUrl
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
                  takeShareIntake: function(id) { return callNative('takeShareIntake', { id: String(id || '') }); }
                };
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
         * Inserts shared text/file paths into the active Kiki session composer (`[data-composer]`),
         * or navigates to `/new` and populates the new-session draft without auto-sending.
         */
        fun buildShareDraftInjectionScript(draftText: String): String {
            val payloadJson = JsonPrimitive(draftText).toString()
            return """
                (function() {
                  var incoming = $payloadJson;
                  if (!incoming) return;
                  var attempts = 0;
                  var navigated = false;
                  function findComposer() {
                    return document.querySelector('[data-composer-input][contenteditable="true"]:not([aria-disabled="true"])')
                      || document.querySelector('textarea[data-composer]:not(:disabled)');
                  }
                  function insertIntoComposer(el) {
                    el.focus();
                    if (el.tagName === 'TEXTAREA') {
                      var cur = el.value || '';
                      var next = cur && !cur.endsWith('\n') ? cur + '\n' + incoming : cur + incoming;
                      var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
                      if (setter && setter.set) setter.set.call(el, next);
                      else el.value = next;
                      el.dispatchEvent(new Event('input', { bubbles: true }));
                      return true;
                    }
                    var existing = (el.textContent || '').trim();
                    var toInsert = existing.length > 0 ? '\n' + incoming : incoming;
                    var sel = window.getSelection && window.getSelection();
                    if (sel) {
                      sel.selectAllChildren(el);
                      sel.collapseToEnd();
                    }
                    var ok = false;
                    try {
                      ok = document.execCommand('insertText', false, toInsert);
                    } catch (_) {}
                    if (!ok) {
                      try {
                        var dt = new DataTransfer();
                        dt.setData('text/plain', toInsert);
                        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
                        ok = true;
                      } catch (_) {}
                    }
                    return ok;
                  }
                  function step() {
                    var composer = findComposer();
                    if (composer) {
                      insertIntoComposer(composer);
                      return;
                    }
                    if (!navigated && attempts >= 3 && window.location.pathname !== '/new') {
                      navigated = true;
                      try {
                        window.history.pushState({}, '', '/new');
                        window.dispatchEvent(new PopStateEvent('popstate'));
                      } catch (_) {}
                    }
                    if (++attempts < 40) {
                      setTimeout(step, 150);
                    }
                  }
                  step();
                })();
            """.trimIndent()
        }
    }
}
