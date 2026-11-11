# Android host

This small Java Activity loads the shared TSX bundle through NSH's public
`NshView.loadAssetBundle` API. Its generated mixed host links the Rust core and
registers `relay/native` for TSX. Before loading, its JNI initializer supplies the
application context to Android keyring storage and the platform TLS verifier,
and records `Context.getFilesDir()` for the local SQLite database. No NSH fork
or Gradle Rust plugin is required.

The build reuses NSH's generated Rust `libnsh.so` and only the Java classes from
its AAR. The AAR's stock native libraries are excluded. The TLS verifier's
official Maven component is included at the version matching Cargo's Android
verifier dependency. Debug builds are unminified.

## Build

Validated with Temurin JDK 17.0.21, Gradle 8.11.1, Android SDK API 35,
build-tools 35.0.1, NDK 27.2.12479018, and Rust's `aarch64-linux-android` target.
Install the necessary SDK packages and accept their licenses before building.
No toolchain binaries are vendored in the repository.

From the repository root:

```sh
sh app/android/build.sh
```

The script defaults to the project-local tools under `.tools/`; existing
`JAVA_HOME`, `ANDROID_HOME`, `ANDROID_NDK_HOME`, and Gradle/NSH on PATH also work.
It builds the TSX bundle and mixed Rust host through NSH, then assembles
`app/android/build/outputs/apk/debug/PowerBin-debug.apk` with Gradle. The stock
APK under `app/android/build/stock` is only an intermediate artifact; install
the Gradle APK. Its standard debug signing key is kept under `.tools/`.

The application crate includes `android/keyring.rs` only on Android. Secrets
use Android Keystore-backed storage; access failures have no plaintext fallback.
The TLS initializer delegates to rustls-platform-verifier's Android integration,
preserving Android certificate validation.

## Local emulator

The local validation device is an API 35 ARM64 emulator named `Relay_API_35`,
with its AVD/user data under `.tools/android-validation/`. With SDK
`platform-tools` on PATH and that emulator running:

```sh
adb -s emulator-5554 install -r app/android/build/outputs/apk/debug/PowerBin-debug.apk
adb -s emulator-5554 reverse tcp:18088 tcp:18088
adb -s emulator-5554 reverse tcp:18080 tcp:18080
adb -s emulator-5554 reverse tcp:4173 tcp:4173
adb -s emulator-5554 shell am start -W -n dev.powersync.relay/.MainActivity
adb -s emulator-5554 logcat -d -b crash
```

The reverse mappings let the demo's configured localhost API, PowerSync, and
web URLs reach the host machine. They do not change the host's listening ports.

## Verification

Before the TSX migration, ARM64 Rust/SDK compilation, Gradle APK assembly, installation, and emulator
launch passed. PowerBin remained running with empty crash and NSH error logs.
Both JNI exports and 16 KB APK alignment were verified; the native library
requires only Android system shared libraries. TLS initialization ran without
a startup exception; a real Rust HTTPS handshake has not yet been exercised.
Android pairing/send/copy UI flows have not been verified.
See [migration validation](../../docs/tsx-migration-validation.md) for checks of
the mixed host; the pre-migration results above do not verify its runtime flows.

References: [NSH Android](https://nsh.dev/docs/android/),
[Android keyring initialization](https://github.com/open-source-cooperative/android-native-keyring-store/tree/v1.0.0),
[platform TLS verifier](https://github.com/rustls/rustls-platform-verifier/tree/v0.7.1),
[AGP 8.9 compatibility](https://developer.android.com/build/releases/agp-8-9-0-release-notes).
