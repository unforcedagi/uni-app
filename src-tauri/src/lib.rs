//! Shared Tauri conversation bridge. Signing and relay I/O remain in Rust.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{Emitter, Manager};
use uni_core::{
    remove_reaction, send_message_with_media, send_reaction, sync_older, sync_once,
    ConversationMessage, LiveConfig, LiveEvent, Store,
};

/// Run blocking work (SQLite, the desktop keyring) off the async executor
/// and off the main thread, where Tauri runs plain `fn` commands.
async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

/// Relay work that touches SQLite and relay watermarks: on a blocking
/// thread, under [`IO_GATE`], with the account key and an open store.
async fn relay_io<T, F>(app: &tauri::AppHandle, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&str, &nostr::Keys, &Store) -> Result<T, String> + Send + 'static,
{
    secure_store::ensure_loaded(app).await?;
    let path = db_path(app)?;
    let url = relay_url(app);
    blocking(move || {
        let _gate = IO_GATE.blocking_lock();
        let (keys, _) = uni_core::load_keys(false).map_err(|e| e.to_string())?;
        let store = Store::open(path).map_err(|e| e.to_string())?;
        f(&url, &keys, &store)
    })
    .await
}

fn room_id<T: std::str::FromStr>(channel: &str) -> Result<T, String> {
    channel.parse().map_err(|_| "invalid room id".to_string())
}

/// Run one of our own message changes (edit/delete) on the IO gate.
async fn change_own_message(
    app: &tauri::AppHandle,
    channel: String,
    target: String,
    new_body: Option<String>,
) -> Result<(), String> {
    relay_io(app, move |url, keys, store| {
        let ch = room_id(&channel)?;
        tauri::async_runtime::block_on(async {
            match new_body {
                Some(body) => {
                    uni_core::edit_message(url, keys, None, store, ch, &target, &body).await
                }
                None => uni_core::delete_message(url, keys, None, store, ch, &target).await,
            }
        })
        .map(|_| ())
        .map_err(|e| e.to_string())
    })
    .await
}

/// Edit one of our own messages (kind 40003, Buzz desktop's shape).
#[tauri::command]
async fn edit_message(
    app: tauri::AppHandle,
    channel: String,
    target: String,
    body: String,
) -> Result<(), String> {
    change_own_message(&app, channel, target, Some(body)).await
}

/// Delete one of our own messages (kind 5 with `h`+`e`, as Buzz desktop does).
#[tauri::command]
async fn delete_message(
    app: tauri::AppHandle,
    channel: String,
    target: String,
) -> Result<(), String> {
    change_own_message(&app, channel, target, None).await
}

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
    let me = uni_core::load_keys(false)
        .ok()
        .map(|(k, _)| k.public_key().to_hex());
    let ids: Vec<String> = views.iter().map(|v| v.id.clone()).collect();
    let all = store
        .reactions(&ids, me.as_deref())
        .map_err(|e| e.to_string())?;
    let mut media = store.message_media(&ids).map_err(|e| e.to_string())?;
    for v in &mut views {
        v.reactions = all
            .iter()
            .filter(|r| r.target == v.id)
            .map(|r| ReactionView {
                emoji: r.emoji.clone(),
                count: r.count,
                mine: r.mine.clone(),
            })
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
async fn get_members(app: tauri::AppHandle, channel: String) -> Result<Vec<MemberView>, String> {
    let path = db_path(&app)?;
    blocking(move || {
        let store = Store::open(path).map_err(|e| e.to_string())?;
        Ok(store
            .channel_members(&channel)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|m| MemberView {
                named: m.name.is_some(),
                name: m
                    .name
                    .unwrap_or_else(|| m.pubkey[..8.min(m.pubkey.len())].to_string()),
                pubkey: m.pubkey,
            })
            .collect())
    })
    .await
}

/// Our pubkey if the key is already loaded (no keystore round-trip).
fn my_pubkey() -> Option<String> {
    uni_core::has_device_keys()
        .then(|| uni_core::load_keys(false).ok())
        .flatten()
        .map(|(k, _)| k.public_key().to_hex())
}

#[tauri::command]
async fn get_rooms(app: tauri::AppHandle) -> Result<Vec<RoomView>, String> {
    let path = db_path(&app)?;
    blocking(move || {
        let store = Store::open(path).map_err(|e| e.to_string())?;
        let me = my_pubkey();
        Ok(store
            .rooms_for(me.as_deref())
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|r| RoomView {
                name: r
                    .name
                    .unwrap_or_else(|| format!("Room {}", &r.id[..8.min(r.id.len())])),
                id: r.id,
                last_message: r.last_message,
                last_ts: r.last_ts,
                mentions: r.mentions,
                unread: r.unread,
            })
            .collect())
    })
    .await
}

