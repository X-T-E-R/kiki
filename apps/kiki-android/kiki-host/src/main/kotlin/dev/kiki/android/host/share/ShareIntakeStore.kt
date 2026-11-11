package dev.kiki.android.host.share

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import java.io.File
import java.io.InputStream
import java.nio.charset.StandardCharsets
import java.util.UUID

@Serializable
data class SharedIntakeItem(
    val id: String,
    val name: String,
    val mimeType: String,
    val path: String? = null,
    val text: String? = null,
    val bytes: Long = 0L,
)

@Serializable
data class ShareIntakeBatch(
    val id: String,
    val createdAtMs: Long,
    val subject: String? = null,
    val items: List<SharedIntakeItem>,
)

/**
 * Pure intent representation so [ShareIntakeStore] can be tested on the JVM without Android Intent stubs.
 */
data class IncomingSharePayload(
    val action: String?,
    val mimeType: String?,
    val subject: String? = null,
    val text: String? = null,
    val streams: List<IncomingShareStream> = emptyList(),
)

data class IncomingShareStream(
    val uriString: String,
    val scheme: String?,
    val authority: String?,
    val displayName: String?,
    val mimeType: String?,
    val open: () -> InputStream?,
)

/**
 * Stages incoming `ACTION_SEND` / `ACTION_SEND_MULTIPLE` content under `<workspace>/shared-inbox/<batchId>/`
 * and persists a small JSON index so both the WebView composer and the `shared_inbox` MCP tool can consume it.
 */
