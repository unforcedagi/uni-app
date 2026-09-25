//! Shared Tauri conversation bridge. Signing and relay I/O remain in Rust.
use serde::Serialize;
use std::path::PathBuf;
use tauri::{Emitter, Manager};
use uni_core::{
    remove_reaction, send_message, send_reaction, sync_older, sync_once, ConversationMessage,
    LiveConfig, LiveEvent, Store,
};

// Serialize foreground refresh, send and forget so SQLite and relay
// watermarks cannot race.
static IO_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Serialize)]
struct MessageView {
    #[serde(rename = "ref")]
    id: String,
    channel: String,
    author: String,
    author_name: String,
    ts: i64,
    body: String,
    mentions_me: bool,
    root: Option<String>,
    parent: Option<String>,
    /// `p`-tag recipients other than the author, with display labels, so the
    /// UI can highlight `@Label` only where the event really tagged someone.
    mentions: Vec<MemberView>,
    reply_count: i64,
    last_reply_ts: Option<i64>,
    /// Body is the author's latest kind-40003 edit.
    edited: bool,
    /// Live reactions grouped by emoji, in first-use order.
    reactions: Vec<ReactionView>,
    /// NIP-92 `imeta` attachments, in tag order.
    media: Vec<uni_core::MediaRef>,
}

#[derive(Serialize)]
struct ReactionView {
    emoji: String,
    count: i64,
    /// Our own reaction event id with this emoji (tap again to undo).
    mine: Option<String>,
}

#[derive(Serialize)]
struct MemberView {
    pubkey: String,
    name: String,
    /// True when the name comes from a kind-0 profile (not a key prefix).
    named: bool,
}

#[derive(Serialize)]
struct RoomView {
    id: String,
    name: String,
    last_message: Option<String>,
    last_ts: Option<i64>,
    /// An unread message mentions us.
    mentions: bool,
    /// Messages from others since the room was last viewed.
    unread: i64,
}

#[derive(Serialize)]
struct SyncView {
    pubkey: String,
    total_items: i64,
    channel_errors: std::collections::BTreeMap<String, String>,
    truncated_channels: Vec<String>,
}

fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("uni.db"))
}

const DEFAULT_RELAY: &str = "wss://buzz.unforced.org";

/// Relay: `UNI_RELAY_URL`, else the one learned when pairing (not secret,
/// stored as `relay-url` in app data), else the default.
fn relay_url(app: &tauri::AppHandle) -> String {
    if let Ok(v) = std::env::var("UNI_RELAY_URL") {
        return v;
    }
    app.path()
        .app_data_dir()
        .ok()
        .and_then(|d| std::fs::read_to_string(d.join("relay-url")).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| s.starts_with("wss://"))
        .unwrap_or_else(|| DEFAULT_RELAY.into())
}

fn view(store: &Store, message: ConversationMessage) -> Result<MessageView, String> {
    view_with_summary(store, message, 0, None)
}

fn view_with_summary(
    store: &Store,
    message: ConversationMessage,
    reply_count: i64,
    last_reply_ts: Option<i64>,
) -> Result<MessageView, String> {
    let mentions = store
        .message_mentions(&message.item.r#ref)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|pk| *pk != message.item.author)
        .map(|pk| member_view(store, pk))
        .collect::<Result<Vec<_>, String>>()?;
    Ok(MessageView {
        mentions,
        reply_count,
        last_reply_ts,
        author_name: store
            .display_name(&message.item.author)
            .map_err(|e| e.to_string())?,
        id: message.item.r#ref,
        channel: message.item.channel,
        author: message.item.author,
        ts: message.item.ts,
        body: message.item.body,
        mentions_me: message.item.mentions_me,
        root: message.root,
        parent: message.parent,
        edited: message.edited,
        reactions: Vec::new(),
        media: Vec::new(),
    })
}

/// Attach grouped reactions to a batch of message views (one query).
fn with_reactions(store: &Store, mut views: Vec<MessageView>) -> Result<Vec<MessageView>, String> {
    let me = uni_core::load_keys(false).ok().map(|(k, _)| k.public_key().to_hex());
    let ids: Vec<String> = views.iter().map(|v| v.id.clone()).collect();
    let all = store.reactions(&ids, me.as_deref()).map_err(|e| e.to_string())?;
    let mut media = store.message_media(&ids).map_err(|e| e.to_string())?;
    for v in &mut views {
        v.reactions = all
            .iter()
            .filter(|r| r.target == v.id)
            .map(|r| ReactionView { emoji: r.emoji.clone(), count: r.count, mine: r.mine.clone() })
            .collect();
        v.media = media
            .iter_mut()
            .filter(|(id, _)| *id == v.id)
            .map(|(_, m)| std::mem::take(m))
            .collect();
    }
    Ok(views)
}

fn member_view(store: &Store, pubkey: String) -> Result<MemberView, String> {
    let label = store
        .profile(&pubkey)
        .map_err(|e| e.to_string())?
        .and_then(|p| p.label().map(str::to_string));
    Ok(MemberView {
        name: label
            .clone()
            .unwrap_or_else(|| pubkey[..8.min(pubkey.len())].to_string()),
        named: label.is_some(),
        pubkey,
    })
}

/// Members of a joined channel (kind-39002 roster) with kind-0 names.
#[tauri::command]
fn get_members(app: tauri::AppHandle, channel: String) -> Result<Vec<MemberView>, String> {
    let store = Store::open(db_path(&app)?).map_err(|e| e.to_string())?;
    store
        .channel_members(&channel)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|m| {
            Ok(MemberView {
                named: m.name.is_some(),
                name: m
                    .name
                    .unwrap_or_else(|| m.pubkey[..8.min(m.pubkey.len())].to_string()),
                pubkey: m.pubkey,
            })
        })
        .collect()
}

