//! Messages (T-278 prototype): you and other people, over Matrix on our own homeserver.
//!
//! One [`Messages`] is one account on this device. It signs in with a password (the prototype; the homeserver's
//! OIDC login later), keeps the account's state, end-to-end keys and event cache in an encrypted SQLite store
//! (matrix-sdk-sqlite with a passphrase), runs matrix-sdk-ui's `SyncService` (simplified sliding sync) and hands the
//! app plain rows: the room list, one room's messages, a status. The webview never sees an access token or a key.
//! Nothing here is offered to agents: "bring Uni in" is a per-conversation gesture that is designed, not built.
//!
//! Locks are held for local work only (swapping the account, building a room's timeline); every network call runs
//! outside them, so a slow homeserver delays the call that needs it and nothing else.
#![recursion_limit = "256"]

mod secrets;
mod view;

pub use secrets::{FileSecrets, Secrets};
pub use view::{checked_homeserver, MessageKind, MessageRow, RoomRow, SendState};

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};

use futures_util::StreamExt;
use matrix_sdk::{
    authentication::matrix::MatrixSession,
    config::RequestConfig,
    ruma::{api::client::receipt::create_receipt::v3::ReceiptType, events::room::message::RoomMessageEventContent, OwnedDeviceId, OwnedRoomId, RoomId},
    store::RoomLoadSettings,
    Client, Room, RoomState, SessionChange,
};
use matrix_sdk_ui::{
    room_list_service::filters::new_filter_non_left,
    sync_service::{State as SyncState, SyncService},
    timeline::{RoomExt, Timeline},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{
    sync::{broadcast, Notify},
    task::JoinHandle,
};
use url::Url;

/// How many of the most recent rooms get a full sliding-sync subscription (their latest message for the list, every
/// event while open). The rest are listed by name and recency only.
const SUBSCRIBED_ROOMS: usize = 50;
const STORE_PASSPHRASE: &str = "store-passphrase";
const SESSION: &str = "session";
/// A command waits this long at most for a homeserver that keeps failing (the SDK's default is to retry for ever).
const RETRY_FOR: Duration = Duration::from_secs(20);

/// What the app is told about the account: whether it is signed in and whether the sync is live.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Status {
    /// `signed_out` | `connecting` | `live` | `offline` | `error`
    pub state: &'static str,
    pub user_id: Option<String>,
    pub homeserver: Option<String>,
    /// What went wrong, or a note that the app should show (a sign-out the homeserver didn't confirm).
    pub error: Option<String>,
}

