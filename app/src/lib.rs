use nsh_core::prelude::*;
#[cfg(target_os = "android")]
#[path = "../android/keyring.rs"]
mod android_keyring;
mod bridge;
mod controller;
#[cfg(not(target_arch = "wasm32"))]
mod db_native;
#[cfg(target_arch = "wasm32")]
mod db_web;
mod model;
mod platform;
#[cfg(target_arch = "wasm32")]
mod random_web;
#[cfg(not(target_arch = "wasm32"))]
mod schema;
#[cfg(not(target_arch = "wasm32"))]
mod storage_native;
mod transport;

#[native_module("powerbin/native")]
fn native(registry: &mut Registry) {
    registry.module::<bridge::PowerBin>();
}
