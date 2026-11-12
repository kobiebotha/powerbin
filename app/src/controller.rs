use crate::model::{Device, GuestView, Item, PairingView, Session};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use native_shell_crypto::{self as crypto, DirectedPurpose, Key, KeyPair, PublicKey};
use nsh_core::prelude::*;
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{cell::RefCell, collections::HashSet, rc::Rc, time::Duration};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

#[cfg(not(target_arch = "wasm32"))]
use crate::db_native as db;
#[cfg(target_arch = "wasm32")]
use crate::db_web as db;

#[derive(Clone, Copy)]
pub struct Ui {
    pub session: Signal<Option<Session>>,
    pub items: Signal<Vec<Item>>,
    pub devices: Signal<Vec<Device>>,
    pub draft: Signal<String>,
    pub recipient: Signal<String>,
    pub tab: Signal<String>,
    pub status: Signal<String>,
    pub error: Signal<String>,
    pub busy: Signal<bool>,
    pub origin: Signal<String>,
    pub name: Signal<String>,
    pub device_name: Signal<String>,
    pub code: Signal<String>,
    pub bootstrap_token: Signal<String>,
    pub pairing: Signal<Option<PairingView>>,
    pub guest: Signal<Option<GuestView>>,
    pub output: Signal<String>,
}

pub enum Action {
    Bootstrap,
    StartPairing,
    ApproveCode,
    ConfirmPairing,
    CancelPairing,
    UnpairDevice(String),
    RenameDevice(String),
    Send,
    Save,
    CreateLink,
    CopyBurn(String),
    CopySaved(String),
    Burn(String),
    Reveal,
    CopyOutput,
}

#[derive(Clone)]
pub struct Controller {
    pub ui: Ui,
    database: Rc<RefCell<Option<db::Database>>>,
    pairing: Rc<RefCell<Option<PendingPairing>>>,
    guest_key: Rc<RefCell<Option<Key>>>,
    active_task: Rc<RefCell<Option<Spawned<()>>>>,
    locally_revoked: Rc<RefCell<HashSet<String>>>,
    clock: Signal<i64>,
    owner: Owner,
}

#[derive(Clone)]
struct PendingPairing {
    id: String,
    candidate: bool,
    session: Session,
    peer: crypto::CompletedPairing,
    peer_device_id: String,
    peer_name: String,
}

#[derive(Deserialize)]
struct Rendezvous {
    id: String,
    #[serde(default)]
    code: String,
    #[serde(default)]
    device_id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    public_key: String,
    #[serde(default)]
    messages: Vec<String>,
}

#[derive(Deserialize)]
struct ServerSession {
    device: GrantedDevice,
    powersync: Endpoint,
}
#[derive(Deserialize)]
struct GrantedDevice {
    shared_key_envelope: String,
}
#[derive(Deserialize)]
struct Endpoint {
    endpoint: String,
}

#[derive(Deserialize)]
struct RevocationReply {
    revoked: bool,
}

#[derive(Deserialize)]
struct RenameReply {
    device: Device,
}

impl Controller {
    pub fn start() -> Self {
        let ui = Ui {
            session: signal(None),
            items: signal(vec![]),
            devices: signal(vec![]),
            draft: signal(String::new()),
            recipient: signal(String::new()),
            tab: signal("send".into()),
            status: signal("Opening your device…".into()),
            error: signal(String::new()),
            busy: signal(true),
            origin: signal(
                option_env!("POWERBIN_API_ORIGIN")
                    .map(str::to_owned)
                    .unwrap_or_else(crate::platform::web_origin),
            ),
            name: signal("My device".into()),
            device_name: signal(String::new()),
            code: signal(String::new()),
            bootstrap_token: signal(String::new()),
            pairing: signal(None),
            guest: signal(None),
            output: signal(String::new()),
        };
        let clock = signal(OffsetDateTime::now_utc().unix_timestamp());
        set_interval(Duration::from_secs(1), move || {
            clock.set(OffsetDateTime::now_utc().unix_timestamp())
        });
        let controller = Self {
            ui,
            database: Default::default(),
            pairing: Default::default(),
            guest_key: Default::default(),
            active_task: Default::default(),
            locally_revoked: Default::default(),
            clock,
            owner: Owner::current(),
        };
        let c = controller.clone();
        spawn(async move {
            let result = if let Some((id, key)) = crate::platform::guest_link() {
                c.open_guest(id, key).await
            } else {
                match crate::platform::load().await {
                    Ok(Some(session)) => c.restore(session).await,
                    Ok(None) => {
                        ui.status
                            .set("A private little connection between your devices.".into());
                        Ok(())
                    }
                    Err(error) => Err(error),
                }
            };
            if let Err(error) = result {
                ui.error.set(error);
            }
            ui.busy.set(false);
        });
        controller
    }

    pub fn dispatch(&self, action: Action) {
        if matches!(action, Action::CancelPairing) {
            if let Some(task) = self.active_task.borrow_mut().take() {
                task.cancel();
            }
            self.pairing.borrow_mut().take();
            self.ui.pairing.set(None);
            self.ui.busy.set(false);
            self.ui.status.set("Pairing cancelled".into());
            return;
        }
        if self.ui.busy.get() {
            return;
        }
        self.ui.busy.set(true);
        self.ui.error.set(String::new());
        let c = self.clone();
        // A send or pairing task belongs to the app, so changing tabs or
        // replacing the setup screen cannot cancel it halfway through.
        let task = self.owner.run(|| {
            spawn(async move {
                if let Err(error) = c.perform(action).await {
                    c.ui.error.set(error);
                }
                c.ui.busy.set(false);
            })
        });
        *self.active_task.borrow_mut() = Some(task);
    }

