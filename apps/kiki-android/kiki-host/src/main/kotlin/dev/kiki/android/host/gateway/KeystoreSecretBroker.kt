package dev.kiki.android.host.gateway

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.KeyStore
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@Serializable
private data class EncryptedSecretRecord(
    val service: String,
    val account: String,
    val nonceB64: String,
    val cipherB64: String,
    val updatedAtMs: Long,
)

@Serializable
private data class SecretVaultFile(
    val v: Int = 1,
    val records: List<EncryptedSecretRecord> = emptyList(),
)

/**
 * AES-256-GCM secret vault backed by AndroidKeyStore (or an injected SecretKey in JVM unit tests).
 * Secrets are encrypted per entry with AAD = "$service\u0000$account" and persisted atomically to [vaultFile].
 */
class KeystoreSecretBroker(
    private val vaultFile: File,
    private val keyProvider: () -> SecretKey = { getOrCreateAndroidKeystoreKey() },
) {
    private val lock = Any()
    private val json = Json { ignoreUnknownKeys = true }
    private val secureRandom = SecureRandom()

    fun get(service: String, account: String): String? = synchronized(lock) {
        requireValidKey(service, account)
        val vault = readVaultLocked()
        val rec = vault.records.firstOrNull { it.service == service && it.account == account } ?: return null
        decryptRecord(rec)
    }

    fun put(service: String, account: String, value: String) = synchronized(lock) {
        requireValidKey(service, account)
        val current = readVaultLocked()
        val encrypted = encryptRecord(service, account, value)
        val updated = current.records
            .filterNot { it.service == service && it.account == account } + encrypted
        writeVaultAtomicallyLocked(SecretVaultFile(v = 1, records = updated))
    }

    fun delete(service: String, account: String): Boolean = synchronized(lock) {
        requireValidKey(service, account)
        val current = readVaultLocked()
        val filtered = current.records.filterNot { it.service == service && it.account == account }
        if (filtered.size == current.records.size) return false
        writeVaultAtomicallyLocked(SecretVaultFile(v = 1, records = filtered))
        true
    }

    fun listAccounts(service: String): List<String> = synchronized(lock) {
        require(service.isNotBlank() && service.length <= 256) { "Invalid service" }
        readVaultLocked().records
            .asSequence()
            .filter { it.service == service }
            .map { it.account }
            .sorted()
            .toList()
    }

    private fun requireValidKey(service: String, account: String) {
        require(service.isNotBlank() && service.length <= 256) { "Invalid service" }
        require(account.isNotBlank() && account.length <= 256) { "Invalid account" }
    }

    private fun encryptRecord(service: String, account: String, plaintext: String): EncryptedSecretRecord {
        val key = keyProvider()
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key)
        val iv = cipher.iv ?: ByteArray(12).also {
            secureRandom.nextBytes(it)
            cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, it))
        }
        cipher.updateAAD(aadBytes(service, account))
        val ciphertext = cipher.doFinal(plaintext.toByteArray(StandardCharsets.UTF_8))
        val enc = Base64.getEncoder()
        return EncryptedSecretRecord(
            service = service,
            account = account,
            nonceB64 = enc.encodeToString(iv),
            cipherB64 = enc.encodeToString(ciphertext),
            updatedAtMs = System.currentTimeMillis(),
        )
    }

    private fun decryptRecord(record: EncryptedSecretRecord): String {
        val key = keyProvider()
        val dec = Base64.getDecoder()
        val iv = dec.decode(record.nonceB64)
        val ciphertext = dec.decode(record.cipherB64)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, iv))
        cipher.updateAAD(aadBytes(record.service, record.account))
        return String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8)
    }

    private fun aadBytes(service: String, account: String): ByteArray =
        "$service\u0000$account".toByteArray(StandardCharsets.UTF_8)

    private fun readVaultLocked(): SecretVaultFile {
        if (!vaultFile.isFile) return SecretVaultFile()
        val text = vaultFile.readText(StandardCharsets.UTF_8)
        if (text.isBlank()) return SecretVaultFile()
        return json.decodeFromString(SecretVaultFile.serializer(), text)
    }

    private fun writeVaultAtomicallyLocked(vault: SecretVaultFile) {
        vaultFile.parentFile?.mkdirs()
        val tmpFile = File(vaultFile.parentFile, "${vaultFile.name}.tmp")
        val payload = json.encodeToString(SecretVaultFile.serializer(), vault)
        tmpFile.writeText(payload, StandardCharsets.UTF_8)
        try {
            Files.move(
                tmpFile.toPath(),
                vaultFile.toPath(),
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING,
            )
        } catch (_: Exception) {
            Files.move(tmpFile.toPath(), vaultFile.toPath(), StandardCopyOption.REPLACE_EXISTING)
        }
    }

    companion object {
        private const val KEYSTORE_PROVIDER = "AndroidKeyStore"
        private const val KEY_ALIAS = "dev.kiki.android.host.secret_vault.v1"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val GCM_TAG_BITS = 128

        fun getOrCreateAndroidKeystoreKey(): SecretKey {
            val ks = KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }
            val existing = (ks.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.secretKey
            if (existing != null) return existing

            val keyGen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER)
            val spec = KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(false)
                .build()
            keyGen.init(spec)
            return keyGen.generateKey()
        }
    }
}
