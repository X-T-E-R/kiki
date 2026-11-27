package dev.kiki.android.host.ui

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.LuminanceSource
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.GlobalHistogramBinarizer
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader

object QrBitmapDecoder {

    private val HINTS: Map<DecodeHintType, Any> = mapOf(
        DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
        DecodeHintType.CHARACTER_SET to "UTF-8",
        DecodeHintType.TRY_HARDER to java.lang.Boolean.TRUE,
    )

    fun decodeYuvLuminance(
        yPlane: ByteArray,
        dataWidth: Int,
        dataHeight: Int,
    ): String? {
        if (dataWidth <= 0 || dataHeight <= 0 || yPlane.size < dataWidth * dataHeight) return null
        val source = PlanarYUVLuminanceSource(
            yPlane,
            dataWidth,
            dataHeight,
            0,
            0,
            dataWidth,
            dataHeight,
            false,
        )
        return decodeSource(source)
    }

    fun decodeArgbPixels(
        argbPixels: IntArray,
        width: Int,
        height: Int,
    ): String? {
        if (width <= 0 || height <= 0 || argbPixels.size < width * height) return null
        val source = RGBLuminanceSource(width, height, argbPixels)
        return decodeSource(source)
    }

    private fun decodeSource(source: LuminanceSource): String? {
        val reader = QRCodeReader()
        val candidates = sequenceOf(
            BinaryBitmap(HybridBinarizer(source)),
            BinaryBitmap(HybridBinarizer(source.invert())),
            BinaryBitmap(GlobalHistogramBinarizer(source)),
        )
        for (bitmap in candidates) {
            val text = runCatching {
                reader.reset()
                reader.decode(bitmap, HINTS)?.text?.trim()?.takeIf { it.isNotEmpty() }
            }.getOrNull()
            if (text != null) return text
        }
        return null
    }
}
