# PowerBin TSX Migration Handoff

Prepared 9 November 2026 for a new Codex chat in this workspace:
`/Users/kobie/projects/powersync/skunkworks/native-shell-demo`.

The next task is to move PowerBin's views from Rust to Native Shell TSX while retaining the Rust application core and PowerSync integrations. The feasibility review is complete; implementation has not started. Use this handoff with the user's implementation instruction in the new chat.

**The product direction is settled.**

PowerBin is a visually attractive, clean Native Shell + PowerSync reference app, accompanied by a short social video, blog post, and runnable repository. It does not need to establish a novel product category. Preserve the existing scope rather than adding features to differentiate it from competitors.

- Deliberate text, URL, and code sharing; no files, images, or automatic clipboard capture.
- Send to one chosen remembered device, pair additional devices, save snippets across the user's devices, and create one-use guest links.
- Immediate incoming updates are the main visible sync benefit. Offline handling is supporting behavior, not the marketing headline.
- The app is named **PowerBin**.
- **Send** is the initial tab and first navigation item. Order: Send, Inbox, Saved, Devices.
- Keep the current appearance and remove no working flows. The old footer, “A little less friction. A little more flow.”, was intentionally removed.

**The intended architecture is TSX screens with a Rust core.**

Rewrite the views in `app/src/ui.rs` as a Native Shell TSX entry and small components. Keep the native PowerSync Rust SDK, encryption, pairing, backend protocol, and most controller logic in Rust. Preserve the existing PowerSync Web SDK adapter for the browser. Use NSH-generated TypeScript declarations for a typed Rust-to-TSX interface.

This is Native Shell TSX using `nsh` and `nsh/base`, with its signals and native rendering. It is not a React DOM application, webview replacement, or migration to a different UI framework. Native TSX runs through QuickJS; the browser uses its own JavaScript engine.

Views are currently about 825 lines of Rust builder code. The meaningful integration work is extracting a clean state/action boundary from the Rust controller. Do not assume its current Rust signals become TSX signals automatically.

**Start with these current files.**

Paths below are relative to the workspace root.

| File | Responsibility |
| --- | --- |
| `app/src/ui.rs` | Current views, styling, forms, tabs, guest screens, list rendering |
| `app/src/controller.rs` | `Controller`, Rust `Ui` signals, `Action`, pairing, sends, saves, guest reveals, SDK watches |
| `app/src/model.rs` | Item/device data and session/view structs |
| `app/src/lib.rs` | Registers only the Rust `App` component under `powerbin/native` |
| `app/nsh.json` | Currently `"rust": "."`, `"root": "App"`, display name PowerBin |
| `app/src/main.rs` | Direct desktop Rust-root runner; must be reconciled with the new TSX entry |
| `app/src/db_native.rs`, `app/src/schema.rs` | Native PowerSync Rust SDK data layer and schema |
| `app/src/db_web.rs` | Rust/WASM bridge to browser PowerSync adapter |
| `app/web/src/adapter.ts` | PowerSync Web SDK, watches, writes, uploads, workers |
| `app/web/src/vault.ts`, `app/src/platform.rs`, `app/src/storage_native.rs` | Local session storage, clipboard, platform helpers |
| `crypto/src/lib.rs` | Existing shared cryptography |
| `server/src/server.js`, `server/src/domain.js` | Auth, write validation, pairing, atomic guest consumption |
| `powersync/sync-config.yaml` | Existing device-scoped Sync Streams |
| `scripts/copy-web-assets.mjs`, `package.json` | Browser packaging and adapter assets |
| `app/ios/`, `app/android/` | Platform build wrappers and Android host initialization |

`Controller::open` starts the SDK and connects watched items/devices/status to Rust UI signals. `Controller::dispatch` owns asynchronous actions so changing tabs cannot cancel a send or pairing task. Preserve that lifecycle property.

**Mixed TSX and Rust support was verified at our exact NSH revision.**

`app/Cargo.toml` pins NSH to `e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3`. A complete local upstream checkout at `.tools/nsh-source` has that exact HEAD. Read its examples before consulting newer upstream APIs. No NSH upgrade is required by the feasibility findings.

Useful local references:

