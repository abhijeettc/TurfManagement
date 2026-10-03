plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "in.turfsync.spike"
    compileSdk = 35

    defaultConfig {
        applicationId = "in.turfsync.spike"
        // NotificationListenerService has existed since API 18; 24 is a floor
        // no counter tablet in service today falls below.
        minSdk = 24
        targetSdk = 35
        // Bump versionCode on every build handed to someone else: Android refuses
        // to install over a same-or-higher code, which reads as "App not installed"
        // with no further explanation on the tester's phone.
        versionCode = 3
        versionName = "0.2-beta"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
}
