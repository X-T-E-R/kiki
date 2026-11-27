import java.io.FileInputStream
import java.security.KeyStore
import java.security.MessageDigest

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

fun propOrEnv(propName: String, envName: String): String? =
    (providers.gradleProperty(propName).orNull ?: providers.environmentVariable(envName).orNull)
        ?.trim()
        ?.takeIf { it.isNotEmpty() }

fun escapeBuildConfigString(raw: String): String =
    "\"" + raw.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

val gitHash: String = runCatching {
    providers.exec { commandLine("git", "rev-parse", "--short=7", "HEAD") }.standardOutput.asText.get().trim()
}.getOrNull()?.takeIf { it.isNotEmpty() } ?: "dev"

val kikiVersionName: String = propOrEnv("kikiVersionNameOverride", "KIKI_VERSION_NAME_OVERRIDE") ?: runCatching {
    val pkgText = rootProject.file("../kiki-gui/package.json").readText()
    Regex("\"version\"\\s*:\\s*\"([^\"]+)\"").find(pkgText)?.groupValues?.getOrNull(1)
}.getOrNull()?.takeIf { it.isNotBlank() } ?: "0.7.0"

val kikiVersionCode: Int = propOrEnv("kikiVersionCodeOverride", "KIKI_VERSION_CODE_OVERRIDE")?.toIntOrNull() ?: runCatching {
    val core = kikiVersionName.substringBefore('-')
    val parts = core.split('.').map { it.toInt() }
    if (parts.size == 3) parts[0] * 1_000_000 + parts[1] * 1_000 + parts[2] else 7000
}.getOrDefault(7000)

val distributionChannel: String = (propOrEnv("kikiDistribution", "KIKI_DISTRIBUTION") ?: "official")
    .lowercase()
    .let { if (it == "portal") "portal" else "official" }

val defaultUpdaterFeedUrl: String = if (distributionChannel == "portal") {
    "https://kiki.zjuam.art/api/kiki/updater/stable/android.json"
} else {
    "https://github.com/X-T-E-R/kiki/releases/latest/download/android.json"
}

val updaterFeedUrl: String = propOrEnv("kikiUpdaterFeedUrl", "KIKI_UPDATER_FEED_URL") ?: defaultUpdaterFeedUrl

val releaseKeystorePath: String? = propOrEnv("kikiAndroidKeystorePath", "KIKI_ANDROID_KEYSTORE_PATH")
    ?: propOrEnv("kikiAndroidKeystoreFile", "KIKI_ANDROID_KEYSTORE_FILE")
val releaseStorePassword: String? = propOrEnv("kikiAndroidStorePassword", "KIKI_ANDROID_STORE_PASSWORD")
val releaseKeyAlias: String? = propOrEnv("kikiAndroidKeyAlias", "KIKI_ANDROID_KEY_ALIAS")
val releaseKeyPassword: String? = propOrEnv("kikiAndroidKeyPassword", "KIKI_ANDROID_KEY_PASSWORD")
val releaseKeystoreFile = releaseKeystorePath?.let { file(it) }
val hasReleaseSigning = releaseKeystoreFile?.isFile == true &&
    !releaseStorePassword.isNullOrEmpty() &&
    !releaseKeyAlias.isNullOrEmpty() &&
    !releaseKeyPassword.isNullOrEmpty()

fun detectKeystoreType(ksFile: java.io.File): String = runCatching {
    FileInputStream(ksFile).use { input ->
        val magic = ByteArray(4)
        if (input.read(magic) == 4 &&
            magic[0] == 0xFE.toByte() &&
            magic[1] == 0xED.toByte() &&
            magic[2] == 0xFE.toByte() &&
            magic[3] == 0xED.toByte()
        ) {
            "JKS"
        } else {
            "PKCS12"
        }
    }
}.getOrDefault("PKCS12")

val detectedReleaseStoreType: String = releaseKeystoreFile?.takeIf { it.isFile }?.let(::detectKeystoreType) ?: "PKCS12"

val keystoreCertSha256: String? = if (hasReleaseSigning && releaseKeystoreFile != null) {
    runCatching {
        val ks = KeyStore.getInstance(detectedReleaseStoreType)
        FileInputStream(releaseKeystoreFile).use { ks.load(it, releaseStorePassword!!.toCharArray()) }
        val cert = ks.getCertificate(releaseKeyAlias)
            ?: throw GradleException("No certificate found in keystore for alias '$releaseKeyAlias'")
        MessageDigest.getInstance("SHA-256").digest(cert.encoded).joinToString("") { "%02X".format(it) }
    }.getOrThrow()
} else {
    null
}

val configuredExpectedSignerSha256: String? = propOrEnv("kikiExpectedSignerSha256", "KIKI_ANDROID_SIGNING_CERT_SHA256")
    ?.replace(":", "")
    ?.uppercase()

if (keystoreCertSha256 != null && configuredExpectedSignerSha256 != null && keystoreCertSha256 != configuredExpectedSignerSha256) {
    throw GradleException(
        "Release keystore certificate SHA-256 ($keystoreCertSha256) does not match KIKI_ANDROID_SIGNING_CERT_SHA256 ($configuredExpectedSignerSha256).",
    )
}

