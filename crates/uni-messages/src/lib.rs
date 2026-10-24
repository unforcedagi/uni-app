//! Messages (T-278 prototype): you and other people, over Matrix on our own homeserver.
//!
//! One [`Messages`] is one account on this device. It signs in with a password (the prototype; the homeserver's
//! OIDC login later), keeps the account's state, end-to-end keys and event cache in an encrypted SQLite store
//! (matrix-sdk-sqlite with a random 256-bit key), runs matrix-sdk-ui's `SyncService` (simplified sliding sync) and hands the
//! app plain rows: the room list, one room's messages, a status. The webview never sees an access token or a key.
//! Nothing here is offered to agents: "bring Uni in" is a per-conversation gesture that is designed, not built.
//!
//! Account changes (sign-in, sign-out, resume, a device ended on the homeserver) take turns: each runs to the end,
//! its network calls included, before the next starts, so a late step of one can never undo a newer one. The account
//! is saved as one record (session, store and the store's key), written in one step, before it replaces the running
//! one. Everything else (sending, opening a room, the room list) never waits on a network call it doesn't make.
#![recursion_limit = "256"]

mod link;
mod secrets;
mod view;

pub use link::{Flow, LinkRow, LinkStep, LinkedAccount, Network, NETWORKS};
pub use secrets::{FileSecrets, Secrets};
pub use view::{checked_homeserver, MessageKind, MessageRow, RoomRow, SendState};

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};

