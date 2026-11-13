//! Protocol v2: X-Wing HPKE with encrypted ML-DSA-65 sender signatures.
//! Noise XX exchanges public identities only; compare the ENTIRE final handshake
//! hash out of band before approval or sharing secrets. This application protocol
//! and its post-quantum dependencies have not received an independent audit.
//! Callers own storage, approval, replay, expiry, revocation and burning policies.

use chacha20poly1305::{
    ChaCha20Poly1305, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use hpke::{Deserializable, Kem, OpModeR, OpModeS, Serializable, kem::XWing};
use ml_dsa::{Keypair, MlDsa65, Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand_chacha::{ChaCha20Rng, rand_core::SeedableRng};
use sha2::{Digest, Sha256};
use snow::{Builder, HandshakeState};
use std::fmt;
use x25519_dalek::{PublicKey as NoisePublicKey, StaticSecret};
use zeroize::{Zeroize, Zeroizing};

pub type Key = [u8; 32];
pub const PROTOCOL_VERSION: u8 = 2;
pub const MAX_PLAINTEXT: usize = 32 * 1024;
pub const PUBLIC_KEY_LEN: usize = 1 + 32 + 1216 + 1952;
const NOISE_END: usize = 1 + 32;
const KEM_END: usize = NOISE_END + 1216;
const SIGNATURE_LEN: usize = 3309;
const ENCAP_LEN: usize = 1120;
const DIRECTED_OVERHEAD: usize = 1 + ENCAP_LEN + SIGNATURE_LEN + 16;
const MAX_PAIRING_MESSAGE: usize = 1 + PUBLIC_KEY_LEN + 96;
const XX: &str = "Noise_XX_25519_ChaChaPoly_BLAKE2s";
const DOMAIN: &[u8] = b"powerbin:crypto:v2:xwing-hpke-sha256-chacha:mldsa65";
const MAX_CONTEXT_FIELD: usize = PUBLIC_KEY_LEN;
type KemPrivate = <XWing as Kem>::PrivateKey;
type KemPublic = <XWing as Kem>::PublicKey;
type EncappedKey = <XWing as Kem>::EncappedKey;

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
            Self::InvalidVersion => "unsupported cryptographic protocol version",
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
impl From<hpke::HpkeError> for Error {
    fn from(_: hpke::HpkeError) -> Self {
        Self::Crypto
    }
}

/// Versioned, validated Noise X25519 + X-Wing + ML-DSA-65 public identity.
/// Private bytes prevent callers from bypassing validation after construction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicKey(Vec<u8>);
impl PublicKey {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() != PUBLIC_KEY_LEN {
            return Err(Error::InvalidInput);
        }
        if bytes[0] != PROTOCOL_VERSION {
            return Err(Error::InvalidVersion);
        }
        validate_x25519(&bytes[1..NOISE_END])?;
        KemPublic::from_bytes(&bytes[NOISE_END..KEM_END]).map_err(|_| Error::InvalidInput)?;
        validate_x25519(&bytes[KEM_END - 32..KEM_END])?;
        let encoded = bytes[KEM_END..]
            .try_into()
            .map_err(|_| Error::InvalidInput)?;
        let verifying = VerifyingKey::<MlDsa65>::decode(&encoded);
        if verifying.encode().as_slice() != &bytes[KEM_END..] {
            return Err(Error::InvalidInput);
        }
        Ok(Self(bytes.to_vec()))
    }
    fn kem(&self) -> Result<KemPublic, Error> {
        KemPublic::from_bytes(&self.0[NOISE_END..KEM_END]).map_err(Into::into)
    }
    fn verifying_key(&self) -> VerifyingKey<MlDsa65> {
        VerifyingKey::decode(
            &self.0[KEM_END..]
                .try_into()
                .expect("validated public key length"),
        )
    }
}
impl AsRef<[u8]> for PublicKey {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}
fn validate_x25519(bytes: &[u8]) -> Result<(), Error> {
    let encoded: Key = bytes.try_into().map_err(|_| Error::InvalidInput)?;
    let mut modulus = [0xff; 32];
    modulus[0] = 0xed;
    modulus[31] = 0x7f;
    if encoded.iter().rev().cmp(modulus.iter().rev()) != std::cmp::Ordering::Less {
        return Err(Error::InvalidInput);
    }
    if !StaticSecret::from([0x42; 32])
        .diffie_hellman(&NoisePublicKey::from(encoded))
        .was_contributory()
    {
        return Err(Error::InvalidInput);
    }
    Ok(())
}

/// Domain-separated subkeys prevent a quantum break of Noise's public X25519
/// key from revealing the root seed and thereby the PQ private keys.
pub struct KeyPair {
    private: Zeroizing<Key>,
    noise_private: Zeroizing<Key>,
    kem_private: KemPrivate,
    signing: SigningKey<MlDsa65>,
    public: PublicKey,
}
impl KeyPair {
    pub fn generate() -> Result<Self, Error> {
        Ok(Self::from_private(random_key()?))
    }
    pub fn from_private(private: Key) -> Self {
        let private = Zeroizing::new(private);
        let noise_private = derive(&private, b"identity-noise");
        let kem_seed = derive(&private, b"identity-xwing");
        let signing_seed = derive(&private, b"identity-mldsa65");
        let (kem_private, kem_public) = XWing::derive_keypair(kem_seed.as_ref());
        let signing = SigningKey::<MlDsa65>::from_seed(&(*signing_seed).into());
        let noise_public = NoisePublicKey::from(&StaticSecret::from(*noise_private));
        let mut bytes = Vec::with_capacity(PUBLIC_KEY_LEN);
        bytes.push(PROTOCOL_VERSION);
        bytes.extend_from_slice(noise_public.as_bytes());
        bytes.extend_from_slice(&kem_public.to_bytes());
        bytes.extend_from_slice(&signing.verifying_key().encode());
        Self {
            private,
            noise_private,
            kem_private,
            signing,
            public: PublicKey(bytes),
        }
    }
    pub fn public_key(&self) -> &PublicKey {
        &self.public
    }
    pub fn private_key(&self) -> &Key {
        &self.private
    }
}
pub fn random_key() -> Result<Key, Error> {
    let mut key = [0; 32];
    getrandom::fill(&mut key).map_err(|_| Error::Random)?;
    Ok(key)
}
fn rng() -> Result<ChaCha20Rng, Error> {
    let mut seed = random_key()?;
    let rng = ChaCha20Rng::from_seed(seed);
    seed.zeroize();
    Ok(rng)
}

struct PairingState {
    handshake: HandshakeState,
    local: PublicKey,
    remote: Option<PublicKey>,
    initiator: bool,
    step: u8,
}
/// XX transports PUBLIC bundles only. Human transcript-hash comparison is mandatory.
pub struct Pairing(Option<PairingState>);
#[derive(Clone, Debug)]
pub struct CompletedPairing {
    pub handshake_hash: Key,
    pub remote_public_key: PublicKey,
}
impl Pairing {
    pub fn initiator(keys: &KeyPair, pairing_id: &str) -> Result<Self, Error> {
        Self::new(keys, pairing_id, true)
    }
    pub fn responder(keys: &KeyPair, pairing_id: &str) -> Result<Self, Error> {
        Self::new(keys, pairing_id, false)
    }
    fn new(keys: &KeyPair, pairing_id: &str, initiator: bool) -> Result<Self, Error> {
        let prologue = context(b"pairing-public-identities", &[external_field(pairing_id)?])?;
        let builder = Builder::new(XX.parse()?)
            .prologue(&prologue)?
            .local_private_key(keys.noise_private.as_ref())?;
        let handshake = if initiator {
            builder.build_initiator()?
        } else {
            builder.build_responder()?
        };
        Ok(Self(Some(PairingState {
            handshake,
            local: keys.public.clone(),
            remote: None,
            initiator,
            step: 0,
        })))
    }
    /// Any error permanently discards this pairing, including wrong operation order.
    pub fn write(&mut self) -> Result<Vec<u8>, Error> {
        let mut state = self.0.take().ok_or(Error::Crypto)?;
        if !matches!((state.initiator, state.step), (true, 0 | 2) | (false, 1)) {
            return Err(Error::Crypto);
        }
        let payload = if state.step == 0 {
            &[][..]
        } else {
            state.local.as_ref()
        };
        let mut output = vec![0; MAX_PAIRING_MESSAGE - 1];
        let length = state.handshake.write_message(payload, &mut output)?;
        state.step += 1;
        self.0 = Some(state);
        Ok(envelope(&output[..length]))
    }
    pub fn read(&mut self, message: &[u8]) -> Result<(), Error> {
        let mut state = self.0.take().ok_or(Error::Crypto)?;
        if !matches!((state.initiator, state.step), (false, 0 | 2) | (true, 1)) {
            return Err(Error::Crypto);
        }
        let message = unversion(message)?;
        if message.len() > MAX_PAIRING_MESSAGE - 1 {
            return Err(Error::InvalidInput);
        }
        let mut payload = vec![0; PUBLIC_KEY_LEN];
        let length = state.handshake.read_message(message, &mut payload)?;
        if state.step == 0 {
            if length != 0 {
                return Err(Error::InvalidInput);
            }
        } else {
            let remote = PublicKey::from_bytes(&payload[..length])?;
            if state.handshake.get_remote_static() != Some(&remote.as_ref()[1..NOISE_END]) {
                return Err(Error::Crypto);
            }
            state.remote = Some(remote);
        }
        state.step += 1;
        self.0 = Some(state);
        Ok(())
    }
    pub fn finish(self) -> Result<CompletedPairing, Error> {
        let state = self.0.ok_or(Error::Crypto)?;
        if state.step != 3 || !state.handshake.is_handshake_finished() {
            return Err(Error::IncompleteHandshake);
        }
        Ok(CompletedPairing {
            handshake_hash: state
                .handshake
                .get_handshake_hash()
                .try_into()
                .map_err(|_| Error::Crypto)?,
            remote_public_key: state.remote.ok_or(Error::Crypto)?,
        })
    }
}

#[derive(Clone, Copy)]
pub enum DirectedPurpose<'a> {
    Transfer { item_id: &'a str },
    GroupKey { device_id: &'a str },
}
impl DirectedPurpose<'_> {
    fn context(self) -> Result<Vec<u8>, Error> {
        match self {
            Self::Transfer { item_id } => context(b"transfer", &[external_field(item_id)?]),
            Self::GroupKey { device_id } => context(b"group-key", &[external_field(device_id)?]),
        }
    }
}
fn directed_context(
    sender: &PublicKey,
    recipient: &PublicKey,
    purpose: DirectedPurpose<'_>,
) -> Result<Vec<u8>, Error> {
    let purpose = purpose.context()?;
    context(
        b"directed",
        &[
            &Sha256::digest(purpose),
            sender.as_ref(),
            recipient.as_ref(),
        ],
    )
}
/// X-Wing HPKE Base encrypts a signature and plaintext; the signature and HPKE
/// context bind both full identities, purpose, item, suite and version.
/// Recipient identity must already have passed directory admission verification.
pub fn seal_directed(
    sender: &KeyPair,
    recipient_public_key: &PublicKey,
    purpose: DirectedPurpose<'_>,
    plaintext: &[u8],
) -> Result<Vec<u8>, Error> {
    check_plaintext(plaintext)?;
    let info = directed_context(sender.public_key(), recipient_public_key, purpose)?;
    let mut signed = Zeroizing::new(info.clone());
    signed.extend_from_slice(plaintext);
    let signature: Signature<MlDsa65> = sender
        .signing
        .try_sign(&signed)
        .map_err(|_| Error::Crypto)?;
    let mut payload = Zeroizing::new(Vec::with_capacity(SIGNATURE_LEN + plaintext.len()));
    payload.extend_from_slice(&signature.encode());
    payload.extend_from_slice(plaintext);
    let (enc, ciphertext) = hpke::single_shot_seal_with_rng::<
        hpke::aead::ChaCha20Poly1305,
        hpke::kdf::HkdfSha256,
        XWing,
    >(
        &OpModeS::Base,
        &recipient_public_key.kem()?,
        &info,
        &payload,
        &info,
        &mut rng()?,
    )?;
    let mut output = Vec::with_capacity(DIRECTED_OVERHEAD + plaintext.len());
    output.push(PROTOCOL_VERSION);
    output.extend_from_slice(&enc.to_bytes());
    output.extend_from_slice(&ciphertext);
    Ok(output)
}
pub fn open_directed(
    recipient: &KeyPair,
    sender_public_key: &PublicKey,
    purpose: DirectedPurpose<'_>,
    ciphertext: &[u8],
) -> Result<Vec<u8>, Error> {
    let body = unversion(ciphertext)?;
    if !(DIRECTED_OVERHEAD - 1..=DIRECTED_OVERHEAD - 1 + MAX_PLAINTEXT).contains(&body.len()) {
        return Err(Error::InvalidInput);
    }
    let info = directed_context(sender_public_key, recipient.public_key(), purpose)?;
    let enc = EncappedKey::from_bytes(&body[..ENCAP_LEN])?;
    let payload = Zeroizing::new(hpke::single_shot_open::<
        hpke::aead::ChaCha20Poly1305,
        hpke::kdf::HkdfSha256,
        XWing,
    >(
        &OpModeR::Base,
        &recipient.kem_private,
        &enc,
        &info,
        &body[ENCAP_LEN..],
        &info,
    )?);
    if payload.len() < SIGNATURE_LEN {
        return Err(Error::Crypto);
    }
    let signature =
        Signature::<MlDsa65>::try_from(&payload[..SIGNATURE_LEN]).map_err(|_| Error::Crypto)?;
    let plaintext = &payload[SIGNATURE_LEN..];
    check_plaintext(plaintext)?;
    let mut signed = Zeroizing::new(info);
    signed.extend_from_slice(plaintext);
    sender_public_key
        .verifying_key()
        .verify(&signed, &signature)
        .map_err(|_| Error::Crypto)?;
    Ok(plaintext.to_vec())
}

/// Fresh 256-bit capability delivered only in the URL fragment; guest links do
/// not authenticate a sender identity.
pub struct GuestPayload {
    pub recipient_secret: Zeroizing<Key>,
    pub ciphertext: Vec<u8>,
}
pub fn create_guest(item_id: &str, plaintext: &[u8]) -> Result<GuestPayload, Error> {
    let recipient_secret = Zeroizing::new(random_key()?);
    let ciphertext = seal_symmetric(
        &recipient_secret,
        b"guest",
        b"guest-encryption",
        item_id,
        plaintext,
    )?;
    Ok(GuestPayload {
        recipient_secret,
        ciphertext,
    })
}
pub fn open_guest(
    recipient_secret: &Key,
    item_id: &str,
    ciphertext: &[u8],
) -> Result<Vec<u8>, Error> {
    open_symmetric(
        recipient_secret,
        b"guest",
        b"guest-encryption",
        item_id,
        ciphertext,
    )
}
pub fn seal_saved(group_key: &Key, item_id: &str, plaintext: &[u8]) -> Result<Vec<u8>, Error> {
    seal_symmetric(group_key, b"saved", b"saved-encryption", item_id, plaintext)
}
pub fn open_saved(group_key: &Key, item_id: &str, ciphertext: &[u8]) -> Result<Vec<u8>, Error> {
    open_symmetric(
        group_key,
        b"saved",
        b"saved-encryption",
        item_id,
        ciphertext,
    )
}
fn seal_symmetric(
    secret: &Key,
    mode: &[u8],
    label: &[u8],
    item_id: &str,
    plaintext: &[u8],
) -> Result<Vec<u8>, Error> {
    check_plaintext(plaintext)?;
    let aad = context(mode, &[external_field(item_id)?])?;
    let key = derive(secret, label);
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
    output.push(PROTOCOL_VERSION);
    output.extend_from_slice(&nonce);
    output.extend_from_slice(&ciphertext);
    Ok(output)
}
fn open_symmetric(
    secret: &Key,
    mode: &[u8],
    label: &[u8],
    item_id: &str,
    ciphertext: &[u8],
) -> Result<Vec<u8>, Error> {
    let body = unversion(ciphertext)?;
    if !(12 + 16..=12 + MAX_PLAINTEXT + 16).contains(&body.len()) {
        return Err(Error::InvalidInput);
    }
    let aad = context(mode, &[external_field(item_id)?])?;
    let key = derive(secret, label);
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

pub struct DeviceIdentity<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub public_key: &'a PublicKey,
}
pub fn device_admission(group_key: &Key, device: &DeviceIdentity<'_>) -> Result<Key, Error> {
    Ok(admission_mac(group_key, device)?
        .finalize()
        .into_bytes()
        .into())
}
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
    let key = derive(group_key, b"device-admission");
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key.as_ref()).map_err(|_| Error::Crypto)?;
    mac.update(&context(
        b"device-admission",
        &[
            external_field(device.id)?,
            external_field(device.name)?,
            device.public_key.as_ref(),
        ],
    )?);
    Ok(mac)
}
fn derive(key: &Key, label: &[u8]) -> Zeroizing<Key> {
    let mut derived = Zeroizing::new([0; 32]);
    Hkdf::<Sha256>::new(Some(DOMAIN), key)
        .expand(label, derived.as_mut())
        .expect("fixed 32-byte HKDF output");
    derived
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
    output.push(PROTOCOL_VERSION);
    output.extend_from_slice(message);
    output
}
fn unversion(envelope: &[u8]) -> Result<&[u8], Error> {
    match envelope.split_first() {
        Some((&PROTOCOL_VERSION, message)) => Ok(message),
        Some(_) => Err(Error::InvalidVersion),
        None => Err(Error::InvalidInput),
    }
}
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
fn external_field(value: &str) -> Result<&[u8], Error> {
    if value.is_empty() || value.len() > 1024 {
        return Err(Error::InvalidInput);
    }
    Ok(value.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex<const N: usize>(value: &str) -> [u8; N] {
        assert_eq!(value.len(), N * 2);
        let mut bytes = [0; N];
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).unwrap();
        }
        bytes
    }

    struct VectorRng(Vec<u8>);
    impl hpke::rand_core::TryRng for VectorRng {
        type Error = std::convert::Infallible;
        fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
            hpke::rand_core::utils::next_word_via_fill(self)
        }
        fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
            hpke::rand_core::utils::next_word_via_fill(self)
        }
        fn try_fill_bytes(&mut self, bytes: &mut [u8]) -> Result<(), Self::Error> {
            bytes.copy_from_slice(&self.0[..bytes.len()]);
            self.0.drain(..bytes.len());
            Ok(())
        }
    }
    impl hpke::rand_core::TryCryptoRng for VectorRng {}

    #[test]
    fn xwing_matches_published_known_answer_vector() {
        // Vector 0 from the X-Wing authors, also shipped by x-wing 0.1.1:
        // https://github.com/dconnolly/draft-connolly-cfrg-xwing-kem/blob/main/spec/test-vectors.json
        // Hashes compact the large expected pk/ct; shared secret is checked in full.
        let secret = hex::<32>("7f9c2ba4e88f827d616045507605853ed73b8093f6efbc88eb1a6eacfa66ef26");
        let expected =
            hex::<32>("d2df0522128f09dd8e2c92b1e905c793d8f57a54c3da25861f10bf4ca613e384");
        let sk = KemPrivate::from_bytes(&secret).unwrap();
        let pk = XWing::sk_to_pk(&sk);
        assert_eq!(
            Sha256::digest(pk.to_bytes()).as_slice(),
            hex::<32>("2e816deebcd76c5c80d0cd2d174478871658e8e2ff42bc9d4a6e486372e856bb")
        );
        let mut randomness = VectorRng(hex::<64>("3cb1eea988004b93103cfb0aeefd2a686e01fa4a58e8a3639ca8a1e3f9ae57e235b8cc873c23dc62b8d260169afa2f75ab916a58d974918835d25e6a435085b2").to_vec());
        let (shared, enc) = XWing::encap_with_rng(&pk, None, &mut randomness).unwrap();
        assert_eq!(shared.0.as_slice(), expected);
        assert_eq!(
            Sha256::digest(enc.to_bytes()).as_slice(),
            hex::<32>("17cd532d657e44c897ca6583e548a5424fc70bf54f99515a4d2bcf99e3469f33")
        );
        assert_eq!(
            XWing::decap(&sk, None, &enc).unwrap().0.as_slice(),
            expected
        );
    }

    #[test]
    fn quantum_exposure_of_noise_scalar_does_not_expose_pq_master_seed() {
        let root = [7; 32];
        let keys = KeyPair::from_private(root);
        assert_ne!(*keys.noise_private, root);
        assert_ne!(*keys.noise_private, *derive(&root, b"identity-xwing"));
        assert_ne!(*keys.noise_private, *derive(&root, b"identity-mldsa65"));
        assert_ne!(
            *derive(&root, b"identity-xwing"),
            *derive(&root, b"identity-mldsa65")
        );
        let original_classical = NoisePublicKey::from(&StaticSecret::from(root));
        assert_ne!(
            &keys.public_key().as_ref()[1..NOISE_END],
            original_classical.as_bytes()
        );
    }

    #[test]
    fn pairing_rejects_identity_bundle_from_a_different_noise_static_key() {
        let a = KeyPair::generate().unwrap();
        let b = KeyPair::generate().unwrap();
        let imposter = KeyPair::generate().unwrap();
        let mut initiator = Pairing::initiator(&a, "pairing").unwrap();
        let mut responder = Pairing::responder(&b, "pairing").unwrap();
        responder.0.as_mut().unwrap().local = imposter.public_key().clone();
        responder.read(&initiator.write().unwrap()).unwrap();
        assert_eq!(
            initiator.read(&responder.write().unwrap()).unwrap_err(),
            Error::Crypto
        );
        assert!(initiator.finish().is_err());
    }

    #[test]
    fn valid_hpke_ciphertexts_with_invalid_sender_signatures_are_rejected() {
        let sender = KeyPair::generate().unwrap();
        let recipient = KeyPair::generate().unwrap();
        let attacker = KeyPair::generate().unwrap();
        let purpose = DirectedPurpose::Transfer {
            item_id: "signature-test",
        };
        let info = directed_context(sender.public_key(), recipient.public_key(), purpose).unwrap();
        let plaintext = b"authentic message";
        let mut signed = info.clone();
        signed.extend_from_slice(plaintext);
        let good: Signature<MlDsa65> = sender.signing.sign(&signed);
        let wrong_signer: Signature<MlDsa65> = attacker.signing.sign(&signed);
        let wrong_message: Signature<MlDsa65> =
            sender.signing.sign(b"different context and message");
        for (signature, succeeds) in [(good, true), (wrong_signer, false), (wrong_message, false)] {
            let mut payload = signature.encode().to_vec();
            payload.extend_from_slice(plaintext);
            let (enc, ciphertext) = hpke::single_shot_seal_with_rng::<
                hpke::aead::ChaCha20Poly1305,
                hpke::kdf::HkdfSha256,
                XWing,
            >(
                &OpModeS::Base,
                &recipient.public_key().kem().unwrap(),
                &info,
                &payload,
                &info,
                &mut rng().unwrap(),
            )
            .unwrap();
            // Ensure AEAD successfully authenticates all three crafted payloads.
            let opened = hpke::single_shot_open::<
                hpke::aead::ChaCha20Poly1305,
                hpke::kdf::HkdfSha256,
                XWing,
            >(
                &OpModeR::Base,
                &recipient.kem_private,
                &enc,
                &info,
                &ciphertext,
                &info,
            )
            .unwrap();
            assert_eq!(opened, payload);
            let mut envelope = vec![PROTOCOL_VERSION];
            envelope.extend_from_slice(&enc.to_bytes());
            envelope.extend_from_slice(&ciphertext);
            let result = open_directed(&recipient, sender.public_key(), purpose, &envelope);
            if succeeds {
                assert_eq!(result.unwrap(), plaintext);
            } else {
                assert_eq!(result.unwrap_err(), Error::Crypto);
            }
        }
    }
}