    async fn perform(&self, action: Action) -> Result<(), String> {
        match action {
            Action::Bootstrap => self.bootstrap().await,
            Action::StartPairing => self.start_pairing().await,
            Action::ApproveCode => self.approve_code().await,
            Action::ConfirmPairing => self.confirm_pairing().await,
            Action::CancelPairing => Ok(()),
            Action::UnpairDevice(id) => self.unpair_device(&id).await,
            Action::RenameDevice(id) => self.rename_device(&id).await,
            Action::Send => self.write("transfer").await,
            Action::Save => self.write("saved").await,
            Action::CreateLink => self.write("link").await,
            Action::CopyBurn(id) => {
                let item = self.item(&id)?;
                crate::platform::copy(&self.plaintext(&item)?).await?;
                self.database()?.consume(&id).await?;
                self.ui
                    .status
                    .set("Copied. Burn queued on this device.".into());
                Ok(())
            }
            Action::CopySaved(id) => {
                crate::platform::copy(&self.plaintext(&self.item(&id)?)?).await
            }
            Action::Burn(id) => self.database()?.burn(&id).await,
            Action::Reveal => self.reveal().await,
            Action::CopyOutput => {
                let value = self
                    .ui
                    .guest
                    .get()
                    .and_then(|g| g.revealed)
                    .unwrap_or_else(|| self.ui.output.get());
                crate::platform::copy(&value).await
            }
        }
    }

    fn session(&self) -> Result<Session, String> {
        self.ui.session.get().ok_or("Pair this device first".into())
    }
    fn database(&self) -> Result<db::Database, String> {
        self.database
            .borrow()
            .clone()
            .ok_or("Database is opening".into())
    }
    fn item(&self, id: &str) -> Result<Item, String> {
        self.ui
            .items
            .get()
            .into_iter()
            .find(|i| i.id == id)
            .ok_or("Item unavailable".into())
    }

    pub fn trusted_devices(&self) -> Vec<Device> {
        let Some(session) = self.ui.session.get() else {
            return vec![];
        };
        verified_devices(&session, self.current_devices())
    }

    fn current_devices(&self) -> Vec<Device> {
        without_locally_revoked(self.ui.devices.get(), &self.locally_revoked.borrow())
    }

    async fn unpair_device(&self, id: &str) -> Result<(), String> {
        let session = self.session()?;
        let target = unpair_target(&session, self.current_devices(), id)?;
        let response = request_with_method(
            &session.origin,
            &session.device_token,
            &format!("/api/devices/{}", target.id),
            reqwest::Method::DELETE,
            None,
        )
        .await;
        let mut devices = self.ui.devices.get();
        let mut recipient = self.ui.recipient.get();
        apply_unpair_result(
            &target.id,
            response,
            &mut devices,
            &mut recipient,
            &mut self.locally_revoked.borrow_mut(),
        )?;
        self.ui.devices.set(devices);
        self.ui.recipient.set(recipient);
        self.ui.status.set(format!("Unpaired {}.", target.name));
        Ok(())
    }

    async fn rename_device(&self, id: &str) -> Result<(), String> {
        let session = self.session()?;
        let devices = self.current_devices();
        let expected = prepare_rename(&session, devices, id, &self.ui.device_name.get())?;
        let response = request(
            &session.origin,
            &session.device_token,
            &format!("/api/devices/{id}/rename"),
            Some(json!({ "name": expected.name, "admission": expected.admission })),
        )
        .await;
        let renamed =
            confirm_rename_result(&session, &expected, response, &self.current_devices())?;
        // Displayed names and admission proofs come only from ordered SDK
        // snapshots, so a delayed HTTP reply cannot replace a newer rename.
        self.ui.device_name.set(renamed.name.clone());
        self.ui.status.set("Device name saved · syncing".into());
        if renamed.id == session.device_id {
            let session = session_after_rename(session, &renamed);
            self.ui.name.set(session.name.clone());
            self.ui.session.set(Some(session.clone()));
            if let Err(error) = crate::platform::save(&session).await {
                return Err(format!(
                    "Device renamed on the server, but its name could not be saved on this device: {error}"
                ));
            }
        }
        Ok(())
    }

    pub fn plaintext(&self, item: &Item) -> Result<String, String> {
        if item.burned_at.is_some() || expired(item.expires_at.as_deref()) {
            return Err("This item has burned".into());
        }
        let session = self.session()?;
        let payload = B64
            .decode(item.payload.as_deref().ok_or("This item has burned")?)
            .map_err(show)?;
        let plaintext = if item.kind == "saved" {
            crypto::open_saved(&key(&session.group_key)?, &item.id, &payload).map_err(show)?
        } else {
            let sender = self
                .trusted_devices()
                .into_iter()
                .find(|d| d.id == item.sender_id)
                .ok_or("Sender is not trusted")?;
            crypto::open_directed(
                &KeyPair::from_private(key(&session.private_key)?),
                &public_key(&sender.public_key)?,
                DirectedPurpose::Transfer { item_id: &item.id },
                &payload,
            )
            .map_err(show)?
        };
        String::from_utf8(plaintext).map_err(show)
    }

    pub fn available(&self, item: &Item) -> bool {
        let _ = self.clock.get();
        item.payload.is_some() && item.burned_at.is_none() && !expired(item.expires_at.as_deref())
    }

    async fn restore(&self, mut session: Session) -> Result<(), String> {
        session.validate_crypto_version()?;
        if session.powersync_endpoint.is_empty() {
            self.ui.origin.set(session.origin.clone());
            self.ui.name.set(session.name.clone());
            let remote: ServerSession = request(&session.origin, &session.device_token, "/api/session", None)
                .await.map_err(|_| "Setup has not finished. Enter the setup token to retry with this device’s saved keys.".to_owned())?;
            session.powersync_endpoint = remote.powersync.endpoint;
            crate::platform::save(&session).await?;
        }
        self.open(session).await
    }