val expectedSignerSha256: String = configuredExpectedSignerSha256 ?: keystoreCertSha256 ?: ""
val useReleaseKeyForDebug: Boolean = propOrEnv("kikiUseReleaseKeyForDebug", "KIKI_USE_RELEASE_KEY_FOR_DEBUG") == "true"
val requestedReleaseTask: Boolean = gradle.startParameter.taskNames.any { it.contains("Release", ignoreCase = true) }

if (requestedReleaseTask && !hasReleaseSigning) {
    throw GradleException(
        "Release signing requires KIKI_ANDROID_KEYSTORE_PATH (or KIKI_ANDROID_KEYSTORE_FILE), " +
            "KIKI_ANDROID_STORE_PASSWORD, KIKI_ANDROID_KEY_ALIAS, and KIKI_ANDROID_KEY_PASSWORD.",
    )
}

val generatedNoticesDir = layout.buildDirectory.dir("generated/noticesAssets")
val generatedRemoteAssetsDir = layout.buildDirectory.dir("generated/remoteAssets")
val mobileDir = rootProject.file("../kiki-gui/mobile")
val mobileLauncherDir = mobileDir.resolve("launcher")
val guiDistDir = rootProject.file("../kiki-gui/dist")

val buildRemoteLauncherBundle by tasks.registering(Exec::class) {
    group = "kiki"
    description = "Compile apps/kiki-gui/mobile launcher bundle for REMOTE_ONLY mode"
    onlyIf { mobileDir.resolve("node_modules").isDirectory || !mobileLauncherDir.resolve("launcher.js").exists() }
    inputs.dir(mobileDir.resolve("src"))
    inputs.file(mobileDir.resolve("scripts/build-launcher.mjs"))
    outputs.file(mobileLauncherDir.resolve("launcher.js"))
    workingDir(mobileDir)
    commandLine("node", mobileDir.resolve("scripts/build-launcher.mjs").absolutePath)
}

val stageRemoteShellAssets by tasks.registering(Sync::class) {
    group = "kiki"
    description = "Stage REMOTE_ONLY launcher and optional kiki-gui bundle into APK assets"
    dependsOn(buildRemoteLauncherBundle)
    from(mobileLauncherDir) { into("kiki/launcher") }
    if (guiDistDir.isDirectory) {
        from(guiDistDir) {
            exclude("**/*.gz", "**/*.br", "**/*.map")
            into("kiki/gui")
        }
    }
    into(generatedRemoteAssetsDir)
}

val stageThirdPartyNotices by tasks.registering(Copy::class) {
    from(rootProject.file("THIRD_PARTY_NOTICES.md"))
    from(rootProject.file("licenses")) { into("licenses") }
    into(generatedNoticesDir.map { it.dir("kiki") })
}

android {
    namespace = "dev.kiki.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.kiki.app"
        minSdk = 30
        targetSdk = 35
        versionCode = kikiVersionCode
        versionName = kikiVersionName
        buildConfigField("String", "GIT_HASH", escapeBuildConfigString(gitHash))
        buildConfigField("String", "DISTRIBUTION_CHANNEL", escapeBuildConfigString(distributionChannel))
        buildConfigField("String", "UPDATER_FEED_URL", escapeBuildConfigString(updaterFeedUrl))
        buildConfigField("String", "EXPECTED_SIGNER_SHA256", escapeBuildConfigString(expectedSignerSha256))
    }

    signingConfigs {
        if (hasReleaseSigning && releaseKeystoreFile != null) {
            create("release") {
                storeFile = releaseKeystoreFile
                storeType = detectedReleaseStoreType
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
                enableV1Signing = false
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    // libkiki_node.so executes directly from nativeLibraryDir, so native libs must be extracted to disk on install.
    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }

    androidResources {
        noCompress += "xz"
    }

    sourceSets.getByName("main") {
        assets.srcDir(generatedNoticesDir)
        assets.srcDir(generatedRemoteAssetsDir)
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildTypes {
        getByName("debug") {
            if (useReleaseKeyForDebug && hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
        getByName("release") {
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    buildFeatures {
        buildConfig = true
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
        unitTests.all {
            if (System.getProperty("updateToolsSnapshot") == "true") {
                it.systemProperty("updateToolsSnapshot", "true")
            }
        }
    }
}

kotlin {
    jvmToolchain(17)
}

tasks.matching {
    (it.name.contains("Assets", ignoreCase = true) || it.name.contains("lint", ignoreCase = true)) &&
        it.name != stageThirdPartyNotices.name &&
        it.name != stageRemoteShellAssets.name
}.configureEach {
    dependsOn(stageThirdPartyNotices)
    dependsOn(stageRemoteShellAssets)
}

dependencies {
    implementation(project(":kiki-host"))
    implementation(project(":kiki-tools-screen"))

    testImplementation(libs.junit)
    testImplementation(libs.kotlin.test)
    testImplementation(libs.kotlinx.serialization.json)
}
