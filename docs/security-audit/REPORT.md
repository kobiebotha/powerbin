# PowerBin security audit: run 1

> Local remediation is tracked in section 8 below. The original audit evidence
> and deployment checks are preserved as the historical record of this run.

## 1. Run profile and scope

| | |
|---|---|
| Target | `powersync-native-shell-demo` (PowerBin), whole repository |
| Source ref | Commit `653d3a5` on branch `init`, plus three files that were untracked at the start (`compose.yaml`, `docs/docker.md`, `scripts/setup-docker.mjs`) |
| Profile | Standard, trimmed by the owner after hunter wave 1. **This is a partial pass.** |
| Execution | Source review plus bounded local checks only, inside an offline container (no network, read-only source, secrets masked). No deployed endpoint, registry, or external service was contacted. |
| Prior runs | None. Nothing was carried or excluded. |
| Agents | 25 launched, 24 completed: 4 reconnaissance, 12 hunters (one interrupted and re-run), 2 coverage critics, 6 verifiers. No budget was set at the start; the owner capped the remainder at 10 agents and 8 were used. |

**HEAD moved during the run**, from `653d3a5` to `79e9412` (two commits). The diff is documentation plus the three previously untracked files. No file under `server/`, `crypto/`, `app/`, `cli/` or `powersync/` changed. The final critic compared the committed files with what was reviewed and found no change that affects a conclusion.

**What the trimmed profile left out:**

- The separate "final-clean" coverage critic did not run. One critic ran after wave 1 (it found three gaps, all then hunted) and one ran after wave 2 (it found none). I make no clean-coverage claim.
- Each candidate got one independent verifier that did both candidate validation and the final record check, instead of two separate reviewers.
- The last hunter and all verifiers ran on a smaller model than the first wave.

**What could not be checked at all:**

- **Dependency advisories.** There is no advisory database offline. Run `pnpm audit --prod` and `cargo audit` against each lockfile.
- **Anything needing a live stack.** No PostgreSQL, PowerSync service, or browser was available. Server routes were exercised in-process against a fake database, so SQL locking and constraint behaviour were emulated, not observed.
- **The `app/` crate as a whole.** It does not build offline. Client logic was checked by compiling verbatim extracts of `app/src` against the real `crypto/` crate.
- **Deployment facts:** TLS termination, proxy behaviour, Railway networking, real database grants, and what the `:latest` images contain.

## 2. Security posture

The end-to-end encryption held up. In the test harness, upload bodies for transfers, saved snippets, and guest links contained no plaintext, keys, or tokens; the guest secret only ever appears after the `#`. The database and sync engine see metadata and opaque ciphertext, which is what the README says.

The cryptography and the pairing protocol were the most heavily tested areas and produced no findings. The server API's authentication and authorization also held.

Two low-severity issues were confirmed, and three leads need a check that only you can do. The most important design point is that **unpairing a device is not a cryptographic event**: it relies on a server-controlled column, and the group key is never rotated.

## 3. Confirmed findings

| Severity | Finding | Boundary | Observed result |
|---|---|---|---|
| Low | Unpairing is enforced only by a server-controlled column | Malicious server, database, or sync engine → trusted-device set | With `revoked_at` cleared on an unpaired device's row, clients trusted it again, encrypted a broadcast to it, and accepted a transfer it signed. |
| Low | Rate limiter keys on the TCP peer address | Anonymous caller → other users' access to pairing, bootstrap, and link reveal | Behind a proxy, 30 empty requests from one client made a different client get 429 on all three routes. |

No medium, high, or critical finding was confirmed.

## 4. Finding details

### 4.1 Unpairing is enforced only by a server-controlled column (low)

**Where:** `app/src/controller.rs:1062` (`verified_devices`), `crypto/src/lib.rs:504` (`admission_mac`), `server/src/server.js:322`.

**Who can do it:** whoever controls the device rows that clients receive (the server operator, anyone who can write to Postgres, or the PowerSync service and its storage) and who also holds the root seed of a device you unpaired.

**What happens:** a client trusts a device row when its admission tag verifies under the group key and `revoked_at` is empty. The tag covers only id, name, and public key. The group key is never rotated. The only client-side memory of an unpair is an in-memory set on the device that did it, which is lost on restart. So serving the old row with `revoked_at` empty puts the device back in the trusted set.

**Reproduction (sandbox, dummy keys):** a Rust test compiled verbatim extracts of `verified_devices`, the recipient filter of `prepare_transfers`, and the transfer branch of `plaintext` against the real crypto crate.

