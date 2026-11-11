package dev.kiki.android.runtime

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.tukaani.xz.XZInputStream
import java.io.BufferedInputStream
import java.io.File
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.BasicFileAttributes
import java.security.DigestInputStream
import java.security.MessageDigest

@Serializable
data class BundledDistMeta(
    val version: String,
    val sha256: String,
    val bytes: Long = 0L,
    val source: String = "",
)

data class InstalledKikiRuntime(
    val version: String,
    val sha256: String,
    val runtimeDir: File,
    val entryMjs: File,
    val webDir: File,
    val homeDir: File,
    val secureDir: File,
    val runDir: File,
    val inboxDir: File,
    val tmpDir: File,
    val compileCacheDir: File,
    val nativeLibraryDir: File,
    val nodeBinary: File,
)

class RuntimeInstaller(
    private val filesDir: File,
    private val cacheDir: File,
    private val nativeLibraryDir: File,
    private val openMetaAsset: () -> InputStream,
    private val openTarXzAsset: () -> InputStream,
) {
    constructor(context: Context) : this(
        filesDir = context.filesDir,
        cacheDir = context.cacheDir,
        nativeLibraryDir = File(context.applicationInfo.nativeLibraryDir),
        openMetaAsset = { context.assets.open(META_ASSET) },
        openTarXzAsset = { context.assets.open(TAR_ASSET) },
    )

    private val lock = Mutex()
    private val json = Json { ignoreUnknownKeys = true }

    val kikiRoot: File get() = File(filesDir, "kiki")
    val runtimesRoot: File get() = File(kikiRoot, "runtime")
    val homeDir: File get() = File(kikiRoot, "home")
    val secureDir: File get() = File(kikiRoot, "secure")
    val runDir: File get() = File(kikiRoot, "run")
    val inboxDir: File get() = File(kikiRoot, "inbox")
    val tmpDir: File get() = File(cacheDir, "kiki/tmp")
    val compileCacheDir: File get() = File(cacheDir, "kiki/compile-cache")

    suspend fun ensureReady(): InstalledKikiRuntime = lock.withLock {
        withContext(Dispatchers.IO) {
            prepareDirectories()
            val meta = openMetaAsset().use { stream ->
                json.decodeFromString(BundledDistMeta.serializer(), stream.readBytes().toString(Charsets.UTF_8))
            }
            val dirKey = "${sanitizeKey(meta.version)}-${meta.sha256.take(8)}"
            val targetDir = File(runtimesRoot, dirKey)
            val stampFile = File(targetDir, ".ready-sha256")
            val entryFile = resolveEntryFile(targetDir)

            if (!targetDir.isDirectory || !stampFile.isFile || stampFile.readText().trim() != meta.sha256 || !entryFile.isFile) {
                extractAtomically(meta, targetDir, stampFile)
            }

            val resolvedEntry = resolveEntryFile(targetDir)
            if (!resolvedEntry.isFile) {
                throw IOException("Kiki runtime entry script missing under ${targetDir.absolutePath}")
            }
            val nodeBin = File(nativeLibraryDir, NODE_SO_NAME)
            InstalledKikiRuntime(
                version = meta.version,
                sha256 = meta.sha256,
                runtimeDir = targetDir,
                entryMjs = resolvedEntry,
                webDir = File(targetDir, "web"),
                homeDir = homeDir,
                secureDir = secureDir,
                runDir = runDir,
                inboxDir = inboxDir,
                tmpDir = tmpDir,
                compileCacheDir = compileCacheDir,
                nativeLibraryDir = nativeLibraryDir,
                nodeBinary = nodeBin,
            )
        }
    }

    fun cleanupOldRuntimes(keepDir: File) {
        val children = runtimesRoot.listFiles() ?: return
        for (child in children) {
            if (child.name != keepDir.name && !child.name.endsWith(".staging")) {
                runCatching { deleteTree(child.toPath()) }
            }
        }
    }

    private fun prepareDirectories() {
        listOf(kikiRoot, runtimesRoot, homeDir, secureDir, File(runDir, "crash"), inboxDir, tmpDir, compileCacheDir)
            .forEach { it.mkdirs() }
    }

    private fun resolveEntryFile(runtimeDir: File): File {
        val primary = File(runtimeDir, "entry.mjs")
        if (primary.isFile) return primary
        val alt = File(runtimeDir, "kiki-android-serve.mjs")
        if (alt.isFile) return alt
        return primary
    }

    private fun extractAtomically(meta: BundledDistMeta, targetDir: File, stampFile: File) {
        val stagingDir = File(runtimesRoot, "${targetDir.name}.staging")
        val oldDir = File(runtimesRoot, "${targetDir.name}.old")
        deleteTree(stagingDir.toPath())
        deleteTree(oldDir.toPath())
        Files.createDirectories(stagingDir.toPath())

        val digest = MessageDigest.getInstance("SHA-256")
        try {
            DigestInputStream(BufferedInputStream(openTarXzAsset(), 64 * 1024), digest).use { raw ->
                val keepOpen = object : FilterInputStream(raw) {
                    override fun close() = Unit
                }
                extractTarStream(XZInputStream(keepOpen), stagingDir.toPath())
                val drain = ByteArray(16 * 1024)
                while (raw.read(drain) >= 0) Unit
            }
            val actualSha = digest.digest().joinToString("") { "%02x".format(it) }
            if (!actualSha.equals(meta.sha256, ignoreCase = true)) {
                throw IOException("kiki-dist.tar.xz SHA-256 mismatch: expected ${meta.sha256}, got $actualSha")
            }
            File(stagingDir, ".ready-sha256").writeText(meta.sha256)
            if (Files.exists(targetDir.toPath(), LinkOption.NOFOLLOW_LINKS)) {
                Files.move(targetDir.toPath(), oldDir.toPath(), StandardCopyOption.ATOMIC_MOVE)
            }
            try {
                Files.move(stagingDir.toPath(), targetDir.toPath(), StandardCopyOption.ATOMIC_MOVE)
            } catch (_: IOException) {
                Files.move(stagingDir.toPath(), targetDir.toPath(), StandardCopyOption.REPLACE_EXISTING)
            }
            deleteTree(oldDir.toPath())
            check(stampFile.isFile) { "Missing stamp file after atomic swap" }
        } catch (e: Exception) {
            runCatching { deleteTree(stagingDir.toPath()) }
            throw e
        }
    }

    private fun extractTarStream(xzIn: InputStream, destRoot: Path) {
        val normalizedRoot = destRoot.toAbsolutePath().normalize()
        var totalBytes = 0L
        var count = 0
        TarArchiveInputStream(BufferedInputStream(xzIn)).use { tar ->
            while (true) {
                val entry = tar.nextEntry ?: break
                if (++count > MAX_ENTRIES) throw IOException("Archive exceeds max entries ($MAX_ENTRIES)")
                val rel = entry.name.removePrefix("./").trimStart('/').trimEnd('/')
                if (rel.isEmpty() || rel == ".") continue
                if (entry.name.startsWith("/")) throw IOException("Absolute path rejected: ${entry.name}")
                val outPath = normalizedRoot.resolve(rel).normalize()
                if (!outPath.startsWith(normalizedRoot)) {
                    throw IOException("Archive entry escapes destination: ${entry.name}")
                }
                when {
                    entry.isDirectory -> Files.createDirectories(outPath)
                    entry.isSymbolicLink -> {
                        outPath.parent?.let { Files.createDirectories(it) }
                        Files.deleteIfExists(outPath)
                        val linkTarget = outPath.parent.resolve(entry.linkName).normalize()
                        if (!linkTarget.startsWith(normalizedRoot)) {
                            throw IOException("Symlink escapes destination: ${entry.name} -> ${entry.linkName}")
                        }
                        Files.createSymbolicLink(outPath, outPath.fileSystem.getPath(entry.linkName))
                    }
                    entry.isFile -> {
                        totalBytes += entry.size
                        if (totalBytes > MAX_BYTES) throw IOException("Archive exceeds max size ($MAX_BYTES)")
                        outPath.parent?.let { Files.createDirectories(it) }
                        Files.deleteIfExists(outPath)
                        Files.newOutputStream(outPath, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE).use { out ->
                            tar.copyTo(out)
                        }
                    }
                }
            }
        }
    }

    private fun sanitizeKey(raw: String): String =
        raw.replace(Regex("[^A-Za-z0-9._-]"), "_").take(48).ifEmpty { "kiki" }

    companion object {
        const val META_ASSET = "kiki/kiki-dist.meta.json"
        const val TAR_ASSET = "kiki/kiki-dist.tar.xz"
        const val NODE_SO_NAME = "libkiki_node.so"
        private const val MAX_BYTES = 512L shl 20
        private const val MAX_ENTRIES = 50_000

        fun deleteTree(path: Path) {
            if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) return
            Files.walkFileTree(path, object : SimpleFileVisitor<Path>() {
                override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
                    Files.deleteIfExists(file)
                    return FileVisitResult.CONTINUE
                }

                override fun postVisitDirectory(dir: Path, exc: IOException?): FileVisitResult {
                    if (exc != null) throw exc
                    Files.deleteIfExists(dir)
                    return FileVisitResult.CONTINUE
                }
            })
        }
    }
}