    async fn open(&self, session: Session) -> Result<(), String> {
        session.validate_crypto_version()?;
        if self
            .ui
            .session
            .get()
            .is_none_or(|current| current.device_id != session.device_id)
        {
            self.locally_revoked.borrow_mut().clear();
        }
        self.ui.session.set(Some(session.clone()));
        self.ui.name.set(session.name.clone());
        self.ui.origin.set(session.origin.clone());
        let ui = self.ui;
        ui.status.set("Opening local database…".into());
        #[cfg(not(target_arch = "wasm32"))]
        let database = {
            use futures_lite::StreamExt;
            let path = crate::platform::database_path(&session.device_id)?;
            let database = db::connect(
                path.to_str().ok_or("Invalid database path")?,
                &session.origin,
                &session.device_token,
                &session.powersync_endpoint,
            )
            .await?;
            ui.status
                .set(sync_status(database.status().is_connected()).into());
            let closing = database.clone();
            let runtime = tokio::runtime::Handle::current();
            cleanup(move || {
                runtime.spawn(async move {
                    closing.disconnect().await;
                });
            });
            let items = database.watch_items();
            spawn(async move {
                futures_lite::pin!(items);
                while let Some(rows) = items.next().await {
                    match rows {
                        Ok(rows) => ui.items.set(rows),
                        Err(error) => ui.error.set(error),
                    }
                }
            });
            let devices = database.watch_devices();
            let locally_revoked = self.locally_revoked.clone();
            spawn(async move {
                futures_lite::pin!(devices);
                while let Some(rows) = devices.next().await {
                    match rows {
                        Ok(rows) => ui
                            .devices
                            .set(without_locally_revoked(rows, &locally_revoked.borrow())),
                        Err(error) => ui.error.set(error),
                    }
                }
            });
            let status_db = database.clone();
            spawn(async move {
                let status = status_db.watch_status();
                futures_lite::pin!(status);
                while let Some(status) = status.next().await {
                    ui.status.set(sync_status(status.is_connected()).into());
                    if let Some(error) = status.any_error() {
                        ui.error.set(error.to_string());
                    }
                    if let Some(error) = status_db.upload_error() {
                        ui.error.set(error);
                    }
                }
            });
            database
        };
        #[cfg(target_arch = "wasm32")]
        let database = {
            use futures_lite::StreamExt;
            let (send, mut snapshots) = futures_channel::mpsc::unbounded();
            let database = db::connect(&session, move |snapshot| {
                let _ = send.unbounded_send(snapshot);
            })
            .await?;
            let locally_revoked = self.locally_revoked.clone();
            // Browser callbacks wake this owned task; only the task writes UI signals.
            spawn(async move {
                while let Some(snapshot) = snapshots.next().await {
                    ui.items.set(snapshot.items);
                    ui.devices.set(without_locally_revoked(
                        snapshot.devices,
                        &locally_revoked.borrow(),
                    ));
                    ui.status.set(sync_status(snapshot.connected).into());
                    if let Some(error) = snapshot.error {
                        ui.error.set(error);
                    }
                }
            });
            database
        };
        *self.database.borrow_mut() = Some(database);
        Ok(())
    }