/// Our pubkey if the key is already loaded (no keystore round-trip).
fn my_pubkey() -> Option<String> {
    uni_core::has_device_keys()
        .then(|| uni_core::load_keys(false).ok())
        .flatten()
        .map(|(k, _)| k.public_key().to_hex())
}

#[tauri::command]
fn get_rooms(app: tauri::AppHandle) -> Result<Vec<RoomView>, String> {
    let store = Store::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let me = my_pubkey();
    store
        .rooms_for(me.as_deref())
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|r| {
            Ok(RoomView {
                name: r
                    .name
                    .unwrap_or_else(|| format!("Room {}", &r.id[..8.min(r.id.len())])),
                id: r.id,
                last_message: r.last_message,
                last_ts: r.last_ts,
                mentions: r.mentions,
                unread: r.unread,
            })
        })
        .collect()
}

#[tauri::command]
fn get_messages(
    app: tauri::AppHandle,
    channel: String,
    root: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<MessageView>, String> {
    // The UI grows `limit` as older pages are loaded.
    let limit = limit.unwrap_or(300).clamp(1, 5000);
    let store = Store::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let views: Vec<MessageView> = match root {
        // Thread view: the root and every cached reply, chronological.
        Some(id) => store
            .thread_messages(&channel, &id, limit)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|m| view(&store, m))
            .collect::<Result<_, _>>()?,
        // Main timeline: roots only, each with its reply summary.
        None => store
            .room_timeline(&channel, limit)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|t| view_with_summary(&store, t.message, t.reply_count, t.last_reply_ts))
            .collect::<Result<_, _>>()?,
    };
    with_reactions(&store, views)
}

/// The user is looking at `channel`: everything cached there is read.
#[tauri::command]
fn mark_read(app: tauri::AppHandle, channel: String) -> Result<(), String> {
    let store = Store::open(db_path(&app)?).map_err(|e| e.to_string())?;
    store.mark_read(&channel).map_err(|e| e.to_string())
}

/// Open a link from a message in the system browser. Only web and mail links;
/// anything else (javascript:, file:, intent:) is refused.
#[tauri::command]
fn open_link(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let lower = url.trim().to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:")) {
        return Err("only http(s) and mailto links can be opened".into());
    }
    app.opener()
        .open_url(url.trim(), None::<&str>)
        .map_err(|e| e.to_string())
}

// ── Live updates ─────────────────────────────────────────────────────────
//
// One long-lived relay connection (uni_core::run_live) while the app is in
// the foreground. SQLite's Connection is !Send, so the loop owns a dedicated
// OS thread with its own current-thread runtime and its own Store handle
// (WAL + busy_timeout let foreground commands read/write alongside it). Each
// stored change is announced to the webview as a `uni://live` event; the UI
// re-reads from SQLite, which stays the single source of truth.

static LIVE: std::sync::Mutex<Option<uni_core::live::StopSender>> = std::sync::Mutex::new(None);

#[derive(Clone, Serialize)]
struct LivePayload {
    /// `message`, `edit`, `delete`, `rooms`, `profiles`, `status`.
    kind: &'static str,
    channel: Option<String>,
    /// Connection status text for `status` events.
    status: Option<String>,
    /// For `message`: the author, so the UI can skip marking own sends unread.
    author: Option<String>,
}

