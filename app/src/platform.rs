use crate::model::Session;

#[cfg(not(target_arch = "wasm32"))]
pub fn database_path(device_id: &str) -> Result<std::path::PathBuf, String> {
    #[cfg(target_os = "android")]
    let directory = crate::android_keyring::files_dir()?;
    #[cfg(not(target_os = "android"))]
    // Keep the original storage namespace across app renames.
    let directory = directories::ProjectDirs::from("dev", "PowerSync", "Relay")
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
        .map(|v| serde_json::from_str(&v).map_err(|e| e.to_string()))
        .transpose()
}

pub async fn save(session: &Session) -> Result<(), String> {
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
    option_env!("RELAY_WEB_ORIGIN").unwrap_or("").into()
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
