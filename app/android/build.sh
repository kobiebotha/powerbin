#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"
export JAVA_HOME="${JAVA_HOME:-$root/.tools/jdk17/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$root/.tools/android-sdk}"
export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$ANDROID_HOME/ndk/27.2.12479018}"
export ANDROID_USER_HOME="${ANDROID_USER_HOME:-$root/.tools/android-validation/user}"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$root/.tools/gradle-home}"
export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:-} -Duser.home=$ANDROID_USER_HOME"
export PATH="$root/.tools/nsh/bin:$root/.tools/gradle-8.11.1/bin:$JAVA_HOME/bin:$PATH"
if [ -x "$root/.tools/cargo/bin/cargo" ]; then
    export CARGO_HOME="$root/.tools/cargo" RUSTUP_HOME="$root/.tools/rustup"
    export PATH="$root/.tools/cargo/bin:$PATH"
fi
mkdir -p "$root/.tools/android-validation" "$ANDROID_USER_HOME"
keystore="$root/.tools/android-validation/debug.keystore"
if [ ! -f "$keystore" ]; then
    keytool -genkeypair -noprompt -keystore "$keystore" -storepass android -keypass android \
        -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US"
fi
nsh build app --out app/android/build/assets/nsh
# The mixed TSX host links the Rust module into libnsh.so; Gradle reuses it.
NSH_KEYSTORE_PASSWORD=android nsh package app --target android --abi arm64-v8a \
    --out app/android/build/stock --keystore "$keystore" --key-alias androiddebugkey
gradle -p app/android --no-daemon assembleDebug