class ShareIntakeStore(
    private val inboxRootDir: File,
    private val selfPackage: String,
    private val clock: () -> Long = System::currentTimeMillis,
    private val maxStreamsPerBatch: Int = DEFAULT_MAX_STREAMS_PER_BATCH,
    private val maxBytesPerStream: Long = DEFAULT_MAX_BYTES_PER_STREAM,
    private val maxRetainedBatches: Int = DEFAULT_MAX_RETAINED_BATCHES,
) {
    private val json = Json { ignoreUnknownKeys = true; prettyPrint = false }
    private val lock = Any()

    private val indexFile: File get() = File(inboxRootDir, "index.json")

    fun stageIncoming(payload: IncomingSharePayload): ShareIntakeBatch? {
        val act = payload.action ?: return null
        if (act != Intent.ACTION_SEND && act != Intent.ACTION_SEND_MULTIPLE) return null

        val batchId = "share_" + UUID.randomUUID().toString().replace("-", "").take(12)
        val batchDir = File(inboxRootDir, batchId)
        val stagedItems = ArrayList<SharedIntakeItem>()

        val trimmedText = payload.text?.trim().orEmpty()
        val trimmedSubject = payload.subject?.trim()?.takeIf { it.isNotEmpty() }
        if (trimmedText.isNotEmpty()) {
            val combinedText = if (trimmedSubject != null && !trimmedText.startsWith(trimmedSubject)) {
                "$trimmedSubject\n$trimmedText"
            } else {
                trimmedText
            }
            stagedItems += SharedIntakeItem(
                id = "${batchId}_txt",
                name = trimmedSubject ?: "shared-text.txt",
                mimeType = "text/plain",
                text = combinedText.take(MAX_TEXT_CHARS),
                bytes = combinedText.toByteArray(StandardCharsets.UTF_8).size.toLong(),
            )
        }

        val usedNames = HashSet<String>()
        for ((idx, stream) in payload.streams.take(maxStreamsPerBatch).withIndex()) {
            if (!isSafeExternalContentStream(stream)) continue
            batchDir.mkdirs()
            val safeName = deduplicateFileName(
                sanitizeFileName(stream.displayName, idx + 1, stream.mimeType ?: payload.mimeType),
                usedNames,
            )
            val dest = File(batchDir, safeName)
            val written = copyBounded(stream.open, dest, maxBytesPerStream)
            if (written == null) {
                runCatching { dest.delete() }
                continue
            }
            stagedItems += SharedIntakeItem(
                id = "${batchId}_${idx + 1}",
                name = safeName,
                mimeType = (stream.mimeType ?: payload.mimeType ?: "application/octet-stream").ifBlank { "application/octet-stream" },
                path = dest.canonicalFile.absolutePath,
                bytes = written,
            )
        }

        if (stagedItems.isEmpty()) {
            if (batchDir.exists()) runCatching { batchDir.deleteRecursively() }
            return null
        }

        val batch = ShareIntakeBatch(
            id = batchId,
            createdAtMs = clock(),
            subject = trimmedSubject,
            items = stagedItems,
        )

        synchronized(lock) {
            inboxRootDir.mkdirs()
            val existing = loadIndexLocked().toMutableList()
            existing.add(0, batch)
            while (existing.size > maxRetainedBatches) {
                val evicted = existing.removeAt(existing.lastIndex)
                val evictedDir = File(inboxRootDir, evicted.id)
                if (evictedDir.exists()) runCatching { evictedDir.deleteRecursively() }
            }
            saveIndexLocked(existing)
        }
        return batch
    }

    /**
     * Reads and consumes the WebView bridge claim for [batchId] (keeping files on disk for the session).
     */
    fun takeBatchItems(batchId: String): List<SharedIntakeItem> = synchronized(lock) {
        loadIndexLocked().firstOrNull { it.id == batchId }?.items.orEmpty()
    }

    fun listBatches(limit: Int = 10): List<ShareIntakeBatch> = synchronized(lock) {
        loadIndexLocked().take(limit.coerceIn(1, maxRetainedBatches))
    }

    fun clearAll(): Int = synchronized(lock) {
        val current = loadIndexLocked()
        for (batch in current) {
            val dir = File(inboxRootDir, batch.id)
            if (dir.exists()) runCatching { dir.deleteRecursively() }
        }
        saveIndexLocked(emptyList())
        current.size
    }

    private fun isSafeExternalContentStream(stream: IncomingShareStream): Boolean {
        val scheme = stream.scheme?.lowercase() ?: return false
        if (scheme != "content") return false
        val authority = stream.authority?.lowercase().orEmpty()
        if (authority.isEmpty()) return false
        val ownLower = selfPackage.lowercase()
        if (authority == ownLower || authority.startsWith("$ownLower.")) {
            return false
        }
        return true
    }

    private fun copyBounded(open: () -> InputStream?, dest: File, maxBytes: Long): Long? {
        return try {
            val input = open() ?: return null
            input.use { src ->
                dest.outputStream().use { out ->
                    val buf = ByteArray(16 * 1024)
                    var total = 0L
                    while (true) {
                        val read = src.read(buf)
                        if (read < 0) break
                        total += read
                        if (total > maxBytes) {
                            throw IllegalStateException("Shared stream exceeds max size ($maxBytes bytes)")
                        }
                        out.write(buf, 0, read)
                    }
                    total
                }
            }
        } catch (_: Throwable) {
            null
        }
    }

    private fun loadIndexLocked(): List<ShareIntakeBatch> {
        if (!indexFile.isFile) return emptyList()
        return runCatching {
            val raw = indexFile.readText(StandardCharsets.UTF_8)
            json.decodeFromString(ListSerializer(ShareIntakeBatch.serializer()), raw)
        }.getOrDefault(emptyList())
    }

    private fun saveIndexLocked(batches: List<ShareIntakeBatch>) {
        inboxRootDir.mkdirs()
        val encoded = json.encodeToString(ListSerializer(ShareIntakeBatch.serializer()), batches)
        indexFile.writeText(encoded, StandardCharsets.UTF_8)
    }

    companion object {
        const val DEFAULT_MAX_STREAMS_PER_BATCH = 12
        const val DEFAULT_MAX_BYTES_PER_STREAM = 64L * 1024L * 1024L
        const val DEFAULT_MAX_RETAINED_BATCHES = 20
        private const val MAX_TEXT_CHARS = 100_000

        /**
         * Formats a staged share batch into user-editable composer draft text.
         * Follows workspace file-paste convention: shared files appear as concrete local paths, never auto-sent.
         */
        fun formatComposerDraft(batch: ShareIntakeBatch): String {
            val parts = ArrayList<String>()
            for (item in batch.items) {
                if (!item.text.isNullOrBlank()) {
                    parts += item.text.trim()
                } else if (!item.path.isNullOrBlank()) {
                    parts += item.path
                }
            }
            return parts.joinToString("\n").trim()
        }

        fun sanitizeFileName(rawName: String?, index: Int, mimeType: String?): String {
            val cleaned = rawName
                ?.substringAfterLast('/')
                ?.substringAfterLast('\\')
                ?.replace(Regex("""[^\p{L}\p{N}._-]"""), "_")
                ?.trim('.', '_', ' ')
                ?.take(96)
                .orEmpty()
            if (cleaned.isNotEmpty() && cleaned != "." && cleaned != "..") {
                return if ('.' in cleaned) cleaned else cleaned + defaultExtensionForMime(mimeType)
            }
            return "shared-$index${defaultExtensionForMime(mimeType)}"
        }

        private fun deduplicateFileName(base: String, used: MutableSet<String>): String {
            if (used.add(base)) return base
            val dot = base.lastIndexOf('.')
            val stem = if (dot > 0) base.substring(0, dot) else base
            val ext = if (dot > 0) base.substring(dot) else ""
            var n = 2
            while (true) {
                val candidate = "$stem-$n$ext"
                if (used.add(candidate)) return candidate
                n++
            }
        }

        private fun defaultExtensionForMime(mime: String?): String {
            val m = mime?.lowercase()?.substringBefore(';')?.trim().orEmpty()
            return when (m) {
                "image/png" -> ".png"
                "image/jpeg", "image/jpg" -> ".jpg"
                "image/webp" -> ".webp"
                "image/gif" -> ".gif"
                "application/pdf" -> ".pdf"
                "text/plain" -> ".txt"
                "text/markdown" -> ".md"
                "application/json" -> ".json"
                else -> ""
            }
        }

        @Suppress("DEPRECATION")
        fun extractFromAndroidIntent(context: Context, intent: Intent?): IncomingSharePayload? {
            if (intent == null) return null
            val action = intent.action ?: return null
            if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return null

            val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)
            val extraText = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
            val uris = LinkedHashSet<Uri>()

            when (action) {
                Intent.ACTION_SEND -> {
                    val single = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
                        intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
                    } else {
                        intent.getParcelableExtra(Intent.EXTRA_STREAM)
                    }
                    if (single != null) uris += single
                }
                Intent.ACTION_SEND_MULTIPLE -> {
                    val list = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
                        intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
                    } else {
                        intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
                    }
                    list?.filterNotNull()?.let { uris.addAll(it) }
                }
            }

            val clip: ClipData? = intent.clipData
            var clipFallbackText: String? = null
            if (clip != null) {
                for (i in 0 until clip.itemCount) {
                    val item = clip.getItemAt(i)
                    if (item.uri != null) {
                        uris += item.uri
                    } else if (clipFallbackText == null && extraText.isNullOrBlank()) {
                        clipFallbackText = item.text?.toString()
                    }
                }
            }

            val resolver = context.contentResolver
            val streams = uris.map { uri ->
                val queriedMime = runCatching { resolver.getType(uri) }.getOrNull()
                val queriedName = queryDisplayName(context, uri)
                IncomingShareStream(
                    uriString = uri.toString(),
                    scheme = uri.scheme,
                    authority = uri.authority,
                    displayName = queriedName ?: uri.lastPathSegment,
                    mimeType = queriedMime ?: intent.type,
                    open = { resolver.openInputStream(uri) },
                )
            }

            return IncomingSharePayload(
                action = action,
                mimeType = intent.type,
                subject = subject,
                text = extraText ?: clipFallbackText,
                streams = streams,
            )
        }

        private fun queryDisplayName(context: Context, uri: Uri): String? = runCatching {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (idx >= 0) cursor.getString(idx) else null
                } else {
                    null
                }
            }
        }.getOrNull()
    }
}