impl Status {
    fn signed_out(note: Option<String>) -> Self {
        Status { state: "signed_out", user_id: None, homeserver: None, error: note }
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

fn server(e: impl std::fmt::Display) -> MessagesError {
    MessagesError::Server { message: e.to_string() }
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
        _ => server(e),
    }
}

fn from_store(e: impl std::fmt::Display) -> MessagesError {
    MessagesError::Server { message: format!("the local store: {e}") }
}

fn default_store() -> String {
    "store".into()
}

#[derive(Serialize, Deserialize)]
struct SavedSession {
    homeserver: String,
    session: MatrixSession,
    /// The store folder under the account's dir; each sign-in gets its own.
    #[serde(default = "default_store")]
    store: String,
}

struct OpenRoom {
    timeline: Arc<Timeline>,
    task: JoinHandle<()>,
}

struct Live {
    client: Client,
    sync: Arc<SyncService>,
    tasks: Vec<JoinHandle<()>>,
}

impl Live {
    async fn stop(mut self) -> Client {
        for t in self.tasks.drain(..) {
            t.abort();
        }
        self.sync.stop().await;
        self.client
    }
}

/// One Matrix account on this device.
pub struct Messages {
    dir: PathBuf,
    secrets: Arc<dyn Secrets>,
    tx: broadcast::Sender<Update>,
    /// The signed-in account. Locked to swap it or to clone its client; never across a network call.
    live: tokio::sync::Mutex<Option<Live>>,
    /// The rooms open in the app and their timelines. Locked while one is built (local work), never across a network
    /// call; the room-list task reads it to keep open rooms subscribed.
    open: tokio::sync::Mutex<HashMap<OwnedRoomId, OpenRoom>>,
    /// Wakes the room-list task when a room opens or closes, so its subscription follows at once.
    resubscribe: Arc<Notify>,
    status: StdMutex<Status>,
    /// The last room list, for `rooms()`.
    rooms: StdMutex<Vec<RoomRow>>,
}

impl Messages {
    /// `dir` holds the encrypted stores (`dir/store-…`); `secrets` holds the store passphrase and the session.
    pub fn new(dir: impl Into<PathBuf>, secrets: Arc<dyn Secrets>) -> Arc<Self> {
        let (tx, _) = broadcast::channel(256);
        Arc::new(Messages {
            dir: dir.into(),
            secrets,
            tx,
            live: tokio::sync::Mutex::new(None),
            open: tokio::sync::Mutex::new(HashMap::new()),
            resubscribe: Arc::new(Notify::new()),
            status: StdMutex::new(Status::signed_out(None)),
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

    async fn build_client(&self, homeserver: &Url, store: &str, passphrase: &str) -> Result<Client> {
        Client::builder()
            .homeserver_url(homeserver.as_str())
            // the address checked by `checked_homeserver` is the one used: a login answer can't move it elsewhere
            .respect_login_well_known(false)
            .request_config(RequestConfig::short_retry().max_retry_time(RETRY_FOR))
            .sqlite_store(self.dir.join(store), Some(passphrase))
            .build()
            .await
            .map_err(from_store)
    }

    async fn client(&self) -> Result<Client> {
        self.live.lock().await.as_ref().map(|l| l.client.clone()).ok_or_else(signed_out)
    }

    /// Pick up the session saved on this device, if there is one. Offline it still opens: the store has the rooms
    /// and messages last synced, and the sync catches up when the homeserver answers. A session that can't be
    /// reopened (its store or key is gone) comes back as signed out, with the reason, so the app offers sign-in.
    pub async fn resume(self: &Arc<Self>) -> Result<Status> {
        let mut live = self.live.lock().await;
        if live.is_some() {
            return Ok(self.status());
        }
        let Some(saved) = self.secrets.get(SESSION).map_err(from_store)? else {
            return Ok(self.status());
        };
        let reopen = async {
            let saved: SavedSession = serde_json::from_str(&saved).map_err(from_store)?;
            let homeserver = checked_homeserver(&saved.homeserver)?;
            let passphrase = self
                .secrets
                .get(STORE_PASSPHRASE)
                .map_err(from_store)?
                .ok_or_else(|| from_store("its key is missing"))?;
            let client = self.build_client(&homeserver, &saved.store, &passphrase).await?;
            client.matrix_auth().restore_session(saved.session, RoomLoadSettings::default()).await.map_err(from_sdk)?;
            Ok::<_, MessagesError>((client, homeserver))
        };
        match reopen.await {
            Ok((client, homeserver)) => {
                *live = Some(self.start(client, &homeserver).await?);
                Ok(self.status())
            }
            Err(e) => {
                let s = Status::signed_out(Some(format!("Couldn't reopen Messages on this device ({e}). Sign in again.")));
                self.set_status(s.clone());
                Ok(s)
            }
        }
    }

    /// Sign in as `user` with `password`. A sign-in is a new device with its own store; what this device had before
    /// (session, store, key) is replaced only once the homeserver has accepted the new sign-in.
    pub async fn sign_in(self: &Arc<Self>, homeserver: &str, user: &str, password: &str) -> Result<Status> {
        let homeserver = checked_homeserver(homeserver)?;
        let user = user.trim();
        if user.is_empty() || password.is_empty() {
            return Err(invalid("Enter a username and a password."));
        }
        let store = format!("store-{}", secrets::random_hex(6));
        let passphrase = secrets::random_hex(32);
        let attempt = async {
            let client = self.build_client(&homeserver, &store, &passphrase).await?;
            client
                .matrix_auth()
                .login_username(user, password)
                .initial_device_display_name("Uni")
                .send()
                .await
                .map_err(from_sdk)?;
            let session = client.matrix_auth().session().ok_or_else(|| server("signed in without a session"))?;
            Ok::<_, MessagesError>((client, session))
        };
        let (client, session) = match attempt.await {
            Ok(x) => x,
            Err(e) => {
                let _ = std::fs::remove_dir_all(self.dir.join(&store));
                return Err(e);
            }
        };
        let saved = serde_json::to_string(&SavedSession { homeserver: homeserver.to_string(), session, store: store.clone() }).map_err(from_store)?;

        // the swap: the new device in, the old one (if any) out
        let mut live = self.live.lock().await;
        let old = live.take();
        self.secrets.set(STORE_PASSPHRASE, &passphrase).map_err(from_store)?;
        self.secrets.set(SESSION, &saved).map_err(from_store)?;
        self.forget_rooms().await;
        *live = Some(self.start(client, &homeserver).await?);
        drop(live);
        if let Some(old) = old {
            // best effort: the previous device leaves the homeserver too
            let _ = old.stop().await.logout().await;
        }
        self.remove_stores(Some(&store));
        Ok(self.status())
    }

    /// Sign out: the device is removed on the homeserver if it answers, and the store and the session here are
    /// deleted either way. If the homeserver didn't confirm, the status says so.
    pub async fn sign_out(self: &Arc<Self>) -> Result<Status> {
        let old = self.live.lock().await.take();
        let note = match old {
            Some(l) => match l.stop().await.logout().await {
                Ok(()) => None,
                Err(_) => Some("Signed out on this device. The homeserver didn't confirm, so this device may still be listed there.".to_owned()),
            },
            None => None,
        };
        Ok(self.wipe(note).await)
    }

    /// The homeserver no longer knows `device` (signed out elsewhere, or the token was revoked). Only if it is still
    /// this account's device: a sign-in that has just replaced it is left alone.
    async fn ended_elsewhere(self: &Arc<Self>, device: Option<OwnedDeviceId>) {
        let mut live = self.live.lock().await;
        if live.as_ref().map(|l| l.client.device_id().map(|d| d.to_owned())) != Some(device) {
            return;
        }
        if let Some(l) = live.take() {
            drop(live);
            l.stop().await;
        }
        self.wipe(Some("This device was signed out on the homeserver. Sign in again.".into())).await;
    }

    async fn wipe(&self, note: Option<String>) -> Status {
        let _ = self.secrets.delete(SESSION);
        let _ = self.secrets.delete(STORE_PASSPHRASE);
        self.forget_rooms().await;
        self.remove_stores(None);
        let s = Status::signed_out(note);
        self.set_status(s.clone());
        let _ = self.tx.send(Update::Rooms { rooms: vec![] });
        s
    }

    async fn forget_rooms(&self) {
        for (_, r) in self.open.lock().await.drain() {
            r.task.abort();
        }
        self.rooms.lock().unwrap().clear();
    }

    /// Delete this account's store folders, except `keep`.
    fn remove_stores(&self, keep: Option<&str>) {
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with("store") && Some(name.as_str()) != keep {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }

    async fn start(self: &Arc<Self>, client: Client, homeserver: &Url) -> Result<Live> {
        let sync = Arc::new(SyncService::builder(client.clone()).with_offline_mode().build().await.map_err(server)?);
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

        // a token the homeserver no longer knows ends the session here too, instead of syncing in a loop
        let me = Arc::downgrade(self);
        let mut changes = client.subscribe_to_session_changes();
        let device = client.device_id().map(|d| d.to_owned());
        let session_task = tokio::spawn(async move {
            while let Ok(change) = changes.recv().await {
                if let SessionChange::UnknownToken(_) = change {
                    if let Some(me) = me.upgrade() {
                        // its own task: ending the session aborts this one
                        tokio::spawn(async move { me.ended_elsewhere(device).await });
                    }
                    break;
                }
            }
        });

        // the room list: every room not left, most recent first
        let me = Arc::downgrade(self);
        let rls = sync.room_list_service();
        let resubscribe = self.resubscribe.clone();
        let rooms_task = tokio::spawn(async move {
            let Ok(all) = rls.all_rooms().await else { return };
            let (stream, controller) = all.entries_with_dynamic_adapters(500);
            controller.set_filter(Box::new(new_filter_non_left()));
            futures_util::pin_mut!(stream);
            let mut list = matrix_sdk_ui::eyeball_im::Vector::new();
            let mut subscribed: Vec<OwnedRoomId> = Vec::new();
            loop {
                // the list changed, or a room was opened or closed
                let list_changed = tokio::select! {
                    next = stream.next() => {
                        let Some(diffs) = next else { break };
                        for d in diffs {
                            d.apply(&mut list);
                        }
                        true
                    }
                    _ = resubscribe.notified() => false,
                };
                let Some(me) = me.upgrade() else { break };
                let rooms: Vec<Room> = list.iter().map(|r: &matrix_sdk_ui::room_list_service::RoomListItem| (**r).clone()).collect();
                // the most recent rooms and the open ones are subscribed: their latest message is known, and an open
                // room gets every event. Compared as a set, so a reordering alone doesn't resubscribe.
                let mut want: Vec<OwnedRoomId> = rooms.iter().take(SUBSCRIBED_ROOMS).map(|r| r.room_id().to_owned()).collect();
                want.extend(me.open.lock().await.keys().cloned());
                want.sort();
                want.dedup();
                if want != subscribed {
                    let ids: Vec<&RoomId> = want.iter().map(|r| r.as_ref()).collect();
                    rls.subscribe_to_rooms(&ids).await;
                    subscribed = want;
                }
                if list_changed {
                    let mut rows = Vec::with_capacity(rooms.len());
                    for r in &rooms {
                        rows.push(view::room_row(r, &RoomExt::latest_event(r).await).await);
                    }
                    *me.rooms.lock().unwrap() = rows.clone();
                    let _ = me.tx.send(Update::Rooms { rooms: rows });
                }
            }
        });

        sync.start().await;
        Ok(Live { client, sync, tasks: vec![status_task, session_task, rooms_task] })
    }

    /// The room list as last synced.
    pub async fn rooms(&self) -> Result<Vec<RoomRow>> {
        self.client().await?;
        Ok(self.rooms.lock().unwrap().clone())
    }

    fn room_id(id: &str) -> Result<OwnedRoomId> {
        RoomId::parse(id).map_err(|_| invalid("That isn't a room id."))
    }

    /// The open room's timeline, built (from the local store) on first use, with its live updates forwarded.
    async fn timeline(self: &Arc<Self>, client: &Client, room_id: &RoomId) -> Result<Arc<Timeline>> {
        let mut open = self.open.lock().await;
        if let Some(r) = open.get(room_id) {
            return Ok(r.timeline.clone());
        }
        let room = client.get_room(room_id).ok_or_else(|| invalid("This account isn't in that room."))?;
        let timeline = Arc::new(room.timeline().await.map_err(server)?);
        // the members' names: sliding sync loads members lazily, so a sender shows by user id until they're fetched
        let members = timeline.clone();
        tokio::spawn(async move { members.fetch_members().await });
        let (items, mut stream) = timeline.subscribe().await;
        let me = Arc::downgrade(self);
        let id = room_id.to_string();
        let task = tokio::spawn(async move {
            // live receive: every change to the room's timeline (a message arriving, our own echo turning into the
            // sent event, an edit, a late decryption) goes to the app as the room's rows
            let mut items = items;
            while let Some(diffs) = stream.next().await {
                for d in diffs {
                    d.apply(&mut items);
                }
                let Some(me) = me.upgrade() else { break };
                let _ = me.tx.send(Update::Timeline { room_id: id.clone(), items: view::message_rows(&items) });
            }
        });
        open.insert(room_id.to_owned(), OpenRoom { timeline: timeline.clone(), task });
        drop(open);
        self.resubscribe.notify_one();
        Ok(timeline)
    }

    /// Open a room: its loaded messages now, and every change after as `Update::Timeline`.
    pub async fn open(self: &Arc<Self>, room_id: &str) -> Result<Vec<MessageRow>> {
        let room_id = Self::room_id(room_id)?;
        let client = self.client().await?;
        let timeline = self.timeline(&client, &room_id).await?;
        let mut rows = view::message_rows(&timeline.items().await);
        if rows.len() < 20 {
            // a fresh room shows its start; an older one, its last screenful. A failed page is not fatal: what is
            // loaded is shown, and "Load earlier messages" can ask again.
            if timeline.paginate_backwards(30).await.is_ok() {
                rows = view::message_rows(&timeline.items().await);
            }
        }
        Ok(rows)
    }

    /// Stop following a room.
    pub async fn close(&self, room_id: &str) -> Result<()> {
        let room_id = Self::room_id(room_id)?;
        if let Some(r) = self.open.lock().await.remove(&room_id) {
            r.task.abort();
        }
        self.resubscribe.notify_one();
        Ok(())
    }

    /// Send a text message. It goes into the room's send queue and shows at once as "sending", then "sent" when the
    /// homeserver has it; an encrypted room's message is encrypted here, for each of the room's devices.
    pub async fn send(self: &Arc<Self>, room_id: &str, body: &str) -> Result<()> {
        let room_id = Self::room_id(room_id)?;
        let body = body.trim_end();
        if body.trim().is_empty() {
            return Err(invalid("There's nothing to send."));
        }
        let client = self.client().await?;
        let timeline = self.timeline(&client, &room_id).await?;
        timeline.send(RoomMessageEventContent::text_plain(body).into()).await.map_err(server)?;
        Ok(())
    }

    /// Accept an invite.
    pub async fn join(&self, room_id: &str) -> Result<()> {
        let room_id = Self::room_id(room_id)?;
        let client = self.client().await?;
        let room = client.get_room(&room_id).ok_or_else(|| invalid("No invite to that room."))?;
        if room.state() != RoomState::Invited {
            return Ok(());
        }
        room.join().await.map_err(from_sdk)
    }

    /// Load older messages of an open room; `true` once the room's start is reached.
    pub async fn older(self: &Arc<Self>, room_id: &str) -> Result<bool> {
        let room_id = Self::room_id(room_id)?;
        let client = self.client().await?;
        let timeline = self.timeline(&client, &room_id).await?;
        timeline.paginate_backwards(30).await.map_err(server)
    }

    /// Mark an open room read up to its latest message.
    pub async fn read(self: &Arc<Self>, room_id: &str) -> Result<()> {
        let room_id = Self::room_id(room_id)?;
        let client = self.client().await?;
        let timeline = self.timeline(&client, &room_id).await?;
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
