use native_shell_crypto::{
    CompletedPairing, DeviceIdentity, DirectedPurpose, Error, Key, KeyPair, MAX_PLAINTEXT, Pairing,
    create_guest, device_admission, open_directed, open_guest, open_saved, random_key,
    seal_directed, seal_saved, verify_device_admission,
};

const TEXT: &[u8] = b"https://powersync.com/\nHello from another device.\n";

fn pair(a: &KeyPair, b: &KeyPair, id: &str) -> (CompletedPairing, CompletedPairing) {
    let mut a = Pairing::initiator(a, id).unwrap();
    let mut b = Pairing::responder(b, id).unwrap();
    b.read(&a.write().unwrap()).unwrap();
    a.read(&b.write().unwrap()).unwrap();
    b.read(&a.write().unwrap()).unwrap();
    (a.finish().unwrap(), b.finish().unwrap())
}

fn damaged(ciphertext: &[u8]) -> Vec<u8> {
    let mut damaged = ciphertext.to_vec();
    let last = damaged.len() - 1;
    damaged[last] ^= 1;
    damaged
}

#[test]
fn pairing_agrees_on_full_hash_and_device_identities() {
    let a = KeyPair::generate().unwrap();
    let b = KeyPair::generate().unwrap();
    let (from_a, from_b) = pair(&a, &b, "pairing-1");
    assert_eq!(from_a.handshake_hash.len(), 32);
    assert_eq!(from_a.handshake_hash, from_b.handshake_hash);
    assert_eq!(&from_a.remote_public_key, b.public_key());
    assert_eq!(&from_b.remote_public_key, a.public_key());

    let restored = KeyPair::from_private(*a.private_key());
    assert_eq!(a.public_key(), restored.public_key());
    let (fresh, _) = pair(&a, &b, "pairing-1");
    assert_ne!(fresh.handshake_hash, from_a.handshake_hash);
}

#[test]
fn incomplete_tampered_and_cross_session_pairings_cannot_finish() {
    let a = KeyPair::generate().unwrap();
    let b = KeyPair::generate().unwrap();
    assert_eq!(
        Pairing::initiator(&a, "pairing")
            .unwrap()
            .finish()
            .unwrap_err(),
        Error::IncompleteHandshake
    );

    let mut a1 = Pairing::initiator(&a, "one").unwrap();
    let mut b2 = Pairing::responder(&b, "two").unwrap();
    b2.read(&a1.write().unwrap()).unwrap();
    assert!(a1.read(&b2.write().unwrap()).is_err());
    assert!(a1.finish().is_err());

    let mut a = Pairing::initiator(&a, "pairing").unwrap();
    let mut b = Pairing::responder(&b, "pairing").unwrap();
    b.read(&a.write().unwrap()).unwrap();
    assert!(a.read(&damaged(&b.write().unwrap())).is_err());
    assert!(a.finish().is_err());
}

#[test]
fn an_interposed_peer_has_a_different_fingerprint() {
    let a = KeyPair::generate().unwrap();
    let b = KeyPair::generate().unwrap();
    let interposer = KeyPair::generate().unwrap();
    let (a_view, _) = pair(&a, &interposer, "same-public-rendezvous");
    let (_, b_view) = pair(&interposer, &b, "same-public-rendezvous");
    assert_ne!(a_view.handshake_hash, b_view.handshake_hash);
    assert_ne!(&a_view.remote_public_key, b.public_key());
    assert_ne!(&b_view.remote_public_key, a.public_key());
}

