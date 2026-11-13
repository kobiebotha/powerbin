use js_sys::Uint8Array;
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

/// Decrypt a guest payload with the same protocol as PowerBin's native and web apps.
/// The caller owns the lifetime of the JavaScript input and returned buffers.
#[wasm_bindgen(js_name = openGuest)]
pub fn open_guest(
    secret: Vec<u8>,
    item_id: &str,
    ciphertext: &[u8],
) -> Result<Uint8Array, JsError> {
    let secret = Zeroizing::new(secret);
    if secret.len() != 32 {
        return Err(JsError::new("The decryption key must contain 32 bytes"));
    }
    let mut key = Zeroizing::new([0; 32]);
    key.copy_from_slice(&secret);
    let plaintext = Zeroizing::new(
        native_shell_crypto::open_guest(&key, item_id, ciphertext)
            .map_err(|error| JsError::new(&error.to_string()))?,
    );
    // Copy into JavaScript before clearing Rust's plaintext allocation.
    Ok(Uint8Array::from(plaintext.as_slice()))
}