    fn new_session(&self) -> Result<Session, String> {
        let origin = self.ui.origin.get().trim_end_matches('/').to_owned();
        let url = reqwest::Url::parse(&origin).map_err(|_| "Enter a valid PowerBin server URL")?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            return Err("Enter an http or https PowerBin server URL".into());
        }
        let name = self.ui.name.get().trim().to_owned();
        if name.is_empty() || name.len() > 80 {
            return Err("Give this device a name of 1–80 characters".into());
        }
        let private = crypto::random_key().map_err(show)?;
        Ok(Session {
            crypto_version: crypto::PROTOCOL_VERSION,
            origin,
            powersync_endpoint: String::new(),
            device_id: new_id()?,
            name,
            private_key: B64.encode(private),
            device_token: B64.encode(crypto::random_key().map_err(show)?),
            group_key: String::new(),
        })
    }

    async fn bootstrap(&self) -> Result<(), String> {
        let settings = self.new_session()?;
        let mut session = match crate::platform::load().await? {
            Some(pending) if pending.powersync_endpoint.is_empty() => pending,
            Some(_) => {
                return Err("This device is already paired. Reopen PowerBin to continue.".into());
            }
            _ => settings.clone(),
        };
        session.origin = settings.origin;
        session.name = settings.name;
        if session.group_key.is_empty() {
            session.group_key = B64.encode(crypto::random_key().map_err(show)?);
        }
        // Persist identity before enrolling it, so a lost HTTP reply cannot
        // strand the installation without its only private key.
        crate::platform::save(&session).await?;
        if let Ok(remote) =
            request::<ServerSession>(&session.origin, &session.device_token, "/api/session", None)
                .await
        {
            session.powersync_endpoint = remote.powersync.endpoint;
            crate::platform::save(&session).await?;
            return self.open(session).await;
        }
        let group = key(&session.group_key)?;
        let keys = KeyPair::from_private(key(&session.private_key)?);
        let mut body = identity(&session, &keys);
        body["shared_key_envelope"] = B64
            .encode(
                crypto::seal_directed(
                    &keys,
                    keys.public_key(),
                    DirectedPurpose::GroupKey {
                        device_id: &session.device_id,
                    },
                    &group,
                )
                .map_err(show)?,
            )
            .into();
        body["admission"] =
            admission(&session.device_id, &session.name, keys.public_key(), &group)?.into();
        let _: Value = request(
            &session.origin,
            &self.ui.bootstrap_token.get(),
            "/api/bootstrap",
            Some(body),
        )
        .await?;
        self.ui.bootstrap_token.set(String::new());
        self.restore(session).await
    }

    async fn start_pairing(&self) -> Result<(), String> {
        let session = self.new_session()?;
        let keys = KeyPair::from_private(key(&session.private_key)?);
        let entry: Rendezvous = request(
            &session.origin,
            "",
            "/api/pairings",
            Some(identity(&session, &keys)),
        )
        .await?;
        self.ui.pairing.set(Some(PairingView {
            code: entry.code,
            ..Default::default()
        }));
        let mut handshake = crypto::Pairing::initiator(&keys, &entry.id).map_err(show)?;
        self.message(&session, &entry.id, 1, handshake.write().map_err(show)?)
            .await?;
        let remote = self.wait_message(&session, &entry.id, 2).await?;
        handshake
            .read(&B64.decode(&remote.messages[1]).map_err(show)?)
            .map_err(show)?;
        self.message(&session, &entry.id, 3, handshake.write().map_err(show)?)
            .await?;
        self.show_pairing(PendingPairing {
            id: entry.id,
            candidate: true,
            session,
            peer: handshake.finish().map_err(show)?,
            peer_device_id: String::new(),
            peer_name: "Your paired device".into(),
        });
        Ok(())
    }

    async fn approve_code(&self) -> Result<(), String> {
        let session = self.session()?;
        let code = self.ui.code.get().trim().replace('-', "");
        let entry: Rendezvous = request(
            &session.origin,
            &session.device_token,
            &format!("/api/pairings/code/{code}"),
            None,
        )
        .await?;
        let keys = KeyPair::from_private(key(&session.private_key)?);
        self.ui.pairing.set(Some(PairingView {
            peer_name: entry.name.clone(),
            ..Default::default()
        }));
        let mut handshake = crypto::Pairing::responder(&keys, &entry.id).map_err(show)?;
        let first = self.wait_message(&session, &entry.id, 1).await?;
        handshake
            .read(&B64.decode(&first.messages[0]).map_err(show)?)
            .map_err(show)?;
        self.message(&session, &entry.id, 2, handshake.write().map_err(show)?)
            .await?;
        let last = self.wait_message(&session, &entry.id, 3).await?;
        handshake
            .read(&B64.decode(&last.messages[2]).map_err(show)?)
            .map_err(show)?;
        let peer = handshake.finish().map_err(show)?;
        if peer.remote_public_key != public_key(&entry.public_key)? {
            return Err("Pairing identity changed".into());
        }
        self.show_pairing(PendingPairing {
            id: entry.id,
            candidate: false,
            session,
            peer,
            peer_device_id: entry.device_id,
            peer_name: entry.name,
        });
        Ok(())
    }

    fn show_pairing(&self, pending: PendingPairing) {
        let code = self.ui.pairing.get().map(|p| p.code).unwrap_or_default();
        self.ui.pairing.set(Some(PairingView {
            code,
            fingerprint: pending
                .peer
                .handshake_hash
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect(),
            peer_name: pending.peer_name.clone(),
            can_confirm: true,
        }));
        *self.pairing.borrow_mut() = Some(pending);
    }

    async fn message(
        &self,
        session: &Session,
        id: &str,
        step: usize,
        message: Vec<u8>,
    ) -> Result<(), String> {
        let _: Value = request(
            &session.origin,
            &session.device_token,
            &format!("/api/pairings/{id}/messages"),
            Some(json!({ "step": step, "message": B64.encode(message) })),
        )
        .await?;
        Ok(())
    }

    async fn wait_message(
        &self,
        session: &Session,
        id: &str,
        count: usize,
    ) -> Result<Rendezvous, String> {
        for _ in 0..300 {
            let entry: Rendezvous = request(
                &session.origin,
                &session.device_token,
                &format!("/api/pairings/{id}"),
                None,
            )
            .await?;
            if entry.messages.len() >= count {
                return Ok(entry);
            }
            timer(Duration::from_secs(1)).await;
        }
        Err("Pairing expired. Start again.".into())
    }

    async fn confirm_pairing(&self) -> Result<(), String> {
        let pending = self
            .pairing
            .borrow()
            .clone()
            .ok_or("Finish the handshake first")?;
        let mut session = pending.session;
        let keys = KeyPair::from_private(key(&session.private_key)?);
        if !pending.candidate {
            let group = key(&session.group_key)?;
            let envelope = crypto::seal_directed(
                &keys,
                &pending.peer.remote_public_key,
                DirectedPurpose::GroupKey {
                    device_id: &pending.peer_device_id,
                },
                &group,
            )
            .map_err(show)?;
            let _: Value = request(&session.origin, &session.device_token, &format!("/api/pairings/{}/approve", pending.id),
                Some(json!({ "public_key": B64.encode(&pending.peer.remote_public_key), "shared_key_envelope": B64.encode(envelope),
                    "admission": admission(&pending.peer_device_id, &pending.peer_name, &pending.peer.remote_public_key, &group)? }))).await?;
        } else {
            self.ui
                .status
                .set("Waiting for approval on your paired device…".into());
            let mut approved = None;
            for _ in 0..300 {
                if let Ok(remote) = request::<ServerSession>(
                    &session.origin,
                    &session.device_token,
                    "/api/session",
                    None,
                )
                .await
                {
                    approved = Some(remote);
                    break;
                }
                timer(Duration::from_secs(1)).await;
            }
            let remote = approved.ok_or("Pairing was not approved in time")?;
            let group = crypto::open_directed(
                &keys,
                &pending.peer.remote_public_key,
                DirectedPurpose::GroupKey {
                    device_id: &session.device_id,
                },
                &B64.decode(remote.device.shared_key_envelope)
                    .map_err(show)?,
            )
            .map_err(show)?;
            let group: Key = group.try_into().map_err(|_| "Invalid group key")?;
            session.group_key = B64.encode(group);
            session.powersync_endpoint = remote.powersync.endpoint;
            crate::platform::save(&session).await?;
            self.open(session).await?;
        }
        self.ui.pairing.set(None);
        self.pairing.borrow_mut().take();
        self.ui.status.set("Device paired. Ready to send.".into());
        Ok(())
    }

    async fn write(&self, kind: &str) -> Result<(), String> {
        let session = self.session()?;
        let text = self.ui.draft.get();
        if text.trim().is_empty() {
            return Err("Add something to send".into());
        }
        if kind == "transfer" {
            let items = prepare_transfers(
                &session,
                self.current_devices(),
                &self.ui.recipient.get(),
                &text,
                OffsetDateTime::now_utc(),
            )?;
            // Encrypt the entire batch before committing any local writes.
            self.database()?.insert_many(&items).await?;
            self.ui.draft.set(String::new());
            self.ui.status.set(format!(
                "Queued for {} {} · expires in an hour",
                items.len(),
                if items.len() == 1 {
                    "device"
                } else {
                    "devices"
                },
            ));
            return Ok(());
        }
        let id = new_id()?;
        let now = OffsetDateTime::now_utc();
        let mut item = Item {
            id: id.clone(),
            kind: kind.into(),
            sender_id: session.device_id.clone(),
            created_at: stamp(now),
            ..Default::default()
        };
        let ciphertext = match kind {
            "saved" => {
                crypto::seal_saved(&key(&session.group_key)?, &id, text.as_bytes()).map_err(show)?
            }
            "link" => {
                let guest = crypto::create_guest(&id, text.as_bytes()).map_err(show)?;
                item.expires_at = Some(stamp(now + time::Duration::hours(48)));
                item.payload = Some(B64.encode(guest.ciphertext));
                let result: Value = request(&session.origin, &session.device_token, "/api/upload",
                    Some(json!({ "batch": [{ "op": "PUT", "table": "items", "id": id, "opData": item }] }))).await?;
                if result["accepted"] != true {
                    return Err(result["error"].as_str().unwrap_or("Link rejected").into());
                }
                self.ui.output.set(format!(
                    "{}/?link={id}#{}",
                    crate::platform::web_origin(),
                    B64.encode(guest.recipient_secret.as_ref())
                ));
                self.ui
                    .status
                    .set("Link ready · one reveal · expires in 48 hours".into());
                self.ui.draft.set(String::new());
                return Ok(());
            }
            _ => return Err("Unknown snippet action".into()),
        };
        item.payload = Some(B64.encode(ciphertext));
        self.database()?.insert(&item).await?;
        self.ui.draft.set(String::new());
        self.ui
            .status
            .set("Saved on this device · syncing to your others".into());
        Ok(())
    }

    async fn open_guest(&self, id: String, secret: String) -> Result<(), String> {
        self.ui.status.set("Checking this link…".into());
        self.ui.guest.set(Some(GuestView {
            id: id.clone(),
            ..Default::default()
        }));
        *self.guest_key.borrow_mut() = Some(key(&secret).map_err(|_| {
            self.guest_error(
                "Open the original link, including its decryption key, to reveal this snippet."
                    .into(),
            )
        })?);
        let value: Value = request(&self.ui.origin.get(), "", &format!("/api/links/{id}"), None)
            .await
            .map_err(|error| self.guest_error(error))?;
        self.ui.guest.set(Some(GuestView {
            id,
            expires_at: value["expires_at"].as_str().unwrap_or_default().into(),
            revealed: None,
            unavailable: false,
        }));
        self.ui
            .status
            .set("Opening this page does not reveal the message.".into());
        Ok(())
    }

    fn guest_error(&self, error: String) -> String {
        self.ui.guest.update(|guest| {
            if let Some(guest) = guest {
                guest.unavailable = true;
            }
        });
        self.ui.status.set("Link unavailable".into());
        error
    }

    async fn reveal(&self) -> Result<(), String> {
        let mut guest = self.ui.guest.get().ok_or("Link unavailable")?;
        let secret = self
            .guest_key
            .borrow()
            .as_ref()
            .copied()
            .ok_or("Link already revealed")?;
        let value: Value = request(
            &self.ui.origin.get(),
            "",
            &format!("/api/links/{}/reveal", guest.id),
            Some(json!({})),
        )
        .await
        .map_err(|error| {
            self.ui.status.set("Link unavailable".into());
            error
        })?;
        let plaintext = crypto::open_guest(
            &secret,
            &guest.id,
            &B64.decode(value["payload"].as_str().ok_or("Link unavailable")?)
                .map_err(show)?,
        )
        .map_err(show)?;
        guest.revealed = Some(String::from_utf8(plaintext).map_err(show)?);
        self.guest_key.borrow_mut().take();
        self.ui.guest.set(Some(guest));
        self.ui
            .status
            .set("Revealed here. The server copy has burned.".into());
        Ok(())
    }
}

