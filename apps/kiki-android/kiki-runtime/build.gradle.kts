plugins {
    id("com.android.library")
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.serialization)
}

val generatedJniDir = layout.buildDirectory.dir("generated/jniLibs")
val generatedAssetsDir = layout.buildDirectory.dir("generated/assets")

val stageKikiNode by tasks.registering(Exec::class) {
    group = "kiki"
    description = "Fetch and stage Termux Bionic Node 24 LTS + shared libraries into jniLibs"
    inputs.file(rootProject.file("tools/kiki-runtime/node.lock"))
    inputs.file(rootProject.file("tools/kiki-runtime/fetch-bionic-node.mjs"))
    outputs.dir(generatedJniDir)
    workingDir(rootProject.projectDir)
    commandLine(
        "node",
        rootProject.file("tools/kiki-runtime/fetch-bionic-node.mjs").absolutePath,
        "--out",
        generatedJniDir.get().asFile.absolutePath,
    )
}

val configuredKikiDistTar = providers.environmentVariable("KIKI_DIST_TAR")
    .orNull
    ?.takeIf { it.isNotBlank() }
    ?.let { rootProject.file(it) }
    ?: rootProject.file("../kimi-code/dist-android/kiki-dist.tar.xz")
val configuredKikiDistTarPresent = configuredKikiDistTar.isFile
val configuredKikiDistTarInputs = rootProject.files().apply {
    if (configuredKikiDistTarPresent) from(configuredKikiDistTar)
}

val stageKikiDist by tasks.registering(Exec::class) {
    group = "kiki"
    description = "Stage kiki-dist.tar.xz and kiki-dist.meta.json into assets/kiki"
    inputs.file(rootProject.file("tools/kiki-runtime/stage-dist.mjs"))
    inputs.files(configuredKikiDistTarInputs).withPropertyName("kikiDistTar")
    inputs.property("kikiDistTarPath", configuredKikiDistTar.absolutePath)
    inputs.property("kikiDistTarPresent", configuredKikiDistTarPresent)
    outputs.dir(generatedAssetsDir)
    workingDir(rootProject.projectDir)
    commandLine(
        "node",
        rootProject.file("tools/kiki-runtime/stage-dist.mjs").absolutePath,
        "--tar",
        configuredKikiDistTar.absolutePath,
        "--out",
        generatedAssetsDir.get().asFile.resolve("kiki").absolutePath,
    )
}

android {
    namespace = "dev.kiki.android.runtime"
    compileSdk = 36

    defaultConfig {
        minSdk = 30
    }

    sourceSets.getByName("main") {
        jniLibs.srcDir(generatedJniDir)
        assets.srcDir(generatedAssetsDir)
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    jvmToolchain(17)
}

tasks.matching { it.name.contains("JniLibFolders") || it.name.contains("NativeLibs") }.configureEach {
    dependsOn(stageKikiNode)
}
tasks.matching { it.name.contains("Assets") }.configureEach {
    dependsOn(stageKikiDist)
}

dependencies {
    implementation(libs.xz)
    implementation(libs.commons.compress)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    testImplementation(libs.junit)
}