use futures_util::StreamExt;
use matrix_sdk::{
    authentication::matrix::MatrixSession,
    config::RequestConfig,
    ruma::{api::client::receipt::create_receipt::v3::ReceiptType, events::room::message::RoomMessageEventContent, OwnedRoomId, RoomId},
    store::RoomLoadSettings,
    Client, Room, RoomState, SessionChange, SqliteStoreConfig,
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
/// The saved account: one record, so its parts can't come from two different sign-ins.
const ACCOUNT: &str = "account";
/// What an earlier build saved as two separate secrets; removed when found.
const LEGACY: [&str; 2] = ["session", "store-passphrase"];
/// An ordinary request (anything but the sync's long poll, which sets its own) gives up after this. It is tried at most
/// four times, with pauses of at most `RETRY_PAUSE` between (the SDK's default is to retry for up to 15 minutes).
const REQUEST_FOR: Duration = Duration::from_secs(15);
const RETRY_PAUSE: Duration = Duration::from_secs(5);
/// A sign-in's login and a logout, all tries included. Account changes wait on these, so they are kept short.
const LOGIN_FOR: Duration = Duration::from_secs(30);
const LOGOUT_FOR: Duration = Duration::from_secs(10);
/// How long the status waits for an account change under way before answering with the status as it is.
const STATUS_WAIT: Duration = Duration::from_secs(2);
/// How long stopping an account's sync may take, twice at most. Normally it is at once; see `Live::stop`.
const STOP_FOR: Duration = Duration::from_secs(3);
/// The crypto database in a store folder (matrix-sdk-sqlite's name for it): a store without it has no keys.
const CRYPTO_DB: &str = "matrix-sdk-crypto.sqlite3";

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
    /// One network's card on the Link screen (T-282).
    Link { link: LinkRow },
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

/// Everything needed to reopen the account. Saved as one record in one write (`Secrets::set`: a temporary file
/// renamed into place), so a session is never paired with another sign-in's store or key.
#[derive(Serialize, Deserialize)]
struct Record {
    homeserver: String,
    session: MatrixSession,
    /// The store folder under the account's dir. Each sign-in gets its own, so its name also says which sign-in this is.
    store: String,
    /// The store's key: 32 random bytes, as hex. Random, so it is used as it is, with no key stretching.
    key: String,
}

struct OpenRoom {
    timeline: Arc<Timeline>,
    task: JoinHandle<()>,
}

struct Live {
    client: Client,
    sync: Arc<SyncService>,
    tasks: Vec<JoinHandle<()>>,
    /// Its store folder's name: which sign-in this is.
    store: String,
}

/// The rooms open in the app, all of one account.
#[derive(Default)]
struct OpenRooms {
    /// Whose rooms these are (the account's store name). A timeline built for an account that has since been
    /// replaced is not kept.
    account: Option<String>,
    rooms: HashMap<OwnedRoomId, OpenRoom>,
    /// Each bridge bot's DM, watched for the Link screen (link.rs), by network.
    links: HashMap<&'static str, JoinHandle<()>>,
}

impl Live {
    /// Stop the account's tasks and its sync. A sync stopped a moment after it started can miss the stop: matrix-sdk-ui's
    /// room-list loop listens for it only once it first runs, and `SyncService::stop` then waits for that loop, which
    /// long-polls on. So if the stop hasn't finished after a moment, the room list's stop is sent again; by then the loop
    /// listens, ends, and the sync service stops its encryption sync itself.
    async fn stop(mut self) -> Client {
        for t in self.tasks.drain(..) {
            t.abort();
        }
        let sync = self.sync.clone();
        let mut stopping = tokio::spawn(async move { sync.stop().await });
        if tokio::time::timeout(STOP_FOR, &mut stopping).await.is_err() {
            let _ = self.sync.room_list_service().stop_sync();
            if tokio::time::timeout(STOP_FOR, &mut stopping).await.is_err() {
                tracing::warn!("the sync didn't stop; it ends at its next failed request");
            }
        }
        self.client
    }
}

/// One Matrix account on this device.
pub struct Messages {
    dir: PathBuf,
    secrets: Arc<dyn Secrets>,
    tx: broadcast::Sender<Update>,
    /// Account changes take turns on it: sign-in, sign-out, resume, a device ended on the homeserver. Held to the end of
    /// each, a sign-in's login (`LOGIN_FOR`) and a logout (`LOGOUT_FOR`) included. Only the status waits on it, and for
    /// `STATUS_WAIT` at most.
    lifecycle: tokio::sync::Mutex<()>,
    /// The signed-in account. Locked to swap it or to clone its client; never across a network call.
    live: tokio::sync::Mutex<Option<Live>>,
    /// The rooms open in the app and their timelines. Locked while one is built (local work), never across a network
    /// call; the room-list task reads it to keep open rooms subscribed.
    open: tokio::sync::Mutex<OpenRooms>,
    /// Wakes the room-list task when a room opens or closes, so its subscription follows at once.
    resubscribe: Arc<Notify>,
    status: StdMutex<Status>,
    /// The last room list, for `rooms()`.
    rooms: StdMutex<Vec<RoomRow>>,
    /// The Link screen's cards, by network, as last read from the bridge bots.
    links: StdMutex<link::LinkRows>,
    /// Bot DMs are found or made one at a time (link.rs says why); the ones made here, by account and network.
    link_creating: tokio::sync::Mutex<HashMap<(String, &'static str), OwnedRoomId>>,
}

impl Messages {
    /// `dir` holds the encrypted stores (`dir/store-…`); `secrets` holds the saved account (`account`).
    pub fn new(dir: impl Into<PathBuf>, secrets: Arc<dyn Secrets>) -> Arc<Self> {
        let (tx, _) = broadcast::channel(256);
        Arc::new(Messages {
            dir: dir.into(),
            secrets,
            tx,
            lifecycle: tokio::sync::Mutex::new(()),
            live: tokio::sync::Mutex::new(None),
            open: tokio::sync::Mutex::new(OpenRooms::default()),
            resubscribe: Arc::new(Notify::new()),
            status: StdMutex::new(Status::signed_out(None)),
            rooms: StdMutex::new(Vec::new()),
            links: StdMutex::new(Default::default()),
            link_creating: tokio::sync::Mutex::new(HashMap::new()),
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

    async fn build_client(&self, homeserver: &Url, store: &str, key: &str) -> Result<Client> {
        let key = key_bytes(key).ok_or_else(|| from_store("its key is damaged"))?;
        Client::builder()
            .homeserver_url(homeserver.as_str())
            // the address checked by `checked_homeserver` is the one used: a login answer can't move it elsewhere
            .respect_login_well_known(false)
            .request_config(RequestConfig::short_retry().timeout(REQUEST_FOR).max_retry_time(RETRY_PAUSE))
            .sqlite_store_with_config_and_cache_path(SqliteStoreConfig::new(self.dir.join(store)).key(Some(&key)), None::<PathBuf>)
            .build()
            .await
            .map_err(from_store)
    }

    /// The running account's client, and which sign-in it is.
    async fn client(&self) -> Result<(Client, String)> {
        self.live.lock().await.as_ref().map(|l| (l.client.clone(), l.store.clone())).ok_or_else(signed_out)
    }

    async fn sync_service(client: &Client) -> Result<Arc<SyncService>> {
        Ok(Arc::new(SyncService::builder(client.clone()).with_offline_mode().build().await.map_err(server)?))
    }

    /// Pick up the account saved on this device, if there is one. Offline it still opens: the store has the rooms and
    /// messages last synced, and the sync catches up when the homeserver answers. An account that can't be reopened
    /// (its store or key is gone) comes back as signed out, with the reason, so the app offers sign-in.
    pub async fn resume(self: &Arc<Self>) -> Result<Status> {
        let Ok(_turn) = tokio::time::timeout(STATUS_WAIT, self.lifecycle.lock()).await else {
            // an account change is under way, waiting on the homeserver: it sends its own status when it is done
            return Ok(self.status());
        };
        if self.live.lock().await.is_some() {
            return Ok(self.status());
        }
        for name in LEGACY {
            let _ = self.secrets.delete(name);
        }
        let Some(saved) = self.secrets.get(ACCOUNT).map_err(from_store)? else {
            // no account: whatever stores are here were left by one that is gone
            self.remove_stores(None);
            return Ok(self.status());
        };
        let reopen = async {
            let record: Record = serde_json::from_str(&saved).map_err(from_store)?;
            // a record whose store is gone would reopen over a new, empty store: no keys, and a device the homeserver
            // already knows by others. Refused, and nothing is deleted; a new sign-in replaces it.
            if !self.dir.join(&record.store).join(CRYPTO_DB).is_file() {
                return Err(from_store("its store is gone"));
            }
            let homeserver = checked_homeserver(&record.homeserver)?;
            let client = self.build_client(&homeserver, &record.store, &record.key).await?;
            client.matrix_auth().restore_session(record.session, RoomLoadSettings::default()).await.map_err(from_sdk)?;
            let sync = Self::sync_service(&client).await?;
            Ok::<_, MessagesError>((client, sync, homeserver, record.store))
        };
        match reopen.await {
            Ok((client, sync, homeserver, store)) => {
                // anything else here was left by a sign-in that never finished
                self.remove_stores(Some(&store));
                self.run(client, sync, &homeserver, store).await;
                Ok(self.status())
            }
            Err(e) => {
                let s = Status::signed_out(Some(format!("Couldn't reopen Messages on this device ({e}). Sign in again.")));
                self.set_status(s.clone());
                Ok(s)
            }
        }
    }

    /// Sign in as `user` with `password`. A sign-in is a new device with its own store. Everything that can fail
    /// comes first; until the new account is saved, the old one keeps running and stays the saved one. Then the new
    /// one replaces it, and the old device leaves the homeserver.
    pub async fn sign_in(self: &Arc<Self>, homeserver: &str, user: &str, password: &str) -> Result<Status> {
        let user = user.trim();
        if user.is_empty() || password.is_empty() {
            return Err(invalid("Enter a username and a password."));
        }
        self.sign_in_with(homeserver, Login::Password { user, password }).await
    }

    /// Sign in with a one-time login token (`m.login.token`), as the Matrix door on the owner's box hands one to this
    /// device (T-282): the same new device, store and record as a password sign-in, and no password on the device.
    pub async fn sign_in_token(self: &Arc<Self>, homeserver: &str, token: &str) -> Result<Status> {
        let token = token.trim();
        if token.is_empty() {
            return Err(invalid("There's no sign-in token."));
        }
        self.sign_in_with(homeserver, Login::Token(token)).await
    }

    async fn sign_in_with(self: &Arc<Self>, homeserver: &str, how: Login<'_>) -> Result<Status> {
        let homeserver = checked_homeserver(homeserver)?;
        // a sign-out still waiting for its logout finishes first, so it can't remove this sign-in afterwards
        let _turn = self.lifecycle.lock().await;
        let store = format!("store-{}", secrets::random_hex(6));
        let key = secrets::random_hex(32);
        let client = match self.build_client(&homeserver, &store, &key).await {
            Ok(client) => client,
            Err(e) => {
                self.remove_store(&store);
                return Err(e);
            }
        };
        let builder = match how {
            Login::Password { user, password } => client.matrix_auth().login_username(user, password),
            Login::Token(token) => client.matrix_auth().login_token(token),
        };
        let login = builder.initial_device_display_name("Uni").send();
        let login = match tokio::time::timeout(LOGIN_FOR, login).await {
            Ok(answer) => answer.map(|_| ()).map_err(from_sdk),
            Err(_) => Err(MessagesError::Unreachable { message: "The homeserver isn't answering.".into() }),
        };
        if let Err(e) = login {
            drop(client);
            self.remove_store(&store);
            return Err(e);
        }
        // signed in on the homeserver: a failure from here signs the new device out again
        let saved = async {
            let session = client.matrix_auth().session().ok_or_else(|| server("signed in without a session"))?;
            let sync = Self::sync_service(&client).await?;
            let record = Record { homeserver: homeserver.to_string(), session, store: store.clone(), key };
            if let Err(e) = self.secrets.set(ACCOUNT, &serde_json::to_string(&record).map_err(from_store)?) {
                // a save that failed may still have saved (a keychain that stored, then errored): the record decides
                if self.saved_store().as_deref() != Some(store.as_str()) {
                    return Err(from_store(e));
                }
                tracing::warn!("saving the account reported an error, but it is saved: {e}");
            }
            Ok::<_, MessagesError>(sync)
        };
        let sync = match saved.await {
            Ok(sync) => sync,
            Err(e) => {
                log_out(&client).await;
                drop(client);
                self.remove_store(&store);
                return Err(e);
            }
        };
        // saved: this is the device's account now. The old one stops, the new one runs; nothing here can fail.
        let old = self.live.lock().await.take();
        let old = match old {
            Some(l) => Some(l.stop().await),
            None => None,
        };
        self.run(client, sync, &homeserver, store.clone()).await;
        if let Some(old) = old {
            // best effort: the previous device leaves the homeserver too
            log_out(&old).await;
        }
        self.remove_stores(Some(&store));
        Ok(self.status())
    }

    /// Sign out: the device is removed on the homeserver if it answers, and the store and the saved account here are
    /// deleted either way. If the homeserver didn't confirm, the status says so.
    pub async fn sign_out(self: &Arc<Self>) -> Result<Status> {
        // held across the logout: no sign-in can finish while it waits and be deleted below
        let _turn = self.lifecycle.lock().await;
        let old = self.live.lock().await.take();
        let confirmed = match old {
            Some(l) => log_out(&l.stop().await).await,
            None => true,
        };
        let note = (!confirmed)
            .then(|| "Signed out on this device. The homeserver didn't confirm, so this device may still be listed there.".to_owned());
        Ok(self.wipe(note).await)
    }

    /// The homeserver no longer knows the device of sign-in `store` (signed out elsewhere, or its token revoked).
    /// Only if that is still the running account: one that has since been replaced is left alone.
    async fn ended_elsewhere(self: &Arc<Self>, store: String) {
        let _turn = self.lifecycle.lock().await;
        let mut live = self.live.lock().await;
        if live.as_ref().map(|l| l.store.as_str()) != Some(store.as_str()) {
            return;
        }
        let Some(l) = live.take() else { return };
        drop(live);
        l.stop().await;
        self.wipe(Some("This device was signed out on the homeserver. Sign in again.".into())).await;
    }

    /// Forget the account here: the saved record, the open rooms, every store. The stores go only once the record is
    /// gone, so a restart never finds a record without its store. Only under the lifecycle turn.
    async fn wipe(&self, note: Option<String>) -> Status {
        let forgotten = self.secrets.delete(ACCOUNT);
        for name in LEGACY {
            let _ = self.secrets.delete(name);
        }
        self.forget_rooms(None).await;
        let note = match forgotten {
            Ok(()) => {
                self.remove_stores(None);
                note
            }
            Err(e) => Some(format!("Signed out on this device, but its saved account couldn't be removed ({e}). Sign out again.")),
        };
        let s = Status::signed_out(note);
        self.set_status(s.clone());
        let _ = self.tx.send(Update::Rooms { rooms: vec![] });
        s
    }

    /// Close every open room; from now on rooms are opened for `account`.
    async fn forget_rooms(&self, account: Option<String>) {
        let mut open = self.open.lock().await;
        for (_, r) in open.rooms.drain() {
            r.task.abort();
        }
        for (_, t) in open.links.drain() {
            t.abort();
        }
        open.account = account;
        drop(open);
        self.rooms.lock().unwrap().clear();
        self.links.lock().unwrap().clear();
    }

    /// Stop the running account without signing out, as the app does when it quits: the saved account stays, and the
    /// next start picks it up.
    pub async fn shut_down(self: &Arc<Self>) {
        let _turn = self.lifecycle.lock().await;
        let old = self.live.lock().await.take();
        if let Some(l) = old {
            l.stop().await;
        }
        self.forget_rooms(None).await;
    }

    /// The store the saved record names, if there is a readable one.
    fn saved_store(&self) -> Option<String> {
        let saved = self.secrets.get(ACCOUNT).ok().flatten()?;
        serde_json::from_str::<Record>(&saved).ok().map(|r| r.store)
    }

    fn remove_store(&self, store: &str) {
        let _ = std::fs::remove_dir_all(self.dir.join(store));
    }

    /// Delete this account's store folders, except `keep`. Only under the lifecycle turn: no sign-in is building one.
    fn remove_stores(&self, keep: Option<&str>) {
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with("store") && Some(name.as_str()) != keep && is_dir(&e.path()) {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }

    /// Run an account whose sync service is built: its status, its room list, its session watch. Nothing here fails.
    async fn run(self: &Arc<Self>, client: Client, sync: Arc<SyncService>, homeserver: &Url, store: String) {
        self.forget_rooms(Some(store.clone())).await;
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
        let this = store.clone();
        let session_task = tokio::spawn(async move {
            loop {
                match changes.recv().await {
                    Ok(SessionChange::UnknownToken(_)) => {
                        if let Some(me) = me.upgrade() {
                            // its own task: ending the session aborts this one
                            tokio::spawn(async move { me.ended_elsewhere(this).await });
                        }
                        break;
                    }
                    Ok(_) => {}
                    // the channel holds one change, so a burst (both syncs refused at once) skips some: read on
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => break,
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
                // conversations only: a bridge's spaces and its bot's DM (linking, T-282) are not shown as conversations
                let rooms: Vec<Room> = list
                    .iter()
                    .map(|r: &matrix_sdk_ui::room_list_service::RoomListItem| (**r).clone())
                    .filter(|r| !r.is_space() && link::bridge_of(r).is_none())
                    .collect();
                // the most recent rooms and the open ones are subscribed: their latest message is known, and an open
                // room gets every event. Compared as a set, so a reordering alone doesn't resubscribe.
                let mut want: Vec<OwnedRoomId> = rooms.iter().take(SUBSCRIBED_ROOMS).map(|r| r.room_id().to_owned()).collect();
                want.extend(me.open.lock().await.rooms.keys().cloned());
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
        *self.live.lock().await = Some(Live { client, sync, tasks: vec![status_task, session_task, rooms_task], store });
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
    async fn timeline(self: &Arc<Self>, client: &Client, account: &str, room_id: &RoomId) -> Result<Arc<Timeline>> {
        let mut open = self.open.lock().await;
        if open.account.as_deref() != Some(account) {
            // the account changed since `client` was taken
            return Err(signed_out());
        }
        if let Some(r) = open.rooms.get(room_id) {
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
        open.rooms.insert(room_id.to_owned(), OpenRoom { timeline: timeline.clone(), task });
        drop(open);
        self.resubscribe.notify_one();
        Ok(timeline)
    }

    /// Open a room: its loaded messages now, and every change after as `Update::Timeline`.
    pub async fn open(self: &Arc<Self>, room_id: &str) -> Result<Vec<MessageRow>> {
        let room_id = Self::room_id(room_id)?;
        let (client, account) = self.client().await?;
        let timeline = self.timeline(&client, &account, &room_id).await?;
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
        if let Some(r) = self.open.lock().await.rooms.remove(&room_id) {
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
        let (client, account) = self.client().await?;
        let timeline = self.timeline(&client, &account, &room_id).await?;
        timeline.send(RoomMessageEventContent::text_plain(body).into()).await.map_err(server)?;
        Ok(())
    }

    /// Accept an invite.
    pub async fn join(&self, room_id: &str) -> Result<()> {
        let room_id = Self::room_id(room_id)?;
        let (client, _) = self.client().await?;
        let room = client.get_room(&room_id).ok_or_else(|| invalid("No invite to that room."))?;
        if room.state() != RoomState::Invited {
            return Ok(());
        }
        room.join().await.map_err(from_sdk)
    }

    /// Load older messages of an open room; `true` once the room's start is reached.
    pub async fn older(self: &Arc<Self>, room_id: &str) -> Result<bool> {
        let room_id = Self::room_id(room_id)?;
        let (client, account) = self.client().await?;
        let timeline = self.timeline(&client, &account, &room_id).await?;
        timeline.paginate_backwards(30).await.map_err(server)
    }

    /// Mark an open room read up to its latest message.
    pub async fn read(self: &Arc<Self>, room_id: &str) -> Result<()> {
        let room_id = Self::room_id(room_id)?;
        let (client, account) = self.client().await?;
        let timeline = self.timeline(&client, &account, &room_id).await?;
        timeline.mark_as_read(ReceiptType::Read).await.map(|_| ()).map_err(from_sdk)
    }

    /// The commands by name, as the Tauri commands and the dev bridge both offer them.
    pub async fn call(self: &Arc<Self>, cmd: &str, args: &Value) -> Result<Value> {
        let s = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
        let to = |v: &dyn ToJson| v.to_json();
        Ok(match cmd {
            "messages_status" => to(&self.resume().await?),
            "messages_sign_in" => to(&self.sign_in(&s("homeserver"), &s("user"), &s("password")).await?),
            "messages_sign_in_token" => to(&self.sign_in_token(&s("homeserver"), &s("token")).await?),
            "messages_sign_out" => to(&self.sign_out().await?),
            "messages_rooms" => to(&self.rooms().await?),
            "messages_open" => to(&self.open(&s("roomId")).await?),
            "messages_close" => to(&self.close(&s("roomId")).await?),
            "messages_send" => to(&self.send(&s("roomId"), &s("body")).await?),
            "messages_join" => to(&self.join(&s("roomId")).await?),
            "messages_older" => to(&self.older(&s("roomId")).await?),
            "messages_read" => to(&self.read(&s("roomId")).await?),
            "messages_links" => to(&self.links().await?),
            "messages_link_check" => to(&self.link_check(&s("network")).await?),
            "messages_link_start" => to(&self.link_start(&s("network"), Some(&s("flow")), Some(&s("relogin"))).await?),
            "messages_link_send" => to(&self.link_send(&s("network"), &s("value")).await?),
            "messages_link_cancel" => to(&self.link_cancel(&s("network")).await?),
            _ => return Err(invalid(format!("no such command: {cmd}"))),
        })
    }
}

/// How a sign-in proves who it is.
enum Login<'a> {
    Password { user: &'a str, password: &'a str },
    /// A one-time `m.login.token`.
    Token(&'a str),
}

/// Log a device out, within `LOGOUT_FOR`; whether the homeserver confirmed it.
async fn log_out(client: &Client) -> bool {
    matches!(tokio::time::timeout(LOGOUT_FOR, client.logout()).await, Ok(Ok(())))
}

/// A store key from its hex form.
fn key_bytes(hex: &str) -> Option<[u8; 32]> {
    let b = hex.as_bytes();
    if b.len() != 64 {
        return None;
    }
    let digit = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let mut key = [0u8; 32];
    for (i, pair) in b.chunks(2).enumerate() {
        key[i] = digit(pair[0])? << 4 | digit(pair[1])?;
    }
    Some(key)
}

fn is_dir(p: &Path) -> bool {
    std::fs::symlink_metadata(p).map(|m| m.is_dir()).unwrap_or(false)
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
