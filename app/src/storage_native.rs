use keyring_core::{Entry, Error, api::CredentialStoreApi};

#[cfg(target_os = "android")]
use android_native_keyring_store::Store;
#[cfg(target_os = "macos")]
use apple_native_keyring_store::keychain::Store;
#[cfg(target_os = "ios")]
use apple_native_keyring_store::protected::Store;
#[cfg(target_os = "linux")]
use zbus_secret_service_keyring_store::Store;

const SERVICE: &str = "dev.powersync.relay";
const USER: &str = "session";

pub fn load() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(session) => Ok(Some(session)),
        Err(Error::NoEntry) => Ok(None),
        Err(Error::BadEncoding(_)) => Err("The secure session is not valid UTF-8".to_owned()),
        Err(error) => Err(error.to_string()),
    }
}

pub fn save(session: &str) -> Result<(), String> {
    entry()?.set_password(session).map_err(|e| e.to_string())
}

fn entry() -> Result<Entry, String> {
    #[cfg(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "android",
        target_os = "linux"
    ))]
    {
        // Android's host must initialize ndk-context with its application Context first.
        let store = Store::new().map_err(|e| e.to_string())?;
        #[cfg(target_os = "ios")]
        let modifiers = Some(std::collections::HashMap::from([(
            "access-policy",
            "when-unlocked-this-device-only",
        )]));
        #[cfg(not(target_os = "ios"))]
        let modifiers = None;
        store
            .build(SERVICE, USER, modifiers.as_ref())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "android",
        target_os = "linux"
    )))]
    Err("Secure session storage is unavailable on this platform".to_owned())
}