fn live_payload(ev: &LiveEvent) -> Option<LivePayload> {
    let p = |kind, channel: Option<String>, status: Option<String>, author| LivePayload {
        kind,
        channel,
        status,
        author,
    };
    Some(match ev {
        LiveEvent::Message { item, new: true } => p(
            "message",
            Some(item.channel.clone()),
            None,
            Some(item.author.clone()),
        ),
        LiveEvent::Message { new: false, .. } => return None,
        LiveEvent::Aux { channel, kind, .. } => p(
            if *kind == 40003 { "edit" } else { "delete" },
            Some(channel.to_string()),
            None,
            None,
        ),
        LiveEvent::ChannelAdded { channel } | LiveEvent::ChannelRemoved { channel } => {
            p("rooms", Some(channel.to_string()), None, None)
        }
        LiveEvent::Profiles { .. } => p("profiles", None, None, None),
        LiveEvent::Connected { .. } => p("status", None, Some("Live".into()), None),
        LiveEvent::Eose { channel } => p("rooms", Some(channel.to_string()), None, None),
        LiveEvent::Disconnected { retry_in, .. } => p(
            "status",
            None,
            Some(format!("Reconnecting in {}s…", retry_in.as_secs().max(1))),
            None,
        ),
        LiveEvent::Stopped { reason } => p("status", None, Some(format!("Live stopped: {reason}")), None),
        LiveEvent::ChannelClosed { channel, message } => p(
            "status",
            Some(channel.to_string()),
            Some(format!("Room {} closed: {message}", &channel.to_string()[..8])),
            None,
        ),
    })
}

/// Start the live subscription (idempotent: a running loop is left alone).
#[tauri::command]
async fn live_start(app: tauri::AppHandle) -> Result<bool, String> {
    secure_store::ensure_loaded(&app).await?;
    let path = db_path(&app)?;
    let url = relay_url(&app);
    let (keys, _) = uni_core::load_keys(false).map_err(|e| e.to_string())?;
    let mut slot = LIVE.lock().map_err(|e| e.to_string())?;
    if slot.as_ref().is_some_and(|s| !s.is_closed()) {
        return Ok(false);
    }
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    *slot = Some(stop_tx);
    drop(slot);
    std::thread::Builder::new()
        .name("uni-live".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                Ok(rt) => rt,
                Err(e) => {
                    tracing::error!("live runtime: {e}");
                    return;
                }
            };
            rt.block_on(async move {
                let store = match Store::open(&path) {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = app.emit("uni://live", LivePayload {
                            kind: "status",
                            channel: None,
                            status: Some(format!("Live unavailable: {e}")),
                            author: None,
                        });
                        return;
                    }
                };
                let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
                let forward_app = app.clone();
                let forward = async move {
                    while let Some(ev) = rx.recv().await {
                        if let Some(payload) = live_payload(&ev) {
                            let _ = forward_app.emit("uni://live", payload);
                        }
                    }
                };
                let runner = uni_core::run_live(LiveConfig::new(url), &keys, None, &store, tx, stop_rx);
                let (result, _) = tokio::join!(runner, forward);
                if let Err(e) = result {
                    tracing::warn!("live loop ended: {e}");
                }
            });
            // The stop receiver is dropped with the loop, so live_start can
            // tell a finished loop (is_closed) from a running one.
        })
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// Stop the live subscription (app backgrounded). Safe to call when stopped.
#[tauri::command]
fn live_stop() -> Result<(), String> {
    if let Some(tx) = LIVE.lock().map_err(|e| e.to_string())?.take() {
        let _ = tx.send(true);
    }
    Ok(())
}