- Honest rows: trusted `[A, C]`, broadcast goes to `[C]`, a transfer from B is refused with "Sender is not trusted".
- Same rows with B's `revoked_at` set back to null: trusted `[A, B, C]`, broadcast goes to `[B, C]`, B's root seed decrypts it, and B's transfer is accepted.
- A brand-new identity whose admission tag was made with only the group key is also trusted.

**Conditions:** needs both server-side control and the removed device's keys. The device visibly reappears in the Devices list. The server side alone gains no plaintext.

**Impact:** text sent after the unpair is encrypted to the removed device, and its messages are accepted again. That is the case unpairing exists for, such as a lost phone.

**Why low:** the preconditions are demanding, and `docs/post-quantum.md:77` already lists revocation among the limits the protocol does not address. The README and the "Unpaired" status message do not tell users this.

**Smallest fix:**

1. Make unpairing rotate the group key: the acting device generates a new key, seals it to every remaining verified device, and re-issues admissions with an epoch bound into the MAC.
2. Until then, persist unpaired device ids and public keys in the local session record, reject them in `verified_devices`, and state the limit in the README and on the unpair confirmation.

Regression test: a row for an unpaired device with `revoked_at` empty and its old admission must not appear in `verified_devices` or among `prepare_transfers` recipients.

### 4.2 Rate limiter keys on the TCP peer address (low)

**Where:** `server/src/server.js:138-148` (`rateLimit`), called at lines 186, 201, and 354.

**Who can do it:** any anonymous network caller who knows the deployment URL.

**What happens:** the limiter counts requests per `request.socket.remoteAddress` in one map shared by bootstrap, pairing creation, and link reveal, and it counts before reading the body or checking any credential. Behind a reverse proxy, which `docs/docker.md:64` recommends, every client arrives from the proxy's address and shares one budget of 30 requests a minute.

**Reproduction (sandbox, loopback):** the unmodified server ran in-process behind a minimal forwarding proxy.

- Client `127.0.0.1` sent 30 empty `POST /api/pairings` requests; each returned 400.
- Client `127.0.0.2` then got 429 on link reveal (0 database queries, link not burned), on a valid pairing request, and on bootstrap with the correct token.
- Control without the proxy: the second client's reveal returned 200.

**Conditions:** the server sits behind a proxy or load balancer. The attacker must keep sending about one request every two seconds; the lockout ends within a minute of stopping.

**Impact:** new devices cannot pair, guests cannot reveal links, and a fresh install cannot be bootstrapped while it continues. No data is disclosed, links are not consumed, and paired devices keep syncing.

**Smallest fix:** add a trusted-proxy setting (off by default), key the limiter on the client address it yields, and give each route its own bucket. The verifier tested this fix. It is safe only if the server is reachable solely through the proxy and the proxy appends the real peer address; with the setting on and the backend reached directly, a rotating `X-Forwarded-For` evaded the limiter. Suggested code is in `findings.json`.

## 5. Needs validation

These are source-grounded leads, not confirmed vulnerabilities, and carry no severity. Full traces and plans are in `NEEDS-VALIDATION.md`.

| Lead | Where | Why it is blocked | Check you can do |
|---|---|---|---|
| App accepts a plain `http://` server address for any host, then sends the setup token and device token over it | `app/src/controller.rs:483`; the CLI allows `http` only for loopback (`cli/src/client.ts:32`) | The app crate does not build offline, so it was not executed. Exposure also depends on someone entering a remote `http://` URL. | Confirm every paired device's server URL is `https` or loopback. Once the crate builds, a unit test calling `new_session()` with `http://192.0.2.1` settles it. |
| Burned ciphertext stays in PowerSync bucket storage because nothing runs compaction | `server/src/server.js:114,122,362`; `powersync/sync-config.yaml:11-13`; `railway/powersync.Dockerfile:5` | Read from PowerSync 1.26.0 source only: with Postgres storage, a superseded row keeps its payload until the separate `compact` command runs. The repo deploys `:latest` and no live stack could be run. | Check which version your container runs and whether a compact job is scheduled. For one burned item id, look in the sync storage database for a `bucket_data` PUT row whose `data` is not null. |
| Web app can be framed, and unpair and delete are click-only | `server/src/server.js:151-153`; `app/ui/pairing.tsx:126` | Current browsers give a cross-site frame empty storage, so it only works from an attacker-controlled sibling subdomain or an old browser. No browser was available. | Check the app origin's response headers for `frame-ancestors` or `X-Frame-Options`, and whether any host you do not control shares its registrable domain. |

One candidate was rejected: `cli/package.json:powerbin-npm-release-unbound-to-source`. The verifier found no lower-trust party who can change what `pnpx powerbin` resolves to, so it is recorded as hardening below.

## 6. Hardening notes and positive patterns

These are not findings. They are grouped by area, most useful first.

**Protocol and crypto**

