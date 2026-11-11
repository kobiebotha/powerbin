plugins { id("com.android.application") version "8.9.2" }

// Use NSH's public Java API, with our generated Rust library instead of the AAR's.
val nshApi by tasks.registering(Sync::class) {
    from(zipTree(rootDir.resolve("../../.tools/nsh/embed/android/nsh.aar"))) { include("classes.jar") }
    into(layout.buildDirectory.dir("nsh-api"))
}
android {
    namespace = "dev.powersync.relay"
    compileSdk = 35
    buildToolsVersion = "35.0.1"
    signingConfigs.getByName("debug") { storeFile = file("../../.tools/android-validation/debug.keystore") }
    defaultConfig {
        applicationId = "dev.powersync.relay"
        minSdk = 28
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
        ndk { abiFilters += "arm64-v8a" }
    }
    sourceSets["main"].apply {
        assets.srcDir(layout.buildDirectory.dir("assets"))
        jniLibs.srcDir("../.nsh/rust/android-release/lib")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
dependencies {
    implementation(files(layout.buildDirectory.file("nsh-api/classes.jar")).builtBy(nshApi))
    // Match rustls-platform-verifier-android 0.2.0 in Cargo.lock.
    implementation("org.rustls:rustls-platform-verifier:0.2.0")
}
