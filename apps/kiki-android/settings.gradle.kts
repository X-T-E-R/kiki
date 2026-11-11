pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "kiki-android"
include(":app", ":kiki-runtime", ":kiki-host", ":kiki-tools-screen")
project(":app").projectDir = file("kiki-app")
