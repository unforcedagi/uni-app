//! Messages (T-278 prototype): you and other people, over Matrix on our own homeserver.
//!
//! One [`Messages`] is one account on this device. It signs in with a password (the prototype; the homeserver's
//! OIDC login later), keeps the account's state, end-to-end keys and event cache in an encrypted SQLite store
//! (matrix-sdk-sqlite with a passphrase), runs matrix-sdk-ui's `SyncService` (simplified sliding sync) and hands the
//! app plain rows: the room list, one room's messages, a status. The webview never sees an access token or a key.
//! Nothing here is offered to agents: "bring Uni in" is a per-conversation gesture that is designed, not built.
#![recursion_limit = "256"]

mod secrets;
mod view;

pub use secrets::{FileSecrets, Secrets};
pub use view::{checked_homeserver, MessageKind, MessageRow, RoomRow, SendState};

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex as StdMutex},
};

use futures_util::StreamExt;
use matrix_sdk::{
    authentication::matrix::MatrixSession,
    ruma::{api::client::receipt::create_receipt::v3::ReceiptType, events::room::message::RoomMessageEventContent, OwnedRoomId, RoomId},
    store::RoomLoadSettings,
    Client, Room, RoomState,
};
use matrix_sdk_ui::{
    room_list_service::filters::new_filter_non_left,
    sync_service::{State as SyncState, SyncService},
    timeline::{RoomExt, Timeline},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{sync::broadcast, task::JoinHandle};
use url::Url;

/// How many of the most recent rooms get a full sliding-sync subscription (their latest message for the list, every
/// event while open). The rest are listed by name and recency only.
const SUBSCRIBED_ROOMS: usize = 50;
const STORE_PASSPHRASE: &str = "store-passphrase";
const SESSION: &str = "session";

/// What the app is told about the account: whether it is signed in and whether the sync is live.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Status {
    /// `signed_out` | `connecting` | `live` | `offline` | `error`
    pub state: &'static str,
    pub user_id: Option<String>,
    pub homeserver: Option<String>,
    pub error: Option<String>,
}

impl Status {
    fn signed_out() -> Self {
        Status { state: "signed_out", user_id: None, homeserver: None, error: None }
    }
}

/// Pushed to the app as they happen (Tauri event `messages://update`; the dev bridge's event stream).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Update {
    Status { status: Status },
    Rooms { rooms: Vec<RoomRow> },
    /// One open room's messages, oldest first, the whole loaded window each time.
    Timeline { room_id: String, items: Vec<MessageRow> },
}

/// The error shape the app's other doors use: `{ kind, message }`.
#[derive(Debug, Clone, Serialize, thiserror::Error, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MessagesError {
    #[error("{message}")]
    SignedOut { message: String },
    #[error("{message}")]
    Unreachable { message: String },
    #[error("{message}")]
    Refused { message: String },
    #[error("{message}")]
    Invalid { message: String },
    #[error("{message}")]
    Server { message: String },
}

pub type Result<T> = std::result::Result<T, MessagesError>;

fn invalid(message: impl Into<String>) -> MessagesError {
    MessagesError::Invalid { message: message.into() }
}

fn signed_out() -> MessagesError {
    MessagesError::SignedOut { message: "Messages isn't signed in on this device.".into() }
}

/// A matrix-sdk error, in the app's words. A refused login says so; a network failure is "unreachable".
fn from_sdk(e: matrix_sdk::Error) -> MessagesError {
    if let Some(api) = e.as_client_api_error() {
        let code = api.status_code.as_u16();
        let message = api.to_string();
        return if code == 401 || code == 403 { MessagesError::Refused { message } } else { MessagesError::Server { message } };
    }
    match &e {
        matrix_sdk::Error::Http(h) if matches!(**h, matrix_sdk::HttpError::Reqwest(_)) => {
            MessagesError::Unreachable { message: "The homeserver isn't answering.".into() }
        }
        _ => MessagesError::Server { message: e.to_string() },
    }
}