#[test]
fn directed_message_authenticates_sender_recipient_item_and_mode() {
    let sender = KeyPair::generate().unwrap();
    let recipient = KeyPair::generate().unwrap();
    let other = KeyPair::generate().unwrap();
    let purpose = DirectedPurpose::Transfer { item_id: "item-1" };
    let ciphertext = seal_directed(&sender, recipient.public_key(), purpose, TEXT).unwrap();
    assert_eq!(
        open_directed(&recipient, sender.public_key(), purpose, &ciphertext).unwrap(),
        TEXT
    );
    assert!(open_directed(&other, sender.public_key(), purpose, &ciphertext).is_err());
    assert!(open_directed(&recipient, other.public_key(), purpose, &ciphertext).is_err());
    assert!(
        open_directed(
            &recipient,
            sender.public_key(),
            DirectedPurpose::Transfer { item_id: "item-2" },
            &ciphertext
        )
        .is_err()
    );
    assert!(
        open_directed(
            &recipient,
            sender.public_key(),
            DirectedPurpose::GroupKey {
                device_id: "item-1"
            },
            &ciphertext
        )
        .is_err()
    );
    assert!(
        open_directed(
            &recipient,
            sender.public_key(),
            purpose,
            &damaged(&ciphertext)
        )
        .is_err()
    );
    assert!(
        open_directed(
            &recipient,
            sender.public_key(),
            purpose,
            &ciphertext[..ciphertext.len() - 1]
        )
        .is_err()
    );
    assert_ne!(
        ciphertext,
        seal_directed(&sender, recipient.public_key(), purpose, TEXT).unwrap()
    );
}

#[test]
fn verified_pairing_identity_can_receive_the_shared_key_grant() {
    let existing = KeyPair::generate().unwrap();
    let candidate = KeyPair::generate().unwrap();
    let (candidate_view, existing_view) = pair(&candidate, &existing, "pairing");
    // The application must get explicit user confirmation before this branch.
    assert_eq!(candidate_view.handshake_hash, existing_view.handshake_hash);
    let group_key = random_key().unwrap();
    let purpose = DirectedPurpose::GroupKey {
        device_id: "candidate-device",
    };
    let envelope = seal_directed(
        &existing,
        &existing_view.remote_public_key,
        purpose,
        &group_key,
    )
    .unwrap();
    let received = open_directed(
        &candidate,
        &candidate_view.remote_public_key,
        purpose,
        &envelope,
    )
    .unwrap();
    assert_eq!(received, group_key);

    let identity = DeviceIdentity {
        id: "candidate-device",
        name: "Phone",
        public_key: candidate.public_key(),
    };
    let admission = device_admission(&group_key, &identity).unwrap();
    verify_device_admission(&received.try_into().unwrap(), &identity, &admission).unwrap();
}

#[test]
fn bootstrap_can_encrypt_its_group_key_to_itself() {
    let first = KeyPair::generate().unwrap();
    let group_key = random_key().unwrap();
    let purpose = DirectedPurpose::GroupKey {
        device_id: "first-device",
    };
    let envelope = seal_directed(&first, first.public_key(), purpose, &group_key).unwrap();
    assert_eq!(
        open_directed(&first, first.public_key(), purpose, &envelope).unwrap(),
        group_key
    );
}

#[test]
fn guest_link_has_a_fresh_secret_and_binds_the_item() {
    let guest = create_guest("link-1", TEXT).unwrap();
    let another = create_guest("link-1", TEXT).unwrap();
    assert_ne!(*guest.recipient_secret, *another.recipient_secret);
    assert_ne!(guest.ciphertext, another.ciphertext);
    assert_eq!(
        open_guest(&guest.recipient_secret, "link-1", &guest.ciphertext).unwrap(),
        TEXT
    );
    assert!(open_guest(&another.recipient_secret, "link-1", &guest.ciphertext).is_err());
    assert!(open_guest(&guest.recipient_secret, "link-2", &guest.ciphertext).is_err());
    assert!(
        open_guest(
            &guest.recipient_secret,
            "link-1",
            &damaged(&guest.ciphertext)
        )
        .is_err()
    );
}

#[test]
fn saved_snippet_requires_the_group_key_and_original_item_id() {
    let group_key = random_key().unwrap();
    let ciphertext = seal_saved(&group_key, "saved-1", TEXT).unwrap();
    assert_eq!(
        open_saved(&group_key, "saved-1", &ciphertext).unwrap(),
        TEXT
    );
    assert!(open_saved(&random_key().unwrap(), "saved-1", &ciphertext).is_err());
    assert!(open_saved(&group_key, "saved-2", &ciphertext).is_err());
    assert!(open_saved(&group_key, "saved-1", &damaged(&ciphertext)).is_err());
    let mut changed_nonce = ciphertext.clone();
    changed_nonce[1] ^= 1;
    assert!(open_saved(&group_key, "saved-1", &changed_nonce).is_err());
    assert_ne!(ciphertext, seal_saved(&group_key, "saved-1", TEXT).unwrap());
}

