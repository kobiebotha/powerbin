//! Shared native/WASM cryptography, with no network, persistence, or UI code.
//!
//! Pairing uses Noise XX; directed messages use K; guest messages use N. These
//! are standard [Noise patterns](https://noiseprotocol.org/noise.html).
//! Completing XX does not authenticate a human: compare the entire finished
//! handshake hash out of band before approving a device or sharing any key.
//! This application protocol has not received a security audit.
//!
//! Ciphertexts are opaque versioned bytes. The caller handles base64url/storage,
//! protects local secret keys, verifies device admissions before using directory
//! keys, and implements expiry, replay prevention, revocation, and burning.

use chacha20poly1305::{
    ChaCha20Poly1305, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use snow::{Builder, HandshakeState};
use std::fmt;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::{Zeroize, Zeroizing};

pub type Key = [u8; 32];
pub const MAX_PLAINTEXT: usize = 32 * 1024;
const VERSION: u8 = 1;
const XX: &str = "Noise_XX_25519_ChaChaPoly_BLAKE2s";
const K: &str = "Noise_K_25519_ChaChaPoly_BLAKE2s";
const N: &str = "Noise_N_25519_ChaChaPoly_BLAKE2s";
const DOMAIN: &[u8] = b"native-shell-demo:crypto:v1";
const MAX_CONTEXT_FIELD: usize = 1024;
const MAX_NOISE_MESSAGE: usize = MAX_PLAINTEXT + 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    InvalidInput,
    InvalidVersion,
    TooLarge,
    IncompleteHandshake,
    Crypto,
    Random,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidInput => "invalid cryptographic input",
            Self::InvalidVersion => "unsupported cryptographic envelope version",
            Self::TooLarge => "plaintext exceeds 32 KiB",
            Self::IncompleteHandshake => "pairing handshake is not complete",
            Self::Crypto => "cryptographic operation failed",
            Self::Random => "secure randomness is unavailable",
        })
    }
}

impl std::error::Error for Error {}

impl From<snow::Error> for Error {
    fn from(_: snow::Error) -> Self {
        Self::Crypto
    }
}

/// A device's persistent X25519 identity. Deliberately does not implement Debug.
pub struct KeyPair {
    private: Key,
    public: Key,
}

impl KeyPair {
    pub fn generate() -> Result<Self, Error> {
        Ok(Self::from_private(random_key()?))
    }

    /// Restore a private key from this device's protected local storage.
    pub fn from_private(private: Key) -> Self {
        let secret = StaticSecret::from(private);
        Self {
            private,
            public: PublicKey::from(&secret).to_bytes(),
        }
    }

    pub fn public_key(&self) -> &Key {
        &self.public
    }

    pub fn private_key(&self) -> &Key {
        &self.private
    }
}

impl Drop for KeyPair {
    fn drop(&mut self) {
        self.private.zeroize();
    }
}

pub fn random_key() -> Result<Key, Error> {
    let mut key = [0; 32];
    getrandom::fill(&mut key).map_err(|_| Error::Random)?;
    Ok(key)
}

/// Candidate is the initiator (messages 1 and 3); existing device responds (2).
/// The public rendezvous code only locates the session. It is not a secret.
pub struct Pairing(Option<HandshakeState>);

/// Proof material for the UI, NOT an assertion that the user verified it.
#[derive(Clone, Debug)]
pub struct CompletedPairing {
    pub handshake_hash: Key,
    pub remote_public_key: Key,
}

impl Pairing {
    pub fn initiator(keys: &KeyPair, pairing_id: &str) -> Result<Self, Error> {
        Self::new(keys, pairing_id, true)
    }

    pub fn responder(keys: &KeyPair, pairing_id: &str) -> Result<Self, Error> {
        Self::new(keys, pairing_id, false)
    }

    fn new(keys: &KeyPair, pairing_id: &str, initiator: bool) -> Result<Self, Error> {
        let prologue = context(b"pairing", &[pairing_id.as_bytes()])?;
        let builder = builder(XX, &prologue, Some(keys.private_key()), None)?;
        Ok(Self(Some(if initiator {
            builder.build_initiator()?
        } else {
            builder.build_responder()?
        })))
    }

    /// Pairing messages carry no application payloads before verification.
    /// Any read/write error discards the session; start a new pairing to retry.
    pub fn write(&mut self) -> Result<Vec<u8>, Error> {
        let mut state = self.0.take().ok_or(Error::Crypto)?;
        let mut output = [0; 96];
        let length = state.write_message(&[], &mut output)?;
        self.0 = Some(state);
        Ok(envelope(&output[..length]))
    }

