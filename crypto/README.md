# Shared cryptography

This crate provides the same protocol version 2 cryptography for native and
WASM builds. It has no PowerSync, network, storage, serialization, or UI
dependencies. The application protocol and its implementation are unaudited.
See [the post-quantum protocol notes](../docs/post-quantum.md) for scope and
primary specifications.

- Device identity: a persistent 32-byte root secret derives separate Noise
  X25519, X-Wing, and ML-DSA-65 keys using domain-separated derivation. The
  public identity bundle contains version `0x02`, a 32-byte Noise public key,
  a 1,216-byte X-Wing public key, and a 1,952-byte ML-DSA-65 public key.
- Pairing: the candidate sends Noise XX messages 1 and 3; the existing device
  sends message 2. Messages 2 and 3 carry the complete public identity bundles.
  Use the pairing session ID as context. After `finish()`, compare the **full
  32-byte handshake hash** on both screens through a trusted out-of-band
  channel. The short rendezvous code is public. `CompletedPairing` does not
  mean the user approved anything. Noise carries no group key or snippet
  plaintext; its classical encryption is not the content-security boundary.
- Directed text and group-key grants: HPKE uses X-Wing
  (ML-KEM-768 plus X25519), HKDF-SHA256, and ChaCha20Poly1305. An encrypted
  ML-DSA-65 signature authenticates the plaintext and its context.
  `DirectedPurpose` separates transfers from group-key grants and binds the
  item ID or recipient device ID. Check the sender's signature when opening.
  X-Wing does not supply HPKE's authenticated mode; sender authentication
  comes from the signature. Verify directory admission before trusting a
  public identity. During pairing, use only the identity from the compared
  transcript and check it equals the candidate identity the server admits.
- Guest links: each item gets a new random 32-byte symmetric secret. Put that
  secret only in the URL fragment. ChaCha20Poly1305 binds the item ID and
  guest mode. A guest link does not authenticate a named sender.
- Saved snippets: ChaCha20Poly1305 with a random 96-bit nonce and authenticated
  item ID and mode. HKDF-SHA256 derives separate encryption and
  directory-admission subkeys from the group key.
- Admission: HMAC-SHA256 authenticates the device ID, exact displayed name,
  and complete public identity bundle. Verification is constant time. Every
  holder of the group key can admit devices; a tag does not attribute
  approval to one specific device.

## Server mapping

The application base64url-encodes public identity bundles and opaque
ciphertext bytes. The public identity is 3,201 bytes, or 4,268 base64url
characters. The relay permits at most 8,192 UTF-8 bytes for that field.

Store the base64url 32-byte `device_admission` tag in `devices.admission`.
Before trusting a synced device, verify its exact ID, name, and decoded
public identity using the local group key. A renamed device needs a new tag.

Store the base64url result of `seal_directed` with
`DirectedPurpose::GroupKey { device_id }` and a 32-byte group-key plaintext
in `devices.shared_key_envelope`. Send the grant only after the user confirms
the full pairing fingerprint. Bootstrap can grant to its own identity.
Decrypt and verify using the approver's identity from the compared pairing
transcript. The caller must retain the trusted grant sender locally or
resolve its ID through an already trusted identity. An arbitrary identity
supplied alongside a grant does not authenticate it.

All ciphertexts use version `0x02`; version 1 is rejected without a fallback.
Directed envelopes carry the HPKE encapsulation and encrypted signed content.
Saved and guest envelopes contain the version byte, a 12-byte nonce, and
AEAD ciphertext/tag. Admission tags are fixed 32 bytes; their input binds the
protocol version. Plaintexts are capped at 32 KiB.

The application owns approval gating, device-local secret storage, directory
replay/revocation policy, one-time server claims, expiry, and burning. Secret
buffers exported by the caller need their own lifetime and cleanup policy.
Clearing a Rust buffer does not guarantee physical erasure from storage.
