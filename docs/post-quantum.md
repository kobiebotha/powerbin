# Post-quantum content encryption

Protocol version 2 adds hybrid post-quantum encryption and post-quantum sender
signatures to directed snippets and group-key grants. The same Rust crypto
crate runs natively and in WebAssembly. This is an unaudited demonstration
protocol, not a claim that the entire application or deployment is
post-quantum secure.

## Construction and trust

Each device retains one random 32-byte root secret. Domain-separated
derivation produces the keys for Noise X25519, X-Wing encryption, and
ML-DSA-65 signatures. A versioned public identity bundles all three public
keys: one version byte, 32 bytes of Noise key, 1,216 bytes of X-Wing key, and
1,952 bytes of ML-DSA-65 key.

Directed snippets and group-key grants use HPKE with X-Wing, HKDF-SHA256, and
ChaCha20Poly1305. X-Wing combines ML-KEM-768 with X25519 so that the key
establishment has both post-quantum and classical components. The sender
signs the plaintext and protocol context with ML-DSA-65, then encrypts the
signed content inside HPKE. The recipient decrypts and verifies against the
expected sender identity before returning plaintext. This is HPKE base mode
with an application signature; X-Wing does not support HPKE's authenticated
KEM mode. The context separates transfers from grants and binds the
appropriate item ID or recipient device ID. [HPKE, RFC 9180](https://www.rfc-editor.org/rfc/rfc9180),
[X-Wing specification](https://datatracker.ietf.org/doc/draft-connolly-cfrg-xwing-kem/)

The ML-KEM primitive is standardized in NIST FIPS 203, and ML-DSA in FIPS 204.
X-Wing and the post-quantum HPKE extensions remain Internet-Drafts. The
application's combination, key derivation, and library implementations have
not received an independent security audit in this project. Standardized
primitives do not make this application FIPS validated. [FIPS 203](https://csrc.nist.gov/pubs/fips/203/final),
[FIPS 204](https://csrc.nist.gov/pubs/fips/204/final),
[post-quantum HPKE draft](https://datatracker.ietf.org/doc/draft-ietf-hpke-pq/)

## Pairing and shared secrets

Pairing still uses classical Noise XX. Its second and third messages carry
the complete public identity bundles. The user compares the full 32-byte
handshake hash on both devices through a trusted out-of-band channel before
approving. The session ID binds the exchange; the short pairing code is a
public rendezvous identifier. The Noise transcript binds the public identity
bundles to the compared fingerprint. [Noise handshake hashing](https://noiseprotocol.org/noise.html#the-handshakestate-object)

No group key or snippet plaintext is sent in classical Noise. The existing
device sends the group key only after fingerprint confirmation, encrypted
with the candidate's X-Wing key and signed with its own ML-DSA-65 key. The
candidate verifies the grant against the approver identity from the compared
transcript. Skipping fingerprint comparison removes this identity check.

The group key is random and 256 bits. Saved snippets use ChaCha20Poly1305
with domain-separated subkeys, random nonces, and authenticated item IDs.
Directory admission uses HMAC-SHA256 over the exact device ID, name, and full
public identity. All group members can issue admission proofs. Guest links
use independent random 256-bit symmetric keys in URL fragments and
ChaCha20Poly1305; they provide no named-sender authentication.

## Protocol version

Public identities and encrypted envelopes use version 2 and are incompatible
with version 1 demo data. Persisted sessions use the existing `session`
record with `crypto_version: 2`; stale development sessions produce a clear
error. There is no fallback to version 1 content encryption.

## Scope and remaining boundaries

The protocol change covers content confidentiality and sender verification
for version 2 directed messages and grants, plus symmetric protection for
saved snippets and guest links. It does not replace server JWT signatures:
those remain Ed25519. It does not replace HTTPS certificate authentication
or require a particular TLS key exchange. TLS may independently negotiate
hybrid post-quantum key exchange, but a dependency's support does not prove
what a deployed connection negotiated.

Device compromise, malicious code running in the browser origin, disclosure
of the root secret or group key, unverified pairing fingerprints, metadata,
directory freshness and revocation, and copied plaintext retain their
existing consequences. Static recipient keys do not provide forward secrecy
against later compromise of that recipient's root secret. One-time reveals
and burn actions cannot retract plaintext or ciphertext already copied by
another party.

## Verification

Run from the repository root using the native pnpm installation and the
project's Rust/NSH toolchain:

```sh
cargo test --manifest-path crypto/Cargo.toml
pnpm test
pnpm run test:integration
cargo run --manifest-path app/Cargo.toml --example sync_smoke
pnpm --dir app/web run check
pnpm run web:build
nsh check app
nsh test app/bridge.test.tsx
nsh build app
```

The integration tests and native sync smoke need the local backend stack.
The native sync smoke verifies SDK transport with placeholder encrypted
payloads; the crypto tests separately exercise encryption and verification.
See [the browser toolchain setup](../app/README.md#browser-build) for WASM
compiler settings. Passing these checks establishes implementation behavior,
not an independent cryptographic audit.