fn from_store(e: impl std::fmt::Display) -> MessagesError {
    MessagesError::Server { message: format!("the local store: {e}") }
}

#[derive(Serialize, Deserialize)]
struct SavedSession {
    homeserver: String,
    session: MatrixSession,
}

struct OpenRoom {
    timeline: Arc<Timeline>,
    task: JoinHandle<()>,
}

struct Live {
    client: Client,
    sync: Arc<SyncService>,
    tasks: Vec<JoinHandle<()>>,
    open: HashMap<OwnedRoomId, OpenRoom>,
}

impl Live {
    async fn stop(mut self) {
        for (_, r) in self.open.drain() {
            r.task.abort();
        }
        for t in self.tasks.drain(..) {
            t.abort();
        }
        self.sync.stop().await;
    }
}

/// One Matrix account on this device.
pub struct Messages {
    dir: PathBuf,
    secrets: Arc<dyn Secrets>,
    tx: broadcast::Sender<Update>,
    live: tokio::sync::Mutex<Option<Live>>,
    status: StdMutex<Status>,
    /// The rooms open in the app, kept subscribed while open.
    opened: StdMutex<HashSet<OwnedRoomId>>,
    /// The last room list, for `rooms()` and for re-subscribing.
    rooms: StdMutex<Vec<RoomRow>>,
}