#[tauri::command]
async fn get_messages(
    app: tauri::AppHandle,
    channel: String,
    root: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<MessageView>, String> {
    // The UI grows `limit` as older pages are loaded.
    let limit = limit.unwrap_or(300).clamp(1, 5000);
    let path = db_path(&app)?;
    blocking(move || {
        let store = Store::open(path).map_err(|e| e.to_string())?;
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
    })
    .await
}

#[derive(Serialize)]
struct SearchHitView {
    message: MessageView,
    /// Room label (falls back like `get_rooms`).
    channel_name: String,
    /// Plain-text excerpt; matches are wrapped in U+E000 … U+E001. The UI
    /// renders those as `<mark>` elements — never as HTML.
    snippet: String,
}

/// Local full-text search over cached Buzz messages (current text: edits
/// applied, deletions excluded). Read-only, so no IO gate.
#[tauri::command]
async fn search(
    app: tauri::AppHandle,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<SearchHitView>, String> {
    let path = db_path(&app)?;
    blocking(move || {
        let store = Store::open(path).map_err(|e| e.to_string())?;
        let limit = limit.unwrap_or(60).clamp(1, 200);
        store
            .search_messages(&query, limit)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|h| {
                let channel_name = h.channel_name.unwrap_or_else(|| {
                    let id = &h.message.item.channel;
                    format!("Room {}", &id[..8.min(id.len())])
                });
                Ok(SearchHitView {
                    message: view(&store, h.message)?,
                    channel_name,
                    snippet: h.snippet,
                })
            })
            .collect()
    })
    .await
}

/// The user is looking at `channel`: everything cached there is read. The
/// new marker is synced to the user's other devices (Buzz read state) after
/// a short debounce, off the UI path.
#[tauri::command]
async fn mark_read(app: tauri::AppHandle, channel: String) -> Result<(), String> {
    let path = db_path(&app)?;
    let advanced = blocking(move || {
        Store::open(path)
            .and_then(|store| store.mark_read(&channel))
            .map_err(|e| e.to_string())
    })
    .await?;
    if advanced {
        schedule_read_state_publish(&app);
    }
    Ok(())
}

/// Debounce window for publishing read state (Buzz desktop uses 5 s).
const READ_STATE_DEBOUNCE: std::time::Duration = std::time::Duration::from_secs(3);
/// Bumped on every schedule; a waiting publisher only runs if it is still
/// the newest, so a burst of reads produces one publish.
static READ_STATE_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn schedule_read_state_publish(app: &tauri::AppHandle) {
    use std::sync::atomic::Ordering;
    let generation = READ_STATE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    // Wait on the timer, not on a parked blocking thread: a burst of reads
    // would otherwise hold one pool thread each for the whole window.
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(READ_STATE_DEBOUNCE).await;
        if READ_STATE_GEN.load(Ordering::SeqCst) != generation {
            return;
        }
        let result = relay_io(&app, |url, keys, store| {
            tauri::async_runtime::block_on(uni_core::publish_read_state(url, keys, None, store))
                .map_err(|e| e.to_string())
        })
        .await;
        // Best effort: an unpublished marker stays dirty and goes out with
        // the next read.
        if let Err(e) = result {
            tracing::warn!("read-state publish failed: {e}");
        }
    });
}