#[tauri::command]
async fn get_identity(app: tauri::AppHandle) -> Result<String, String> {
    secure_store::ensure_loaded(&app).await?;
    uni_core::load_keys(false)
        .map(|(keys, _)| keys.public_key().to_hex())
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct IdentityStatus {
    paired: bool,
    pubkey: Option<String>,
}

#[tauri::command]
async fn identity_status(app: tauri::AppHandle) -> Result<IdentityStatus, String> {
    secure_store::ensure_loaded(&app).await?;
    // Desktop may hit the OS keyring here; keep it off the async executor.
    let pubkey = tauri::async_runtime::spawn_blocking(|| {
        uni_core::load_keys(false)
            .ok()
            .map(|(k, _)| k.public_key().to_hex())
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(IdentityStatus {
        paired: pubkey.is_some(),
        pubkey,
    })
}

/// Forget this device's key and the local message cache that belongs to it.
#[tauri::command]
async fn identity_forget(app: tauri::AppHandle) -> Result<(), String> {
    let _gate = IO_GATE.lock().await;
    let _ = live_stop();
    secure_store::forget(&app).await?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    for f in ["uni.db", "uni.db-wal", "uni.db-shm", "relay-url"] {
        let _ = std::fs::remove_file(dir.join(f));
    }
    Ok(())
}

// One pairing at a time; the pending session owns its relay connection.
static PAIRING: tokio::sync::Mutex<Option<uni_core::pairing::PendingPairing>> =
    tokio::sync::Mutex::const_new(None);

#[derive(Serialize)]
struct PairingStarted {
    sas: String,
}

#[tauri::command]
async fn pairing_start(uri: String) -> Result<PairingStarted, String> {
    let mut slot = PAIRING.lock().await;
    if let Some(old) = slot.take() {
        let _ = old.cancel(false).await;
    }
    let pending = uni_core::pairing::start(&uri)
        .await
        .map_err(|e| e.to_string())?;
    let sas = pending.sas().to_string();
    *slot = Some(pending);
    Ok(PairingStarted { sas })
}

#[derive(Serialize)]
struct PairingDone {
    pubkey: String,
}

#[tauri::command]
async fn pairing_confirm(app: tauri::AppHandle) -> Result<PairingDone, String> {
    let pending = PAIRING
        .lock()
        .await
        .take()
        .ok_or("no pairing in progress — paste the link again")?;
    let identity = pending.confirm().await.map_err(|e| e.to_string())?;
    secure_store::save(&app, &identity.nsec).await?;
    let keys = secure_store::nostr_keys(&identity.nsec)?;
    uni_core::set_device_keys(keys);
    if let Some(relay) = &identity.relay_url {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("relay-url"), relay).map_err(|e| e.to_string())?;
    }
    Ok(PairingDone {
        pubkey: identity.pubkey.to_hex(),
    })
}

#[tauri::command]
async fn pairing_cancel(codes_differ: Option<bool>) -> Result<(), String> {
    if let Some(pending) = PAIRING.lock().await.take() {
        pending
            .cancel(codes_differ.unwrap_or(false))
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// SQLite Connection is !Send. Run the entire async core operation inside the
// blocking task, with its own runtime context, then return only Send data.
#[tauri::command]
async fn refresh(app: tauri::AppHandle) -> Result<SyncView, String> {
    secure_store::ensure_loaded(&app).await?;
    let path = db_path(&app)?;
    let url = relay_url(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let _gate = IO_GATE.blocking_lock();
        let (keys, _) = uni_core::load_keys(false).map_err(|e| e.to_string())?;
        let store = Store::open(path).map_err(|e| e.to_string())?;
        let report = tauri::async_runtime::block_on(sync_once(&url, &keys, None, &store))
            .map_err(|e| e.to_string())?;
        Ok(SyncView {
            pubkey: report.pubkey,
            total_items: report.total_items,
            truncated_channels: report
                .fetched
                .iter()
                .filter(|(_, n)| **n >= 500)
                .map(|(id, _)| id.clone())
                .collect(),
            channel_errors: report.channel_errors,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn post_message(
    app: tauri::AppHandle,
    channel: String,
    body: String,
    reply_to: Option<String>,
    recipients: Vec<String>,
) -> Result<MessageView, String> {
    secure_store::ensure_loaded(&app).await?;
    let path = db_path(&app)?;
    let url = relay_url(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let _gate = IO_GATE.blocking_lock();
        let ch = channel.parse().map_err(|_| "invalid room id".to_string())?;
        let (keys, _) = uni_core::load_keys(false).map_err(|e| e.to_string())?;
        let store = Store::open(path).map_err(|e| e.to_string())?;
        let sent = tauri::async_runtime::block_on(send_message(
            &url,
            &keys,
            None,
            &store,
            ch,
            &body,
            reply_to.as_deref(),
            &recipients,
        ))
        .map_err(|e| e.to_string())?;
        let message = store
            .message(&channel, &sent.r#ref)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| {
                "message accepted but not found locally; refresh to recover".to_string()
            })?;
        let v = view(&store, message)?;
        with_reactions(&store, vec![v])?
            .pop()
            .ok_or_else(|| "message view missing".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Toggle a reaction: publish `emoji` on `target`, or, when `mine` names our
/// existing reaction with that emoji, delete it (kind 5).
#[tauri::command]
async fn react(
    app: tauri::AppHandle,
    channel: String,
    target: String,
    emoji: String,
    mine: Option<String>,
) -> Result<(), String> {
    secure_store::ensure_loaded(&app).await?;
    let path = db_path(&app)?;
    let url = relay_url(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let _gate = IO_GATE.blocking_lock();
        let ch = channel.parse().map_err(|_| "invalid room id".to_string())?;
        let (keys, _) = uni_core::load_keys(false).map_err(|e| e.to_string())?;
        let store = Store::open(path).map_err(|e| e.to_string())?;
        tauri::async_runtime::block_on(async {
            match mine {
                Some(id) => remove_reaction(&url, &keys, None, &store, &id).await,
                None => send_reaction(&url, &keys, None, &store, ch, &target, &emoji).await.map(|_| ()),
            }
        })
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Load one page of older history for `channel`. Returns new message count;
/// 0 means the start of the room has been reached.
#[tauri::command]
async fn load_older(app: tauri::AppHandle, channel: String) -> Result<usize, String> {
    secure_store::ensure_loaded(&app).await?;
    let path = db_path(&app)?;
    let url = relay_url(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let _gate = IO_GATE.blocking_lock();
        let ch = channel.parse().map_err(|_| "invalid room id".to_string())?;
        let (keys, _) = uni_core::load_keys(false).map_err(|e| e.to_string())?;
        let store = Store::open(path).map_err(|e| e.to_string())?;
        tauri::async_runtime::block_on(sync_older(&url, &keys, None, &store, ch, 100))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Media cache (`<app cache>/media/<sha256>`); the OS may evict it.
fn media_cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_cache_dir().map_err(|e| e.to_string())?.join("media"))
}

/// Bytes of a relay media blob (`https://<relay>/media/<sha256>.<ext>`),
/// fetched with Blossom `t=get` auth, SHA-256 verified against the URL and
/// the `imeta` `x` (`sha`), and cached by hash. Returned as a raw IPC
/// response (an `ArrayBuffer` in the webview, turned into a `blob:` URL), as
/// Buzz desktop's `fetch_media_bytes` does: no asset-protocol scope, no
/// base64 inflation, and the auth token never reaches the webview.
#[tauri::command]
async fn media_bytes(
    app: tauri::AppHandle,
    url: String,
    sha: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    secure_store::ensure_loaded(&app).await?;
    let relay = relay_url(&app);
    let dir = media_cache_dir(&app)?;
    // No IO_GATE: this touches neither SQLite nor relay watermarks, and must
    // not queue images behind a slow sync.
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let (keys, _) = uni_core::load_keys(false).map_err(|e| e.to_string())?;
        tauri::async_runtime::block_on(uni_core::fetch_media(
            &relay,
            &keys,
            &url,
            sha.as_deref(),
            &dir,
        ))
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Download a relay file to the cache and return its local path.
#[tauri::command]
async fn media_save(app: tauri::AppHandle, url: String, sha: Option<String>) -> Result<String, String> {
    secure_store::ensure_loaded(&app).await?;
    let relay = relay_url(&app);
    let dir = media_cache_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (keys, _) = uni_core::load_keys(false).map_err(|e| e.to_string())?;
        let hash = uni_core::media::media_sha_from_url(&relay, &url).map_err(|e| e.to_string())?;
        tauri::async_runtime::block_on(uni_core::fetch_media(&relay, &keys, &url, sha.as_deref(), &dir))
            .map_err(|e| e.to_string())?;
        uni_core::media::cache_path(&dir, &hash)
            .map(|p| p.to_string_lossy().into_owned())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The relay's HTTP origin (e.g. `https://buzz.unforced.org`), so the UI can
/// tell relay media (authenticated fetch) from third-party image links.
#[tauri::command]
fn relay_origin(app: tauri::AppHandle) -> String {
    let url = relay_url(&app);
    url.replacen("wss://", "https://", 1).replacen("ws://", "http://", 1).trim_end_matches('/').to_string()
}

#[cfg(mobile)]
mod mobile;
mod secure_store;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(mobile)]
    mobile::init_runtime();
    uni_core::init_crypto();
    tauri::Builder::default()
        .plugin(secure_store::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|_app| {
            #[cfg(mobile)]
            mobile::setup(_app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_rooms,
            get_messages,
            get_members,
            get_identity,
            identity_status,
            identity_forget,
            pairing_start,
            pairing_confirm,
            pairing_cancel,
            refresh,
            post_message,
            mark_read,
            open_link,
            live_start,
            live_stop,
            react,
            load_older,
            media_bytes,
            media_save,
            relay_origin
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