    pub fn read(&mut self, message: &[u8]) -> Result<(), Error> {
        let mut state = self.0.take().ok_or(Error::Crypto)?;
        let message = unversion(message)?;
        if message.len() > 96 {
            return Err(Error::InvalidInput);
        }
        let mut payload = [0; 96];
        if state.read_message(message, &mut payload)? != 0 {
            return Err(Error::InvalidInput);
        }
        self.0 = Some(state);
        Ok(())
    }

    pub fn finish(self) -> Result<CompletedPairing, Error> {
        let state = self.0.ok_or(Error::Crypto)?;
        if !state.is_handshake_finished() {
            return Err(Error::IncompleteHandshake);
        }
        Ok(CompletedPairing {
            handshake_hash: state
                .get_handshake_hash()
                .try_into()
                .map_err(|_| Error::Crypto)?,
            remote_public_key: state
                .get_remote_static()
                .ok_or(Error::Crypto)?
                .try_into()
                .map_err(|_| Error::Crypto)?,
        })
    }
}

/// Distinct protocol contexts prevent a text transfer becoming a key grant.
#[derive(Clone, Copy)]
pub enum DirectedPurpose<'a> {
    Transfer { item_id: &'a str },
    GroupKey { device_id: &'a str },
}

impl DirectedPurpose<'_> {
    fn context(self) -> Result<Vec<u8>, Error> {
        match self {
            Self::Transfer { item_id } => context(b"transfer", &[item_id.as_bytes()]),
            Self::GroupKey { device_id } => context(b"group-key", &[device_id.as_bytes()]),
        }
    }
}

/// One-way Noise K authenticates the sender to the recipient, whose directory
/// public key must already have passed `verify_device_admission`.
pub fn seal_directed(
    sender: &KeyPair,
    recipient_public_key: &Key,
    purpose: DirectedPurpose<'_>,
    plaintext: &[u8],
) -> Result<Vec<u8>, Error> {
    let prologue = purpose.context()?;
    let state = builder(
        K,
        &prologue,
        Some(sender.private_key()),
        Some(recipient_public_key),
    )?
    .build_initiator()?;
    seal_noise(state, plaintext)
}

pub fn open_directed(
    recipient: &KeyPair,
    sender_public_key: &Key,
    purpose: DirectedPurpose<'_>,
    ciphertext: &[u8],
) -> Result<Vec<u8>, Error> {
    let prologue = purpose.context()?;
    let state = builder(
        K,
        &prologue,
        Some(recipient.private_key()),
        Some(sender_public_key),
    )?
    .build_responder()?;
    open_noise(state, ciphertext)
}

/// Noise N provides anonymous encryption; guest links do not authenticate a
/// sender. Each call creates a fresh recipient secret for the URL fragment.
pub struct GuestPayload {
    pub recipient_secret: Zeroizing<Key>,
    pub ciphertext: Vec<u8>,
}

pub fn create_guest(item_id: &str, plaintext: &[u8]) -> Result<GuestPayload, Error> {
    let recipient = KeyPair::generate()?;
    let prologue = context(b"guest", &[item_id.as_bytes()])?;
    let state = builder(N, &prologue, None, Some(recipient.public_key()))?.build_initiator()?;
    Ok(GuestPayload {
        recipient_secret: Zeroizing::new(*recipient.private_key()),
        ciphertext: seal_noise(state, plaintext)?,
    })
}

pub fn open_guest(
    recipient_secret: &Key,
    item_id: &str,
    ciphertext: &[u8],
) -> Result<Vec<u8>, Error> {
    let prologue = context(b"guest", &[item_id.as_bytes()])?;
    let state = builder(N, &prologue, Some(recipient_secret), None)?.build_responder()?;
    open_noise(state, ciphertext)
}

/// Format: version (1 byte), random nonce (12 bytes), ciphertext and AEAD tag.
pub fn seal_saved(group_key: &Key, item_id: &str, plaintext: &[u8]) -> Result<Vec<u8>, Error> {
    check_plaintext(plaintext)?;
    let aad = context(b"saved", &[item_id.as_bytes()])?;
    let key = group_subkey(group_key, b"saved-encryption")?;
    let cipher = ChaCha20Poly1305::new_from_slice(key.as_ref()).map_err(|_| Error::Crypto)?;
    let mut nonce = [0; 12];
    getrandom::fill(&mut nonce).map_err(|_| Error::Random)?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| Error::Crypto)?;
    let mut output = Vec::with_capacity(1 + nonce.len() + ciphertext.len());
    output.push(VERSION);
    output.extend_from_slice(&nonce);
    output.extend_from_slice(&ciphertext);
    Ok(output)
}

