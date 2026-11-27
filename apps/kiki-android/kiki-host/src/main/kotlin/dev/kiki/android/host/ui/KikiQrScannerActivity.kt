package dev.kiki.android.host.ui

import android.Manifest
import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.util.Size
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import dev.kiki.android.host.i18n.HostStrings
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class KikiQrScannerActivity : ComponentActivity() {

    private val analysisExecutor = Executors.newSingleThreadExecutor()
    private val resolvedOnce = AtomicBoolean(false)
    private lateinit var previewView: PreviewView
    private lateinit var permissionCard: LinearLayout
    private var cameraProvider: ProcessCameraProvider? = null

    private val cameraPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            permissionCard.visibility = View.GONE
            startCameraPreview()
        } else {
            permissionCard.visibility = View.VISIBLE
        }
    }

    private val pickImageLauncher = registerForActivityResult(
        ActivityResultContracts.GetContent(),
    ) { uri: Uri? ->
        if (uri != null) {
            decodeFromImageUri(uri)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.isAppearanceLightStatusBars = false
        controller.isAppearanceLightNavigationBars = false

        buildLayout()

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            startCameraPreview()
        } else {
            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    override fun onDestroy() {
        runCatching { cameraProvider?.unbindAll() }
        analysisExecutor.shutdownNow()
        super.onDestroy()
    }

    private fun buildLayout() {
        val density = resources.displayMetrics.density
        fun dp(v: Int): Int = (v * density + 0.5f).toInt()
        val zh = HostStrings.isChinese(this)
        val dark = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        val tokens = KikiPalette.of(dark)

        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#0E1315"))
        }

        previewView = PreviewView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
            scaleType = PreviewView.ScaleType.FILL_CENTER
        }
        root.addView(previewView)

        val reticle = View(this).apply {
            val size = dp(248)
            layoutParams = FrameLayout.LayoutParams(size, size, Gravity.CENTER)
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(24).toFloat()
                setColor(Color.parseColor("#12FFFFFF"))
                setStroke(dp(2), Color.parseColor("#CCEEEAE2"))
            }
        }
        root.addView(reticle)

        val overlayChrome = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
        }

        val topBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(20), dp(14), dp(20), dp(14))
        }

        val cancelBtn = makeOverlayPill(
            text = if (zh) "取消" else "Cancel",
            dp = ::dp,
        ) {
            setResult(Activity.RESULT_CANCELED)
            finish()
        }

        val titleView = TextView(this).apply {
            text = if (zh) "扫描电脑配对码" else "Scan Pairing Code"
            setTextColor(Color.parseColor("#F5F2EB"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginStart = dp(14)
            }
        }
        topBar.addView(cancelBtn)
        topBar.addView(titleView)

        val centerSpacer = FrameLayout(this).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        }

        permissionCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            visibility = View.GONE
            setPadding(dp(24), dp(22), dp(24), dp(22))
            layoutParams = FrameLayout.LayoutParams(
                dp(300),
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER,
            )
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(18).toFloat()
                setColor(tokens.paper)
                setStroke(dp(1), tokens.hairline)
            }
            addView(TextView(this@KikiQrScannerActivity).apply {
                text = if (zh) "需要相机权限以扫描二维码" else "Camera access needed to scan QR"
                setTextColor(tokens.ink)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 15.5f)
                typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
                gravity = Gravity.CENTER
            })
            addView(TextView(this@KikiQrScannerActivity).apply {
                text = if (zh) "也可直接粘贴配对链接或从相册选取二维码截图" else "You can also paste a pairing link or choose a QR image"
                setTextColor(tokens.inkFaint)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
                gravity = Gravity.CENTER
                setPadding(0, dp(6), 0, dp(14))
            })
            addView(TextView(this@KikiQrScannerActivity).apply {
                text = if (zh) "开启相机权限" else "Enable Camera"
                setTextColor(tokens.paper)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f)
                typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
                setPadding(dp(18), dp(9), dp(18), dp(9))
                background = GradientDrawable().apply {
                    shape = GradientDrawable.RECTANGLE
                    cornerRadius = dp(16).toFloat()
                    setColor(tokens.ink)
                }
                setOnClickListener {
                    val intent = Intent(
                        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.parse("package:$packageName"),
                    )
                    runCatching { startActivity(intent) }
                }
            })
        }
        centerSpacer.addView(permissionCard)

        val bottomBar = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(24), dp(12), dp(24), dp(28))
        }

        val hintLabel = TextView(this).apply {
            text = if (zh) "在电脑 Kiki 打开「设置 · 远程连接」获取配对码" else "Open Settings > Remote Connection in desktop Kiki"
            setTextColor(Color.parseColor("#CCEEEAE2"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, dp(14))
        }
        bottomBar.addView(hintLabel)

        val actionsRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
        }

        val pasteBtn = makeOverlayPill(
            text = if (zh) "粘贴配对链接" else "Paste Link",
            dp = ::dp,
        ) {
            pasteFromClipboard(zh)
        }

        val galleryBtn = makeOverlayPill(
            text = if (zh) "相册选图" else "Choose Image",
            dp = ::dp,
        ) {
            runCatching { pickImageLauncher.launch("image/*") }
        }.apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply {
                marginStart = dp(12)
            }
        }

        actionsRow.addView(pasteBtn)
        actionsRow.addView(galleryBtn)
        bottomBar.addView(actionsRow)

        overlayChrome.addView(topBar)
        overlayChrome.addView(centerSpacer)
        overlayChrome.addView(bottomBar)
        root.addView(overlayChrome)

        ViewCompat.setOnApplyWindowInsetsListener(overlayChrome) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        setContentView(root)
    }

    override fun onResume() {
        super.onResume()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            permissionCard.visibility = View.GONE
            if (cameraProvider == null) {
                startCameraPreview()
            }
        }
    }

    private fun makeOverlayPill(
        text: String,
        dp: (Int) -> Int,
        onClick: () -> Unit,
    ): TextView = TextView(this).apply {
        this.text = text
        setTextColor(Color.parseColor("#F5F2EB"))
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f)
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        setPadding(dp(16), dp(9), dp(16), dp(9))
        background = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = dp(18).toFloat()
            setColor(Color.parseColor("#881B2226"))
            setStroke(dp(1), Color.parseColor("#44EEEAE2"))
        }
        setOnClickListener { onClick() }
    }

    private fun startCameraPreview() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener(
            {
                val provider = runCatching { future.get() }.getOrNull() ?: return@addListener
                cameraProvider = provider
                val preview = Preview.Builder().build().also {
                    it.surfaceProvider = previewView.surfaceProvider
                }
                @Suppress("DEPRECATION")
                val analysis = ImageAnalysis.Builder()
                    .setTargetResolution(Size(1280, 720))
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                analysis.setAnalyzer(analysisExecutor, ::analyzeFrame)

                runCatching {
                    provider.unbindAll()
                    provider.bindToLifecycle(
                        this,
                        CameraSelector.DEFAULT_BACK_CAMERA,
                        preview,
                        analysis,
                    )
                }
            },
            ContextCompat.getMainExecutor(this),
        )
    }

    private fun analyzeFrame(image: ImageProxy) {
        try {
            if (resolvedOnce.get()) return
            val plane = image.planes.firstOrNull() ?: return
            val width = image.width
            val height = image.height
            val rowStride = plane.rowStride
            val pixelStride = plane.pixelStride
            val buffer = plane.buffer
            buffer.rewind()

            val yBytes = ByteArray(width * height)
            if (rowStride == width && pixelStride == 1) {
                buffer.get(yBytes, 0, yBytes.size)
            } else {
                val rowBuf = ByteArray(rowStride)
                for (row in 0 until height) {
                    val remaining = buffer.remaining()
                    val toRead = if (row == height - 1) minOf(rowStride, remaining) else rowStride
                    if (toRead <= 0) break
                    buffer.get(rowBuf, 0, toRead)
                    if (pixelStride == 1) {
                        System.arraycopy(rowBuf, 0, yBytes, row * width, minOf(width, toRead))
                    } else {
                        var col = 0
                        while (col < width && col * pixelStride < toRead) {
                            yBytes[row * width + col] = rowBuf[col * pixelStride]
                            col++
                        }
                    }
                }
            }

            val decoded = QrBitmapDecoder.decodeYuvLuminance(yBytes, width, height)
            if (!decoded.isNullOrBlank()) {
                deliverResult(decoded)
            }
        } finally {
            image.close()
        }
    }

    private fun pasteFromClipboard(zh: Boolean) {
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        val text = cm?.primaryClip
            ?.takeIf { it.itemCount > 0 }
            ?.getItemAt(0)
            ?.coerceToText(this)
            ?.toString()
            ?.trim()
            .orEmpty()
        if (text.isEmpty()) {
            Toast.makeText(
                this,
                if (zh) "剪贴板为空" else "Clipboard is empty",
                Toast.LENGTH_SHORT,
            ).show()
            return
        }
        deliverResult(text)
    }

    private fun decodeFromImageUri(uri: Uri) {
        val zh = HostStrings.isChinese(this)
        analysisExecutor.execute {
            val decoded = runCatching {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
                var sample = 1
                while (bounds.outWidth / sample > 1600 || bounds.outHeight / sample > 1600) {
                    sample *= 2
                }
                val opts = BitmapFactory.Options().apply { inSampleSize = sample }
                val bmp = contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, opts) }
                    ?: return@runCatching null
                try {
                    val w = bmp.width
                    val h = bmp.height
                    val pixels = IntArray(w * h)
                    bmp.getPixels(pixels, 0, w, 0, 0, w, h)
                    QrBitmapDecoder.decodeArgbPixels(pixels, w, h)
                } finally {
                    bmp.recycle()
                }
            }.getOrNull()

            runOnUiThread {
                if (!decoded.isNullOrBlank()) {
                    deliverResult(decoded)
                } else {
                    Toast.makeText(
                        this,
                        if (zh) "未在图片中识别到二维码" else "No QR code found in image",
                        Toast.LENGTH_SHORT,
                    ).show()
                }
            }
        }
    }

    private fun deliverResult(qrText: String) {
        if (!resolvedOnce.compareAndSet(false, true)) return
        runOnUiThread {
            setResult(Activity.RESULT_OK, Intent().putExtra(EXTRA_QR_TEXT, qrText))
            finish()
        }
    }

    companion object {
        const val EXTRA_QR_TEXT = "kiki.qr_text"
    }
}
