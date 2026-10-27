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

mod copies;
mod download;
mod link;
mod secrets;
mod view;

pub use link::{Flow, LinkRow, LinkStep, LinkedAccount, Network, NETWORKS};
pub use secrets::{FileSecrets, Secrets};
pub use view::{checked_homeserver, safe_mime, Media, MediaKind, MessageKind, MessageRow, Reaction, Reply, RoomRow, SendState};

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
    ruma::{
        api::client::receipt::create_receipt::v3::ReceiptType, events::room::message::RoomMessageEventContent, EventId, OwnedEventId, OwnedRoomId,
        RoomId,
    },
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
pub(crate) const REQUEST_FOR: Duration = Duration::from_secs(15);
const RETRY_PAUSE: Duration = Duration::from_secs(5);
/// A sign-in's login and a logout, all tries included. Account changes wait on these, so they are kept short.
const LOGIN_FOR: Duration = Duration::from_secs(30);
const LOGOUT_FOR: Duration = Duration::from_secs(10);
/// How long the status waits for an account change under way before answering with the status as it is.
const STATUS_WAIT: Duration = Duration::from_secs(2);
/// How long stopping an account's sync may take, twice at most. Normally it is at once; see `Live::stop`.
const STOP_FOR: Duration = Duration::from_secs(3);
/// After a send failed for a reason that passes (the homeserver restarting, the network gone), the SDK pauses the
/// room's send queue; it is turned back on after this, then twice as long each time, up to `QUEUE_RETRY_MAX`.
const QUEUE_RETRY: Duration = Duration::from_secs(2);
const QUEUE_RETRY_MAX: Duration = Duration::from_secs(30);
/// The crypto database in a store folder (matrix-sdk-sqlite's name for it): a store without it has no keys.
const CRYPTO_DB: &str = "matrix-sdk-crypto.sqlite3";
/// T-313: the largest attachment fetched for the app (`Messages::set_media_limit` lowers it), and how long its download
/// may take. The limit holds while the bytes arrive (download.rs).
pub const MAX_MEDIA: u64 = 100 * 1024 * 1024;
pub(crate) const MEDIA_FOR: Duration = Duration::from_secs(120);
/// How long quitting waits for an attachment copy being written to remove itself.
const QUIT_WAIT: Duration = Duration::from_secs(2);
/// The largest voice message sent to be transcribed (the transcription service's own limit).
pub const MAX_TRANSCRIBE: usize = 25 * 1024 * 1024;
/// How long a transcription may take: the service runs near real time on a CPU.
const TRANSCRIBE_FOR: Duration = Duration::from_secs(300);
/// Transcriptions running at once; the rest wait their turn.
const TRANSCRIBING: usize = 2;
/// Where a voice message's transcript is kept: in the account's encrypted store, by event.
const TRANSCRIPT_KEY: &str = "uni.transcript.v1:";
/// Replied-to messages asked for at once, at most: the rest are asked for with the room's next change (a page loaded, a
/// message arriving, an answer coming back), so a long history is fetched a batch at a time.
const REPLY_FETCHES: usize = 20;

/// T-313: turns a voice message into words. The app's is uni-transcribe on the owner's box (faster-whisper, reached
/// with the device key: src-tauri's messages.rs); the tests use their own. Answers the words, or why not.
pub trait Transcriber: Send + Sync {
    fn transcribe(&self, audio: Vec<u8>, mime: String) -> Transcribing;
}

/// A transcription under way.
pub type Transcribing = std::pin::Pin<Box<dyn std::future::Future<Output = std::result::Result<String, String>> + Send>>;

/// A voice message's words, as transcribed once and kept.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Transcript {
    pub text: String,
}