pub fn open_saved(group_key: &Key, item_id: &str, ciphertext: &[u8]) -> Result<Vec<u8>, Error> {
    let body = unversion(ciphertext)?;
    if !(12 + 16..=12 + MAX_PLAINTEXT + 16).contains(&body.len()) {
        return Err(Error::InvalidInput);
    }
    let aad = context(b"saved", &[item_id.as_bytes()])?;
    let key = group_subkey(group_key, b"saved-encryption")?;
    let cipher = ChaCha20Poly1305::new_from_slice(key.as_ref()).map_err(|_| Error::Crypto)?;
    cipher
        .decrypt(
            Nonce::from_slice(&body[..12]),
            Payload {
                msg: &body[12..],
                aad: &aad,
            },
        )
        .map_err(|_| Error::Crypto)
}

/// Admission binds the complete displayed identity. Renaming requires a new tag.
pub struct DeviceIdentity<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub public_key: &'a Key,
}

/// Any device holding the personal group key may admit another device. This is
/// a group authenticator, not a signature or proof of which device approved it.
pub fn device_admission(group_key: &Key, device: &DeviceIdentity<'_>) -> Result<Key, Error> {
    Ok(admission_mac(group_key, device)?
        .finalize()
        .into_bytes()
        .into())
}

/// Uses the HMAC library's constant-time verification, including tag length.
pub fn verify_device_admission(
    group_key: &Key,
    device: &DeviceIdentity<'_>,
    tag: &[u8],
) -> Result<(), Error> {
    admission_mac(group_key, device)?
        .verify_slice(tag)
        .map_err(|_| Error::Crypto)
}

fn admission_mac(group_key: &Key, device: &DeviceIdentity<'_>) -> Result<Hmac<Sha256>, Error> {
    let key = group_subkey(group_key, b"device-admission")?;
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key.as_ref()).map_err(|_| Error::Crypto)?;
    mac.update(&context(
        b"device-admission",
        &[
            device.id.as_bytes(),
            device.name.as_bytes(),
            device.public_key,
        ],
    )?);
    Ok(mac)
}

fn group_subkey(group_key: &Key, label: &[u8]) -> Result<Zeroizing<Key>, Error> {
    let mut key = Zeroizing::new([0; 32]);
    Hkdf::<Sha256>::new(Some(DOMAIN), group_key)
        .expand(label, key.as_mut())
        .map_err(|_| Error::Crypto)?;
    Ok(key)
}

fn builder<'a>(
    pattern: &str,
    prologue: &'a [u8],
    local: Option<&'a Key>,
    remote: Option<&'a Key>,
) -> Result<Builder<'a>, Error> {
    let mut builder = Builder::new(pattern.parse()?).prologue(prologue)?;
    if let Some(key) = local {
        builder = builder.local_private_key(key)?;
    }
    if let Some(key) = remote {
        builder = builder.remote_public_key(key)?;
    }
    Ok(builder)
}

fn seal_noise(mut state: HandshakeState, plaintext: &[u8]) -> Result<Vec<u8>, Error> {
    check_plaintext(plaintext)?;
    let mut output = vec![0; plaintext.len() + 128];
    let length = state.write_message(plaintext, &mut output)?;
    if !state.is_handshake_finished() {
        return Err(Error::Crypto);
    }
    Ok(envelope(&output[..length]))
}

fn open_noise(mut state: HandshakeState, ciphertext: &[u8]) -> Result<Vec<u8>, Error> {
    let message = unversion(ciphertext)?;
    if message.len() > MAX_NOISE_MESSAGE {
        return Err(Error::InvalidInput);
    }
    let mut plaintext = vec![0; message.len()];
    let length = state.read_message(message, &mut plaintext)?;
    if !state.is_handshake_finished() {
        plaintext.zeroize();
        return Err(Error::Crypto);
    }
    if length > MAX_PLAINTEXT {
        plaintext.zeroize();
        return Err(Error::TooLarge);
    }
    plaintext.truncate(length);
    Ok(plaintext)
}

fn check_plaintext(plaintext: &[u8]) -> Result<(), Error> {
    if plaintext.len() > MAX_PLAINTEXT {
        Err(Error::TooLarge)
    } else {
        Ok(())
    }
}

fn envelope(message: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(message.len() + 1);
    output.push(VERSION);
    output.extend_from_slice(message);
    output
}

fn unversion(envelope: &[u8]) -> Result<&[u8], Error> {
    match envelope.split_first() {
        Some((&VERSION, message)) => Ok(message),
        Some(_) => Err(Error::InvalidVersion),
        None => Err(Error::InvalidInput),
    }
}

/// Length framing prevents ambiguous concatenation; the domain binds version.
fn context(purpose: &[u8], fields: &[&[u8]]) -> Result<Vec<u8>, Error> {
    let mut output = Vec::from(DOMAIN);
    for field in std::iter::once(purpose).chain(fields.iter().copied()) {
        if field.is_empty() || field.len() > MAX_CONTEXT_FIELD {
            return Err(Error::InvalidInput);
        }
        output.extend_from_slice(&(field.len() as u32).to_be_bytes());
        output.extend_from_slice(field);
    }
    Ok(output)
}