impl Messages {
    /// `dir` holds the encrypted store (`dir/store`); `secrets` holds its passphrase and the session.
    pub fn new(dir: impl Into<PathBuf>, secrets: Arc<dyn Secrets>) -> Arc<Self> {
        let (tx, _) = broadcast::channel(256);
        Arc::new(Messages {
            dir: dir.into(),
            secrets,
            tx,
            live: tokio::sync::Mutex::new(None),
            status: StdMutex::new(Status::signed_out()),
            opened: StdMutex::new(HashSet::new()),
            rooms: StdMutex::new(Vec::new()),
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Update> {
        self.tx.subscribe()
    }

    pub fn status(&self) -> Status {
        self.status.lock().unwrap().clone()
    }

    fn set_status(&self, s: Status) {
        let changed = {
            let mut cur = self.status.lock().unwrap();
            let changed = *cur != s;
            *cur = s.clone();
            changed
        };
        if changed {
            let _ = self.tx.send(Update::Status { status: s });
        }
    }

    fn passphrase(&self, fresh: bool) -> Result<String> {
        if !fresh {
            if let Some(p) = self.secrets.get(STORE_PASSPHRASE).map_err(from_store)? {
                return Ok(p);
            }
        }
        let p = secrets::random_hex(32);
        self.secrets.set(STORE_PASSPHRASE, &p).map_err(from_store)?;
        Ok(p)
    }

    async fn build_client(&self, homeserver: &Url, passphrase: &str) -> Result<Client> {
        Client::builder()
            .homeserver_url(homeserver.as_str())
            .sqlite_store(self.dir.join("store"), Some(passphrase))
            .build()
            .await
            .map_err(|e| from_store(e))
    }

    /// Pick up the session saved on this device, if there is one. Offline it still opens: the store has the rooms
    /// and messages last synced, and the sync catches up when the homeserver answers.
    pub async fn resume(self: &Arc<Self>) -> Result<Status> {
        let mut live = self.live.lock().await;
        if live.is_some() {
            return Ok(self.status());
        }
        let Some(saved) = self.secrets.get(SESSION).map_err(from_store)? else {
            return Ok(Status::signed_out());
        };
        let saved: SavedSession = serde_json::from_str(&saved).map_err(from_store)?;
        let homeserver = checked_homeserver(&saved.homeserver)?;
        let client = self.build_client(&homeserver, &self.passphrase(false)?).await?;
        client.matrix_auth().restore_session(saved.session, RoomLoadSettings::default()).await.map_err(from_sdk)?;
        *live = Some(self.start(client, &homeserver).await?);
        Ok(self.status())
    }

    /// Sign in as `user` with `password`. A new sign-in is a new device: the old store is dropped first.
    pub async fn sign_in(self: &Arc<Self>, homeserver: &str, user: &str, password: &str) -> Result<Status> {
        let homeserver = checked_homeserver(homeserver)?;
        let user = user.trim();
        if user.is_empty() || password.is_empty() {
            return Err(invalid("Enter a username and a password."));
        }
        let mut live = self.live.lock().await;
        if let Some(old) = live.take() {
            old.stop().await;
        }
        let _ = std::fs::remove_dir_all(self.dir.join("store"));
        let client = self.build_client(&homeserver, &self.passphrase(true)?).await?;
        client
            .matrix_auth()
            .login_username(user, password)
            .initial_device_display_name("Uni")
            .send()
            .await
            .map_err(from_sdk)?;
        let session = client.matrix_auth().session().ok_or_else(|| MessagesError::Server { message: "signed in without a session".into() })?;
        let saved = serde_json::to_string(&SavedSession { homeserver: homeserver.to_string(), session }).map_err(from_store)?;
        self.secrets.set(SESSION, &saved).map_err(from_store)?;
        *live = Some(self.start(client, &homeserver).await?);
        Ok(self.status())
    }

    /// Sign out: the device is removed on the homeserver, and the store and the session here are deleted.
    pub async fn sign_out(self: &Arc<Self>) -> Result<Status> {
        let mut live = self.live.lock().await;
        if let Some(l) = live.take() {
            let client = l.client.clone();
            l.stop().await;
            let _ = client.logout().await;
        }
        let _ = self.secrets.delete(SESSION);
        let _ = self.secrets.delete(STORE_PASSPHRASE);
        let _ = std::fs::remove_dir_all(self.dir.join("store"));
        self.opened.lock().unwrap().clear();
        self.rooms.lock().unwrap().clear();
        self.set_status(Status::signed_out());
        let _ = self.tx.send(Update::Rooms { rooms: vec![] });
        Ok(self.status())
    }

    async fn start(self: &Arc<Self>, client: Client, homeserver: &Url) -> Result<Live> {
        let sync = Arc::new(SyncService::builder(client.clone()).with_offline_mode().build().await.map_err(|e| MessagesError::Server { message: e.to_string() })?);
        let base = Status {
            state: "connecting",
            user_id: client.user_id().map(|u| u.to_string()),
            homeserver: Some(homeserver.to_string()),
            error: None,
        };
        self.set_status(base.clone());

        // the sync's state, as the app's status line
        let me = Arc::downgrade(self);
        let mut states = sync.state();
        let status_task = tokio::spawn(async move {
            while let Some(state) = states.next().await {
                let Some(me) = me.upgrade() else { break };
                let (word, error) = match state {
                    SyncState::Running => ("live", None),
                    SyncState::Offline => ("offline", None),
                    SyncState::Error(e) => ("error", Some(e.to_string())),
                    SyncState::Idle | SyncState::Terminated => ("connecting", None),
                };
                me.set_status(Status { state: word, error, ..base.clone() });
            }
        });

        // the room list: every room not left, most recent first
        let me = Arc::downgrade(self);
        let rls = sync.room_list_service();
        let rooms_task = tokio::spawn(async move {
            let Ok(all) = rls.all_rooms().await else { return };
            let (stream, controller) = all.entries_with_dynamic_adapters(500);
            controller.set_filter(Box::new(new_filter_non_left()));
            futures_util::pin_mut!(stream);
            let mut list = matrix_sdk_ui::eyeball_im::Vector::new();
            let mut subscribed: Vec<OwnedRoomId> = Vec::new();
            while let Some(diffs) = stream.next().await {
                for d in diffs {
                    d.apply(&mut list);
                }
                let Some(me) = me.upgrade() else { break };
                let rooms: Vec<Room> = list.iter().map(|r: &matrix_sdk_ui::room_list_service::RoomListItem| (**r).clone()).collect();
                // the most recent rooms and the open ones are subscribed: their latest message is known, and an open
                // room gets every event
                let mut want: Vec<OwnedRoomId> = rooms.iter().take(SUBSCRIBED_ROOMS).map(|r| r.room_id().to_owned()).collect();
                for id in me.opened.lock().unwrap().iter() {
                    if !want.contains(id) {
                        want.push(id.clone());
                    }
                }
                if want != subscribed {
                    let ids: Vec<&RoomId> = want.iter().map(|r| r.as_ref()).collect();
                    rls.subscribe_to_rooms(&ids).await;
                    subscribed = want;
                }
                let mut rows = Vec::with_capacity(rooms.len());
                for r in &rooms {
                    rows.push(view::room_row(r, &RoomExt::latest_event(r).await).await);
                }
                *me.rooms.lock().unwrap() = rows.clone();
                let _ = me.tx.send(Update::Rooms { rooms: rows });
            }
        });

        sync.start().await;
        Ok(Live { client, sync, tasks: vec![status_task, rooms_task], open: HashMap::new() })
    }

    /// The room list as last synced.
    pub async fn rooms(&self) -> Result<Vec<RoomRow>> {
        if self.live.lock().await.is_none() {
            return Err(signed_out());
        }
        Ok(self.rooms.lock().unwrap().clone())
    }

    fn room_id(id: &str) -> Result<OwnedRoomId> {
        RoomId::parse(id).map_err(|_| invalid("That isn't a room id."))
    }

    async fn timeline(self: &Arc<Self>, live: &mut Live, room_id: &RoomId) -> Result<Arc<Timeline>> {
        if let Some(r) = live.open.get(room_id) {
            return Ok(r.timeline.clone());
        }
        let room = live.client.get_room(room_id).ok_or_else(|| invalid("This account isn't in that room."))?;
        let timeline = Arc::new(room.timeline().await.map_err(|e| MessagesError::Server { message: e.to_string() })?);
        // the members' names: sliding sync loads members lazily, so a sender shows by user id until they're fetched
        let members = timeline.clone();
        tokio::spawn(async move { members.fetch_members().await });
        let (items, mut stream) = timeline.subscribe().await;
        let me = Arc::downgrade(self);
        let id = room_id.to_string();
        let own = live.client.user_id().map(|u| u.to_owned());
        let task = tokio::spawn(async move {
            // live receive: every change to the room's timeline (a message arriving, our own echo turning into the
            // sent event, an edit, a late decryption) goes to the app as the room's rows
            let mut items = items;
            while let Some(diffs) = stream.next().await {
                for d in diffs {
                    d.apply(&mut items);
                }
                let Some(me) = me.upgrade() else { break };
                let _ = me.tx.send(Update::Timeline { room_id: id.clone(), items: view::message_rows(&items, own.as_deref()) });
            }
        });
        live.open.insert(room_id.to_owned(), OpenRoom { timeline: timeline.clone(), task });
        self.opened.lock().unwrap().insert(room_id.to_owned());
        Ok(timeline)
    }

    /// Open a room: its loaded messages now, and every change after as `Update::Timeline`.
    pub async fn open(self: &Arc<Self>, room_id: &str) -> Result<Vec<MessageRow>> {
        let room_id = Self::room_id(room_id)?;
        let mut guard = self.live.lock().await;
        let live = guard.as_mut().ok_or_else(signed_out)?;
        let timeline = self.timeline(live, &room_id).await?;
        let own = live.client.user_id().map(|u| u.to_owned());
        let mut rows = view::message_rows(&timeline.items().await, own.as_deref());
        if rows.len() < 20 {
            // a fresh room shows its start; an older one, its last screenful
            let _ = timeline.paginate_backwards(30).await;
            rows = view::message_rows(&timeline.items().await, own.as_deref());
        }
        Ok(rows)
    }

    /// Stop following a room.
    pub async fn close(&self, room_id: &str) -> Result<()> {
        let room_id = Self::room_id(room_id)?;
        if let Some(live) = self.live.lock().await.as_mut() {
            if let Some(r) = live.open.remove(&room_id) {
                r.task.abort();
            }
        }
        self.opened.lock().unwrap().remove(&room_id);
        Ok(())
    }

    /// Send a text message. It shows at once as "sending" and turns "sent" when the homeserver has it; an encrypted
    /// room's message is encrypted here, for each of the room's devices.
    pub async fn send(self: &Arc<Self>, room_id: &str, body: &str) -> Result<()> {
        let room_id = Self::room_id(room_id)?;
        let body = body.trim_end();
        if body.trim().is_empty() {
            return Err(invalid("There's nothing to send."));
        }
        let mut guard = self.live.lock().await;
        let live = guard.as_mut().ok_or_else(signed_out)?;
        let timeline = self.timeline(live, &room_id).await?;
        timeline.send(RoomMessageEventContent::text_plain(body).into()).await.map_err(|e| MessagesError::Server { message: e.to_string() })?;
        Ok(())
    }

    /// Accept an invite.
    pub async fn join(&self, room_id: &str) -> Result<()> {
        let room_id = Self::room_id(room_id)?;
        let guard = self.live.lock().await;
        let live = guard.as_ref().ok_or_else(signed_out)?;
        let room = live.client.get_room(&room_id).ok_or_else(|| invalid("No invite to that room."))?;
        if room.state() != RoomState::Invited {
            return Ok(());
        }
        room.join().await.map_err(from_sdk)
    }

    /// Load older messages of an open room; `true` once the room's start is reached.
    pub async fn older(self: &Arc<Self>, room_id: &str) -> Result<bool> {
        let room_id = Self::room_id(room_id)?;
        let mut guard = self.live.lock().await;
        let live = guard.as_mut().ok_or_else(signed_out)?;
        let timeline = self.timeline(live, &room_id).await?;
        timeline.paginate_backwards(30).await.map_err(|e| MessagesError::Server { message: e.to_string() })
    }

    /// Mark an open room read up to its latest message.
    pub async fn read(self: &Arc<Self>, room_id: &str) -> Result<()> {
        let room_id = Self::room_id(room_id)?;
        let mut guard = self.live.lock().await;
        let live = guard.as_mut().ok_or_else(signed_out)?;
        let timeline = self.timeline(live, &room_id).await?;
        timeline.mark_as_read(ReceiptType::Read).await.map(|_| ()).map_err(from_sdk)
    }

    /// The commands by name, as the Tauri commands and the dev bridge both offer them.
    pub async fn call(self: &Arc<Self>, cmd: &str, args: &Value) -> Result<Value> {
        let s = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
        let to = |v: &dyn ToJson| v.to_json();
        Ok(match cmd {
            "messages_status" => to(&self.resume().await?),
            "messages_sign_in" => to(&self.sign_in(&s("homeserver"), &s("user"), &s("password")).await?),
            "messages_sign_out" => to(&self.sign_out().await?),
            "messages_rooms" => to(&self.rooms().await?),
            "messages_open" => to(&self.open(&s("roomId")).await?),
            "messages_close" => to(&self.close(&s("roomId")).await?),
            "messages_send" => to(&self.send(&s("roomId"), &s("body")).await?),
            "messages_join" => to(&self.join(&s("roomId")).await?),
            "messages_older" => to(&self.older(&s("roomId")).await?),
            "messages_read" => to(&self.read(&s("roomId")).await?),
            _ => return Err(invalid(format!("no such command: {cmd}"))),
        })
    }
}

/// So `call` can answer each command's own type as JSON.
trait ToJson {
    fn to_json(&self) -> Value;
}

impl<T: Serialize> ToJson for T {
    fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}
