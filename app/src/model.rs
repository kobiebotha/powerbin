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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RevokedDevice {
    pub id: String,
    pub public_key: String,
}

// This record stays on the device. The server only receives the public key,
// hashed bearer token, and an encrypted group-key grant.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct Session {
    #[serde(default)]
    pub crypto_version: u8,
    pub origin: String,
    pub powersync_endpoint: String,
    pub device_id: String,
    pub name: String,
    pub private_key: String,
    pub device_token: String,
    pub group_key: String,
    // Local decisions must survive a server replay and an app restart.
    #[serde(default)]
    pub revoked_devices: Vec<RevokedDevice>,
}

impl Session {
    pub fn validate_transport(&self) -> Result<(), String> {
        crate::transport::origin(&self.origin)?;
        if !self.powersync_endpoint.is_empty() {
            crate::transport::sync_endpoint(&self.origin, &self.powersync_endpoint)?;
        }
        Ok(())
    }

    /// Preserve this device's identity while the user corrects a legacy URL.
    pub fn upgrade_transport(&self, new_origin: &str) -> Result<Self, String> {
        let old = reqwest::Url::parse(&self.origin).map_err(|_| "Invalid saved server URL")?;
        let new = crate::transport::origin(new_origin)?;
        if !matches!(old.scheme(), "http" | "https")
            || new.scheme() != "https"
            || old.host_str() != new.host_str()
            || !old.username().is_empty()
            || old.password().is_some()
            || old.path() != "/"
            || old.query().is_some()
            || old.fragment().is_some()
        {
            return Err(
                "To recover this device, enter the HTTPS URL for the same saved server hostname."
                    .into(),
            );
        }
        let mut session = self.clone();
        session.origin = new.as_str().trim_end_matches('/').to_owned();
        // Fetch current credentials over the corrected origin before reconnecting.
        session.powersync_endpoint.clear();
        Ok(session)
    }

    pub fn is_locally_revoked(&self, device: &Device) -> bool {
        self.revoked_devices
            .iter()
            .any(|revoked| revoked.id == device.id || revoked.public_key == device.public_key)
    }

    pub fn validate_crypto_version(&self) -> Result<(), String> {
        if self.crypto_version != native_shell_crypto::PROTOCOL_VERSION {
            return Err("This demo session uses an incompatible encryption protocol. Clear its local session and set it up again.".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod transport_tests {
    use super::Session;

    #[test]
    fn restored_sessions_reject_insecure_api_and_sync_urls() {
        let mut session: Session = serde_json::from_value(serde_json::json!({
            "crypto_version": native_shell_crypto::PROTOCOL_VERSION,
            "origin": "https://powerbin.test", "powersync_endpoint": "https://sync.test",
            "device_id": "dummy-device", "name": "Test device", "private_key": "dummy-key",
            "device_token": "dummy-token", "group_key": "dummy-group-key"
        }))
        .unwrap();
        assert!(session.validate_transport().is_ok());
        session.origin = "http://powerbin.test".into();
        assert!(session.validate_transport().is_err());
        session.origin = "https://powerbin.test".into();
        session.powersync_endpoint = "http://sync.test".into();
        assert!(session.validate_transport().is_err());
        session.powersync_endpoint = "http://127.0.0.1:8080".into();
        assert!(session.validate_transport().is_err());
        session.powersync_endpoint.clear();
        assert!(
            session.validate_transport().is_ok(),
            "unfinished secure setup can be saved"
        );
    }

    #[test]
    fn correcting_a_saved_http_origin_preserves_identity_and_refuses_another_host() {
        let session: Session = serde_json::from_value(serde_json::json!({
            "crypto_version": native_shell_crypto::PROTOCOL_VERSION,
            "origin": "http://powerbin.test", "powersync_endpoint": "http://sync.test",
            "device_id": "dummy-device", "name": "Test device", "private_key": "dummy-key",
            "device_token": "dummy-token", "group_key": "dummy-group-key",
            "revoked_devices": [{"id": "revoked-peer", "public_key": "revoked-key"}]
        }))
        .unwrap();
        assert!(session.upgrade_transport("https://another.test").is_err());
        assert!(session.upgrade_transport("http://powerbin.test").is_err());
        let upgraded = session.upgrade_transport("https://powerbin.test").unwrap();
        assert!(upgraded.validate_transport().is_ok());
        assert_eq!(upgraded.origin, "https://powerbin.test");
        assert!(upgraded.powersync_endpoint.is_empty());
        assert_eq!(upgraded.device_id, session.device_id);
        assert_eq!(upgraded.private_key, session.private_key);
        assert_eq!(upgraded.device_token, session.device_token);
        assert_eq!(upgraded.group_key, session.group_key);
        assert_eq!(upgraded.revoked_devices, session.revoked_devices);
    }
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