- `.tools/nsh-source/crates/nsh-cli/src/templates/mixed/App.tsx`
- `.tools/nsh-source/crates/nsh-cli/src/templates/mixed/lib.rs`
- `.tools/nsh-source/crates/nsh-cli/src/templates/mixed/README.md`
- `.tools/nsh-source/examples/rust-exports/App.tsx`
- `.tools/nsh-source/examples/rust-exports/native/src/lib.rs`
- `.tools/nsh-source/examples/rust-exports/native/src/account.rs`
- `.tools/nsh-source/examples/rust-exports/native/src/ledger.rs`
- `.tools/nsh-source/crates/nsh-engine/tests/engine/host_modules.rs`
- `.tools/nsh-source/crates/nsh-platform-web/src/browser/modules.rs`
- `.tools/nsh-source/crates/nsh-platform-web/src/browser/bindings.rs`

The examples demonstrate `#[native_module]`, registered `#[module]` functions and `#[class]` classes, generated declarations, async Rust methods returning TS promises, and typed callbacks from Rust into TSX. `Account::on_change` uses `Callback` and `listener.post(...)`; TSX updates its signals in the listener. The engine's host-module test demonstrates `on(event, Callback, CallCx) -> Stop`, a core task started with `cx.start`, immediate initial state, later updates, and subscription disposal. Equivalent class/module/callback support exists in the browser runtime.

