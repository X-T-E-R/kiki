package ai.easyagent.kiki;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.provider.MediaStore;
import android.view.View;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsAnimationCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.PluginHandle;
import java.io.File;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;

public class MainActivity extends BridgeActivity {

    private ValueCallback<Uri[]> pendingFileChooserCallback;
    private Uri pendingCameraOutputUri;
    private File pendingCameraOutputFile;
    private String[] pendingCameraFallbackMimeTypes;
    private boolean pendingCameraFallbackAllowMultiple;
    private int lastImeCssPx = -1;
    private int lastSysBarsBottomPx = 0;
    private String lastImeCssScript = "";

    private final ActivityResultLauncher<Intent> fileChooserLauncher = registerForActivityResult(
        new ActivityResultContracts.StartActivityForResult(),
        result -> {
            ValueCallback<Uri[]> cb = pendingFileChooserCallback;
            pendingFileChooserCallback = null;
            Uri cameraUri = pendingCameraOutputUri;
            File cameraFile = pendingCameraOutputFile;
            pendingCameraOutputUri = null;
            pendingCameraOutputFile = null;

            if (result.getResultCode() != Activity.RESULT_OK) {
                deleteFileQuietly(cameraFile);
                if (cb != null) cb.onReceiveValue(null);
                return;
            }

            Intent data = result.getData();
            List<Uri> uris = new ArrayList<>();
            if (data != null && data.getClipData() != null && data.getClipData().getItemCount() > 0) {
                ClipData clip = data.getClipData();
                for (int i = 0; i < clip.getItemCount(); i++) {
                    Uri itemUri = clip.getItemAt(i).getUri();
                    if (itemUri != null) uris.add(itemUri);
                }
            } else if (data != null && data.getData() != null) {
                uris.add(data.getData());
            } else if (cameraUri != null && cameraFile != null && cameraFile.exists() && cameraFile.length() > 0L) {
                uris.add(cameraUri);
            }

            if (uris.isEmpty() || (cameraUri != null && !uris.contains(cameraUri))) {
                deleteFileQuietly(cameraFile);
            }
            if (cb != null) {
                cb.onReceiveValue(uris.isEmpty() ? null : uris.toArray(new Uri[0]));
            }
        }
    );

