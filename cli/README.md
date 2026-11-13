# PowerBin CLI

Reveal and burn a PowerBin one-time text message from your terminal. Requires
Node.js 22.12 or later. No account, pairing, global installation, or Rust toolchain
is needed to reveal a link.

```sh
pnpx powerbin reveal 'https://your-powerbin.example/?link=<id>#<key>'
```

Paste the **complete original link**, including the key after `#`, and quote it.
The CLI claims the ciphertext once, then decrypts it locally using the same Rust
cryptography as the PowerBin native and browser apps. The key and plaintext are
never sent to the server.

## Output and scripting

In a terminal, PowerBin prints a short heading followed by the message. When stdout is
piped or redirected, it contains the exact UTF-8 message bytes, including the
original newlines. Terminal headings and errors go to stderr.

```sh
pnpx powerbin reveal '<complete link>' > message.txt
pnpx powerbin reveal '<complete link>' --raw
pnpx powerbin --help
pnpx powerbin --version
```

`--raw` writes exact bytes even in a terminal and suppresses the heading.
Normal terminal output escapes control characters from the message. Raw output
is intended for scripts and trusted text.

Use `--stdin` to supply a link through standard input instead of including it in
the command line or shell history:

```sh
pnpx powerbin reveal --stdin
```

Paste one complete link and end the input with EOF, or pipe the link from another
program. PowerBin does not persist links or messages. Your terminal, clipboard,
shell, or redirected files may retain them.

Exit codes: `0` for success, `1` for a reveal/decryption/output failure, and `2`
for invalid arguments or a malformed link.

## One-time behavior

Running `reveal` checks compatibility without consuming the link, then claims it
once. There is no confirmation prompt. Version 0.1.1 and later require the server
to report `protocol_version: 2` in its availability response. Older servers and
legacy v1 links are rejected before the consuming request. Update the PowerBin
server and browser app together, reload the browser, and create a fresh link.

Missing or malformed keys are rejected before contacting the server. A validly
encoded but incorrect key can still consume the message before decryption fails.

The CLI never retries or follows redirects for the consuming request. If the
response is lost after the server claims the message, it cannot be recovered.
If saving or printing the plaintext fails after a successful reveal, the link
has already burned. Do not configure automatic retries around this command.

Opening a link in the browser or fetching the readable `curl '<link>'` view only
checks availability. Browser recipients must select **Reveal & burn** to consume
it. Curl itself cannot decrypt because the URL fragment is not sent to the server.

Links must use HTTPS. Plain HTTP is accepted only for loopback development
servers (`localhost`, `127.0.0.1`, and `[::1]`).

PowerBin is an unaudited demo. A guest link does not authenticate a named sender,
and burning cannot retract copies already saved or displayed.

## Development

The CLI uses TypeScript for the command and a small WASM wrapper around the
repository's shared `crypto` crate. The published package bundles compiled WASM
and has no runtime npm dependencies or installation scripts.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm run cli:build
pnpm run cli:test
```

Building requires Rust with the `wasm32-unknown-unknown` target and
`wasm-bindgen-cli` exactly 0.2.129. The build also recognizes this repository's
existing `.tools/cargo`, `.tools/rustup`, and `.tools/wasm-bindgen` installations.
The tests decrypt a fixture produced by the native Rust implementation and check
the real CLI against local HTTP servers.

Before releasing, build, run the tests, pack `cli`, and verify the tarball through
an isolated installation. Publish that verified tarball using the npm account
that owns the package. The `files` allowlist includes only runtime output,
documentation, and license notices.

## License

CC0-1.0. Third-party Rust dependency licenses are included with the package.