async fn request<T: DeserializeOwned>(
    origin: &str,
    token: &str,
    path: &str,
    body: Option<Value>,
) -> Result<T, String> {
    let method = if body.is_some() {
        reqwest::Method::POST
    } else {
        reqwest::Method::GET
    };
    request_with_method(origin, token, path, method, body).await
}

async fn request_with_method<T: DeserializeOwned>(
    origin: &str,
    token: &str,
    path: &str,
    method: reqwest::Method,
    body: Option<Value>,
) -> Result<T, String> {
    let client = reqwest::Client::new();
    let url = format!("{}{path}", origin.trim_end_matches('/'));
    let mut request = client.request(method, url);
    if let Some(body) = body {
        request = request.json(&body);
    }
    if !token.is_empty() {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.map_err(show)?;
    let status = response.status();
    let value: Value = response.json().await.map_err(show)?;
    if !status.is_success() {
        return Err(value["error"].as_str().unwrap_or("Request failed").into());
    }
    serde_json::from_value(value).map_err(show)
}

fn key(value: &str) -> Result<Key, String> {
    B64.decode(value)
        .map_err(show)?
        .try_into()
        .map_err(|_| "Invalid key length".into())
}

fn public_key(value: &str) -> Result<PublicKey, String> {
    let bytes = B64.decode(value).map_err(show)?;
    PublicKey::from_bytes(&bytes).map_err(show)
}

fn without_locally_revoked(
    mut devices: Vec<Device>,
    locally_revoked: &HashSet<String>,
) -> Vec<Device> {
    devices.retain(|device| !locally_revoked.contains(&device.id));
    devices
}

fn prepare_rename(
    session: &Session,
    devices: Vec<Device>,
    id: &str,
    proposed_name: &str,
) -> Result<Device, String> {
    let mut target = verified_devices(session, devices)
        .into_iter()
        .find(|device| device.id == id)
        .ok_or("This device is no longer a trusted paired device.")?;
    let name = proposed_name.trim();
    if name.is_empty() {
        return Err("Enter a device name.".into());
    }
    if name.len() > 64 {
        return Err("That name is too long. Try a shorter name.".into());
    }
    target.name = name.into();
    target.admission = Some(admission(
        &target.id,
        &target.name,
        &public_key(&target.public_key)?,
        &key(&session.group_key)?,
    )?);
    Ok(target)
}

fn confirm_rename_result(
    session: &Session,
    expected: &Device,
    response: Result<RenameReply, String>,
    devices: &[Device],
) -> Result<Device, String> {
    let renamed = response?.device;
    if renamed.id != expected.id
        || renamed.public_key != expected.public_key
        || renamed.name != expected.name
        || renamed.admission != expected.admission
        || verified_devices(session, vec![renamed.clone()]).is_empty()
    {
        return Err("The server returned an invalid device rename.".into());
    }
    verified_devices(session, devices.to_vec())
        .into_iter()
        .find(|device| {
            device.id == renamed.id
                && device.public_key == renamed.public_key
                && device.revoked_at.is_none()
        })
        .ok_or("The device is no longer available to rename.")?;
    Ok(renamed)
}

fn session_after_rename(mut session: Session, renamed: &Device) -> Session {
    if session.device_id == renamed.id {
        session.name = renamed.name.clone();
    }
    session
}

fn unpair_target(session: &Session, devices: Vec<Device>, id: &str) -> Result<Device, String> {
    if id == session.device_id {
        return Err("This device cannot unpair itself. Choose another paired device.".into());
    }
    verified_devices(session, devices)
        .into_iter()
        .find(|device| device.id == id)
        .ok_or("This device is no longer a trusted paired device.".into())
}

fn apply_unpair_result(
    id: &str,
    response: Result<RevocationReply, String>,
    devices: &mut Vec<Device>,
    recipient: &mut String,
    locally_revoked: &mut HashSet<String>,
) -> Result<(), String> {
    if !response?.revoked {
        return Err("The server did not confirm that the device was unpaired.".into());
    }
    // PowerSync may still emit its old local snapshot before the server change
    // arrives. Suppress that device for this session without editing synced rows.
    locally_revoked.insert(id.into());
    devices.retain(|device| device.id != id);
    if recipient.as_str() == id {
        recipient.clear();
    }
    Ok(())
}

fn verified_devices(session: &Session, devices: Vec<Device>) -> Vec<Device> {
    let Ok(group) = key(&session.group_key) else {
        return vec![];
    };
    devices
        .into_iter()
        .filter(|device| {
            let (Ok(public), Some(tag)) = (public_key(&device.public_key), &device.admission) else {
                return false;
            };
            let Ok(tag) = B64.decode(tag) else {
                return false;
            };
            device.revoked_at.is_none()
                && crypto::verify_device_admission(
                    &group,
                    &crypto::DeviceIdentity {
                        id: &device.id,
                        name: &device.name,
                        public_key: &public,
                    },
                    &tag,
                )
                .is_ok()
        })
        .collect()
}

fn prepare_transfers(
    session: &Session,
    devices: Vec<Device>,
    selected_recipient: &str,
    text: &str,
    now: OffsetDateTime,
) -> Result<Vec<Item>, String> {
    if text.trim().is_empty() {
        return Err("Add something to send".into());
    }
    let recipients: Vec<_> = verified_devices(session, devices)
        .into_iter()
        .filter(|device| {
            device.id != session.device_id
                && (selected_recipient.is_empty() || device.id == selected_recipient)
        })
        .collect();
    if recipients.is_empty() {
        return Err(if selected_recipient.is_empty() {
            "Pair another trusted device in Devices before sending"
        } else {
            "Choose a trusted paired device other than this device"
        }
        .into());
    }
    if recipients.len() > 100 {
        return Err("Too many recipients for one send. Select a single device (maximum 100 recipients per send).".into());
    }
    let sender = KeyPair::from_private(key(&session.private_key)?);
    let created_at = stamp(now);
    let expires_at = stamp(now + time::Duration::hours(1));
    let items: Vec<Item> = recipients
        .into_iter()
        .map(|recipient| {
            let id = new_id()?;
            let ciphertext = crypto::seal_directed(
                &sender,
                &public_key(&recipient.public_key)?,
                DirectedPurpose::Transfer { item_id: &id },
                text.as_bytes(),
            )
            .map_err(show)?;
            Ok(Item {
                id,
                kind: "transfer".into(),
                sender_id: session.device_id.clone(),
                recipient_id: Some(recipient.id),
                payload: Some(B64.encode(ciphertext)),
                created_at: created_at.clone(),
                expires_at: Some(expires_at.clone()),
                ..Default::default()
            })
        })
        .collect::<Result<_, String>>()?;
    // Include all Item fields, including nulls omitted by SQLite's upload data,
    // so this is a conservative bound on the existing API's 1 MiB request cap.
    let batch: Vec<_> = items
        .iter()
        .map(|item| json!({ "op": "PUT", "table": "items", "id": item.id, "opData": item }))
        .collect();
    if serde_json::to_vec(&json!({ "batch": batch }))
        .map_err(show)?
        .len()
        > 1024 * 1024
    {
        return Err("This snippet is too large to send to all these devices at once. Shorten it or select a single device.".into());
    }
    Ok(items)
}

fn sync_status(connected: bool) -> &'static str {
    if connected {
        "Connected · changes sync live"
    } else {
        "Offline · changes stay on this device until connected"
    }
}
fn show(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn new_id() -> Result<String, String> {
    let random = crypto::random_key().map_err(show)?;
    Ok(
        uuid::Builder::from_random_bytes(random[..16].try_into().unwrap())
            .into_uuid()
            .to_string(),
    )
}
fn stamp(value: OffsetDateTime) -> String {
    value.format(&Rfc3339).unwrap()
}
fn expired(value: Option<&str>) -> bool {
    value
        .and_then(|v| OffsetDateTime::parse(v, &Rfc3339).ok())
        .is_some_and(|v| v <= OffsetDateTime::now_utc())
}
fn identity(session: &Session, keys: &KeyPair) -> Value {
    json!({ "device_id": session.device_id, "name": session.name,
        "public_key": B64.encode(keys.public_key()), "device_token": session.device_token })
}
fn admission(id: &str, name: &str, public_key: &PublicKey, group: &Key) -> Result<String, String> {
    Ok(B64.encode(
        crypto::device_admission(
            group,
            &crypto::DeviceIdentity {
                id,
                name,
                public_key,
            },
        )
        .map_err(show)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const GROUP: Key = [9; 32];

    fn session() -> Session {
        Session {
            crypto_version: crypto::PROTOCOL_VERSION,
            origin: "http://localhost:18088".into(),
            powersync_endpoint: "http://localhost:18080".into(),
            device_id: "sender".into(),
            name: "Sender".into(),
            private_key: B64.encode([1; 32]),
            device_token: String::new(),
            group_key: B64.encode(GROUP),
        }
    }

    fn device(id: &str, secret: u8) -> Device {
        let keys = KeyPair::from_private([secret; 32]);
        Device {
            id: id.into(),
            name: id.into(),
            public_key: B64.encode(keys.public_key()),
            admission: Some(admission(id, id, keys.public_key(), &GROUP).unwrap()),
            ..Default::default()
        }
    }

    #[test]
    fn default_send_targets_only_other_trusted_active_devices() {
        let mut revoked = device("revoked", 4);
        revoked.revoked_at = Some(stamp(OffsetDateTime::UNIX_EPOCH));
        let mut unsigned = device("unsigned", 5);
        unsigned.admission = None;
        let mut forged = device("forged", 6);
        forged.name = "Changed after admission".into();
        let items = prepare_transfers(
            &session(),
            vec![
                device("sender", 1),
                device("one", 2),
                revoked,
                unsigned,
                device("two", 3),
                forged,
            ],
            "",
            "A private handoff",
            OffsetDateTime::UNIX_EPOCH,
        )
        .unwrap();
        assert_eq!(
            items
                .iter()
                .map(|item| item.recipient_id.as_deref().unwrap())
                .collect::<Vec<_>>(),
            ["one", "two"]
        );
    }

    #[test]
    fn explicit_recipient_never_falls_back_to_broadcast() {
        let devices = vec![device("sender", 1), device("one", 2), device("two", 3)];
        let items = prepare_transfers(
            &session(),
            devices.clone(),
            "two",
            "For one device",
            OffsetDateTime::UNIX_EPOCH,
        )
        .unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].recipient_id.as_deref(), Some("two"));
        for selected in ["sender", "missing"] {
            assert!(
                prepare_transfers(
                    &session(),
                    devices.clone(),
                    selected,
                    "Do not broadcast this",
                    OffsetDateTime::UNIX_EPOCH,
                )
                .unwrap_err()
                .contains("trusted paired device")
            );
        }
        let mut revoked = device("revoked", 4);
        revoked.revoked_at = Some(stamp(OffsetDateTime::UNIX_EPOCH));
        assert!(
            prepare_transfers(
                &session(),
                vec![device("one", 2), revoked],
                "revoked",
                "Do not redirect this",
                OffsetDateTime::UNIX_EPOCH,
            )
            .is_err()
        );
    }

    #[test]
    fn broadcast_copies_have_distinct_bound_ciphertexts_and_shared_expiry() {
        let now = OffsetDateTime::UNIX_EPOCH;
        let plaintext = "  Preserve this exact text.\n";
        let items = prepare_transfers(
            &session(),
            vec![device("one", 2), device("two", 3)],
            "",
            plaintext,
            now,
        )
        .unwrap();
        assert_ne!(items[0].id, items[1].id);
        assert_ne!(items[0].payload, items[1].payload);
        let sender = KeyPair::from_private([1; 32]);
        for (index, item) in items.iter().enumerate() {
            assert_eq!(item.kind, "transfer");
            assert_eq!(item.sender_id, "sender");
            assert_eq!(item.created_at, stamp(now));
            assert_eq!(
                item.expires_at.as_deref(),
                Some(stamp(now + time::Duration::hours(1)).as_str())
            );
            let recipient = KeyPair::from_private([index as u8 + 2; 32]);
            let ciphertext = B64.decode(item.payload.as_ref().unwrap()).unwrap();
            assert_eq!(
                crypto::open_directed(
                    &recipient,
                    sender.public_key(),
                    DirectedPurpose::Transfer { item_id: &item.id },
                    &ciphertext,
                )
                .unwrap(),
                plaintext.as_bytes()
            );
            assert!(
                crypto::open_directed(
                    &recipient,
                    sender.public_key(),
                    DirectedPurpose::Transfer {
                        item_id: &items[1 - index].id,
                    },
                    &ciphertext,
                )
                .is_err()
            );
            let other_recipient = KeyPair::from_private([3 - index as u8; 32]);
            assert!(
                crypto::open_directed(
                    &other_recipient,
                    sender.public_key(),
                    DirectedPurpose::Transfer { item_id: &item.id },
                    &ciphertext,
                )
                .is_err()
            );
        }
    }

    #[test]
    fn send_requires_text_and_an_eligible_other_device() {
        for devices in [vec![], vec![device("sender", 1)]] {
            assert!(
                prepare_transfers(
                    &session(),
                    devices,
                    "",
                    "A private handoff",
                    OffsetDateTime::UNIX_EPOCH,
                )
                .unwrap_err()
                .contains("Pair another trusted device")
            );
        }
        assert_eq!(
            prepare_transfers(
                &session(),
                vec![device("one", 2)],
                "",
                " \n\t ",
                OffsetDateTime::UNIX_EPOCH,
            )
            .unwrap_err(),
            "Add something to send"
        );
    }

    #[test]
    fn send_rejects_batches_over_the_existing_api_limits_before_queueing() {
        let too_many = (2..=102)
            .map(|index| device(&format!("device-{index}"), index))
            .collect();
        assert!(
            prepare_transfers(
                &session(),
                too_many,
                "",
                "A private handoff",
                OffsetDateTime::UNIX_EPOCH,
            )
            .unwrap_err()
            .contains("maximum 100 recipients")
        );
        let devices: Vec<_> = (2..=26)
            .map(|index| device(&format!("device-{index}"), index))
            .collect();
        let large_text = "🟩".repeat(8_000);
        assert!(
            prepare_transfers(
                &session(),
                devices.clone(),
                "",
                &large_text,
                OffsetDateTime::UNIX_EPOCH,
            )
            .unwrap_err()
            .contains("too large to send to all these devices")
        );
        assert_eq!(
            prepare_transfers(
                &session(),
                devices,
                "device-2",
                &large_text,
                OffsetDateTime::UNIX_EPOCH,
            )
            .unwrap()
            .len(),
            1
        );
    }

    #[test]
    fn unpair_requires_another_current_trusted_active_device() {
        let mut revoked = device("revoked", 4);
        revoked.revoked_at = Some(stamp(OffsetDateTime::UNIX_EPOCH));
        let mut unsigned = device("unsigned", 5);
        unsigned.admission = None;
        let mut forged = device("forged", 6);
        forged.name = "Changed after admission".into();
        let devices = vec![
            device("sender", 1),
            device("one", 2),
            revoked,
            unsigned,
            forged,
        ];
        assert_eq!(
            unpair_target(&session(), devices.clone(), "one")
                .unwrap()
                .id,
            "one"
        );
        for id in ["sender", "missing", "", "revoked", "unsigned", "forged"] {
            assert!(unpair_target(&session(), devices.clone(), id).is_err());
        }
    }

    #[test]
    fn confirmed_unpair_clears_only_the_removed_recipient_and_filters_stale_sync() {
        let original = vec![device("sender", 1), device("one", 2), device("two", 3)];
        let mut devices = original.clone();
        let mut recipient = "one".to_owned();
        let mut locally_revoked = HashSet::new();
        apply_unpair_result(
            "one",
            Ok(RevocationReply { revoked: true }),
            &mut devices,
            &mut recipient,
            &mut locally_revoked,
        )
        .unwrap();
        assert!(recipient.is_empty());
        assert_eq!(devices, vec![original[0].clone(), original[2].clone()]);
        let stale_snapshot = without_locally_revoked(original.clone(), &locally_revoked);
        assert_eq!(stale_snapshot, devices);
        assert!(unpair_target(&session(), stale_snapshot.clone(), "one").is_err());
        let transfers = prepare_transfers(
            &session(),
            stale_snapshot,
            "",
            "Only the remaining peer",
            OffsetDateTime::UNIX_EPOCH,
        )
        .unwrap();
        assert_eq!(transfers.len(), 1);
        assert_eq!(transfers[0].recipient_id.as_deref(), Some("two"));

        let mut recipient = "two".to_owned();
        apply_unpair_result(
            "one",
            Ok(RevocationReply { revoked: true }),
            &mut original.clone(),
            &mut recipient,
            &mut locally_revoked,
        )
        .unwrap();
        assert_eq!(recipient, "two");
    }

    #[test]
    fn failed_unpair_preserves_visible_membership_and_selection() {
        let original = vec![device("sender", 1), device("one", 2), device("two", 3)];
        for response in [
            Err("Server unavailable".to_owned()),
            Ok(RevocationReply { revoked: false }),
        ] {
            let mut devices = original.clone();
            let mut recipient = "one".to_owned();
            let mut locally_revoked = HashSet::new();
            assert!(
                apply_unpair_result(
                    "one",
                    response,
                    &mut devices,
                    &mut recipient,
                    &mut locally_revoked,
                )
                .is_err()
            );
            assert_eq!(devices, original);
            assert_eq!(recipient, "one");
            assert!(locally_revoked.is_empty());
        }
    }

    #[test]
    fn rename_trims_and_authenticates_exact_utf8_name_for_self_or_peer() {
        let devices = vec![device("sender", 1), device("one", 2)];
        let renamed = prepare_rename(&session(), devices.clone(), "one", "  My Mac 🟩\n").unwrap();
        assert_eq!(renamed.name, "My Mac 🟩");
        assert_ne!(renamed.admission, devices[1].admission);
        assert_eq!(verified_devices(&session(), vec![renamed.clone()]).len(), 1);
        let mut old_proof = renamed;
        old_proof.admission = devices[1].admission.clone();
        assert!(verified_devices(&session(), vec![old_proof]).is_empty());
        assert!(prepare_rename(&session(), devices.clone(), "sender", "This Mac").is_ok());
        assert!(prepare_rename(&session(), devices.clone(), "one", &"🟩".repeat(16)).is_ok());
        for name in [" \n\t ".into(), "🟩".repeat(17), "x".repeat(65)] {
            assert!(prepare_rename(&session(), devices.clone(), "one", &name).is_err());
        }
        let mut revoked = device("revoked", 3);
        revoked.revoked_at = Some(stamp(OffsetDateTime::UNIX_EPOCH));
        let mut unsigned = device("unsigned", 4);
        unsigned.admission = None;
        let devices = vec![device("one", 2), revoked, unsigned];
        for id in ["missing", "", "revoked", "unsigned"] {
            assert!(prepare_rename(&session(), devices.clone(), id, "New name").is_err());
        }
    }

    #[test]
    fn failed_or_untrusted_rename_reply_leaves_names_and_proofs_unchanged() {
        let original = vec![device("sender", 1), device("one", 2)];
        let expected = prepare_rename(&session(), original.clone(), "one", "New name").unwrap();
        let mut replies = vec![Err("Server unavailable".into())];
        let mut invalid = expected.clone();
        invalid.id = "other-device".into();
        replies.push(Ok(RenameReply { device: invalid }));
        let mut invalid = expected.clone();
        invalid.public_key = device("other", 3).public_key;
        replies.push(Ok(RenameReply { device: invalid }));
        let mut invalid = expected.clone();
        invalid.name = "Unexpected name".into();
        replies.push(Ok(RenameReply { device: invalid }));
        let mut invalid = expected.clone();
        invalid.admission = original[1].admission.clone();
        replies.push(Ok(RenameReply { device: invalid }));
        let mut invalid = expected.clone();
        invalid.revoked_at = Some(stamp(OffsetDateTime::UNIX_EPOCH));
        replies.push(Ok(RenameReply { device: invalid }));
        for response in replies {
            let devices = original.clone();
            assert!(confirm_rename_result(&session(), &expected, response, &devices).is_err());
            assert_eq!(devices, original);
        }
    }

    #[test]
    fn rename_confirmation_requires_current_trusted_active_target() {
        let original = device("one", 2);
        let expected =
            prepare_rename(&session(), vec![original.clone()], "one", "New name").unwrap();
        let mut revoked = original.clone();
        revoked.revoked_at = Some(stamp(OffsetDateTime::UNIX_EPOCH));
        let mut changed_key = original.clone();
        changed_key.public_key = device("other", 3).public_key;
        let mut unsigned = original;
        unsigned.admission = None;
        for devices in [vec![], vec![revoked], vec![changed_key], vec![unsigned]] {
            assert!(
                confirm_rename_result(
                    &session(),
                    &expected,
                    Ok(RenameReply {
                        device: expected.clone(),
                    }),
                    &devices,
                )
                .is_err()
            )
        }
    }

    #[test]
    fn delayed_rename_confirmation_cannot_replace_newer_synced_name_or_proof() {
        let original = device("one", 2);
        let expected = prepare_rename(
            &session(),
            vec![original.clone()],
            "one",
            "My requested name",
        )
        .unwrap();
        // The SDK may deliver a newer remote name, including a return to the
        // original name, before our older HTTP acknowledgement arrives.
        for remote_name in ["Newer remote name", "one"] {
            let synced =
                prepare_rename(&session(), vec![original.clone()], "one", remote_name).unwrap();
            let devices = vec![synced.clone()];
            let confirmed = confirm_rename_result(
                &session(),
                &expected,
                Ok(RenameReply {
                    device: expected.clone(),
                }),
                &devices,
            )
            .unwrap();
            assert_eq!(confirmed.name, "My requested name");
            assert_eq!(devices, vec![synced]);
            assert_eq!(verified_devices(&session(), devices).len(), 1);
        }
    }

    #[test]
    fn self_rename_changes_only_session_name_and_peer_rename_keeps_it() {
        let original = session();
        let renamed =
            prepare_rename(&original, vec![device("sender", 1)], "sender", "My Mac").unwrap();
        let mut expected = original.clone();
        expected.name = "My Mac".into();
        assert!(session_after_rename(original.clone(), &renamed) == expected);
        let peer = prepare_rename(&original, vec![device("one", 2)], "one", "Other Mac").unwrap();
        assert!(session_after_rename(original.clone(), &peer) == original);
    }
}
