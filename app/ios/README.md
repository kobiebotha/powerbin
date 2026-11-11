# iOS simulator build

```sh
sh app/ios/build-simulator.sh
```

Run from the repository root on an Apple Silicon Mac with Xcode and the NSH/Rust
prerequisites. The output is `.nsh/out/ios-simulator/PowerBin.app`.
NSH packages the shared TSX entry with its linked Rust core. This wrapper keeps
the same simulator keychain entitlement behavior as the earlier Rust-root app.

An iOS simulator app has separate macOS host-signing and simulated iOS
entitlements. The wrapper embeds the application identifier and private
keychain group in Mach-O `__TEXT,__entitlements` and `__TEXT,__ents_der` sections.
It generates DER with Xcode's `derq`, applies linker flags only to
`aarch64-apple-ios-sim`, and keeps the host signature plain ad-hoc.

This follows the split in Xcode's installed resources:
`BaseEntitlements-Simulator.plist` contains the host debug entitlement;
`BaseEntitlements-Simulator-Simulated.plist` contains the simulated app ID;
`iPhoneSimulator.sdk/Entitlements.plist` supplies the simulated app ID and
keychain access groups. The wrapper verifies the simulator platform, embedded
sections, and code signature. An empty host entitlement dump is expected.

NSH 0.4's stock simulator package omits these sections, causing protected
keychain access to fail with `errSecMissingEntitlement` (`-34018`). Putting the
iOS keychain groups directly into the host signature instead causes launch
rejection. The wrapper retains the protected keychain store throughout.

The synthetic `SIMULATOR0` namespace is only for local simulators and needs no
Apple development team. Real iPhone/iPad builds need a valid Apple signing
identity and provisioning profile; use NSH's device `--sign` and `--profile`
options so device entitlements come from that profile.

Before the TSX migration, verified on the iOS 27.2 simulator: protected keychain startup, full-fingerprint
pairing with macOS, PowerSync connection, saved-snippet decryption, encrypted
transfers in both directions, and Copy & burn with exact text confirmed by
native Paste. After a simulator restart, the remembered session reconnected and
decrypted saved snippets without setup or pairing. See the root README for the
pre-migration platform verification table and
[migration validation](../../docs/tsx-migration-validation.md) for the mixed app.

See Apple's [keychain entitlement troubleshooting](https://developer.apple.com/forums/thread/114456)
and [provisioning profile explanation](https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles).
