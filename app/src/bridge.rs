//! One controller per JavaScript engine, with an owned core task as the
//! boundary between JavaScript calls and Rust's reactive runtime.
use crate::controller::{Action, Controller};
use futures_channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};
use futures_lite::StreamExt;
use nsh_core::element::{Local, create_root};
use nsh_core::prelude::*;
use std::{cell::RefCell, rc::Rc};

#[derive(Clone, PartialEq, JsObject)]
pub struct DisplaySession {
    pub device_id: String,
    pub name: String,
    pub origin: String,
}

#[derive(Clone, PartialEq, JsObject)]
pub struct DisplayItem {
    pub id: String,
    pub kind: String,
    pub sender_name: String,
    pub plaintext: String,
    pub expires_at: Option<String>,
}

#[derive(Clone, PartialEq, JsObject)]
pub struct DisplayDevice {
    pub id: String,
    pub name: String,
    pub public_key: String,
}

/// Display state only. Device tokens, private keys, group keys, admission
/// records, and encrypted payloads never cross this interface.
#[derive(Clone, PartialEq, JsObject)]
pub struct UiState {
    pub ready: bool,
    pub session: Option<DisplaySession>,
    pub items: Vec<DisplayItem>,
    pub devices: Vec<DisplayDevice>,
    pub draft: String,
    pub recipient: String,
    pub tab: String,
    pub status: String,
    pub error: String,
    pub busy: bool,
    pub origin: String,
    pub name: String,
    pub device_name: String,
    pub code: String,
    pub bootstrap_token: String,
    pub pairing: Option<crate::model::PairingView>,
    pub guest: Option<crate::model::GuestView>,
    pub output: String,
}

type Listener = Rc<RefCell<Option<Callback<UiState>>>>;

enum Command {
    Snapshot(Listener),
    SetField(Field, String),
    Dispatch(Action),
}

/// VM-local, rather than thread-local: browser engines can share a thread.
/// Keeping this task alive through view remounts/hot updates avoids a second
/// SDK connection and preserves in-flight sends and pairing.
struct Bridge {
    send: UnboundedSender<Command>,
    receive: RefCell<Option<UnboundedReceiver<Command>>>,
    listeners: RefCell<Vec<Listener>>,
}

impl Default for Bridge {
    fn default() -> Self {
        let (send, receive) = unbounded();
        Self {
            send,
            receive: RefCell::new(Some(receive)),
            listeners: RefCell::new(vec![]),
        }
    }
}

impl Local for Bridge {
    fn close(&self) {
        for listener in self.listeners.borrow_mut().drain(..) {
            listener.borrow_mut().take();
        }
        self.send.close_channel();
    }
}

impl Bridge {
    fn start(self: &Rc<Self>, cx: CallCx<'_>) {
        let Some(mut receive) = self.receive.borrow_mut().take() else {
            return;
        };
        let bridge = self.clone();
        cx.start(async move {
            let (owner, controller) = create_root(|| {
                let controller = Controller::start();
                let source = controller.clone();
                // Equality suppresses the clock's ticks unless an item expires.
                let state = computed(move || snapshot(&source));
                let weak = Rc::downgrade(&bridge);
                effect(move || {
                    let state = state.get();
                    if let Some(bridge) = weak.upgrade() {
                        bridge.listeners.borrow_mut().retain(|listener| {
                            if let Some(listener) = listener.borrow().as_ref() {
                                listener.post(state.clone());
                                true
                            } else {
                                false
                            }
                        });
                    }
                });
                controller
            });
            while let Some(command) = receive.next().await {
                owner.run(|| match command {
                    Command::Snapshot(listener) => {
                        if let Some(listener) = listener.borrow().as_ref() {
                            listener.post(snapshot(&controller));
                        }
                    }
                    Command::SetField(field, value) => field.set(&controller, value),
                    Command::Dispatch(action) => controller.dispatch(action),
                });
            }
            // Cancels controller tasks/watches/timers and disconnects native
            // PowerSync when the engine closes, never when a screen changes.
            owner.dispose();
        });
    }
}

/// The typed view boundary for the Rust application core.
#[module]
pub struct PowerBin;

#[module]
impl PowerBin {
    /// Sends an initial snapshot and subsequent changes without polling.
    /// The returned function and the calling JS owner's cleanup unsubscribe.
    pub fn on_change(
        #[args(state)] listener: Callback<UiState>,
        sys: System,
        cx: CallCx<'_>,
    ) -> Stop {
        let bridge = sys.locals.get::<Bridge>();
        let listener = Rc::new(RefCell::new(Some(listener)));
        bridge.listeners.borrow_mut().push(listener.clone());
        bridge.start(cx);
        let _ = bridge
            .send
            .unbounded_send(Command::Snapshot(listener.clone()));
        let weak = Rc::downgrade(&bridge);
        Stop::new(move || {
            listener.borrow_mut().take();
            if let Some(bridge) = weak.upgrade() {
                bridge
                    .listeners
                    .borrow_mut()
                    .retain(|entry| !Rc::ptr_eq(entry, &listener));
            }
        })
    }

    /// Edits a controller-owned form value or navigation selection.
    pub fn set_field(field: Field, value: String, sys: System, cx: CallCx<'_>) {
        let bridge = sys.locals.get::<Bridge>();
        bridge.start(cx);
        let _ = bridge.send.unbounded_send(Command::SetField(field, value));
    }

