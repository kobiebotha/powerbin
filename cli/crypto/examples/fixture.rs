use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

fn main() {
    let id = "70f39f7d-13a0-4f4f-bfb8-39c0c8f16c52";
    let plaintext = "Hello, 世界!\nsecond line\t✓";
    let guest = native_shell_crypto::create_guest(id, plaintext.as_bytes()).unwrap();
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "id": id,
            "key": URL_SAFE_NO_PAD.encode(guest.recipient_secret.as_ref()),
            "payload": URL_SAFE_NO_PAD.encode(guest.ciphertext),
            "plaintext": plaintext,
        }))
        .unwrap()
    );
}