/// An attachment's bytes, decrypted, with the type the app may give them (`view::safe_mime`) and its file name.
pub struct Fetched {
    pub bytes: Vec<u8>,
    pub mime: String,
    pub name: String,
}

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
    links: HashMap<&'static str, (OwnedRoomId, JoinHandle<()>)>,
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
    /// The cards' revision counter (`LinkRow::rev`).
    link_rev: std::sync::atomic::AtomicU64,
    /// Bot DMs are found or made one at a time (link.rs says why); the ones made here, by account and network.
    link_creating: tokio::sync::Mutex<HashMap<(String, &'static str), OwnedRoomId>>,
    /// T-313: what turns voice messages into words, if this device has one.
    transcriber: StdMutex<Option<Arc<dyn Transcriber>>>,
    /// One transcription per voice message at a time: a second ask waits for the first, then reads what it kept.
    transcribing: StdMutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// At most `TRANSCRIBING` sent to the transcriber at once.
    transcribe_turns: Arc<tokio::sync::Semaphore>,
    /// The largest attachment fetched (`MAX_MEDIA` unless lowered).
    media_max: std::sync::atomic::AtomicU64,
    /// Decrypted copies written for the system's viewer, by account; they go when it does (copies.rs).
    copies: Arc<copies::Registry>,
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
            link_rev: std::sync::atomic::AtomicU64::new(0),
            link_creating: tokio::sync::Mutex::new(HashMap::new()),
            transcriber: StdMutex::new(None),
            transcribing: StdMutex::new(HashMap::new()),
            transcribe_turns: Arc::new(tokio::sync::Semaphore::new(TRANSCRIBING)),
            media_max: std::sync::atomic::AtomicU64::new(MAX_MEDIA),
            copies: Arc::new(Default::default()),
        })
    }

    /// T-313: the largest attachment this device fetches, at most `MAX_MEDIA` (a device with less memory, or a test).
    pub fn set_media_limit(&self, max: u64) {
        self.media_max.store(max.min(MAX_MEDIA), std::sync::atomic::Ordering::Relaxed);
    }

    fn media_limit(&self) -> u64 {
        self.media_max.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// T-313: how this device turns voice messages into words. Without one, `transcript` says it can't.
    pub fn set_transcriber(&self, t: Arc<dyn Transcriber>) {
        *self.transcriber.lock().unwrap() = Some(t);
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
        for (_, (_, t)) in open.links.drain() {
            t.abort();
        }
        // the attachments opened for another account go with it (and all of them when none is in force)
        self.copies.lock().sweep(account.as_deref());
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

        // a send that failed for a reason that passes pauses its room's queue (matrix-sdk does that, so it doesn't spin);
        // turn it back on after a moment, so messages written while the homeserver restarted go out after all, and
        // later ones don't wait as "sending" forever
        let queue = client.clone();
        let mut errors = client.send_queue().subscribe_errors();
        let queue_task = tokio::spawn(async move {
            let mut pause = QUEUE_RETRY;
            let mut last = std::time::Instant::now();
            loop {
                match errors.recv().await {
                    Ok(e) if e.is_recoverable => {}
                    Ok(_) => continue,
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => break,
                }
                // one outage pauses every room that tried to send: wait once, then wake them all together; if it
                // fails again straight away, wait longer next time
                if last.elapsed() > QUEUE_RETRY_MAX * 4 {
                    pause = QUEUE_RETRY;
                }
                tokio::time::sleep(pause).await;
                while errors.try_recv().is_ok() {}
                last = std::time::Instant::now();
                pause = (pause * 2).min(QUEUE_RETRY_MAX);
                tracing::warn!("sending paused after a failure that passes; turning the send queues back on");
                queue.send_queue().set_enabled(true).await;
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
            // T-310: each room's network, once known: it doesn't change, so a new message doesn't read every room's
            // power levels again. Not kept while it can't be told ("other"): the room's state may still be on its way.
            let mut networks: HashMap<OwnedRoomId, &'static str> = HashMap::new();
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
                        let row = view::room_row(r, &RoomExt::latest_event(r).await, networks.get(r.room_id()).copied()).await;
                        if row.network != "other" {
                            networks.insert(r.room_id().to_owned(), row.network);
                        }
                        rows.push(row);
                    }
                    *me.rooms.lock().unwrap() = rows.clone();
                    let _ = me.tx.send(Update::Rooms { rooms: rows });
                }
            }
        });

        sync.start().await;
        *self.live.lock().await = Some(Live { client, sync, tasks: vec![status_task, session_task, queue_task, rooms_task], store });
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
        self.timeline_with(client, account, room_id, true).await
    }

    /// As `timeline`; `forward: false` (and any bridge bot's DM) keeps its rows in Rust: they are what is typed into a
    /// login step, which the app's screen never shows as a conversation.
    async fn timeline_with(self: &Arc<Self>, client: &Client, account: &str, room_id: &RoomId, forward: bool) -> Result<Arc<Timeline>> {
        let mut open = self.open.lock().await;
        if open.account.as_deref() != Some(account) {
            // the account changed since `client` was taken
            return Err(signed_out());
        }
        if let Some(r) = open.rooms.get(room_id) {
            return Ok(r.timeline.clone());
        }
        let room = client.get_room(room_id).ok_or_else(|| invalid("This account isn't in that room."))?;
        let forward = forward && link::bridge_of(&room).is_none();
        let timeline = Arc::new(room.timeline().await.map_err(server)?);
        // the members' names: sliding sync loads members lazily, so a sender shows by user id until they're fetched
        let members = timeline.clone();
        tokio::spawn(async move { members.fetch_members().await });
        let (items, mut stream) = timeline.subscribe().await;
        let me = Arc::downgrade(self);
        let id = room_id.to_string();
        let user = client.user_id().map(ToOwned::to_owned);
        let replies = timeline.clone();
        let task = tokio::spawn(async move {
            // live receive: every change to the room's timeline (a message arriving, our own echo turning into the
            // sent event, an edit, a late decryption) goes to the app as the room's rows
            let mut items = items;
            let mut asked = std::collections::HashSet::new();
            fetch_replies(&replies, &view::message_rows(&items, user.as_deref()), &mut asked);
            while let Some(diffs) = stream.next().await {
                for d in diffs {
                    d.apply(&mut items);
                }
                let Some(me) = me.upgrade() else { break };
                if forward {
                    let rows = view::message_rows(&items, user.as_deref());
                    fetch_replies(&replies, &rows, &mut asked);
                    let _ = me.tx.send(Update::Timeline { room_id: id.clone(), items: rows });
                }
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
        if client.get_room(&room_id).is_some_and(|r| link::bridge_of(&r).is_some()) {
            // linking, not a conversation: what was typed there stays in Rust
            return Err(invalid("That is a bridge's linking room, not a conversation."));
        }
        let timeline = self.timeline(&client, &account, &room_id).await?;
        let me = client.user_id();
        let mut rows = view::message_rows(&timeline.items().await, me);
        if rows.len() < 20 {
            // a fresh room shows its start; an older one, its last screenful. A failed page is not fatal: what is
            // loaded is shown, and "Load earlier messages" can ask again.
            if timeline.paginate_backwards(30).await.is_ok() {
                rows = view::message_rows(&timeline.items().await, me);
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
        if client.get_room(&room_id).is_some_and(|r| link::bridge_of(&r).is_some()) {
            // a bridge's linking room: only link.rs says anything there, once and checked (never the send queue)
            return Err(invalid("That is a bridge's linking room, not a conversation."));
        }
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

    /// T-313: an open room's media message: where its bytes are and what it is. Only a message the room's timeline
    /// holds: the app names an event, never a media address, so it can't make this fetch anything else.
    async fn media_message(self: &Arc<Self>, room_id: &str, event_id: &str) -> Result<(Client, String, OwnedEventId, matrix_sdk::ruma::events::room::MediaSource, Media)> {
        let room_id = Self::room_id(room_id)?;
        let event_id = EventId::parse(event_id).map_err(|_| invalid("That isn't an event id."))?;
        let (client, account) = self.client().await?;
        if client.get_room(&room_id).is_some_and(|r| link::bridge_of(&r).is_some()) {
            return Err(invalid("That is a bridge's linking room, not a conversation."));
        }
        let timeline = self.timeline(&client, &account, &room_id).await?;
        let item = timeline.item_by_event_id(&event_id).await.ok_or_else(|| invalid("That message isn't loaded here."))?;
        let (source, media) = view::media_of(&item).ok_or_else(|| invalid("That message has no attachment."))?;
        Ok((client, account, event_id, source, media))
    }

    /// An attachment's bytes, within this device's limit: refused before the download when its event says it is larger,
    /// and stopped while it arrives if it turns out to be (download.rs).
    async fn bytes_of(&self, client: &Client, source: matrix_sdk::ruma::events::room::MediaSource, media: &Media, max: u64) -> Result<Vec<u8>> {
        if media.size.is_some_and(|n| n > max) {
            return Err(download::too_big());
        }
        download::download(client, source, max).await
    }

    /// T-313: an attachment's bytes, through the account's own client: the homeserver's authenticated media download
    /// (with the account's token, which never leaves Rust), decrypted here for an encrypted room, and kept in the
    /// account's encrypted media store so it is fetched once.
    pub async fn media(self: &Arc<Self>, room_id: &str, event_id: &str) -> Result<Fetched> {
        let (client, _, _, source, media) = self.media_message(room_id, event_id).await?;
        let bytes = self.bytes_of(&client, source, &media, self.media_limit()).await?;
        Ok(Fetched { bytes, mime: media.mime, name: media.name })
    }

    /// T-313: what a media message carries (its name, type, size), without fetching it.
    pub async fn media_info(self: &Arc<Self>, room_id: &str, event_id: &str) -> Result<Media> {
        Ok(self.media_message(room_id, event_id).await?.4)
    }

    /// T-313: write an attachment, decrypted, to `file`, for the system's viewer; answers the type it may be opened as.
    /// The copy belongs to the account: it is removed when the account ends (copies.rs), and one finished after its
    /// account ended is removed and refused, never handed over. `drop_copy` removes it sooner.
    pub async fn write_copy(self: &Arc<Self>, room_id: &str, event_id: &str, file: &Path) -> Result<String> {
        let (client, account, _, source, media) = self.media_message(room_id, event_id).await?;
        let bytes = self.bytes_of(&client, source, &media, self.media_limit()).await?;
        let ticket = self.copies.lock().add(&account, file);
        let ended = || invalid("Messages signed out or closed while the file was being opened.");
        match copies::write_copy(self.copies.clone(), ticket, file.to_owned(), bytes, || {}).await {
            Ok(true) => {}
            // ended while it was written (signed out, replaced, or the app quitting): its writer removed it
            Ok(false) => return Err(ended()),
            Err(e) => return Err(server(format!("couldn't write the file to open: {e}"))),
        }
        let now = self.live.lock().await.as_ref().map(|l| l.store.clone());
        if !self.copies.lock().settle(ticket, file, &account, now.as_deref()) {
            return Err(ended());
        }
        Ok(media.mime)
    }

    /// T-313: the app is quitting: every copy goes now, none is written from here on, and a write under way is waited for
    /// (up to `QUIT_WAIT`) while it removes what it wrote (copies.rs). A quit without this, as Android may kill the app,
    /// leaves them to the app's next start, which removes them.
    pub fn drop_copies(&self) {
        if !copies::close_and_wait(&self.copies, QUIT_WAIT) {
            tracing::warn!("a copy was still being written as the app quit; the next start removes it");
        }
    }

    /// T-313: done with a copy `write_copy` made: removed now.
    pub fn drop_copy(&self, file: &Path) {
        self.copies.lock().remove(file);
    }

    /// T-313: a voice message's words. Transcribed once, by this device's transcriber, and kept in the account's
    /// encrypted store, so a second ask (this session or after a restart) reads them back. Two asks at once share one
    /// transcription. A failure isn't kept: asking again tries again.
    pub async fn transcript(self: &Arc<Self>, room_id: &str, event_id: &str) -> Result<Transcript> {
        let (client, _, event_id, source, media) = self.media_message(room_id, event_id).await?;
        if !matches!(media.kind, MediaKind::Voice | MediaKind::Audio) {
            return Err(invalid("Only a voice message or audio is transcribed."));
        }
        let key = format!("{TRANSCRIPT_KEY}{event_id}");
        let gate = self.transcribing.lock().unwrap().entry(key.clone()).or_default().clone();
        // the gate goes once nobody holds it, however this ask ends (answered, failed, or dropped by its caller)
        let _gone = GateGuard { gates: &self.transcribing, key: key.clone(), gate: gate.clone() };
        let _turn = gate.lock().await;
        let done = async {
            if let Some(kept) = client.state_store().get_custom_value(key.as_bytes()).await.map_err(from_store)? {
                return serde_json::from_slice::<Transcript>(&kept).map_err(from_store);
            }
            let transcriber = self.transcriber.lock().unwrap().clone().ok_or_else(|| MessagesError::Unreachable {
                message: "Transcription isn't available on this device.".into(),
            })?;
            if media.size.is_some_and(|n| n > MAX_TRANSCRIBE as u64) {
                return Err(invalid("This recording is too long to transcribe."));
            }
            // the turn is taken before the download, so waiting asks don't each hold a clip in memory
            let _slot = self.transcribe_turns.clone().acquire_owned().await.map_err(server)?;
            let audio = self.bytes_of(&client, source, &media, (MAX_TRANSCRIBE as u64).min(self.media_limit())).await.map_err(|e| match e {
                MessagesError::Invalid { message } if message == download::TOO_LARGE => invalid("This recording is too long to transcribe."),
                e => e,
            })?;
            let text = match tokio::time::timeout(TRANSCRIBE_FOR, transcriber.transcribe(audio, media.mime.clone())).await {
                Ok(Ok(text)) => text.trim().to_owned(),
                Ok(Err(e)) => {
                    // the detail (an HTTP answer, a host) is for the log; the person reads that it didn't work this time
                    tracing::warn!("transcribing a voice message failed: {e}");
                    return Err(MessagesError::Unreachable { message: "Couldn't transcribe it right now.".into() });
                }
                Err(_) => return Err(MessagesError::Unreachable { message: "Transcribing took too long.".into() }),
            };
            let t = Transcript { text };
            let kept = serde_json::to_vec(&t).map_err(from_store)?;
            // the account may have been signed out meanwhile: its store is gone with it, and so are these words
            if self.client().await.is_ok_and(|(c, _)| c.user_id() == client.user_id()) {
                client.state_store().set_custom_value_no_read(key.as_bytes(), kept).await.map_err(from_store)?;
            }
            Ok(t)
        }
        .await;
        drop(_turn);
        drop(gate);
        done
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
            "messages_transcript" => to(&self.transcript(&s("roomId"), &s("eventId")).await?),
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

/// Removes a voice message's transcription gate when the last ask holding it ends.
struct GateGuard<'a> {
    gates: &'a StdMutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    key: String,
    gate: Arc<tokio::sync::Mutex<()>>,
}

impl Drop for GateGuard<'_> {
    fn drop(&mut self) {
        let mut gates = self.gates.lock().unwrap();
        // the map's, this guard's and the caller's own: nobody else holds it
        if gates.get(&self.key).is_some_and(|g| Arc::ptr_eq(g, &self.gate) && Arc::strong_count(g) <= 3) {
            gates.remove(&self.key);
        }
    }
}

/// Ask the homeserver for the messages replies answer that the timeline doesn't hold yet, each once per open room and
/// at most `REPLY_FETCHES`; each arrives as a timeline change, so the reply shows its quote.
fn fetch_replies(timeline: &Arc<Timeline>, rows: &[MessageRow], asked: &mut std::collections::HashSet<String>) {
    let mut now = 0;
    // newest first: what's on screen when a room opens
    for r in rows.iter().rev() {
        let (Some(reply), Some(id)) = (&r.reply, &r.event_id) else { continue };
        if reply.text.is_some() || reply.unavailable || asked.contains(id) {
            continue;
        }
        if now == REPLY_FETCHES {
            break;
        }
        now += 1;
        asked.insert(id.clone());
        let Ok(id) = EventId::parse(id) else { continue };
        let t = timeline.clone();
        tokio::spawn(async move {
            let _ = t.fetch_details_for_event(&id).await;
        });
    }
}

/// Log a device out, within `LOGOUT_FOR`; whether the homeserver confirmed it.
async fn log_out(client: &Client) -> bool {
    matches!(tokio::time::timeout(LOGOUT_FOR, client.logout()).await, Ok(Ok(())))
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
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