- Bind the candidate's device id and name into the Noise handshake. The approver currently seals the grant and computes the admission tag for an id and name supplied by the server (`app/src/controller.rs:626-627, 700-708`).
- Add a counter or epoch to the admission MAC. Old (name, tag) pairs stay valid, so the server can roll a device's name back.
- `burned_at`, `expires_at`, `created_at`, and a saved item's `sender_id` are not authenticated. A server that kept the ciphertext could re-serve a burned or expired transfer to the same recipient. Keep a local consumed-id set and bind expiry into the sealed context.
- All saved items share one long-lived ChaCha20-Poly1305 key with random 96-bit nonces. Derive a per-item key or use XChaCha20-Poly1305.
- Ciphertext length is plaintext length plus a constant, so the server learns exact snippet lengths. Pad to size buckets if that matters to you.
- Return `Zeroizing` buffers from `open_directed`, `open_saved`, and `open_guest`; the group key currently passes through a plain `Vec<u8>`.
- Use hedged ML-DSA signing instead of the deterministic variant.
- Pairing UI: cap and quote the server-relayed device name in the trust prompt, expire a pending pairing locally after five minutes, and clear it when a new attempt starts.

**Server**

- Re-check the caller's device row inside the write transaction for approve, rename, and revoke (`server/src/server.js:268, 305, 321`).
- Refuse to revoke the last active device. Today it can revoke itself, and bootstrap stays closed, so only direct database access recovers the install.
- Revoking a device does not burn the guest links it created.
- A guest link's UUID travels in the query string, so it reaches proxy logs. Anyone who sees it can burn the link, though not decrypt it.
- Cap pending `pairing_sessions` and delete expired ones promptly. They are uncapped and kept about 24 hours.
- Give `pg.Pool` an `error` listener and timeouts. An idle-client error after a database restart currently terminates the process.
- `web.js` tests the reserved `/api` and `/health` prefixes before normalizing the path, and serves dotfiles and `.map` files if they exist in the web root.
- Limit the publication and the `powerbin_sync` grant to the six device columns the stream needs. Today the sync engine also receives `token_hash` and `shared_key_envelope`.
- Reject NUL characters and far out-of-range dates in `itemInput`; they would return 500 and leave the device's upload queue retrying.
- There is no device-token rotation route; a leaked token means revoke and re-pair.

**Clients**

- Generate a fresh first-device identity when the server URL changes. A token already sent to a mistyped address is otherwise enrolled at the corrected one (`app/src/controller.rs:505-527`).
- Validate and lowercase the guest link id in the web app as the CLI does. A case-altered link is burned and then fails to decrypt.
- Refuse an `http` or `ws` sync endpoint when the API origin is `https`.
- The guest secret is removed from the address bar only after navigation, so browser history may keep the full link until it is revealed.
- Create the desktop data directory with mode 0700.
- The browser session is stored as plaintext JSON in IndexedDB. Wrapping it with a non-extractable WebCrypto key would limit what a script injection could export.
- Add `script-src 'self'` to the web shell's CSP and a `frame-ancestors` response header.
- The Android build is debug-signed with a fixed keystore password. Add a release signing path before distributing.

**Deployment and supply chain**

- Pin `journeyapps/powersync-service` by version or digest. It is `:latest` today, and the JWT, sync-rule, admin-route, and compaction behaviour in this audit was observed only on 1.26.0.
- Print an exact version in the guest instruction (`pnpx powerbin@x.y.z`), publish the CLI from a tagged CI job with provenance, clean `cli/dist` before packing, and add the CLI build and tests to CI.
- The Dockerfile pipes the pnpm installer to `sh` with no checksum, and base images are tags, not digests.
- The dev stack publishes Postgres, storage, and PowerSync ports on all interfaces, and the source-run server defaults to `0.0.0.0`. Bind them to loopback.
- The dev stack hands the PowerSync container the superuser and app-role passwords through `env_file`.
- `scripts/setup-env.mjs` does not reset the mode of an existing `powersync/docker/.env`; that file is currently mode 644 in this checkout.
- Keep the Railway API token out of the root `.env`, which package scripts load wholesale.
- Add `signing-key.json`, `*.pem`, and `*.key` to `.gitignore`.
- Run the Postgres integration suite in CI and add a concurrent double-bootstrap case. Single-use bootstrap depends on Postgres locking that this audit could only emulate.

**Positive patterns**