/// Open a link from a message in the system browser. Only web and mail links;
/// anything else (javascript:, file:, intent:) is refused.
#[tauri::command]
fn open_link(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let lower = url.trim().to_ascii_lowercase();
    if !(lower.starts_with("https://")
        || lower.starts_with("http://")
        || lower.starts_with("mailto:"))
    {
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
/// Queue of ephemeral events (typing) for the running live loop's socket.
static OUTBOX: std::sync::Mutex<Option<tokio::sync::mpsc::UnboundedSender<nostr::Event>>> =
    std::sync::Mutex::new(None);

#[derive(Clone, Serialize)]
struct LivePayload {
    /// `message`, `edit`, `delete`, `rooms`, `profiles`, `status`.
    kind: &'static str,
    channel: Option<String>,
    /// Connection status text for `status` events.
    status: Option<String>,
    /// For `message`: the author, so the UI can skip marking own sends unread.
    author: Option<String>,
    /// For `typing`: the thread root being typed in, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    root: Option<String>,
    /// For `message`: set when it @-mentions us, with a short preview and the
    /// author's display name, so the desktop can notify without a round trip.
    #[serde(skip_serializing_if = "Option::is_none")]
    notify: Option<NotifyInfo>,
}

#[derive(Clone, Serialize)]
struct NotifyInfo {
    author_name: String,
    preview: String,
}

fn live_payload(ev: &LiveEvent) -> Option<LivePayload> {
    let p = |kind, channel: Option<String>, status: Option<String>, author| LivePayload {
        kind,
        channel,
        status,
        author,
        root: None,
        notify: None,
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
        LiveEvent::Typing {
            channel,
            author,
            root,
        } => LivePayload {
            root: root.clone(),
            ..p(
                "typing",
                Some(channel.to_string()),
                None,
                Some(author.clone()),
            )
        },
        LiveEvent::Profiles { .. } => p("profiles", None, None, None),
        // Read on another device: badges change; the UI re-reads rooms.
        LiveEvent::ReadState { .. } => p("rooms", None, None, None),
        LiveEvent::Connected { .. } => p("status", None, Some("Live".into()), None),
        LiveEvent::Eose { channel } => p("rooms", Some(channel.to_string()), None, None),
        LiveEvent::Disconnected { retry_in, .. } => p(
            "status",
            None,
            Some(format!("Reconnecting in {}s…", retry_in.as_secs().max(1))),
            None,
        ),
        LiveEvent::Stopped { reason } => p(
            "status",
            None,
            Some(format!("Live stopped: {reason}")),
            None,
        ),
        LiveEvent::ChannelClosed { channel, message } => p(
            "status",
            Some(channel.to_string()),
            Some(format!(
                "Room {} closed: {message}",
                &channel.to_string()[..8]
            )),
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
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
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
                        let _ = app.emit(
                            "uni://live",
                            LivePayload {
                                kind: "status",
                                channel: None,
                                status: Some(format!("Live unavailable: {e}")),
                                author: None,
                                root: None,
                                notify: None,
                            },
                        );
                        return;
                    }
                };
                let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
                let forward_app = app.clone();
                let store_ref = &store;
                let forward = async move {
                    while let Some(ev) = rx.recv().await {
                        if let Some(mut payload) = live_payload(&ev) {
                            if let LiveEvent::Message { item, new: true } = &ev {
                                if item.mentions_me {
                                    let preview: String = item.body.chars().take(160).collect();
                                    payload.notify = Some(NotifyInfo {
                                        author_name: store_ref
                                            .display_name(&item.author)
                                            .unwrap_or_else(|_| item.author[..8].to_string()),
                                        preview,
                                    });
                                }
                            }
                            let _ = forward_app.emit("uni://live", payload);
                        }
                    }
                };
                let (out_tx, out_rx) = tokio::sync::mpsc::unbounded_channel();
                if let Ok(mut o) = OUTBOX.lock() {
                    *o = Some(out_tx);
                }
                let mut cfg = LiveConfig::new(url);
                cfg.outbox = Some(std::sync::Arc::new(tokio::sync::Mutex::new(out_rx)));
                let runner = uni_core::run_live(cfg, &keys, None, &store, tx, stop_rx);
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

/// Tell the room we're typing (Buzz kind 20002). Best effort, no reply: sent
/// on the live socket when it's up, dropped otherwise.
#[tauri::command]
async fn send_typing(
    app: tauri::AppHandle,
    channel: String,
    root: Option<String>,
    parent: Option<String>,
) -> Result<(), String> {
    let Some(tx) = OUTBOX.lock().map_err(|e| e.to_string())?.clone() else {
        return Ok(());
    };
    let channel: uuid::Uuid = channel.parse().map_err(|_| "invalid channel".to_string())?;
    secure_store::ensure_loaded(&app).await?;
    let (keys, _) = uni_core::load_keys(false).map_err(|e| e.to_string())?;
    let ev = uni_core::typing::typing_event(&keys, channel, root.as_deref(), parent.as_deref())
        .map_err(|e| e.to_string())?;
    let _ = tx.send(ev);
    Ok(())
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
async fn get_npub(app: tauri::AppHandle) -> Result<String, String> {
    use nostr::nips::nip19::ToBech32;
    secure_store::ensure_loaded(&app).await?;
    let (keys, _) = uni_core::load_keys(false).map_err(|e| e.to_string())?;
    keys.public_key().to_bech32().map_err(|e| e.to_string())
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
    let pubkey = blocking(|| {
        Ok(uni_core::load_keys(false)
            .ok()
            .map(|(k, _)| k.public_key().to_hex()))
    })
    .await?;
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
    let handle = app.clone();
    relay_io(&app, move |url, keys, store| {
        let report = tauri::async_runtime::block_on(sync_once(url, keys, None, store))
            .map_err(|e| e.to_string())?;
        // Retry a read-state publish that failed earlier (e.g. offline).
        if uni_core::read_state_dirty(store, keys).unwrap_or(false) {
            schedule_read_state_publish(&handle);
        }
        Ok(SyncView {
            pubkey: report.pubkey,
            total_items: report.total_items,
            truncated_channels: report
                .fetched
                .iter()
                // A full page means the relay may hold more than one fetch returned.
                .filter(|(_, n)| **n as u64 >= uni_core::buzz::RELAY_MAX_LIMIT)
                .map(|(id, _)| id.clone())
                .collect(),
            channel_errors: report.channel_errors,
        })
    })
    .await
}

#[tauri::command]
async fn prepare_voice_message(
    app: tauri::AppHandle,
    channel: String,
    reply_to: Option<String>,
    recipients: Vec<String>,
    media: Vec<uni_core::MediaRef>,
) -> Result<String, String> {
    relay_io(&app, move |url, keys, store| {
        let event = uni_core::compose::prepare_message(
            url,
            keys,
            store,
            room_id(&channel)?,
            "",
            reply_to.as_deref(),
            &recipients,
            &media,
        )
        .map_err(|e| e.to_string())?;
        serde_json::to_string(&event).map_err(|e| e.to_string())
    })
    .await
}

fn accepted_error(event_id: String, message: String) -> String {
    serde_json::json!({ "accepted": true, "eventId": event_id, "message": message }).to_string()
}

#[tauri::command]
async fn post_message(
    app: tauri::AppHandle,
    channel: String,
    body: String,
    reply_to: Option<String>,
    recipients: Vec<String>,
    media: Option<Vec<uni_core::MediaRef>>,
    signed_event: Option<String>,
) -> Result<MessageView, serde_json::Value> {
    relay_io(&app, move |url, keys, store| {
        let ch = room_id(&channel)?;
        let sent = if let Some(json) = signed_event {
            let event = serde_json::from_str(&json).map_err(|e| e.to_string())?;
            tauri::async_runtime::block_on(uni_core::compose::publish_message(
                url, keys, None, store, ch, event,
            ))
        } else {
            tauri::async_runtime::block_on(send_message_with_media(
                url,
                keys,
                None,
                store,
                ch,
                &body,
                reply_to.as_deref(),
                &recipients,
                media.as_deref().unwrap_or(&[]),
            ))
        }
        .map_err(|e| match e {
            uni_core::Error::Accepted { event_id, message } => accepted_error(event_id, message),
            other => other.to_string(),
        })?;
        (|| {
            let message = store
                .message(&channel, &sent.r#ref)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| {
                    "message accepted but not found locally; refresh to recover".to_string()
                })?;
            let v = view(store, message)?;
            with_reactions(store, vec![v])?
                .pop()
                .ok_or_else(|| "message view missing".to_string())
        })()
        .map_err(|e| accepted_error(sent.r#ref, e))
    })
    .await
    .map_err(|e| serde_json::from_str(&e).unwrap_or(serde_json::Value::String(e)))
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
    relay_io(&app, move |url, keys, store| {
        let ch = room_id(&channel)?;
        tauri::async_runtime::block_on(async {
            match mine {
                Some(id) => remove_reaction(url, keys, None, store, &id).await,
                None => send_reaction(url, keys, None, store, ch, &target, &emoji)
                    .await
                    .map(|_| ()),
            }
        })
        .map_err(|e| e.to_string())
    })
    .await
}

/// Load one page of older history for `channel`. Returns new message count;
/// 0 means the start of the room has been reached.
#[tauri::command]
async fn load_older(app: tauri::AppHandle, channel: String) -> Result<usize, String> {
    relay_io(&app, move |url, keys, store| {
        let ch = room_id(&channel)?;
        tauri::async_runtime::block_on(sync_older(url, keys, None, store, ch, 100))
            .map_err(|e| e.to_string())
    })
    .await
}

/// Media cache (`<app cache>/media/<sha256>`); the OS may evict it.
fn media_cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("media"))
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
    let bytes = blocking(move || {
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
    .await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Upload a picked/pasted/dropped file via raw IPC (never a JSON byte array).
/// `x-filename` and `x-file-mime` are display/advisory hints only.
#[tauri::command]
async fn media_upload(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<uni_core::MediaRef, String> {
    let bytes = &ipc_bytes(&request, 100 * 1024 * 1024)?;
    if bytes.is_empty() || bytes.len() > uni_core::media::MAX_UPLOAD_BYTES {
        return Err("file is empty or exceeds 25 MB".into());
    }
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string()
    };
    let filename = url::form_urlencoded::parse(format!("name={}", header("x-filename")).as_bytes())
        .find(|(k, _)| k == "name")
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default();
    let mime = header("x-file-mime");
    let data = bytes.clone();
    secure_store::ensure_loaded(&app).await?;
    let relay = relay_url(&app);
    blocking(move || {
        let (keys, _) = uni_core::load_keys(false).map_err(|e| e.to_string())?;
        tauri::async_runtime::block_on(uni_core::media::upload_media(
            &relay, &keys, data, &mime, &filename,
        ))
        .map_err(|e| e.to_string())
    })
    .await
}

/// Binary IPC body. Desktop sends raw bytes; Android's WebView has no request
/// bodies on the custom protocol, so Tauri falls back to postMessage, which
/// JSON-encodes a Uint8Array as an array of numbers. Accept both.
fn ipc_bytes(request: &tauri::ipc::Request<'_>, max: usize) -> Result<Vec<u8>, String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => {
            if b.is_empty() || b.len() > max {
                return Err(format!(
                    "file is empty or larger than {} MB",
                    max / (1024 * 1024)
                ));
            }
            Ok(b.clone())
        }
        tauri::ipc::InvokeBody::Json(serde_json::Value::Array(items)) => {
            if items.is_empty() || items.len() > max {
                return Err(format!(
                    "file is empty or larger than {} MB",
                    max / (1024 * 1024)
                ));
            }
            items
                .iter()
                .map(|v| v.as_u64().filter(|n| *n <= 255).map(|n| n as u8))
                .collect::<Option<Vec<u8>>>()
                .ok_or_else(|| "file bytes arrived malformed over IPC".to_string())
        }
        _ => Err("no file bytes received over IPC".into()),
    }
}

/// Transcribe a voice message on uni-1. Body: raw audio; header `x-audio-mime`.
#[tauri::command]
async fn voice_transcribe(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<uni_core::transcribe::Transcript, String> {
    let bytes = &ipc_bytes(&request, 100 * 1024 * 1024)?;
    if bytes.is_empty() || bytes.len() > uni_core::transcribe::MAX_TRANSCRIBE_BYTES {
        return Err("recording is empty or larger than 25 MB".into());
    }
    let mime = request
        .headers()
        .get("x-audio-mime")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("audio/webm")
        .to_string();
    let audio = bytes.clone();
    secure_store::ensure_loaded(&app).await?;
    blocking(move || {
        let (keys, _) = uni_core::load_keys(false).map_err(|e| e.to_string())?;
        tauri::async_runtime::block_on(uni_core::transcribe::transcribe(
            uni_core::transcribe::TRANSCRIBE_URL,
            &keys,
            audio,
            &mime,
        ))
        .map_err(|e| e.to_string())
    })
    .await
}

/// Download a relay file to the cache and return its local path.
#[tauri::command]
async fn media_save(
    app: tauri::AppHandle,
    url: String,
    sha: Option<String>,
) -> Result<String, String> {
    secure_store::ensure_loaded(&app).await?;
    let relay = relay_url(&app);
    let dir = media_cache_dir(&app)?;
    blocking(move || {
        let (keys, _) = uni_core::load_keys(false).map_err(|e| e.to_string())?;
        let hash = uni_core::media::media_sha_from_url(&relay, &url).map_err(|e| e.to_string())?;
        tauri::async_runtime::block_on(uni_core::fetch_media(
            &relay,
            &keys,
            &url,
            sha.as_deref(),
            &dir,
        ))
        .map_err(|e| e.to_string())?;
        uni_core::media::cache_path(&dir, &hash)
            .map(|p| p.to_string_lossy().into_owned())
            .map_err(|e| e.to_string())
    })
    .await
}

/// Fetch and open an attachment with the OS default file handler. Never
/// open a remote URL directly (that would omit Blossom auth and leak identity).
#[tauri::command]
async fn media_open(app: tauri::AppHandle, url: String, sha: Option<String>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let relay = relay_url(&app);
    uni_core::media::media_sha_from_url(&relay, &url).map_err(|e| e.to_string())?;
    let ext = url
        .rsplit_once('.')
        .map(|(_, ext)| ext)
        .filter(|ext| {
            ext.len() <= 8
                && ext
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
        .unwrap_or("bin")
        .to_string();
    let path = media_save(app.clone(), url, sha).await?;
    let target = format!("{path}.{ext}");
    blocking({
        let path = path.clone();
        let target = target.clone();
        move || {
            std::fs::copy(&path, &target)
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
    })
    .await?;
    app.opener()
        .open_path(target, None::<&str>)
        .map_err(|e| e.to_string())
}

/// The relay's HTTP origin (e.g. `https://buzz.unforced.org`), so the UI can
/// tell relay media (authenticated fetch) from third-party image links.
#[tauri::command]
fn relay_origin(app: tauri::AppHandle) -> String {
    let url = relay_url(&app);
    url.replacen("wss://", "https://", 1)
        .replacen("ws://", "http://", 1)
        .trim_end_matches('/')
        .to_string()
}

// ── Journal: entries go straight to the Parachute vault, signed per request
// with the same key that signs Buzz messages (NIP-98). The device queues each
// entry first, so journaling works offline and survives app restarts.

const DEFAULT_HUB: &str = "https://uni-1.taildf9ce2.ts.net";
const DEFAULT_VAULT: &str = "uni";
/// `unforced` was merged into `uni` (T-56, 2026-10-06) and is now a read-only
/// archive, so a device still pointed at it writes to `uni` instead.
const RETIRED_VAULT: &str = "unforced";

fn vault_config(app: &tauri::AppHandle) -> uni_core::parachute::VaultConfig {
    let saved: Option<uni_core::parachute::VaultConfig> = app
        .path()
        .app_data_dir()
        .ok()
        .and_then(|d| std::fs::read_to_string(d.join("vault.json")).ok())
        .and_then(|s| serde_json::from_str(&s).ok());
    let mut cfg = saved.unwrap_or_else(|| uni_core::parachute::VaultConfig {
        hub: DEFAULT_HUB.into(),
        vault: DEFAULT_VAULT.into(),
    });
    migrate_retired_vault(&mut cfg);
    cfg
}

/// A saved choice of the retired `unforced` vault now means `uni`.
fn migrate_retired_vault(cfg: &mut uni_core::parachute::VaultConfig) {
    if cfg.vault.trim() == RETIRED_VAULT {
        cfg.vault = DEFAULT_VAULT.into();
    }
}

#[tauri::command]
fn journal_config(app: tauri::AppHandle) -> uni_core::parachute::VaultConfig {
    vault_config(&app)
}

#[tauri::command]
fn journal_set_config(app: tauri::AppHandle, hub: String, vault: String) -> Result<(), String> {
    let cfg = uni_core::parachute::VaultConfig {
        hub: hub.trim().trim_end_matches('/').to_string(),
        vault: vault.trim().to_string(),
    };
    let mut cfg = cfg;
    migrate_retired_vault(&mut cfg);
    if cfg.vault.is_empty()
        || !cfg
            .vault
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("vault name: letters, numbers, - and _".into());
    }
    let keys = nostr::Keys::generate();
    uni_core::parachute::VaultClient::new(cfg.clone(), keys).map_err(|e| e.to_string())?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(
        dir.join("vault.json"),
        serde_json::to_string(&cfg).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

/// Journal entries send one at a time, off the relay IO gate.
static JOURNAL_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn journal_flush_inner(
    app: &tauri::AppHandle,
) -> Result<uni_core::journal::FlushReport, String> {
    secure_store::ensure_loaded(app).await?;
    let path = db_path(app)?;
    let cfg = vault_config(app);
    let _gate = JOURNAL_GATE.lock().await;
    blocking(move || {
        let (keys, _) = uni_core::load_keys(false).map_err(|e| e.to_string())?;
        let store = Store::open(path).map_err(|e| e.to_string())?;
        let client = uni_core::parachute::VaultClient::new(cfg, keys).map_err(|e| e.to_string())?;
        tauri::async_runtime::block_on(uni_core::journal::flush(&store, &client))
            .map_err(|e| e.to_string())
    })
    .await
}

async fn journal_queue_entry(
    app: &tauri::AppHandle,
    entry: JournalDraft,
    audio: Option<(Vec<u8>, String)>,
) -> Result<(), String> {
    let path = db_path(app)?;
    blocking(move || {
        let store = Store::open(path).map_err(|e| e.to_string())?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or_default();
        store
            .journal_queue(
                &entry.entry_id,
                &entry.path,
                &entry.content,
                &entry.source,
                &entry.created_at,
                audio.as_ref().map(|(b, m)| (b.as_slice(), m.as_str())),
                now,
            )
            .map_err(|e| e.to_string())
    })
    .await
}

#[derive(serde::Deserialize)]
struct JournalDraft {
    entry_id: String,
    path: String,
    content: String,
    source: String,
    created_at: String,
}

/// Queue a typed entry, then try to send everything queued.
#[tauri::command]
async fn journal_save_text(
    app: tauri::AppHandle,
    entry: JournalDraft,
) -> Result<uni_core::journal::FlushReport, String> {
    journal_queue_entry(&app, entry, None).await?;
    journal_flush_inner(&app).await
}

/// Queue a voice entry. Body: raw audio bytes. Headers: `x-entry` (JSON
/// draft) and `x-audio-mime`. Raw IPC keeps a minutes-long recording from
/// being inflated into a JSON number array.
#[tauri::command]
async fn journal_save_voice(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<uni_core::journal::FlushReport, String> {
    let bytes = &ipc_bytes(&request, 100 * 1024 * 1024)?;
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    let entry: JournalDraft = serde_json::from_str(
        &header("x-entry").ok_or_else(|| "missing x-entry header".to_string())?,
    )
    .map_err(|e| format!("bad entry: {e}"))?;
    let mime = header("x-audio-mime").unwrap_or_else(|| "audio/webm".into());
    if !mime.starts_with("audio/") {
        return Err("audio mime must be audio/*".into());
    }
    // Refuse before copying an oversized recording.
    if bytes.is_empty() || bytes.len() > uni_core::parachute::MAX_AUDIO_BYTES {
        return Err("audio is empty or too large".into());
    }
    journal_queue_entry(&app, entry, Some((bytes.clone(), mime))).await?;
    journal_flush_inner(&app).await
}

#[tauri::command]
async fn journal_flush(app: tauri::AppHandle) -> Result<uni_core::journal::FlushReport, String> {
    journal_flush_inner(&app).await
}

#[tauri::command]
async fn journal_pending(
    app: tauri::AppHandle,
) -> Result<Vec<uni_core::journal::QueuedEntry>, String> {
    let path = db_path(&app)?;
    blocking(move || {
        Store::open(path)
            .and_then(|s| s.journal_pending())
            .map_err(|e| e.to_string())
    })
    .await
}

async fn with_vault<T, F>(app: &tauri::AppHandle, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(uni_core::parachute::VaultClient) -> Result<T, String> + Send + 'static,
{
    secure_store::ensure_loaded(app).await?;
    let cfg = vault_config(app);
    blocking(move || {
        let (keys, _) = uni_core::load_keys(false).map_err(|e| e.to_string())?;
        let client = uni_core::parachute::VaultClient::new(cfg, keys).map_err(|e| e.to_string())?;
        f(client)
    })
    .await
}

/// Newest journal entries from the vault.
#[tauri::command]
async fn journal_list(
    app: tauri::AppHandle,
    limit: usize,
    offset: usize,
) -> Result<Vec<uni_core::parachute::JournalNote>, String> {
    with_vault(&app, move |c| {
        tauri::async_runtime::block_on(c.list_entries(limit, offset)).map_err(|e| e.to_string())
    })
    .await
}

/// One entry, full content (used to watch a transcript land).
#[tauri::command]
async fn journal_entry(
    app: tauri::AppHandle,
    id: String,
) -> Result<uni_core::parachute::JournalNote, String> {
    with_vault(&app, move |c| {
        tauri::async_runtime::block_on(c.get_entry(&id)).map_err(|e| e.to_string())
    })
    .await
}

#[derive(Serialize)]
struct VaultNote {
    /// Hub origin the note was read from (for the "Open in Parachute" URL).
    hub: String,
    vault: String,
    /// The vault's `Note` JSON (id, path, content, tags, metadata, links).
    note: serde_json::Value,
}

/// One vault note for the in-app note view, read over the same NIP-98
/// `/mcp` door as the Journal. `vault` defaults to the Journal's vault;
/// `note_ref` is a note id or path.
#[tauri::command]
async fn vault_note(
    app: tauri::AppHandle,
    vault: Option<String>,
    note_ref: String,
) -> Result<VaultNote, String> {
    let vault = vault
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| vault_config(&app).vault);
    with_vault(&app, move |c| {
        let note = tauri::async_runtime::block_on(c.get_note(&vault, &note_ref))
            .map_err(|e| e.to_string())?;
        Ok(VaultNote {
            hub: c.origin().to_string(),
            vault,
            note,
        })
    })
    .await
}

/// Search Parachute notes by meaning, signed with this device's Nostr key
/// (NIP-98) — the same door as the Journal and note view. `vault: None`
/// searches every vault the key can read.
#[tauri::command]
async fn vault_search(
    app: tauri::AppHandle,
    query: String,
    vault: Option<String>,
    limit: Option<usize>,
    mode: Option<String>,
    path_prefix: Option<String>,
) -> Result<Vec<uni_core::parachute::NoteHit>, String> {
    let vault = vault
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    with_vault(&app, move |c| {
        tauri::async_runtime::block_on(c.search_notes(
            vault.as_deref(),
            &query,
            limit.unwrap_or(20),
            mode.as_deref(),
            path_prefix.as_deref(),
        ))
        .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn vault_list(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    with_vault(&app, |c| {
        tauri::async_runtime::block_on(c.list_vaults()).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn vault_paths(
    app: tauri::AppHandle,
    vault: String,
) -> Result<Vec<uni_core::parachute::NotePath>, String> {
    with_vault(&app, move |c| {
        tauri::async_runtime::block_on(c.list_paths(&vault)).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn vault_create(
    app: tauri::AppHandle,
    vault: String,
    path: String,
    content: String,
) -> Result<serde_json::Value, String> {
    with_vault(&app, move |c| {
        tauri::async_runtime::block_on(c.create_note(&vault, &path, &content))
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn vault_save(
    app: tauri::AppHandle,
    vault: String,
    id: String,
    content: String,
    if_updated_at: Option<String>,
    force: Option<bool>,
) -> Result<serde_json::Value, String> {
    with_vault(&app, move |c| {
        tauri::async_runtime::block_on(c.save_note(
            &vault,
            &id,
            &content,
            if_updated_at.as_deref(),
            force.unwrap_or(false),
        ))
        .map_err(|e| e.to_string())
    })
    .await
}

#[derive(Serialize, Deserialize)]
struct AndroidUpdateManifest {
    version: String,
    url: String,
}

#[tauri::command]
async fn android_update_manifest() -> Result<AndroidUpdateManifest, String> {
    // Bundled roots: a bare reqwest client uses the platform verifier, which
    // fails on Android without JNI setup, so this check never succeeded there.
    uni_core::init_crypto();
    let response =
        uni_core::media::https_client_following_redirects(std::time::Duration::from_secs(12))
            .map_err(|e| e.to_string())?
            .get("https://github.com/unforcedagi/uni-app/releases/latest/download/android.json")
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
    let manifest: AndroidUpdateManifest = response.json().await.map_err(|e| e.to_string())?;
    let trusted = manifest
        .url
        .strip_prefix("https://github.com/unforcedagi/uni-app/releases/download/uni-v")
        .is_some_and(|rest| rest.ends_with("/uni.apk") && !rest.contains(".."));
    if !trusted {
        return Err("untrusted update URL".into());
    }
    Ok(manifest)
}

#[cfg(desktop)]
mod desktop_log;
#[cfg(mobile)]
mod mobile;
mod pair_source;
mod secure_store;

#[cfg(target_os = "macos")]
fn install_tab_menu(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, WINDOW_SUBMENU_ID};
    // The default macOS menu binds Cmd+W to Close Window in both File and
    // Window. Replace those native actions with Close Tab so the OS does not
    // close the app before the WebView can receive the keydown.
    let menu = Menu::default(app.handle())?;
    for item in menu.items()? {
        if let Some(submenu) = item.as_submenu() {
            if submenu.text()? == "File" {
                let _ = submenu.remove_at(0)?; // default Close Window
                let close = MenuItem::with_id(
                    app.handle(),
                    "uni-close-tab",
                    "Close Tab",
                    true,
                    Some("Cmd+W"),
                )?;
                submenu.prepend(&close)?;
            } else if item.id().0 == WINDOW_SUBMENU_ID {
                let last = submenu.items()?.len().saturating_sub(1);
                let _ = submenu.remove_at(last)?; // default Close Window
            }
        }
    }
    app.set_menu(menu)?;
    app.on_menu_event(|handle, event| {
        if event.id().0 == "uni-close-tab" {
            let _ = handle.emit("uni://close-tab", ());
        }
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(desktop)]
    desktop_log::init();
    #[cfg(mobile)]
    mobile::init_runtime();
    uni_core::init_crypto();
    tauri::Builder::default()
        .plugin(secure_store::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|_app| {
            #[cfg(mobile)]
            _app.handle().plugin(tauri_plugin_barcode_scanner::init())?;
            #[cfg(target_os = "macos")]
            install_tab_menu(_app)?;
            #[cfg(desktop)]
            {
                _app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
                _app.handle().plugin(tauri_plugin_process::init())?;
                _app.handle().plugin(tauri_plugin_notification::init())?;
            }
            #[cfg(mobile)]
            mobile::setup(_app);
            tracing::info!(version = %_app.package_info().version, "setup complete; opening window");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_rooms,
            get_messages,
            get_members,
            get_identity,
            get_npub,
            identity_status,
            identity_forget,
            pair_source::pair_source_available,
            pair_source::pair_source_start,
            pair_source::pair_source_wait_offer,
            pair_source::pair_source_confirm,
            pair_source::pair_source_cancel,
            pairing_start,
            pairing_confirm,
            pairing_cancel,
            refresh,
            post_message,
            prepare_voice_message,
            mark_read,
            open_link,
            live_start,
            send_typing,
            live_stop,
            react,
            load_older,
            edit_message,
            delete_message,
            search,
            media_bytes,
            media_upload,
            voice_transcribe,
            media_save,
            media_open,
            relay_origin,
            journal_config,
            journal_set_config,
            journal_save_text,
            journal_save_voice,
            journal_flush,
            journal_pending,
            journal_list,
            journal_entry,
            vault_note,
            vault_search,
            vault_list,
            vault_paths,
            vault_create,
            vault_save,
            android_update_manifest
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod vault_default_tests {
    use super::*;

    fn cfg(vault: &str) -> uni_core::parachute::VaultConfig {
        uni_core::parachute::VaultConfig {
            hub: DEFAULT_HUB.into(),
            vault: vault.into(),
        }
    }

    #[test]
    fn default_vault_is_uni() {
        assert_eq!(DEFAULT_VAULT, "uni");
    }

    #[test]
    fn saved_unforced_choice_migrates_to_uni() {
        let mut c = cfg("unforced");
        migrate_retired_vault(&mut c);
        assert_eq!(c.vault, "uni");
    }

    #[test]
    fn other_saved_vaults_are_kept() {
        for v in ["uni", "parachute", "my-vault"] {
            let mut c = cfg(v);
            migrate_retired_vault(&mut c);
            assert_eq!(c.vault, v);
        }
    }
}
