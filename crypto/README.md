# Shared cryptography

This crate contains the same cryptographic operations for native builds and
WASM. It has no PowerSync, network, storage, serialization, or UI dependencies.
The application protocol is not audited.

- Device identity: a persistent X25519 `KeyPair`, stored only on its device.
- Pairing: candidate sends XX messages 1 and 3, existing device sends message 2.
  Use the pairing session ID as the context. After `finish()`, compare the **full
  32-byte handshake hash** on both screens out of band. The short rendezvous
  code is public. `CompletedPairing` does not mean the user approved anything.
- Directed text and key grants: Noise K authenticates a previously trusted
  sender. `DirectedPurpose` binds either the transfer item ID or recipient
  device ID, with separate domains. Verify directory admission before using a
  public key. During pairing, use the key authenticated by the verified XX
  session and check it equals the candidate key the server will admit.
- Guest: `create_guest` generates a new recipient secret for every item. Put
  that secret only in the URL fragment. Noise N does not authenticate a sender.
- Saved: ChaCha20Poly1305, random 96-bit nonce, authenticated item ID and mode.
  HKDF-SHA256 derives distinct encryption and directory-admission subkeys.
- Admission: HMAC-SHA256 authenticates device ID, displayed name, and raw public
  key. Verification is constant time. All holders of the personal group key
  can admit devices; this does not attribute approval to a particular device.

The standard Noise patterns and handshake-hash channel binding are described
in the [Noise specification](https://noiseprotocol.org/noise.html).

## Server mapping

The application base64url-encodes raw public keys and opaque ciphertext bytes.
Store the base64url 32-byte `device_admission` tag in `devices.admission`.
Before trusting a synced device, verify it against its exact ID, name, and
decoded public key using the local group key. A renamed device needs a new tag.

Store the base64url result of `seal_directed` with
`DirectedPurpose::GroupKey { device_id }` and a 32-byte group-key plaintext in
`devices.shared_key_envelope`. Decrypt using the approver's key authenticated
by the verified pairing session; bootstrap can grant to its own public key.
The caller must remember the trusted grant sender locally or include its ID
in an outer envelope and resolve that ID only through an already trusted key.
An arbitrary public key supplied alongside a grant does not authenticate it.

Ciphertext format version 1 is one leading byte `0x01` followed by the Noise
message. Saved ciphertexts instead contain `0x01`, a 12-byte nonce, and the
AEAD ciphertext/tag. Admission tags are fixed 32 bytes; their authenticated
input binds the protocol version. Plaintexts are capped at 32 KiB.

The application owns approval gating, device-local secret storage, directory
replay/revocation policy, one-time server claims, expiry, and burning. Secret
buffers exported by the caller need their own lifetime/cleanup policy. Clearing
a Rust buffer is not a guarantee of physical erasure from device storage.