Public references: [mixed Rust and TSX guide](https://nsh.dev/docs/rust/#extending-a-rust-app-with-tsx), [pinned exports example](https://github.com/longbridge/nsh/tree/e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3/examples/rust-exports), [pinned host subscription test](https://github.com/longbridge/nsh/blob/e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3/crates/nsh-engine/tests/engine/host_modules.rs).

**The Rust controller needs a deliberate bridge.**

The current controller uses `Signal`, `Owner`, `spawn`, `Rc<RefCell<...>>`, and component-owned cleanup. It is not directly exportable unchanged. Plain synchronous Rust class/module methods run inside the JavaScript call, outside the core reactive context. Route signal creation/access, tasks, and controller actions through the appropriate NSH core context, async entry point, or `CallCx` machinery. Follow the pinned examples rather than inventing a cross-thread callback mechanism.

Expose UI-ready state and actions through a small facade. An initial snapshot plus change subscription is a reasonable approach, but the precise API is an implementation choice. Preserve automatic incoming updates; do not add polling between TSX and Rust. Include unsubscribe/cleanup behavior and prevent duplicate controllers or sync connections after remounts/hot updates.

Do not export the complete `Session` object as view state: it contains private keys, device tokens, and the group key. TSX needs display state and commands, not these secrets. Avoid maintaining independently mutable copies of the same authoritative state in both languages. Draft inputs can remain in TSX and be passed to commands if that simplifies the controller.

**Preserve existing semantics.**

- The codebase now uses `dev.powersync.powerbin`, the `powerbin/native` module, PowerBin keychain/storage namespaces, database naming, and Android package paths. This identifier rename supersedes the migration's original compatibility choices: existing app data and keys are not automatically migrated, and devices need to pair again.
- Pairing uses a short rendezvous code and Noise XX, with comparison of the entire fingerprint on both devices. Preserve confirmation and cancellation.
- Directed transfers are recipient-encrypted; saved snippets use the shared group key. Transfers expire after one hour; guest links expire after 48 hours.
- Copy & burn hides a received transfer locally and queues its server burn. Upload clears the server payload and syncs a tombstone. The app does not promise forensic erasure or retraction of clipboard/offline copies.
- Opening a guest link does not consume it. Explicit Reveal & burn atomically claims and clears its ciphertext on the server. An ambiguous network failure can lose that secret. Guest mode opens no PowerSync database.
- The cryptographic protocol is an unaudited demo. Keep its existing documented boundaries; this migration is not a crypto redesign.
- Keep SDK transaction completion, permanent upload rejection handling, credential refresh, and single-session connection ownership intact.

**Packaging has two important platform details.**

The mixed template keeps the Rust crate in `nsh.json` and uses a TSX entry instead of the configured Rust root. Check the pinned CLI's entry discovery and update commands/docs accordingly. Audit the direct Rust `app/src/main.rs` runner rather than leaving a reference to a deleted `App` type.

The current Android Activity calls `initializeKeyring(...)` before `view.runRustApp("nsh")`. It will need the correct mixed/TSX loading path while retaining keyring, files-directory, and TLS initialization. See `app/android/README.md`, `build.sh`, `keyring.rs`, and `src/main/java/dev/powersync/powerbin/MainActivity.java`. The custom Gradle APK is the intended final artifact; the stock NSH APK is an intermediate.

iOS uses `app/ios/build-simulator.sh` to embed simulator keychain entitlement sections, then apply plain ad-hoc signing. Preserve that behavior and keep iOS and macOS output folders separate. Browser packaging must still copy the PowerSync adapter output, workers, and SQLite WASM assets into the packaged site. Rust-only browser compatibility code may change when introducing the JS runtime; remove it only after verifying the mixed build.

**Use the existing local tools and stack.**

Project-local tools are under `.tools/`: `nsh/bin`, `cargo`, `rustup`, `jdk17`, `android-sdk`, `gradle-8.11.1`, and `gradle-home`. The iOS/Android build scripts already configure their toolchain paths. For direct NSH/Cargo commands, the equivalent environment is:

```sh
export PATH="$PWD/.tools/nsh/bin:$PWD/.tools/cargo/bin:$PATH"
export CARGO_HOME="$PWD/.tools/cargo"
export RUSTUP_HOME="$PWD/.tools/rustup"
```

See the current README before starting services. The local stack is API/static web on 18088, PowerSync on 18080, source Postgres on 15432, and PowerSync storage Postgres on 15433. The four-service Railway setup exists but has not been published or deployed externally. Preserve `.env`; do not print or copy credentials into the handoff, code, or logs.

Previous approvals covered installation/testing of Android JDK/SDK/NDK and its licenses, and Xcode's iOS simulator components. These are already installed. New work should normally reuse them.

**Suggested implementation sequence and completion criteria.**

1. Inspect the current app and pinned mixed examples. Establish one typed Rust-to-TSX state/action subscription before translating every screen. Verify a Rust-side change reaches rendered TSX on desktop and web, with cleanup.
2. Translate the existing screens and reusable styles into small TSX components. Preserve PowerBin branding, Send-first navigation, form behavior, errors/loading, pairing, transfers, saved snippets, and guest links.
3. Update entry points and platform packaging. Keep one set of TSX views across native and web. Avoid duplicating the Rust application logic in TypeScript.
4. Exercise actual PowerSync-driven receive and burn updates without refresh, not just a synthetic counter. Verify pairing, both transfer directions, clipboard/copy-and-burn, saved snippets, guest reveal exactly once, and restoration of paired identity after restart.
5. Run appropriate checks below and platform packaging. Inspect the UI on desktop and web; recheck iOS and Android. Add focused bridge/lifecycle verification where meaningful. Do not claim runtime verification from compilation alone.
6. Update README, app/platform instructions, and affected blog draft claims to describe TSX views with the Rust core. Re-measure source size if quoting it; no line-count reduction has been established for the rewrite.

Existing checks/entry commands, to adapt when the TSX entry changes:

```sh
pnpm test
pnpm run test:integration
cargo test --manifest-path crypto/Cargo.toml
cargo run --manifest-path app/Cargo.toml --example sync_smoke
pnpm --dir app/web run check
pnpm run web:build
nsh check app
nsh build app
nsh package app --target macos --out .nsh/out/macos --run
sh app/ios/build-simulator.sh
sh app/android/build.sh
```

Database/integration/smoke checks require the local backend stack. Browser adapter checks are separate from NSH checking/building the TSX; both matter.

Before migration, macOS and browser flows and iOS simulator pairing/transfers/burn/saved/key restoration were exercised. Android was built, installed, and launched, but its UI flows were not verified. Linux compilation passed; runtime was not checked. Treat these as the old implementation's baseline, not evidence for the new TSX version. Existing screenshots/video are under `docs/media/powerbin-*`; the 28-second social draft uses edited real captures and is not a latency benchmark.

**Workspace and user rules.**

The implementation is largely untracked: the last status showed modified `README.md` and untracked app, crypto, server, docs, PowerSync, Railway, scripts, and workspace files. Preserve all existing work. No commit or push was made for the feasibility review or this handoff. Do not clean/reset the workspace or treat untracked files as disposable. `.pnpm-store/` also appeared untracked; avoid accidentally staging dependencies.

- Never `git push`; the user will do it.
- Never blanket-stage with `git add .` or `git add -A`; specify files.
- Use distinct local branches if a plan calls for separate PRs.
- Never deploy to the PowerSync Vercel organization without explicit approval.
- Prefer pnpm.
- Kobie's timezone is America/Denver; 22:00–05:00 are quiet hours. Continue useful work, but do not request inputs during those hours.
- This is a UI migration. Do not change PowerSync/backend infrastructure or deploy externally as an incidental step. Load the PowerSync skill before data/schema/sync changes; the established target is the existing local self-hosted Postgres/API stack.

**Research is background, not remaining work.**

Competitor research established that automatic delivery already exists in several clipboard apps. The user accepted that a polished Native Shell + PowerSync demo is sufficient. Do not reopen product differentiation, add attachments, or port another clipboard project. The next work is the TSX migration and its validation.
