import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 36
    namespace = "org.unforced.uni"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "org.unforced.uni"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    // T-305: releases are release builds (optimized, stripped Rust library), signed with the one key installed apps
    // trust: the keystore Gradle's debug signing has always used, $ANDROID_USER_HOME/debug.keystore (cert
    // 6E:9F:4F:94…22:46:B6:3D, see ~/.config/uni/android.env). Unlike debug signing, a missing keystore fails the
    // build here instead of silently creating a new key.
    signingConfigs {
        create("release") {
            val home = System.getenv("ANDROID_USER_HOME") ?: "${System.getProperty("user.home")}/.android"
            storeFile = file("$home/debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            // T-335: UNI_ANDROID_UNSIGNED=1 (publish.sh, via scripts/android-release-build.sh) builds the release APK
            // unsigned (app-universal-release-unsigned.apk, still zip-aligned) and never opens a keystore; the sealed
            // broker signs it after the owner approves. Unset, local release builds sign as before.
            if (System.getenv("UNI_ANDROID_UNSIGNED") != "1") {
                signingConfig = signingConfigs.getByName("release")
            }
            // T-305: no R8. Rust finds the Kotlin classes (RustWebView, Ipc, the plugins) by name over JNI, and the
            // dex is a few MB of a release; shrinking it is not worth a class renamed out from under the shell.
            isMinifyEnabled = false
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    // T-305: compress the Rust library inside the APK. An update is a full download, and deflate halves the library;
    // Android unpacks it once at install instead of mapping it from the APK.
    packaging {
        jniLibs.useLegacyPackaging = true
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

// T-79: RustWebView.kt and Ipc.kt in src/main/java/org/unforced/uni replace the generated wry copies.
tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    exclude("**/generated/RustWebView.kt", "**/generated/Ipc.kt")
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")