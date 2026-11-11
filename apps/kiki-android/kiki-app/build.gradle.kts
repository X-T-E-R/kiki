plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

val gitHash: String = runCatching {
    providers.exec { commandLine("git", "rev-parse", "--short=7", "HEAD") }.standardOutput.asText.get().trim()
}.getOrNull()?.takeIf { it.isNotEmpty() } ?: "dev"

val generatedNoticesDir = layout.buildDirectory.dir("generated/noticesAssets")

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
        versionCode = 1
        versionName = "0.5.1"
        buildConfigField("String", "GIT_HASH", "\"$gitHash\"")
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
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildTypes {
        getByName("release") {
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

tasks.matching { it.name.contains("Assets") && it.name != stageThirdPartyNotices.name }.configureEach {
    dependsOn(stageThirdPartyNotices)
}

dependencies {
    implementation(project(":kiki-host"))
    implementation(project(":kiki-tools-screen"))

    testImplementation(libs.junit)
    testImplementation(libs.kotlin.test)
    testImplementation(libs.kotlinx.serialization.json)
}
