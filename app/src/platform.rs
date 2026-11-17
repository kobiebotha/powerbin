use crate::model::Session;

#[cfg(not(target_arch = "wasm32"))]
pub fn database_path(device_id: &str) -> Result<std::path::PathBuf, String> {
    #[cfg(target_os = "android")]
    let directory = crate::android_keyring::files_dir()?;
    #[cfg(not(target_os = "android"))]
    let directory = directories::ProjectDirs::from("dev", "PowerSync", "PowerBin")
        .ok_or("Device data directory unavailable")?
        .data_dir()
        .to_owned();
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    Ok(directory.join(format!("{device_id}.db")))
}

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(module = "/web/dist/adapter.js")]
extern "C" {
    #[wasm_bindgen(catch, js_name = load)]
    async fn js_load() -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = save)]
    async fn js_save(value: &str) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = copy)]
    async fn js_copy(value: &str) -> Result<JsValue, JsValue>;
}

pub async fn load() -> Result<Option<Session>, String> {
    #[cfg(target_arch = "wasm32")]
    let value = js_load().await.map_err(crate::db_web::error)?.as_string();
    #[cfg(not(target_arch = "wasm32"))]
    let value = nsh_core::prelude::blocking(crate::storage_native::load)
        .await
        .map_err(|e| e.to_string())??;
    value
        .map(|v| {
            let session: Session = serde_json::from_str(&v).map_err(|e| e.to_string())?;
            session.validate_crypto_version()?;
            // Reading local keys is safe even for a legacy HTTP URL. Controller
            // restore validates before any network request and offers correction.
            Ok(session)
        })
        .transpose()
}

pub async fn save(session: &Session) -> Result<(), String> {
    session.validate_crypto_version()?;
    session.validate_transport()?;
    let value = serde_json::to_string(session).map_err(|e| e.to_string())?;
    #[cfg(target_arch = "wasm32")]
    js_save(&value).await.map_err(crate::db_web::error)?;
    #[cfg(not(target_arch = "wasm32"))]
    nsh_core::prelude::blocking(move || crate::storage_native::save(&value))
        .await
        .map_err(|e| e.to_string())??;
    Ok(())
}

pub async fn copy(value: &str) -> Result<(), String> {
    #[cfg(target_arch = "wasm32")]
    js_copy(value).await.map_err(crate::db_web::error)?;
    #[cfg(not(target_arch = "wasm32"))]
    nsh_core::prelude::set_clipboard(value);
    Ok(())
}

pub fn web_origin() -> String {
    #[cfg(target_arch = "wasm32")]
    if let Some(window) = web_sys::window() {
        if let Ok(origin) = window.location().origin() {
            return origin;
        }
    }
    option_env!("POWERBIN_WEB_ORIGIN").unwrap_or("").into()
}

/// The public app address is display-only; pairing still requires the code
/// exchange and fingerprint comparison on both devices.
pub fn pairing_url() -> String {
    #[cfg(target_arch = "wasm32")]
    let source = web_sys::window().and_then(|window| window.location().href().ok());
    #[cfg(not(target_arch = "wasm32"))]
    let source = option_env!("POWERBIN_WEB_ORIGIN").map(str::to_owned);
    clean_pairing_url(source.as_deref())
}

fn clean_pairing_url(value: Option<&str>) -> String {
    let Some(mut url) = value.and_then(|value| reqwest::Url::parse(value.trim()).ok()) else {
        return String::new();
    };
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return String::new();
    }
    // Never include a guest link, its decryption key, or another page's query
    // parameters in the address shared with a new device.
    url.set_query(None);
    url.set_fragment(None);
    url.into()
}

pub fn guest_link() -> Option<(String, String)> {
    #[cfg(target_arch = "wasm32")]
    {
        let window = web_sys::window()?;
        let url = reqwest::Url::parse(&window.location().href().ok()?).ok()?;
        let id = url
            .query_pairs()
            .find(|(key, _)| key == "link")?
            .1
            .into_owned();
        let secret = url.fragment().unwrap_or_default().to_owned();
        // Remove the decryption key from the address bar before any network call.
        let clean = format!(
            "{}{}?link={id}",
            url.origin().ascii_serialization(),
            url.path()
        );
        window
            .history()
            .ok()?
            .replace_state_with_url(&JsValue::NULL, "", Some(&clean))
            .ok()?;
        return Some((id, secret));
    }
    #[cfg(not(target_arch = "wasm32"))]
    None
}

#[cfg(test)]
mod tests {
    use super::clean_pairing_url;

    #[test]
    fn pairing_url_uses_the_actual_custom_domain_and_preserves_the_app_path() {
        assert_eq!(
            clean_pairing_url(Some("https://CUSTOM.example:443/powerbin/index.html")),
            "https://custom.example/powerbin/index.html"
        );
        assert_eq!(
            clean_pairing_url(Some("http://localhost:8080")),
            "http://localhost:8080/"
        );
    }

    #[test]
    fn pairing_url_strips_query_and_fragment_secrets() {
        assert_eq!(
            clean_pairing_url(Some(
                "https://relay.example/app/?link=guest&other=value#secret-key"
            )),
            "https://relay.example/app/"
        );
    }

    #[test]
    fn pairing_url_requires_a_configured_http_address_without_credentials() {
        for value in [
            None,
            Some(""),
            Some(" "),
            Some("relay.example"),
            Some("file:///app/index.html"),
            Some("javascript:alert(1)"),
            Some("ftp://relay.example/"),
            Some("https://user:password@relay.example/"),
            Some("https://user@relay.example/"),
        ] {
            assert!(clean_pairing_url(value).is_empty(), "{value:?}");
        }
    }
}
