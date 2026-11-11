use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Item {
    pub id: String,
    pub kind: String,
    pub sender_id: String,
    pub recipient_id: Option<String>,
    pub payload: Option<String>,
    pub created_at: String,
    pub expires_at: Option<String>,
    pub burned_at: Option<String>,
    pub burn_reason: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub public_key: String,
    pub admission: Option<String>,
    pub created_at: String,
    pub revoked_at: Option<String>,
}

// This record stays on the device. The server only receives the public key,
// hashed bearer token, and an encrypted group-key grant.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct Session {
    pub origin: String,
    pub powersync_endpoint: String,
    pub device_id: String,
    pub name: String,
    pub private_key: String,
    pub device_token: String,
    pub group_key: String,
}

#[derive(Clone, Default, PartialEq, Serialize, Deserialize, nsh_core::prelude::JsObject)]
pub struct PairingView {
    pub code: String,
    pub fingerprint: String,
    pub peer_name: String,
    pub can_confirm: bool,
}

#[derive(Clone, Default, PartialEq, Serialize, Deserialize, nsh_core::prelude::JsObject)]
pub struct GuestView {
    pub id: String,
    pub expires_at: String,
    pub revealed: Option<String>,
    pub unavailable: bool,
}