    /// Starts an app-owned action. Item and device actions require an id.
    pub fn dispatch(
        action: CommandName,
        id: Option<String>,
        sys: System,
        cx: CallCx<'_>,
    ) -> Result<(), String> {
        let action = action.action(id)?;
        let bridge = sys.locals.get::<Bridge>();
        bridge.start(cx);
        bridge
            .send
            .unbounded_send(Command::Dispatch(action))
            .map_err(|_| "PowerBin has closed".into())
    }
}

#[derive(Clone, Copy, PartialEq, PropEnum)]
pub enum Field {
    Draft,
    Recipient,
    Tab,
    Origin,
    Name,
    DeviceName,
    Code,
    BootstrapToken,
    Error,
}

impl Field {
    fn set(self, controller: &Controller, value: String) {
        let ui = controller.ui;
        match self {
            Self::Draft => ui.draft.set(value),
            Self::Recipient => ui.recipient.set(value),
            Self::Tab => {
                if matches!(value.as_str(), "send" | "inbox" | "saved" | "devices") {
                    ui.tab.set(value);
                }
            }
            Self::Origin => ui.origin.set(value),
            Self::Name => ui.name.set(value),
            Self::DeviceName => ui.device_name.set(value),
            Self::Code => ui.code.set(value),
            Self::BootstrapToken => ui.bootstrap_token.set(value),
            Self::Error => ui.error.set(value),
        }
    }
}

#[derive(Clone, Copy, PartialEq, PropEnum)]
pub enum CommandName {
    Bootstrap,
    StartPairing,
    ApproveCode,
    ConfirmPairing,
    CancelPairing,
    UnpairDevice,
    RenameDevice,
    Send,
    Save,
    CreateLink,
    CopyBurn,
    CopySaved,
    Burn,
    Reveal,
    CopyOutput,
}

impl CommandName {
    fn action(self, id: Option<String>) -> Result<Action, String> {
        Ok(match self {
            Self::Bootstrap => Action::Bootstrap,
            Self::StartPairing => Action::StartPairing,
            Self::ApproveCode => Action::ApproveCode,
            Self::ConfirmPairing => Action::ConfirmPairing,
            Self::CancelPairing => Action::CancelPairing,
            Self::UnpairDevice => Action::UnpairDevice(
                id.filter(|value| !value.is_empty())
                    .ok_or("Missing device id")?,
            ),
            Self::RenameDevice => Action::RenameDevice(
                id.filter(|value| !value.is_empty())
                    .ok_or("Missing device id")?,
            ),
            Self::Send => Action::Send,
            Self::Save => Action::Save,
            Self::CreateLink => Action::CreateLink,
            Self::CopyBurn => Action::CopyBurn(id.ok_or("Missing item id")?),
            Self::CopySaved => Action::CopySaved(id.ok_or("Missing item id")?),
            Self::Burn => Action::Burn(id.ok_or("Missing item id")?),
            Self::Reveal => Action::Reveal,
            Self::CopyOutput => Action::CopyOutput,
        })
    }
}

fn snapshot(controller: &Controller) -> UiState {
    let ui = controller.ui;
    let session = ui.session.get();
    let devices = controller.trusted_devices();
    let items = ui
        .items
        .get()
        .into_iter()
        .filter(|item| {
            controller.available(item)
                && (item.kind == "saved"
                    || (item.kind == "transfer"
                        && item.recipient_id.as_deref()
                            == session.as_ref().map(|s| s.device_id.as_str())))
        })
        .map(|item| DisplayItem {
            sender_name: devices
                .iter()
                .find(|device| device.id == item.sender_id)
                .map(|device| device.name.clone())
                .unwrap_or_else(|| "Paired device".into()),
            plaintext: controller
                .plaintext(&item)
                .unwrap_or_else(|_| "Unable to decrypt this snippet".into()),
            id: item.id,
            kind: item.kind,
            expires_at: item.expires_at,
        })
        .collect();
    UiState {
        ready: true,
        session: session.map(|session| DisplaySession {
            name: devices
                .iter()
                .find(|device| device.id == session.device_id)
                .map(|device| device.name.clone())
                .unwrap_or(session.name),
            device_id: session.device_id,
            origin: session.origin,
        }),
        items,
        devices: devices
            .into_iter()
            .map(|device| DisplayDevice {
                id: device.id,
                name: device.name,
                public_key: device.public_key,
            })
            .collect(),
        draft: ui.draft.get(),
        recipient: ui.recipient.get(),
        tab: ui.tab.get(),
        status: ui.status.get(),
        error: ui.error.get(),
        busy: ui.busy.get(),
        origin: ui.origin.get(),
        name: ui.name.get(),
        device_name: ui.device_name.get(),
        code: ui.code.get(),
        bootstrap_token: ui.bootstrap_token.get(),
        pairing: ui.pairing.get(),
        guest: ui.guest.get(),
        output: ui.output.get(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unpair_command_requires_a_device_id() {
        assert!(CommandName::UnpairDevice.action(None).is_err());
        assert!(
            CommandName::UnpairDevice
                .action(Some(String::new()))
                .is_err()
        );
        assert!(matches!(
            CommandName::UnpairDevice.action(Some("peer-device".into())),
            Ok(Action::UnpairDevice(id)) if id == "peer-device"
        ));
    }

    #[test]
    fn rename_command_requires_a_device_id() {
        assert!(CommandName::RenameDevice.action(None).is_err());
        assert!(
            CommandName::RenameDevice
                .action(Some(String::new()))
                .is_err()
        );
        assert!(matches!(
            CommandName::RenameDevice.action(Some("peer-device".into())),
            Ok(Action::RenameDevice(id)) if id == "peer-device"
        ));
    }
}
