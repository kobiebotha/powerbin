# PowerBin app

One Native Shell TSX app supplies the views on desktop, mobile, and the web.
`nsh.json` retains `"rust": "."` and discovers [App.tsx](App.tsx) as the entry;
there is no Rust root component. Native TSX runs through QuickJS and renders
Native Shell components. The browser uses its JavaScript engine and compiles
the Rust core to WebAssembly. The browser's small TypeScript adapter supplies
the PowerSync Web SDK and browser storage/clipboard operations.

The [Rust bridge](src/bridge.rs) exports the display state and commands through
`powerbin/native`; NSH generates TypeScript declarations under
`.nsh/types/powerbin/native.d.ts`. Its change subscription pushes updates into TSX
signals without polling. The controller owns the session, encryption, and
PowerSync connection; private keys and device tokens are not view state.

Follow the [repository setup](../README.md) for the local backend and services.
From the repository root:

```sh
nsh package app --target macos --out .nsh/out/macos --run
```

For development on the current desktop backend:

```sh
nsh run app
nsh check app
nsh test app/bridge.test.tsx
nsh build app
```

The build reads the public `API_ORIGIN` and `WEB_ORIGIN` values from the root
`.env`. Native device secrets use the OS credential store. Browser sessions
use origin-local IndexedDB. No secret-storage fallback writes them to plaintext
files.

The app ID, native credential-store service, and local database names use
PowerBin. Builds using the previous identifiers keep separate app data and
credentials; pair devices again when switching to this build. Existing encrypted
snippets require the original device keys and are not migrated automatically.
Keep an already paired client available to approve the new device identities;
an initialized backend cannot bootstrap another first device.

## Read the integration

| Entry point | What to look for |
| --- | --- |
| [src/db_native.rs](src/db_native.rs) | `connect`, schema, watched queries, backend connector, upload transaction completion |
| [web/src/adapter.ts](web/src/adapter.ts) | The same flow through `@powersync/web`, including worker assets |
| [src/db_web.rs](src/db_web.rs) | Small Rust/WASM bridge to the Web SDK adapter |
| [src/schema.rs](src/schema.rs) | Native local SQLite schema |
| [src/controller.rs](src/controller.rs) | Shared application actions, with encryption before local insertion |
| [App.tsx](App.tsx), [ui/](ui/) | Shared Native Shell TSX screens and components |
| [src/bridge.rs](src/bridge.rs) | Typed display snapshots, change subscription, and commands into Rust |
| [src/storage_native.rs](src/storage_native.rs), [web/src/vault.ts](web/src/vault.ts) | Device-local session/key persistence |
| [../crypto/](../crypto/) | Isolated cryptography and its tests |

PowerSync owns local persistence, the upload queue, and replication into watched
queries. The controller uses those operations directly. Pairing approval and
one-use guest reveals use explicit backend endpoints; a guest reveal does not
open the browser's synced database.

Browser sync uses PowerSync's WebSocket transport. This avoids the streaming
`fetch()` path where [WebKit can withhold an update until another chunk arrives](https://bugs.webkit.org/show_bug.cgi?id=322545).
On a quiet HTTP sync stream, the next chunk can be the service's 18–22 second
heartbeat. The local watched snapshot still reads items and devices atomically.

## Browser build

The mixed runtime links native dependencies such as zstd into WebAssembly.
In addition to the Rust WASM target and matching `wasm-bindgen-cli`, install
LLVM with a WebAssembly-capable `clang` and `llvm-ar`. Set target-specific
compiler variables if these tools are not on PATH. On macOS, the existing
project-local Android NDK includes both tools:

```sh
export PATH="$PWD/.tools/nsh/bin:$PWD/.tools/cargo/bin:$PWD/.tools/wasm-bindgen:$PATH"
export CARGO_HOME="$PWD/.tools/cargo"
export RUSTUP_HOME="$PWD/.tools/rustup"
llvm_bin="$PWD/.tools/android-sdk/ndk/27.2.12479018/toolchains/llvm/prebuilt/darwin-x86_64/bin"
export CC_wasm32_unknown_unknown="$llvm_bin/clang"
export AR_wasm32_unknown_unknown="$llvm_bin/llvm-ar"
```

Run this from the repository root; another LLVM installation can supply the
same two tools. These variables affect only the WebAssembly C/C++ build.

```sh
pnpm --dir app/web run check
pnpm run web:build
```

The script builds the adapter first because wasm-bindgen imports its output,
then packages the TSX views with the Rust/WASM core and copies all adapter/worker/SQLite assets into
`.nsh/out/PowerBin/web/dist`. Serve that site through `WEB_DIST` as described in
the root README.

Native Shell generates runners under `app/.nsh/rust/` and packages under the
repository's `.nsh/out/`; generated files are not app source. Use distinct
output folders for macOS and iOS so their `PowerBin.app` packages do not overwrite
one another:

```sh
sh app/ios/build-simulator.sh
```

The [iOS wrapper](ios/README.md) embeds simulator keychain entitlements in the
binary while preserving plain ad-hoc host signing. Use it instead of the raw
NSH simulator package command so protected keychain access works.

The NSH dependencies pin an official upstream revision in `Cargo.toml` to fix
the 0.4 published crate's relative-source packaging issue. Mixed TSX/Rust builds
use that revision's generated host and browser runtime. The browser uses its
own JavaScript engine and still needs [src/random_web.rs](src/random_web.rs) to
connect getrandom to the host's Web Crypto import; it does not link the native
QuickJS runtime's random shim.
Android uses the small [public embedding host](android/README.md) to initialize
the platform keyring and TLS verifier before loading the shared TSX bundle.

See the [migration validation](../docs/tsx-migration-validation.md) for current
checks and runtime evidence, and the root README for burn/privacy limits.
