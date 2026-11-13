#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"
export PATH="$root/.tools/nsh/bin:$PATH"
if [ -x "$root/.tools/cargo/bin/cargo" ]; then
    export CARGO_HOME="$root/.tools/cargo" RUSTUP_HOME="$root/.tools/rustup"
    export PATH="$root/.tools/cargo/bin:$PATH"
fi
entitlements="$root/app/ios/simulator.entitlements"
der="$root/app/.nsh/simulator-entitlements.der"
mkdir -p "$root/app/.nsh"
xcrun derq query -f xml -i "$entitlements" -o "$der" --raw
# iOS Simulator reads these sections; macOS signing must not claim iOS groups.
export CARGO_TARGET_AARCH64_APPLE_IOS_SIM_RUSTFLAGS="${CARGO_TARGET_AARCH64_APPLE_IOS_SIM_RUSTFLAGS:-} -C link-arg=-Wl,-sectcreate,__TEXT,__entitlements,$entitlements -C link-arg=-Wl,-sectcreate,__TEXT,__ents_der,$der"
nsh package app --target ios-simulator --out .nsh/out/ios-simulator
bundle="$root/.nsh/out/ios-simulator/PowerBin.app"
# Simulator-only identity: device signing must use Apple's provisioning profile.
xcrun vtool -show-build "$bundle/PowerBin" | /usr/bin/grep -q 'platform IOSSIMULATOR'
codesign --force --sign - "$bundle"
codesign --verify --strict "$bundle"
xcrun otool -l "$bundle/PowerBin" | /usr/bin/grep -E -A 3 'sectname __entitlements|sectname __ents_der'
codesign --display --entitlements - --xml "$bundle"