    private final ActivityResultLauncher<String> cameraPermissionLauncher = registerForActivityResult(
        new ActivityResultContracts.RequestPermission(),
        granted -> {
            String[] fallbackMimes = pendingCameraFallbackMimeTypes;
            boolean allowMultiple = pendingCameraFallbackAllowMultiple;
            pendingCameraFallbackMimeTypes = null;
            pendingCameraFallbackAllowMultiple = false;
            if (pendingFileChooserCallback == null) {
                return;
            }
            if (Boolean.TRUE.equals(granted)) {
                Intent cameraIntent = createCameraCaptureIntent();
                if (cameraIntent != null) {
                    launchFileChooserIntent(cameraIntent);
                    return;
                }
            }
            launchFileChooserIntent(buildDocumentPickerIntent(fallbackMimes != null ? fallbackMimes : new String[] { "image/*" }, allowMultiple));
        }
    );

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(KikiShellPlugin.class);
        super.onCreate(savedInstanceState);
        PluginHandle handle = getBridge() == null ? null : getBridge().getPlugin("KikiShell");
        if (handle != null && handle.getInstance() instanceof KikiShellPlugin shellPlugin) {
            shellPlugin.ensureWebViewListenersRegistered();
            getBridge()
                .setWebViewClient(
                    new BridgeWebViewClient(getBridge()) {
                        @Override
                        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                            if (!shellPlugin.handleSslError(view, handler, error)) {
                                super.onReceivedSslError(view, handler, error);
                            }
                        }

                        @Override
                        public void onPageCommitVisible(WebView view, String url) {
                            super.onPageCommitVisible(view, url);
                            applyLatestImeCss(view);
                        }

                        @Override
                        public void onPageFinished(WebView view, String url) {
                            super.onPageFinished(view, url);
                            applyLatestImeCss(view);
                        }
                    }
                );
            WebView webView = getBridge().getWebView();
            if (webView != null) {
                setupImeInsetsBridge(webView);
                webView.setWebChromeClient(
                    new BridgeWebChromeClient(getBridge()) {
                        @Override
                        public void onPermissionRequest(PermissionRequest request) {
                            shellPlugin.handleWebPermissionRequest(request);
                        }

                        @Override
                        public boolean onShowFileChooser(
                            WebView view,
                            ValueCallback<Uri[]> filePathCallback,
                            WebChromeClient.FileChooserParams fileChooserParams
                        ) {
                            return handleShowFileChooser(filePathCallback, fileChooserParams);
                        }
                    }
                );
            }
        }
    }

    @Override
    public void onDestroy() {
        clearPendingFileChooser(true);
        super.onDestroy();
    }

    private void setupImeInsetsBridge(WebView webView) {
        View target = getWindow() != null ? getWindow().getDecorView() : webView;
        ViewCompat.setOnApplyWindowInsetsListener(target, (v, windowInsets) -> {
            Insets sysBars = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
            );
            Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
            lastSysBarsBottomPx = sysBars.bottom;
            publishImeHeightCss(webView, computeImeCssPx(ime.bottom, sysBars.bottom));
            return ViewCompat.onApplyWindowInsets(v, windowInsets);
        });

        ViewCompat.setWindowInsetsAnimationCallback(
            target,
            new WindowInsetsAnimationCompat.Callback(WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
                @NonNull
                @Override
                public WindowInsetsCompat onProgress(
                    @NonNull WindowInsetsCompat insets,
                    @NonNull List<WindowInsetsAnimationCompat> runningAnimations
                ) {
                    Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
                    int sysBottom = insets.getInsets(
                        WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
                    ).bottom;
                    if (sysBottom <= 0) sysBottom = lastSysBarsBottomPx;
                    publishImeHeightCss(webView, computeImeCssPx(ime.bottom, sysBottom));
                    return insets;
                }

                @Override
                public void onEnd(@NonNull WindowInsetsAnimationCompat animation) {
                    ViewCompat.requestApplyInsets(target);
                }
            }
        );
    }

    private int computeImeCssPx(int imeBottomPx, int sysBarsBottomPx) {
        float density = Math.max(1f, getResources().getDisplayMetrics().density);
        return Math.max(0, (int) ((Math.max(0, imeBottomPx - sysBarsBottomPx)) / density));
    }

    private void publishImeHeightCss(WebView webView, int imeCssPx) {
        if (imeCssPx == lastImeCssPx && !lastImeCssScript.isEmpty()) return;
        lastImeCssPx = imeCssPx;
        lastImeCssScript =
            "(function(){var r=document.documentElement;if(r)r.style.setProperty('--kiki-ime-height','" +
            Math.max(0, imeCssPx) +
            "px');})();";
        applyLatestImeCss(webView);
    }

    private void applyLatestImeCss(WebView webView) {
        if (webView == null || lastImeCssScript.isEmpty()) return;
        webView.evaluateJavascript(lastImeCssScript, null);
    }

    private boolean handleShowFileChooser(
        ValueCallback<Uri[]> filePathCallback,
        WebChromeClient.FileChooserParams fileChooserParams
    ) {
        clearPendingFileChooser(true);
        pendingFileChooserCallback = filePathCallback;

        String[] rawAccept = fileChooserParams == null ? null : fileChooserParams.getAcceptTypes();
        String[] mimeTypes = normalizeAcceptMimeTypes(rawAccept);
        boolean allowImage = acceptsImages(mimeTypes);
        boolean captureEnabled = fileChooserParams != null && fileChooserParams.isCaptureEnabled();
        boolean allowMultiple =
            fileChooserParams != null &&
            fileChooserParams.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE;

        if (captureEnabled && allowImage) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                pendingCameraFallbackMimeTypes = mimeTypes;
                pendingCameraFallbackAllowMultiple = allowMultiple;
                try {
                    cameraPermissionLauncher.launch(Manifest.permission.CAMERA);
                    return true;
                } catch (Exception ignored) {
                    clearPendingFileChooser(false);
                    return false;
                }
            }
            Intent cameraIntent = createCameraCaptureIntent();
            if (cameraIntent != null) {
                return launchFileChooserIntent(cameraIntent);
            }
        }

        Intent docIntent = buildDocumentPickerIntent(mimeTypes, allowMultiple);
        Intent launchIntent = docIntent;
        if (
            allowImage &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
        ) {
            Intent cameraIntent = createCameraCaptureIntent();
            if (cameraIntent != null) {
                Intent chooser = Intent.createChooser(docIntent, null);
                chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[] { cameraIntent });
                launchIntent = chooser;
            }
        }
        return launchFileChooserIntent(launchIntent);
    }

    private boolean launchFileChooserIntent(Intent intent) {
        try {
            fileChooserLauncher.launch(intent);
            return true;
        } catch (Exception ignored) {
            clearPendingFileChooser(false);
            return false;
        }
    }

    private Intent buildDocumentPickerIntent(String[] mimeTypes, boolean allowMultiple) {
        Intent docIntent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        docIntent.addCategory(Intent.CATEGORY_OPENABLE);
        docIntent.setType(mimeTypes.length == 1 ? mimeTypes[0] : "*/*");
        if (mimeTypes.length > 1) {
            docIntent.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes);
        }
        if (allowMultiple) {
            docIntent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        }
        return docIntent;
    }

    private Intent createCameraCaptureIntent() {
        try {
            File captureDir = new File(getCacheDir(), "camera");
            if (!captureDir.exists()) {
                //noinspection ResultOfMethodCallIgnored
                captureDir.mkdirs();
            }
            File photoFile = File.createTempFile("kiki_capture_", ".jpg", captureDir);
            Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", photoFile);
            Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            intent.putExtra(MediaStore.EXTRA_OUTPUT, uri);
            intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            if (intent.resolveActivity(getPackageManager()) == null) {
                deleteFileQuietly(photoFile);
                return null;
            }
            pendingCameraOutputFile = photoFile;
            pendingCameraOutputUri = uri;
            return intent;
        } catch (Exception ignored) {
            return null;
        }
    }

    private void clearPendingFileChooser(boolean notifyNull) {
        ValueCallback<Uri[]> cb = pendingFileChooserCallback;
        pendingFileChooserCallback = null;
        if (notifyNull && cb != null) {
            cb.onReceiveValue(null);
        }
        pendingCameraOutputUri = null;
        deleteFileQuietly(pendingCameraOutputFile);
        pendingCameraOutputFile = null;
        pendingCameraFallbackMimeTypes = null;
        pendingCameraFallbackAllowMultiple = false;
    }

    private static void deleteFileQuietly(File file) {
        if (file != null && file.exists()) {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        }
    }

    static String[] normalizeAcceptMimeTypes(String[] rawAccept) {
        if (rawAccept == null || rawAccept.length == 0) {
            return new String[] { "*/*" };
        }
        LinkedHashSet<String> cleaned = new LinkedHashSet<>();
        for (String entry : rawAccept) {
            if (entry == null) continue;
            for (String part : entry.split(",")) {
                String trimmed = part.trim();
                if (!trimmed.isEmpty() && trimmed.contains("/")) {
                    cleaned.add(trimmed);
                }
            }
        }
        return cleaned.isEmpty() ? new String[] { "*/*" } : cleaned.toArray(new String[0]);
    }

    static boolean acceptsImages(String[] mimeTypes) {
        if (mimeTypes == null) return false;
        for (String mime : mimeTypes) {
            if (mime == null) continue;
            String lower = mime.toLowerCase(Locale.ROOT);
            if ("*/*".equals(lower) || lower.startsWith("image/")) {
                return true;
            }
        }
        return false;
    }
}