#[test]
fn directory_admission_rejects_substituted_identity_fields_and_tags() {
    let group_key = random_key().unwrap();
    let key = KeyPair::generate().unwrap();
    let identity = DeviceIdentity {
        id: "phone",
        name: "My phone",
        public_key: key.public_key(),
    };
    let tag = device_admission(&group_key, &identity).unwrap();
    verify_device_admission(&group_key, &identity, &tag).unwrap();
    for changed in [
        DeviceIdentity {
            id: "attacker",
            ..identity
        },
        DeviceIdentity {
            name: "Trusted laptop",
            ..identity
        },
        DeviceIdentity {
            public_key: &[7; 32],
            ..identity
        },
    ] {
        assert!(verify_device_admission(&group_key, &changed, &tag).is_err());
    }
    assert!(verify_device_admission(&random_key().unwrap(), &identity, &tag).is_err());
    assert!(verify_device_admission(&group_key, &identity, &damaged(&tag)).is_err());
    assert!(verify_device_admission(&group_key, &identity, &tag[..31]).is_err());
    assert!(verify_device_admission(&group_key, &identity, &[0; 33]).is_err());

    let a = DeviceIdentity {
        id: "a",
        name: "bc",
        public_key: key.public_key(),
    };
    let b = DeviceIdentity {
        id: "ab",
        name: "c",
        public_key: key.public_key(),
    };
    assert_ne!(
        device_admission(&group_key, &a).unwrap(),
        device_admission(&group_key, &b).unwrap()
    );
}

#[test]
fn empty_and_maximum_plaintexts_roundtrip_and_larger_inputs_are_rejected() {
    let a = KeyPair::generate().unwrap();
    let b = KeyPair::generate().unwrap();
    let group_key: Key = random_key().unwrap();
    let purpose = DirectedPurpose::Transfer { item_id: "maximum" };
    for plaintext in [vec![], vec![0x5a; MAX_PLAINTEXT]] {
        let directed = seal_directed(&a, b.public_key(), purpose, &plaintext).unwrap();
        assert_eq!(
            open_directed(&b, a.public_key(), purpose, &directed).unwrap(),
            plaintext
        );
        let guest = create_guest("maximum", &plaintext).unwrap();
        assert_eq!(
            open_guest(&guest.recipient_secret, "maximum", &guest.ciphertext).unwrap(),
            plaintext
        );
        let saved = seal_saved(&group_key, "maximum", &plaintext).unwrap();
        assert_eq!(
            open_saved(&group_key, "maximum", &saved).unwrap(),
            plaintext
        );
    }
    let large = vec![0; MAX_PLAINTEXT + 1];
    assert_eq!(
        seal_directed(&a, b.public_key(), purpose, &large).unwrap_err(),
        Error::TooLarge
    );
    assert!(matches!(
        create_guest("large", &large),
        Err(Error::TooLarge)
    ));
    assert_eq!(
        seal_saved(&group_key, "large", &large).unwrap_err(),
        Error::TooLarge
    );
}

#[test]
fn malformed_versions_and_missing_contexts_are_rejected() {
    let group_key = random_key().unwrap();
    assert_eq!(
        open_saved(&group_key, "id", &[]).unwrap_err(),
        Error::InvalidInput
    );
    assert_eq!(
        open_saved(&group_key, "id", &[2]).unwrap_err(),
        Error::InvalidVersion
    );
    assert!(open_saved(&group_key, "id", &[1]).is_err());
    assert_eq!(
        seal_saved(&group_key, "", TEXT).unwrap_err(),
        Error::InvalidInput
    );
    assert!(create_guest(&"x".repeat(1025), TEXT).is_err());

    let guest = create_guest("id", TEXT).unwrap();
    let mut version = guest.ciphertext;
    version[0] = 2;
    assert_eq!(
        open_guest(&guest.recipient_secret, "id", &version).unwrap_err(),
        Error::InvalidVersion
    );
    let keys = KeyPair::generate().unwrap();
    let mut pairing = Pairing::responder(&keys, "id").unwrap();
    assert_eq!(pairing.read(&[2]).unwrap_err(), Error::InvalidVersion);
    assert!(pairing.finish().is_err());
}