- Context strings are length-prefixed and domain-separated; key derivation uses separate labels per purpose.
- `open_directed` verifies a signature bound to purpose, item id, sender, and recipient before returning plaintext; there is no fallback path.
- The Noise handshake hash covers the full post-quantum key bundles, and the app displays all 32 bytes.
- Every SQL value is a bound parameter; the error handler returns generic messages and logs only error codes.
- The Origin allow-list is exact-match and there are no cookies, so there is no ambient credential to abuse.
- `.dockerignore` is an allow-list that ends with unconditional secret excludes; GitHub Actions are pinned to commit SHAs; the publish job is master-only and holds the only write token.
- No secret was found in the tree or in git history.
- The CLI refuses redirects, caps responses, never sends the key, and escapes terminal control characters.
- Browser randomness comes from Web Crypto and fails closed.

## 7. Coverage

| Status | Units |
|---|---|
| Covered, no candidate | 26 |
| Candidate, decided | 6 (2 confirmed, 3 needs validation, 1 rejected) |
| Blocked | 1 (dependency advisories) |
| Deferred or out of scope | 0 |
| **Total** | **33** |

The first critic accepted three missing units and no reassignments; all three were hunted. The second critic accepted nothing. A separate final-clean critic did not run, so this coverage is partial.

Ledger and findings both pass the skill's validators. Machine-readable records are in `findings.json` and `coverage-ledger.json`; sandbox logs are under `agents/*/artifacts/`.

## 8. Local remediation — 13 November 2026

These changes apply to the source checkout. They have not been published or
deployed, and do not establish that any existing installation was exposed.
The separate hardening notes in section 6 remain a backlog.

| Finding | Source change | Remaining limit |
| --- | --- | --- |
| App sends credentials to a remote HTTP origin | Shared native/browser transport validation rejects non-loopback HTTP before creating requests. New and restored sessions, API actions, and sync connectors validate destinations. API requests refuse redirects. An HTTPS API requires an HTTPS sync endpoint, including credential refresh responses. | Existing remote-HTTP sessions must be corrected to the same server's HTTPS origin; the setup recovery flow preserves their identity, keys, token, and denylist without contacting the old URL. Localhost HTTP remains available for development. |
| Rate limiter shares a proxy's TCP address and a budget across routes | Explicit `TRUST_PROXY_HEADER` selects `x-real-ip` or the rightmost `x-forwarded-for` address; the default ignores forwarded headers. Pairing, bootstrap, and reveal have separate per-client budgets and return `Retry-After`. Invalid and scoped forwarded IPs fall back to the TCP peer; equivalent IPv6 spellings share a budget. | Existing Railway installations need `TRUST_PROXY_HEADER=x-real-ip` when adopting the new server. Only a proxy that overwrites the selected header and `X-Forwarded-Proto` may reach the public backend port. Limits remain process-local. |
| App can be framed | All server responses include `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`. | Deploy the updated server so these headers reach the browser. |
| Removed device rows can be replayed after restart | The acting device persists blocked device IDs and public keys before sending DELETE; restored trust, transfer recipients, and incoming sender checks reject them. Network failures cannot undo the block. | **Known-identity replay is mitigated, not full cryptographic revocation.** Other devices still rely on server revocation. A removed group-key holder working with a malicious server can forge an admission for a fresh identity even on the acting device, and retains shared-key access to saved ciphertext. Full closure needs key rotation and authenticated, rollback-resistant membership updates. |
| Burned ciphertext persists in sync history without compaction | The PowerSync image is pinned to 1.26.0 and supervises startup plus hourly compaction with no overlap, bounded job duration, retries, and clean shutdown. The Railway template inherits the image entrypoint; local Compose builds the same image. CI checks the schedule and actual storage cleanup. | Compaction runs after replication and can be delayed by failed jobs. It does not erase offline copies, database journals, or backups. This PostgreSQL bucket storage uses v2; self-hosted v4 requires MongoDB storage. |

Validation completed:

- `pnpm test`: 40 server, 12 browser-adapter, and 9 scheduler tests pass.
- The real Postgres integration suite passes 12 tests, including an HTTP reveal
  that leaves ciphertext and burn state unchanged before a successful HTTPS reveal.
- The native app passes 25 unit tests. Dummy listeners observe no forbidden HTTP
  request or redirect replay; persistence tests cover session correction and
  known-identity revocation replay after restart.
- Web type-check and production build, WebAssembly `cargo check`, and Rust
  formatting checks pass. The unpair UI also passed `nsh check app`.
- The updated Linux amd64 PowerSync image builds. A disposable two-database test
  reproduces superseded ciphertext retained without compaction, restarts the test
  service under the default image supervisor, and confirms automatic compaction
  clears that ciphertext while preserving current unburned ciphertext. Test
  containers, network, and temporary configuration are removed afterward.

No credential-bearing audit traffic was sent to a deployed service. Existing
installations need rebuilt clients, the new images, and the proxy setting above;
editing this checkout does not update remote Railway templates or deployments.
