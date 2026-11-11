# TSX migration validation

Validated 9 November 2026 against the pinned Native Shell revision
`e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3` and the existing local backend stack.
The earlier Rust-root results remain historical evidence in the root README.

## Implementation

- `app/App.tsx` and `app/ui/` contain the shared Native Shell TSX views. The
  previous Rust view module and direct Rust-root desktop binary were removed.
- `app/src/bridge.rs` exports generated display-state, field, and command types
  under the existing `relay/native` module. Session keys and device credentials
  stay in Rust. Rust watches push snapshots; there is no TSX-to-Rust polling.
- A VM-local core task owns one controller and its reactive root. Subscriptions
  receive initial state, release their callbacks on unsubscribe/owner cleanup,
  and can remount without creating another controller. Actions remain app-owned.
- The Rust controller, native SDK, Web SDK adapter, encryption, backend protocol,
  sync configuration, storage namespaces, and application identifiers are retained.
- Android loads the TSX asset bundle after its original keyring/files/TLS setup.
  iOS retains its simulator entitlement sections and ad-hoc signing wrapper.

## Automated checks

| Check | Migration result |
| --- | --- |
| `nsh check app` | Passed, including generated Rust declarations and all TSX fixtures |
| `nsh test app/bridge.test.tsx` | 2 passed: snapshots across complete subscriber remount; explicit unsubscribe with a second live listener |
| `pnpm test` | 17 passed |
| `pnpm run test:integration` | 9 passed against local Postgres |
| `cargo test --manifest-path crypto/Cargo.toml` | 11 passed |
| `cargo run --manifest-path app/Cargo.toml --example sync_smoke` | All 6 checks passed: real clients/watches, offline insert, queue persistence/reconnect, consumption tombstones, replay resistance, permanent rejection recovery |
| `pnpm --dir app/web run check` | Passed |
| `pnpm run web:build` | Passed; mixed Rust/WASM runtime, TSX bundle, wasm-bindgen, and copied adapter/workers/SQLite assets |
| `cargo fmt --manifest-path app/Cargo.toml --check` | Passed |
| macOS package | Passed |
| iOS simulator wrapper | Passed release build, platform, entitlement-section, and code-signature checks; installed |
| Android custom Gradle APK | Built and installed; v2 signature, 16 KB alignment, TSX bundle, native library, and JNI exports verified |

The installed pnpm dependencies were reused with
`pnpm_config_verify_deps_before_run=false`: pnpm's automatic dependency
verification otherwise attempted an unrelated modules-directory replacement.
Loopback/network checks required execution outside the command sandbox.

Browser builds need wasm-bindgen CLI 0.2.129 on PATH, plus a WASM-capable clang
and llvm-ar. The existing local wasm-bindgen and Android NDK tools were reused;
see `app/README.md` for the target-scoped compiler/archiver environment.
The browser still needs `random_web.rs`: mixed browser builds use the browser's
JavaScript engine and do not link the native QuickJS randomness implementation.

## Observed runtime flows

The packaged mixed builds were exercised through the actual UI, using only
synthetic migration messages. No external deployment was made.

| Surface | Observed behavior |
| --- | --- |
| macOS | Restored the existing Demo Mac identity, connected, and retained Send-first navigation and appearance |
| Browser | Restored the existing paired browser identity on `127.0.0.1:4173`; displayed the shared TSX views |
| macOS ↔ browser | Directed encrypted transfers arrived in already-open Inbox views in both directions without refresh |
| Clipboard/burn | Browser and macOS Copy & burn removed received test transfers; native Paste reproduced the exact copied text |
| Saved | A new snippet decrypted on the other open device; deleting that test snippet immediately removed it from the other view |
| Guest | Opening two copies revealed no text; explicit Reveal & burn succeeded once, and the second tab was rejected as consumed; the fragment key disappeared from the address bar |
| Pairing | An isolated localhost browser exercised start/cancel, full 64-hex-character fingerprint comparison on both screens, confirmation, connection, and saved-snippet decryption |
| New identity restart | Reloading that paired browser restored its identity and decrypted the existing saved snippet without pairing again |
| iOS 27.2 | Restored the existing Demo iPhone identity after mixed-build installation, connected, received/burned a live transfer, sent a transfer back to macOS, and decrypted the existing saved snippet; appearance checked |
| Android API 35 | Custom Gradle APK cold launch returned `Status: ok`; the app process remained running, crash buffer was empty, and process warnings contained no NSH or application errors |

The isolated pairing device was revoked after validation. Its temporary static
server was stopped, and the generated transfer/saved test snippets were burned.
The existing demo saved snippet and remembered device identities were preserved.

Migration captures: [macOS](media/powerbin-tsx-macos.png) and
[browser](media/powerbin-tsx-browser.jpg).

Android startup was checked through developer launch/process/log commands.
Only emulator graphics and optional dex-metadata warnings appeared. Android UI
flows and Linux mixed-build runtime have not been visually exercised in this
migration.
