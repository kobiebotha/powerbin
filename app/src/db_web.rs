use crate::model::{Device, Item, Session};
use serde::{Deserialize, Serialize};
use std::rc::Rc;
use wasm_bindgen::{JsCast, prelude::*};

#[wasm_bindgen(module = "/web/dist/adapter.js")]
extern "C" {
    #[wasm_bindgen(catch, js_name = connect)]
    async fn js_connect(config: JsValue) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(js_name = watch)]
    fn js_watch(callback: &js_sys::Function) -> js_sys::Function;
    #[wasm_bindgen(catch, js_name = insertMany)]
    async fn js_insert_many(items: JsValue) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = consume)]
    async fn js_consume(id: &str) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = burn)]
    async fn js_burn(id: &str) -> Result<JsValue, JsValue>;
}

#[derive(Deserialize)]
pub struct Snapshot {
    pub items: Vec<Item>,
    pub devices: Vec<Device>,
    pub connected: bool,
    pub error: Option<String>,
}

#[derive(Clone)]
pub struct Database {
    _subscription: Rc<Subscription>,
}

struct Subscription {
    _listener: Closure<dyn FnMut(JsValue)>,
    unsubscribe: js_sys::Function,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        let _ = self.unsubscribe.call0(&JsValue::UNDEFINED);
    }
}

pub async fn connect(
    session: &Session,
    on_change: impl Fn(Snapshot) + 'static,
) -> Result<Database, String> {
    let config = serde_json::json!({
        "backend_url": session.origin,
        "device_id": session.device_id,
        "device_token": session.device_token,
    });
    js_connect(
        config
            .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
            .map_err(|e| e.to_string())?,
    )
    .await
    .map_err(error)?;
    let listener = Closure::new(move |value| {
        if let Ok(snapshot) = serde_wasm_bindgen::from_value(value) {
            on_change(snapshot);
        }
    });
    let unsubscribe = js_watch(listener.as_ref().unchecked_ref());
    Ok(Database {
        _subscription: Rc::new(Subscription {
            _listener: listener,
            unsubscribe,
        }),
    })
}

impl Database {
    pub async fn insert(&self, item: &Item) -> Result<(), String> {
        self.insert_many(std::slice::from_ref(item)).await
    }
    pub async fn insert_many(&self, items: &[Item]) -> Result<(), String> {
        if items.is_empty() {
            return Ok(());
        }
        js_insert_many(
            items
                .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
                .map_err(|e| e.to_string())?,
        )
        .await
        .map_err(error)?;
        Ok(())
    }
    pub async fn consume(&self, id: &str) -> Result<(), String> {
        js_consume(id).await.map_err(error)?;
        Ok(())
    }
    pub async fn burn(&self, id: &str) -> Result<(), String> {
        js_burn(id).await.map_err(error)?;
        Ok(())
    }
}

pub fn error(value: JsValue) -> String {
    value
        .as_string()
        .or_else(|| {
            js_sys::Reflect::get(&value, &"message".into())
                .ok()?
                .as_string()
        })
        .unwrap_or_else(|| "Browser operation failed".into())
}
