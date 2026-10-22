//! Shared Tauri conversation bridge. Signing and relay I/O remain in Rust.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{Emitter, Manager};
use uni_core::{
    send_message_with_media, sync_older, sync_once,
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

/// r26 (Codex P1 3): relay work for what the user sends (a message, an edit, a delete, a voice message's event). It does not take
/// [`IO_GATE`]: the first sync holds that gate for 12 to 13 s, and a send must not wait behind it. Sends keep their own order
/// ([`SEND_GATE`]) and their own store connection (WAL, 5 s busy timeout, as the live loop already does), so a send during a sync
/// writes only its own rows. The sync's watermarks are `max(ts)` of what it fetched, and a send's `set_since` only moves one forward.
async fn relay_send_io<T, F>(app: &tauri::AppHandle, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&str, &nostr::Keys, &Store) -> Result<T, String> + Send + 'static,
{
    secure_store::ensure_loaded(app).await?;
    let path = db_path(app)?;
    let url = relay_url(app);
    let queued = std::time::Instant::now();
    blocking(move || {
        let _gate = SEND_GATE.blocking_lock();
        tracing::info!(waited_ms = queued.elapsed().as_millis() as u64, "send: own path");
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
    relay_send_io(app, move |url, keys, store| {
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

// Serialize foreground refresh, history paging and forget so SQLite and relay
// watermarks cannot race. (r26: sends have their own path, `relay_send_io`.)
static IO_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// r26: sends, edits and deletes wait only for each other (see [`relay_send_io`]).
static SEND_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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
    /// Who reacted and when they first did, first first.
    by: Vec<ReactorView>,
}

#[derive(Serialize)]
struct ReactorView {
    pubkey: String,
    ts: i64,
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
                by: r
                    .by
                    .iter()
                    .map(|b| ReactorView {
                        pubkey: b.pubkey.clone(),
                        ts: b.ts,
                    })
                    .collect(),
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

/// T-161: the slice of a message `src/approvals.ts` reads (`ApprovalSource`): no member names or mentions, so a read on every live
/// message stays one query.
#[derive(Serialize)]
struct ApprovalSourceView {
    #[serde(rename = "ref")]
    id: String,
    channel: String,
    author: String,
    ts: i64,
    body: String,
    root: Option<String>,
}

/// T-161: what Hermes approval prompts are read from (`src/approvals.ts` decides which still wait). Every room with a prompt in the last day,
/// from its oldest prompt on: the answers and outcomes after it are the rest of the room's messages. Read-only, so no IO gate.
#[tauri::command]
async fn approval_messages(app: tauri::AppHandle) -> Result<Vec<ApprovalSourceView>, String> {
    let path = db_path(&app)?;
    blocking(move || {
        let store = Store::open(path).map_err(|e| e.to_string())?;
        let since = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
            - 86_400;
        let me = my_pubkey();
        store
            // the answers line every prompt ends with ("… or `/deny` to cancel."), the command prompt's and the smart-deny one's alike
            // and the first words of every outcome `parseOutcome` reads (approved, denied, timed out, expired, nothing pending); the
            // newest 1000 a room, far more than a day of prompts
            .approval_messages(
                "deny` to cancel.",
                &["✅ Command", "❌ Command", "⌛ ", "⚠️ Approval expired", "⚠ Approval expired", "No pending command"],
                since,
                me.as_deref(),
                1000,
            )
            .map(|rows| {
                rows.into_iter()
                    .map(|m| ApprovalSourceView {
                        id: m.item.r#ref,
                        channel: m.item.channel,
                        author: m.item.author,
                        ts: m.item.ts,
                        body: m.item.body,
                        root: m.root,
                    })
                    .collect()
            })
            .map_err(|e| e.to_string())
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

/// One line from the webview into the app's own log (`uni.log`): which asks Uni must recheck (T-124 r28). Task ids only; one line, bounded.
#[tauri::command]
fn log_line(line: String) {
    let one: String = line.chars().filter(|c| !c.is_control()).take(1000).collect();
    tracing::info!(target: "uni_web", "{one}");
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
    // No key at all is "unpaired"; a key that could not be read is an error the app retries, never a pairing screen.
    let pubkey = blocking(|| {
        uni_core::key_status()
            .map(|k| k.map(|k| k.public_key().to_hex()))
            .map_err(|e| e.to_string())
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
    // T-234: what this identity answered (and any answer it signed but didn't send) goes with it
    for f in ["uni.db", "uni.db-wal", "uni.db-shm", "relay-url", uni_core::sealed_card::ANSWERS_FILE] {
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
    relay_send_io(&app, move |url, keys, store| {
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
    relay_send_io(&app, move |url, keys, store| {
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

/// T-176: keys the person trusts to ask for secrets: `UNI_SECRET_REQUESTERS` (comma-separated hex) plus the
/// `secret-requesters` file in app data (one hex pubkey per line, written by [`secret_pin`]).
fn secret_requesters_list(app: &tauri::AppHandle) -> Vec<nostr::PublicKey> {
    let from_file = app
        .path()
        .app_data_dir()
        .ok()
        .and_then(|d| std::fs::read_to_string(d.join("secret-requesters")).ok())
        .unwrap_or_default();
    let from_env = std::env::var("UNI_SECRET_REQUESTERS").unwrap_or_default();
    from_file
        .lines()
        .chain(from_env.split(','))
        .filter_map(|s| nostr::PublicKey::from_hex(s.trim()).ok())
        .collect()
}

#[tauri::command]
fn secret_requesters(app: tauri::AppHandle) -> Vec<String> {
    secret_requesters_list(&app).iter().map(|k| k.to_hex()).collect()
}

/// T-176: the request in message `request`, verified from its signed event (never the cached row), with the key that
/// signed it. The card renders from this, so what it shows is what `send_secret` will answer.
#[derive(Serialize)]
struct SecretRequestView {
    author: String,
    request: uni_core::secret::SecretRequest,
}

#[tauri::command]
async fn secret_request(app: tauri::AppHandle, channel: String, request: String) -> Result<SecretRequestView, String> {
    let path = db_path(&app)?;
    blocking(move || {
        let store = Store::open(path).map_err(|e| e.to_string())?;
        let asked = uni_core::secret::stored_request(&store, &channel, &request).map_err(|e| e.to_string())?;
        Ok(SecretRequestView { author: asked.requester.to_hex(), request: asked.request })
    })
    .await
}

/// Trust the key that signed message `request` to ask for secrets (the card's "Trust" button, after showing its
/// fingerprint). The key comes from the verified signed event, not from the webview. Only the first key is trusted this
/// way: once one is pinned, another member can't become a requester by one click (a second key goes in the file by hand).
#[tauri::command]
async fn secret_pin(app: tauri::AppHandle, channel: String, request: String) -> Result<(), String> {
    let path = db_path(&app)?;
    let key = blocking(move || {
        let store = Store::open(path).map_err(|e| e.to_string())?;
        uni_core::secret::stored_request(&store, &channel, &request)
            .map(|a| a.requester)
            .map_err(|e| e.to_string())
    })
    .await?;
    let pinned = secret_requesters_list(&app);
    if pinned.contains(&key) {
        return Ok(());
    }
    if !pinned.is_empty() {
        return Err("another key is already trusted for secrets; add this one to the secret-requesters file by hand".into());
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("secret-requesters"))
        .map_err(|e| e.to_string())?;
    writeln!(f, "{}", key.to_hex()).map_err(|e| e.to_string())
}

/// T-176: answer the secret request in message `request` with `value`, sealed (NIP-59) to the request's one-time
/// key. The request, its signer and its one-time key come from the signed event kept at ingest and re-verified here,
/// never from the cached row or the webview. The value is never logged; this copy is zeroized when the command
/// returns (the IPC buffer and the webview's string are not: T-176 design note §7).
/// Returns the wrap's event id.
#[tauri::command]
async fn send_secret(
    app: tauri::AppHandle,
    channel: String,
    request: String,
    value: String,
) -> Result<String, String> {
    let value = zeroize::Zeroizing::new(value);
    let pinned = secret_requesters_list(&app);
    relay_send_io(&app, move |url, keys, store| {
        let asked = uni_core::secret::stored_request(store, &channel, &request).map_err(|e| e.to_string())?;
        let now = nostr::Timestamp::now().as_secs();
        uni_core::secret::check_answerable(&asked, &pinned, now).map_err(|e| e.to_string())?;
        let wrap = uni_core::secret::seal_delivery(keys, &asked, &value, now).map_err(|e| e.to_string())?;
        tauri::async_runtime::block_on(uni_core::secret::publish_wrap(url, keys, None, wrap))
            .map(|id| id.to_hex())
            .map_err(|e| e.to_string())
    })
    .await
}

/// T-176: ask the requester of message `request` to forget what it stored under that request's name.
#[tauri::command]
async fn forget_secret(app: tauri::AppHandle, channel: String, request: String) -> Result<String, String> {
    let pinned = secret_requesters_list(&app);
    relay_send_io(&app, move |url, keys, store| {
        let asked = uni_core::secret::stored_request(store, &channel, &request).map_err(|e| e.to_string())?;
        if !pinned.contains(&asked.requester) {
            return Err("this requester is not trusted for secrets".into());
        }
        let now = nostr::Timestamp::now().as_secs();
        let wrap = uni_core::secret::seal_forget(keys, &asked, now)
            .map_err(|e| e.to_string())?;
        tauri::async_runtime::block_on(uni_core::secret::publish_wrap(url, keys, None, wrap))
            .map(|id| id.to_hex())
            .map_err(|e| e.to_string())
    })
    .await
}

/// T-234: the Uni key approvals are for. Compiled in, never taken from the webview or a message. Only a Linux debug
/// build takes `UNI_DEBUG_TRUSTED_UNI` instead, so the headless walk can sign cards with a synthetic Uni key. Not
/// `debug_assertions` alone: the released Android APK is a debug build (publish.sh `tauri android build --debug`), and
/// no shipped build may read a trust root from its environment. Linux builds are never released.
fn trusted_uni() -> nostr::PublicKey {
    #[cfg(all(debug_assertions, target_os = "linux"))]
    if let Some(k) = std::env::var("UNI_DEBUG_TRUSTED_UNI").ok().and_then(|s| nostr::PublicKey::from_hex(s.trim()).ok()) {
        return k;
    }
    nostr::PublicKey::from_hex(uni_core::archive::UNI_PUBKEY).expect("the compiled-in Uni key is valid")
}

/// T-234: the app's data folder, where the enrollment record and a not-yet-confirmed enrollment are kept.
fn sealed_state_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// T-234 Settings → Approvals: Uni's key, the public half of this device's sealing key (derived here, in Rust, from
/// the identity key), the rooms the enrollment can go into, and the enrollment already made. Public facts only.
#[tauri::command]
async fn sealed_status(app: tauri::AppHandle) -> Result<uni_core::sealed::SealedStatus, String> {
    secure_store::ensure_loaded(&app).await?;
    let path = db_path(&app)?;
    let dir = sealed_state_dir(&app)?;
    blocking(move || {
        let (keys, _) = uni_core::load_keys(false).map_err(|e| e.to_string())?;
        let store = Store::open(path).map_err(|e| e.to_string())?;
        uni_core::sealed::status(&keys, &trusted_uni(), &store, &dir).map_err(|e| e.to_string())
    })
    .await
}

/// T-234: "Enable approvals for Uni", after the person confirmed. Signs the enrollment with the identity key and
/// publishes it in `channel`, a room Uni is in by the relay's roster; the sealing key never leaves Rust. Returns the
/// record; a second or concurrent call returns the same record without publishing again (`sealed::enroll`).
#[tauri::command]
async fn sealed_enroll(app: tauri::AppHandle, channel: String) -> Result<uni_core::sealed::EnrollmentRecord, String> {
    let dir = sealed_state_dir(&app)?;
    relay_send_io(&app, move |url, keys, store| {
        let ch = room_id(&channel)?;
        let now = nostr::Timestamp::now().as_secs();
        tauri::async_runtime::block_on(uni_core::sealed::enroll(url, keys, None, store, ch, &trusted_uni(), &dir, now))
            .map_err(|e| e.to_string())
    })
    .await
}

/// T-234: the signer of message `reference` if it is a verified enrollment for the trusted Uni (the room shows it as
/// a line only then; a body that merely looks like one stays an ordinary message).
#[tauri::command]
async fn sealed_enrollment_line(app: tauri::AppHandle, channel: String, reference: String) -> Result<Option<String>, String> {
    let path = db_path(&app)?;
    blocking(move || {
        let store = Store::open(path).map_err(|e| e.to_string())?;
        uni_core::sealed::stored_enrollment(&store, &channel, &reference, &trusted_uni()).map_err(|e| e.to_string())
    })
    .await
}

/// T-234: Uni's approval card (or morning card) in message `reference`, checked in Rust from its kept signed event
/// (CARD.md §3) against the compiled-in Uni key and this device's sealing key. The card draws only from this view: its
/// rows when every check passed, else one line saying why and nothing to tap. No data key is in it.
#[tauri::command]
async fn sealed_card(app: tauri::AppHandle, channel: String, reference: String) -> Result<uni_core::sealed_card::CardView, String> {
    secure_store::ensure_loaded(&app).await?;
    let path = db_path(&app)?;
    let dir = sealed_state_dir(&app)?;
    blocking(move || {
        let (keys, _) = uni_core::load_keys(false).map_err(|e| e.to_string())?;
        let store = Store::open(path).map_err(|e| e.to_string())?;
        let ev = uni_core::sealed_card::stored_card(&store, &channel, &reference).map_err(|e| e.to_string())?;
        let seal = uni_core::sealed::derive_seal_key(&keys).map_err(|e| e.to_string())?;
        let answers = uni_core::sealed_card::Answers::load(&dir).map_err(|e| e.to_string())?;
        Ok(uni_core::sealed_card::view(&ev, &trusted_uni(), &seal, &answers, nostr::Timestamp::now().as_secs()))
    })
    .await
}

/// T-234: the person's tap on a card: `decision` ("approve" or "deny") for the requests `rids` of message `reference`.
/// Rust checks the card again, refuses a replay or a second answer, opens the data key from the signed card's box and
/// sends one NIP-59 wrap per request to its one-time key (kind 46042). Nothing secret comes from or goes to the
/// webview. Returns the card's view after the answer.
#[tauri::command]
async fn sealed_answer(
    app: tauri::AppHandle,
    channel: String,
    reference: String,
    decision: String,
    rids: Vec<String>,
) -> Result<uni_core::sealed_card::CardView, String> {
    use uni_core::sealed_card::{self as card, Decision};
    let decision = match decision.as_str() {
        "approve" => Decision::Approve,
        "deny" => Decision::Deny,
        _ => return Err("unknown decision".into()),
    };
    let dir = sealed_state_dir(&app)?;
    if decision == Decision::Approve {
        // the device's own confirm, before anything is recorded or sent: what it names comes from the checked card here
        let (path, dir2, ch, re, ids) = (db_path(&app)?, dir.clone(), channel.clone(), reference.clone(), rids.clone());
        secure_store::ensure_loaded(&app).await?;
        let (title, reason) = blocking(move || {
            let (keys, _) = uni_core::load_keys(false).map_err(|e| e.to_string())?;
            let store = Store::open(path).map_err(|e| e.to_string())?;
            let ev = card::stored_card(&store, &ch, &re).map_err(|e| e.to_string())?;
            let seal = uni_core::sealed::derive_seal_key(&keys).map_err(|e| e.to_string())?;
            let answers = card::Answers::load(&dir2).map_err(|e| e.to_string())?;
            let view = card::view(&ev, &trusted_uni(), &seal, &answers, nostr::Timestamp::now().as_secs());
            card::approval_summary(&view, &ids).map_err(|e| e.to_string())
        })
        .await?;
        confirm_approval(&app, title, reason).await?;
    }
    relay_send_io(&app, move |url, keys, store| {
        let ev = card::stored_card(store, &channel, &reference).map_err(|e| e.to_string())?;
        let now = nostr::Timestamp::now().as_secs();
        tauri::async_runtime::block_on(card::answer(url, keys, None, &ev, &trusted_uni(), decision, &rids, &dir, now))
            .map_err(|e| e.to_string())?;
        let seal = uni_core::sealed::derive_seal_key(keys).map_err(|e| e.to_string())?;
        let answers = card::Answers::load(&dir).map_err(|e| e.to_string())?;
        Ok(card::view(&ev, &trusted_uni(), &seal, &answers, now))
    })
    .await
}

/// T-234 (Codex review 1, P0): an approval needs the person, not only the webview. The card's hold and tap are React; a
/// script in the webview could call `sealed_answer` itself. So before a data key goes anywhere, Rust raises the
/// device's own confirm, which no page can answer: the device unlock (biometric or screen lock) on Android and macOS,
/// a native dialog on Linux (never released). Its words come from the checked card. One at a time.
async fn confirm_approval(app: &tauri::AppHandle, title: String, reason: String) -> Result<(), String> {
    static CONFIRMING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _one = CONFIRMING.try_lock().map_err(|_| "another approval is waiting for your confirmation".to_string())?;
    // The headless walk (cage) can't press a native dialog's button. Only a Linux debug build, which is never released,
    // lets `UNI_DEBUG_APPROVE_CONFIRMED=1` stand in for that press; it writes the confirm's words to the walk folder.
    #[cfg(all(debug_assertions, target_os = "linux"))]
    if std::env::var("UNI_DEBUG_APPROVE_CONFIRMED").as_deref() == Ok("1") {
        if let Ok(dir) = std::env::var("UNI_T76_DIR") {
            use std::io::Write;
            let line = serde_json::json!({ "title": title, "reason": reason }).to_string();
            let _ = std::fs::OpenOptions::new().create(true).append(true).open(std::path::Path::new(&dir).join("confirms.jsonl"))
                .and_then(|mut f| writeln!(f, "{line}"));
        }
        return Ok(());
    }
    #[cfg(any(target_os = "android", target_os = "macos"))]
    {
        // never cancelled from here: the sender lives until the unlock answers
        let (_keep, never) = tokio::sync::watch::channel(None);
        let id = uuid::Uuid::new_v4().to_string();
        secure_store::unlock(app, &id, never, &title, &reason).await.map_err(|e| format!("not approved: {e}"))
    }
    #[cfg(not(any(target_os = "android", target_os = "macos")))]
    {
        #[cfg(desktop)]
        {
            use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
            let (tx, rx) = tokio::sync::oneshot::channel();
            app.dialog()
                .message(reason)
                .title(title)
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom("Approve".into(), "Cancel".into()))
                .show(move |ok| {
                    let _ = tx.send(ok);
                });
            match rx.await {
                Ok(true) => Ok(()),
                _ => Err("not approved: cancelled on this device".into()),
            }
        }
        #[cfg(not(desktop))]
        {
            let _ = (app, title, reason);
            Err("approvals need a device unlock, which this platform doesn't have".into())
        }
    }
}

/// T-234: the cards from Uni waiting for a tap in any room (checked, unanswered, not expired), for Needs you.
#[tauri::command]
async fn sealed_waiting(app: tauri::AppHandle) -> Result<Vec<uni_core::sealed_card::Waiting>, String> {
    secure_store::ensure_loaded(&app).await?;
    let path = db_path(&app)?;
    let dir = sealed_state_dir(&app)?;
    blocking(move || {
        let (keys, _) = uni_core::load_keys(false).map_err(|e| e.to_string())?;
        let store = Store::open(path).map_err(|e| e.to_string())?;
        let seal = uni_core::sealed::derive_seal_key(&keys).map_err(|e| e.to_string())?;
        let answers = uni_core::sealed_card::Answers::load(&dir).map_err(|e| e.to_string())?;
        let now = nostr::Timestamp::now().as_secs();
        uni_core::sealed_card::waiting(&store, &keys.public_key().to_hex(), &trusted_uni(), &seal, &answers, now).map_err(|e| e.to_string())
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

/// Content-Type for a streamed attachment: the `imeta` `m` when it is audio
/// or video, else from the URL's extension (as `attachmentKind` decides in
/// the UI). None for anything that is not playable media.
fn stream_mime(mime: Option<&str>, url: &str) -> Option<String> {
    // Parameters (`video/mp4; codecs="avc1"`) don't change what it is.
    if let Some(m) = mime.map(|m| m.split(';').next().unwrap_or("").trim()).filter(|m| !m.is_empty()) {
        let m = m.to_ascii_lowercase();
        let safe = m.bytes().all(|b| b.is_ascii_alphanumeric() || b"/-+.".contains(&b));
        return (safe && (m.starts_with("video/") || m.starts_with("audio/"))).then_some(m);
    }
    let ext = url.rsplit_once('.')?.1.to_ascii_lowercase();
    Some(
        match ext.as_str() {
            "mp4" | "m4v" => "video/mp4",
            "webm" => "video/webm",
            "mov" => "video/quicktime",
            "mp3" => "audio/mpeg",
            "m4a" => "audio/mp4",
            "aac" => "audio/aac",
            "ogg" | "oga" => "audio/ogg",
            "opus" => "audio/opus",
            "wav" => "audio/wav",
            "flac" => "audio/flac",
            _ => return None,
        }
        .to_string(),
    )
}

/// Where the webview plays a streamed attachment: `url` on Linux and Android
/// (see `media_loopback`), else the `unimedia` protocol URL the UI builds from `sha`.
#[derive(Serialize)]
struct MediaStreamView {
    sha: String,
    url: Option<String>,
}

/// T-172: make a relay video or audio file playable. It is streamed to the
/// hash-keyed cache (Blossom auth, SHA-256 verified, up to 500 MB) and allowed
/// on the `unimedia` protocol; the webview then plays
/// `unimedia://localhost/<sha>`, which answers byte ranges from that file
/// (Linux and Android: a token-guarded 127.0.0.1 URL instead). Neither the bytes nor
/// the auth token pass through JavaScript. A file already in the cache plays
/// once its hash is re-checked, without the key. The hash stays pinned against
/// cache pruning until the player calls `media_release`.
#[tauri::command]
async fn media_stream(
    app: tauri::AppHandle,
    url: String,
    sha: Option<String>,
    mime: Option<String>,
) -> Result<MediaStreamView, String> {
    let content_type = stream_mime(mime.as_deref(), &url).ok_or("not a video or audio attachment")?;
    secure_store::ensure_loaded(&app).await?;
    let relay = relay_url(&app);
    let dir = media_cache_dir(&app)?;
    let hash = uni_core::media::media_sha_from_url(&relay, &url).map_err(|e| e.to_string())?;
    if sha.as_deref().is_some_and(|x| !x.is_empty() && !x.eq_ignore_ascii_case(&hash)) {
        return Err("imeta hash does not match the media URL".into());
    }
    let fetched = hash.clone();
    blocking(move || {
        let reg = &media_registry::MEDIA;
        let budget = uni_core::media::MEDIA_CACHE_BUDGET;
        media_registry::fetch_pinned(reg, &dir, &fetched, Some(&content_type), budget, || {
            let max = uni_core::media::MAX_STREAM_MEDIA_BYTES;
            if media_registry::lock(reg).is_allowed(&fetched) && dir.join(&fetched).is_file() {
                return Ok(false);
            }
            if uni_core::media::verified_cache_file(&dir, &fetched, max).is_some() {
                return Ok(false);
            }
            let (keys, _) = uni_core::load_keys(false).map_err(|e| e.to_string())?;
            tauri::async_runtime::block_on(uni_core::media::fetch_media_to_file(
                &relay,
                &keys,
                &url,
                sha.as_deref(),
                &dir,
                max,
            ))
            .map_err(|e| e.to_string())?;
            tracing::info!(sha = %fetched, "media_stream: downloaded and verified");
            Ok(true)
        })
    })
    .await?;
    #[cfg(any(target_os = "linux", target_os = "android"))]
    let url = Some(format!("{}/{hash}", media_loopback::base(media_cache_dir(&app)?)?));
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    let url = None;
    Ok(MediaStreamView { sha: hash, url })
}

fn checked_hash(sha: &str) -> Result<String, String> {
    let sha = sha.trim().to_ascii_lowercase();
    if sha.len() == 64 && sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(sha)
    } else {
        Err("bad media hash".into())
    }
}

/// A player started (again) on a streamed file: keep it in the cache while it plays.
#[tauri::command]
fn media_pin(sha: String) -> Result<(), String> {
    media_registry::lock(&media_registry::MEDIA).pin(&checked_hash(&sha)?);
    Ok(())
}

/// A player ended or went away: its file may be pruned again. Pairs with
/// `media_stream` and `media_pin`.
#[tauri::command]
fn media_release(sha: String) -> Result<(), String> {
    media_registry::lock(&media_registry::MEDIA).release(&checked_hash(&sha)?);
    Ok(())
}

/// The `unimedia` protocol: byte ranges of a verified cached video or audio
/// file (see [`media_stream`]); 404 for any other path.
fn media_protocol(
    ctx: tauri::UriSchemeContext<'_, tauri::Wry>,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    use tauri::http::{header, Response};
    let app = ctx.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let sha = request.uri().path().trim_start_matches('/').to_string();
        let range = request
            .headers()
            .get(header::RANGE)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let content_type = media_registry::lock(&media_registry::MEDIA).content_type(&sha);
        let head = request.method() == tauri::http::Method::HEAD;
        let reply = content_type.and_then(|ct| {
            let path = uni_core::media::cache_path(&media_cache_dir(&app).ok()?, &sha).ok()?;
            if head {
                // The length only: never read the file for a HEAD.
                let len = std::fs::metadata(&path).ok()?.len();
                return Some((ct, uni_core::media::RangeReply { status: 200, content_range: None, body: Vec::new() }, len));
            }
            let r = uni_core::media::read_range(&path, range.as_deref()).ok()?;
            let len = r.body.len() as u64;
            Some((ct, r, len))
        });
        tracing::debug!(sha = %sha, range = ?range, status = reply.as_ref().map(|r| r.1.status), "unimedia");
        let response = match reply {
            Some((ct, r, len)) => {
                let mut b = Response::builder()
                    .status(r.status)
                    .header(header::CONTENT_TYPE, ct)
                    .header(header::ACCEPT_RANGES, "bytes")
                    .header(header::CONTENT_LENGTH, len)
                    .header(header::CACHE_CONTROL, "no-store");
                if let Some(cr) = r.content_range {
                    b = b.header(header::CONTENT_RANGE, cr);
                }
                b.body(r.body)
            }
            None => Response::builder()
                .status(404)
                .header(header::CONTENT_TYPE, "text/plain")
                .body(b"not found".to_vec()),
        };
        responder.respond(response.unwrap_or_else(|_| Response::new(Vec::new())));
    });
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

/// Transcribe a voice message on the hub's host (T-137: the URL follows the
/// hub setting, and its other name if this one is unreachable). Body: raw
/// audio; header `x-audio-mime`.
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
    let cfg = vault_config(&app);
    // the vault client's rule: https, or http only on this device (never audio over plain http)
    uni_core::hub::checked_origin(&cfg.hub).map_err(|e| e.to_string())?;
    let remember = remember_hub(&app, &cfg);
    blocking(move || {
        let (keys, _) = uni_core::load_keys(false).map_err(|e| e.to_string())?;
        tauri::async_runtime::block_on(uni_core::transcribe::transcribe_on_hub(
            &cfg.hub,
            &keys,
            audio,
            &mime,
            Some(remember),
        ))
        .map_err(|e| e.to_string())
    })
    .await
}

/// The verified cache file for the attachment whose URL names `hash`, if cached. The `imeta` `x` (`expected`) is
/// checked first, as `fetch_media_to_file` does before its own cache lookup, so a cache hit can't skip it
/// (Codex review 2).
fn cached_attachment(dir: &std::path::Path, hash: &str, expected: Option<&str>, max: u64) -> Result<Option<PathBuf>, String> {
    if expected.is_some_and(|x| !x.is_empty() && !x.eq_ignore_ascii_case(hash)) {
        return Err("imeta hash does not match the media URL".into());
    }
    Ok(uni_core::media::verified_cache_file(dir, hash, max))
}

/// How long an opened copy stays pinned after it is handed to the OS: the viewer opens it after the handoff
/// returns (desktop: `open_path`; Android: the FileProvider URI, T-174), and once it has the file open, pruning
/// the name no longer hurts it.
const OPENED_COPY_GRACE: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// Open copies being prepared: one lock per `<hash>.<ext>`, so two Opens of the same file never write it at once.
static OPEN_COPY_LOCKS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<std::sync::Mutex<()>>>>> =
    std::sync::LazyLock::new(Default::default);

/// Make `dir/<name>` a verified copy of the cached `dir/<hash>`. A copy already there is reused only if it still
/// hashes to `hash` (never on its length alone). Otherwise the cache file is copied to a private `.part` name,
/// hashed on the way, and only a copy that verified is renamed onto `<name>`: a viewer holding the old file
/// keeps reading it whole, and nobody ever sees a half-written or wrong copy (Codex T-174 review 1).
/// Returns whether it copied.
fn prepare_open_copy(dir: &std::path::Path, hash: &str, name: &str) -> Result<bool, String> {
    let lock = OPEN_COPY_LOCKS.lock().unwrap_or_else(|e| e.into_inner()).entry(name.to_string()).or_default().clone();
    let _one_writer = lock.lock().unwrap_or_else(|e| e.into_inner());
    let target = dir.join(name);
    if uni_core::media::file_sha256(&target).is_ok_and(|got| got == hash) {
        return Ok(false);
    }
    let tmp = dir.join(format!("{name}.{}.part", uuid::Uuid::new_v4()));
    uni_core::media::copy_verified(&dir.join(hash), &tmp, hash).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(true)
}

/// Copy the cached `<hash>` to `<hash>.<ext>` for the OS opener, pinning the copy's name first so no prune
/// removes it while it is written or before the viewer opens it (Codex review 2). The caller releases the
/// returned name (after [`OPENED_COPY_GRACE`]).
fn pinned_copy(reg: &std::sync::Mutex<media_registry::Registry>, dir: &std::path::Path, hash: &str, ext: &str) -> Result<(PathBuf, String), String> {
    let name = format!("{hash}.{ext}");
    media_registry::lock(reg).pin(&name);
    match prepare_open_copy(dir, hash, &name) {
        Ok(_) => Ok((dir.join(&name), name)),
        Err(e) => {
            media_registry::lock(reg).release(&name);
            Err(e)
        }
    }
}

/// Download a relay file to the cache (streamed, up to 500 MB) and return its
/// local path and hash. The hash stays pinned; the caller releases it.
async fn save_pinned(app: &tauri::AppHandle, url: String, sha: Option<String>) -> Result<(String, String), String> {
    secure_store::ensure_loaded(app).await?;
    let relay = relay_url(app);
    let dir = media_cache_dir(app)?;
    let hash = uni_core::media::media_sha_from_url(&relay, &url).map_err(|e| e.to_string())?;
    let pinned = hash.clone();
    blocking(move || {
        let reg = &media_registry::MEDIA;
        let budget = uni_core::media::MEDIA_CACHE_BUDGET;
        media_registry::fetch_pinned(reg, &dir, &pinned, None, budget, || {
            let max = uni_core::media::MAX_STREAM_MEDIA_BYTES;
            if cached_attachment(&dir, &pinned, sha.as_deref(), max)?.is_some() {
                return Ok(false);
            }
            let (keys, _) = uni_core::load_keys(false).map_err(|e| e.to_string())?;
            tauri::async_runtime::block_on(uni_core::media::fetch_media_to_file(
                &relay,
                &keys,
                &url,
                sha.as_deref(),
                &dir,
                max,
            ))
            .map(|_| true)
            .map_err(|e| e.to_string())
        })?;
        uni_core::media::cache_path(&dir, &pinned)
            .map(|p| (p.to_string_lossy().into_owned(), pinned.clone()))
            .map_err(|e| e.to_string())
    })
    .await
}

/// The `imeta` `m` when it is a plain `type/subtype` (parameters dropped); a hint for the app that opens the file.
fn attachment_mime(mime: Option<&str>) -> Option<String> {
    let m = mime?.split(';').next()?.trim().to_ascii_lowercase();
    let safe = m.split_once('/').is_some_and(|(a, b)| !a.is_empty() && !b.is_empty())
        && m.bytes().all(|b| b.is_ascii_alphanumeric() || b"/-+.".contains(&b));
    safe.then_some(m)
}

/// T-174: save a relay attachment where the user finds it: Android's
/// Downloads (MediaStore), the Downloads folder on desktop (see `files`).
/// Downloaded to the cache first (streamed, up to 500 MB, Blossom auth and
/// SHA-256 check), then copied out under the attachment's own name (`name`:
/// the `imeta` filename). Returns where it went, for the confirmation.
#[tauri::command]
async fn media_save(
    app: tauri::AppHandle,
    url: String,
    sha: Option<String>,
    name: Option<String>,
    mime: Option<String>,
) -> Result<String, String> {
    let (path, hash) = save_pinned(&app, url.clone(), sha).await?;
    let name = uni_core::media::download_name(name.as_deref(), &url, &hash);
    // Still pinned: the cache is not pruned under the copy.
    let saved = files::save(&app, std::path::Path::new(&path), &name, attachment_mime(mime.as_deref()).as_deref()).await;
    media_registry::lock(&media_registry::MEDIA).release(&hash);
    saved
}

/// T-204: "Download .md": save a note's markdown (`text`, exactly as the UI
/// read it from the vault) as `name`. Desktop asks where with the Save dialog,
/// Android puts it in Downloads (see `files`). `None` when the user cancelled.
#[tauri::command]
async fn note_download(window: tauri::Window, name: String, text: String) -> Result<Option<String>, String> {
    files::save_note(&window, &name, text).await
}

/// T-204: share a note's markdown as `name` through the Android share sheet.
#[tauri::command]
async fn note_share(app: tauri::AppHandle, name: String, text: String, title: Option<String>) -> Result<(), String> {
    files::share_note(&app, &name, text, title.as_deref()).await
}

/// Fetch and open an attachment in the app the system picks for its type
/// (Android: FileProvider + ACTION_VIEW, see `files`). Never open a remote
/// URL directly (that would omit Blossom auth and leak identity).
#[tauri::command]
async fn media_open(
    app: tauri::AppHandle,
    url: String,
    sha: Option<String>,
    mime: Option<String>,
) -> Result<(), String> {
    let relay = relay_url(&app);
    uni_core::media::media_sha_from_url(&relay, &url).map_err(|e| e.to_string())?;
    let ext = uni_core::media::url_extension(&url).unwrap_or("bin").to_string();
    let (_, hash) = save_pinned(&app, url, sha).await?;
    let dir = media_cache_dir(&app)?;
    let copied = blocking({
        let hash = hash.clone();
        move || pinned_copy(&media_registry::MEDIA, &dir, &hash, &ext)
    })
    .await;
    media_registry::lock(&media_registry::MEDIA).release(&hash);
    let (target, name) = copied?;
    // Android hands the viewer a content:// URI; it reads the copy after this returns, as on desktop.
    let opened = files::open(&app, &target, attachment_mime(mime.as_deref()).as_deref()).await;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(OPENED_COPY_GRACE).await;
        media_registry::lock(&media_registry::MEDIA).release(&name);
    });
    opened
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

// ── Calendar (T-229): through the calendar door on the hub's host. Each
// request is NIP-98 signed with the device key, as Mail's are; the door is
// the only writer of event notes, so the webview never holds a vault token.

use uni_core::cal::{CalDoor, CalError};

fn cal_invalid(message: impl ToString) -> CalError {
    CalError::Invalid { message: message.to_string() }
}

/// `UNI_CAL_URL` (a scratch or fake door, no alias), else port 8490 on the hub's host, its new name first.
fn cal_base(app: &tauri::AppHandle) -> Result<(String, Option<String>), CalError> {
    if let Ok(v) = std::env::var(uni_core::cal::CAL_URL_ENV) {
        if !v.trim().is_empty() {
            return Ok((v.trim().to_string(), None));
        }
    }
    let hub = vault_config(app).hub;
    uni_core::cal::door_urls(&hub).ok_or_else(|| cal_invalid(format!("no calendar door for the hub {hub} (it must be https)")))
}

/// Run `f` with a door client on the device key, off the async executor.
async fn cal_io<F>(app: &tauri::AppHandle, f: F) -> Result<serde_json::Value, CalError>
where
    F: FnOnce(&CalDoor) -> Result<serde_json::Value, CalError> + Send + 'static,
{
    secure_store::ensure_loaded(app).await.map_err(cal_invalid)?;
    let (base, alias) = cal_base(app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (keys, _) = uni_core::load_keys(false).map_err(cal_invalid)?;
        f(&CalDoor::new(&base, &keys)?.with_alias(alias.as_deref()))
    })
    .await
    .map_err(cal_invalid)?
}

/// What this key may do at the door (`{role, ops, calendar, tz}`); the Calendar place shows only when it answers.
#[tauri::command]
async fn cal_session(app: tauri::AppHandle) -> Result<serde_json::Value, CalError> {
    cal_io(&app, |door| tauri::async_runtime::block_on(door.session())).await
}

/// The instances overlapping `[from, to)`, as the door expands them.
#[tauri::command]
async fn cal_events(app: tauri::AppHandle, from: String, to: String) -> Result<serde_json::Value, CalError> {
    cal_io(&app, move |door| tauri::async_runtime::block_on(door.events(&from, &to))).await
}

/// One event note in full.
#[tauri::command]
async fn cal_event(app: tauri::AppHandle, id: String) -> Result<serde_json::Value, CalError> {
    cal_io(&app, move |door| tauri::async_runtime::block_on(door.event(&id))).await
}

/// The conflict records the door keeps (`event-conflict` notes).
#[tauri::command]
async fn cal_conflicts(app: tauri::AppHandle) -> Result<serde_json::Value, CalError> {
    cal_io(&app, |door| tauri::async_runtime::block_on(door.conflicts())).await
}

/// One named write (`create`, `move`, …); refused on the device unless it is one this app sends.
#[tauri::command]
async fn cal_op(app: tauri::AppHandle, op: serde_json::Value) -> Result<serde_json::Value, CalError> {
    cal_io(&app, move |door| tauri::async_runtime::block_on(door.op(&op))).await
}

// ── Mail (T-45): through the mail bridge on the hub's host. Each
// request is NIP-98 signed with the device key; the bridge holds the mail
// credentials, so the webview never sees one. Reading never writes; the
// writes (T-210, below) are the bridge's named operations.

use uni_core::mail::{MailBridge, MailError};

fn mail_invalid(message: impl ToString) -> MailError {
    MailError::Invalid { message: message.to_string() }
}

/// The bridge origin and, for a hub with another name (T-137), the bridge
/// there: `UNI_MAIL_URL` (a scratch or fake bridge, no alias), else port 8452
/// on the hub's host, its new name first ([`uni_core::mail::bridge_urls`]).
fn mail_base(app: &tauri::AppHandle) -> Result<(String, Option<String>), MailError> {
    if let Ok(v) = std::env::var(uni_core::mail::MAIL_URL_ENV) {
        if !v.trim().is_empty() {
            return Ok((v.trim().to_string(), None));
        }
    }
    let hub = vault_config(app).hub;
    uni_core::mail::bridge_urls(&hub).ok_or_else(|| mail_invalid(format!("no mail bridge for the hub {hub} (it must be https)")))
}

/// Run `f` with a bridge client on the device key, off the async executor.
async fn mail_io<T, F>(app: &tauri::AppHandle, f: F) -> Result<T, MailError>
where
    T: Send + 'static,
    F: FnOnce(&MailBridge) -> Result<T, MailError> + Send + 'static,
{
    secure_store::ensure_loaded(app).await.map_err(mail_invalid)?;
    let (base, alias) = mail_base(app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (keys, _) = uni_core::load_keys(false).map_err(mail_invalid)?;
        f(&MailBridge::new(&base, &keys)?.with_alias(alias.as_deref()))
    })
    .await
    .map_err(mail_invalid)?
}

/// The accounts this key reads (its own, and the one shared with it: T-45 v2) with their mailboxes.
#[tauri::command]
async fn mail_overview(app: tauri::AppHandle) -> Result<uni_core::mail::Overview, MailError> {
    mail_io(&app, |mail| tauri::async_runtime::block_on(mail.overview())).await
}

/// A page of threads from one or more accounts, merged newest first; `text` searches.
#[tauri::command]
async fn mail_threads(app: tauri::AppHandle, sources: Vec<uni_core::mail::Source>, text: Option<String>) -> Result<uni_core::mail::ThreadPage, MailError> {
    mail_io(&app, move |mail| tauri::async_runtime::block_on(mail.threads(&sources, text.as_deref(), uni_core::mail::PAGE_SIZE))).await
}

/// A thread to read, oldest first: plain text, sanitized HTML, attachments. `Email/get` only: nothing is marked read.
#[tauri::command]
async fn mail_thread(app: tauri::AppHandle, account_id: String, thread_id: String) -> Result<uni_core::mail::Thread, MailError> {
    mail_io(&app, move |mail| tauri::async_runtime::block_on(mail.thread(&account_id, &thread_id))).await
}

/// Uni's triage notes on these messages (display only), by email id.
#[tauri::command]
async fn mail_triage(app: tauri::AppHandle, account_id: String, email_ids: Vec<String>) -> Result<std::collections::HashMap<String, String>, MailError> {
    mail_io(&app, move |mail| tauri::async_runtime::block_on(mail.triage(&account_id, &email_ids))).await
}

/// Fetch an attachment through the bridge into the cache and open it with
/// the OS default handler, as `media_open` does for relay files. Mail comes
/// from anyone, so only documents, images and media are opened, and only
/// when the declared type and the bytes match the name
/// ([`uni_core::mail::open_attachment_in`]): a file that could run as a program
/// is refused before it is fetched, a disguised one before it is written.
#[tauri::command]
async fn mail_attachment_open(app: tauri::AppHandle, account_id: Option<String>, blob_id: String, name: Option<String>, mime: Option<String>) -> Result<(), MailError> {
    use tauri_plugin_opener::OpenerExt;
    let dir = app.path().app_cache_dir().map_err(mail_invalid)?.join("mail");
    let opener = app.clone();
    mail_io(&app, move |mail| {
        let open = |path: &std::path::Path| opener.opener().open_path(path.to_string_lossy(), None::<&str>).map_err(|e| e.to_string());
        tauri::async_runtime::block_on(uni_core::mail::open_attachment_in(mail, &dir, account_id.as_deref(), &blob_id, name.as_deref(), mime.as_deref(), open)).map(|_| ())
    })
    .await
}

// T-210: writes are the bridge's named operations, run only where its session offers them
// (`uni_core::mail::write`). Sending is save → review → send by id and fingerprint, once per opId.

use uni_core::mail::{DraftFields, Reviewed, SendOutcome};

/// Set or clear "read" ($seen) on these messages.
#[tauri::command]
async fn mail_mark_seen(app: tauri::AppHandle, account_id: String, email_ids: Vec<String>, seen: bool) -> Result<(), MailError> {
    mail_io(&app, move |mail| tauri::async_runtime::block_on(mail.mark_seen(&account_id, &email_ids, seen))).await
}

#[tauri::command]
async fn mail_flag(app: tauri::AppHandle, account_id: String, email_ids: Vec<String>, flagged: bool) -> Result<(), MailError> {
    mail_io(&app, move |mail| tauri::async_runtime::block_on(mail.flag(&account_id, &email_ids, flagged))).await
}

/// Move these messages from the account's Inbox to its Archive.
#[tauri::command]
async fn mail_archive(app: tauri::AppHandle, account_id: String, email_ids: Vec<String>) -> Result<(), MailError> {
    mail_io(&app, move |mail| tauri::async_runtime::block_on(mail.archive(&account_id, &email_ids))).await
}

/// Save a draft (over `replaces`, opened with fingerprint `base`); the answer is what to review before sending.
#[tauri::command]
async fn mail_draft_save(app: tauri::AppHandle, account_id: String, fields: DraftFields, replaces: Option<String>, base: Option<String>) -> Result<Reviewed, MailError> {
    mail_io(&app, move |mail| {
        let over = replaces.as_deref().zip(base.as_deref());
        if replaces.is_some() && over.is_none() {
            return Err(mail_invalid("replacing a draft needs the fingerprint it was opened with"));
        }
        tauri::async_runtime::block_on(mail.draft_save(&account_id, &fields, over))
    })
    .await
}

/// An existing draft as it is, for review: its fingerprint, and the Uni drafts sending it discards.
#[tauri::command]
async fn mail_draft_review(app: tauri::AppHandle, account_id: String, draft_id: String) -> Result<Reviewed, MailError> {
    mail_io(&app, move |mail| tauri::async_runtime::block_on(mail.draft_review(&account_id, &draft_id))).await
}

#[tauri::command]
async fn mail_draft_discard(app: tauri::AppHandle, account_id: String, draft_id: String) -> Result<(), MailError> {
    mail_io(&app, move |mail| tauri::async_runtime::block_on(mail.draft_discard(&account_id, &draft_id))).await
}

/// Send the reviewed draft once, under the review's opId.
#[tauri::command]
async fn mail_send(app: tauri::AppHandle, account_id: String, op_id: String, reviewed: Reviewed) -> Result<SendOutcome, MailError> {
    mail_io(&app, move |mail| tauri::async_runtime::block_on(mail.send(&account_id, &op_id, &reviewed))).await
}

/// The owner sends as Uni, through the bridge's deputy path and Uni's outbound rules.
#[tauri::command]
async fn mail_send_as_uni(app: tauri::AppHandle, account_id: String, op_id: String, fields: DraftFields) -> Result<SendOutcome, MailError> {
    mail_io(&app, move |mail| tauri::async_runtime::block_on(mail.send_as_uni(&account_id, &op_id, &fields))).await
}

/// Where a send stands (an unknown outcome is checked with the mail server first).
#[tauri::command]
async fn mail_send_check(app: tauri::AppHandle, account_id: String, op_id: String) -> Result<SendOutcome, MailError> {
    mail_io(&app, move |mail| tauri::async_runtime::block_on(mail.send_check(&account_id, &op_id))).await
}

/// T-213: the sends on Uni's account waiting for you, with what each says (read-only).
#[tauri::command]
async fn mail_parked(app: tauri::AppHandle, account_id: String) -> Result<Vec<uni_core::mail::Parked>, MailError> {
    mail_io(&app, move |mail| tauri::async_runtime::block_on(mail.parked(&account_id))).await
}

/// Approve a parked send: exactly the draft whose fingerprint you were shown, once per opId.
#[tauri::command]
async fn mail_send_approve(app: tauri::AppHandle, account_id: String, op_id: String, fingerprint: String) -> Result<SendOutcome, MailError> {
    mail_io(&app, move |mail| tauri::async_runtime::block_on(mail.send_approve(&account_id, &op_id, &fingerprint))).await
}

/// Decline a parked send: nothing is sent.
#[tauri::command]
async fn mail_send_decline(app: tauri::AppHandle, account_id: String, op_id: String) -> Result<SendOutcome, MailError> {
    mail_io(&app, move |mail| tauri::async_runtime::block_on(mail.send_decline(&account_id, &op_id))).await
}

// ── Journal: entries go straight to the Parachute vault, signed per request
// with the same key that signs Buzz messages (NIP-98). The device queues each
// entry first, so journaling works offline and survives app restarts.

/// T-137: stays `uni-1` until the tailnet rename (step 3); `uni` is its alias
/// (`uni_core::hub::HUB_ALIASES`), so this build reaches the hub either way.
const DEFAULT_HUB: &str = "https://uni-1.taildf9ce2.ts.net"; // public-ok: the shipped default hub (T-190, see CLAUDE.md)
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

/// The hub setting as the UI sees it, with every origin that is this hub
/// (T-137: links on either tailnet name open in-app).
#[derive(Serialize)]
struct HubSetting {
    hub: String,
    vault: String,
    hub_origins: Vec<String>,
}

#[tauri::command]
fn journal_config(app: tauri::AppHandle) -> HubSetting {
    let cfg = vault_config(&app);
    HubSetting {
        hub_origins: uni_core::hub::hub_origins(&cfg.hub),
        hub: cfg.hub,
        vault: cfg.vault,
    }
}

/// T-137: when the hub answers on its other name, later launches go straight
/// there: the setting in `vault.json` becomes that name.
fn remember_hub(
    app: &tauri::AppHandle,
    cfg: &uni_core::parachute::VaultConfig,
) -> uni_core::parachute::OnHubSwitch {
    let dir = app.path().app_data_dir().ok();
    let vault = cfg.vault.clone();
    std::sync::Arc::new(move |origin: &str| {
        let Some(dir) = &dir else { return };
        let cfg = uni_core::parachute::VaultConfig {
            hub: origin.to_string(),
            vault: vault.clone(),
        };
        let saved = std::fs::create_dir_all(dir).and_then(|_| {
            std::fs::write(
                dir.join("vault.json"),
                serde_json::to_string(&cfg).unwrap_or_default(),
            )
        });
        if let Err(e) = saved {
            tracing::warn!("hub {origin} answered but couldn't be saved: {e}");
        }
    })
}

/// The vault client for the hub setting, remembering the hub's other name
/// when that is the one that answers.
fn vault_client(
    app: &tauri::AppHandle,
    cfg: uni_core::parachute::VaultConfig,
    keys: nostr::Keys,
) -> Result<uni_core::parachute::VaultClient, String> {
    let remember = remember_hub(app, &cfg);
    uni_core::parachute::VaultClient::new(cfg, keys)
        .map(|c| c.on_hub_switch(remember))
        .map_err(|e| e.to_string())
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
    let app = app.clone();
    let _gate = JOURNAL_GATE.lock().await;
    blocking(move || {
        let (keys, _) = uni_core::load_keys(false).map_err(|e| e.to_string())?;
        let store = Store::open(path).map_err(|e| e.to_string())?;
        let client = vault_client(&app, cfg, keys)?;
        tauri::async_runtime::block_on(uni_core::journal::flush(&store, &client))
            .map_err(|e| e.to_string())
    })
    .await
}

async fn journal_queue_entry(
    app: &tauri::AppHandle,
    entry: JournalDraft,
    audio: Option<(Vec<u8>, String)>,
    save_another: bool,
) -> Result<uni_core::journal::Queued, String> {
    let path = db_path(app)?;
    blocking(move || {
        let store = Store::open(path).map_err(|e| e.to_string())?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or_default();
        let send = uni_core::journal::Submission {
            id: entry.submission_id.as_deref().unwrap_or(&entry.entry_id),
            save_another,
        };
        store
            .journal_submit(
                send,
                &entry.entry_id,
                &entry.path,
                &entry.alternates,
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
    /// Paths to try, in order, when `path` is taken (0.1.46; older drafts have none).
    #[serde(default)]
    alternates: Vec<String>,
    /// Made once per composer send and kept when that send is retried
    /// (0.1.46 fix); a draft without one is its own send (its entry id).
    #[serde(default)]
    submission_id: Option<String>,
}

/// Queue a typed entry, then try to send everything queued. A retry of the
/// same send queues nothing. The same words as an entry waiting, or sent in
/// the last ten minutes, aren't queued: the report names that entry and the
/// app asks; `save_another` is the answer "Save another".
#[tauri::command]
async fn journal_save_text(
    app: tauri::AppHandle,
    entry: JournalDraft,
    save_another: Option<bool>,
) -> Result<uni_core::journal::FlushReport, String> {
    let queued = journal_queue_entry(&app, entry, None, save_another.unwrap_or(false)).await?;
    let mut report = journal_flush_inner(&app).await?;
    if let uni_core::journal::Queued::SameWords(same) = queued {
        report.duplicate = Some(same);
    }
    Ok(report)
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
    journal_queue_entry(&app, entry, Some((bytes.clone(), mime)), false).await?;
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
    let app = app.clone();
    blocking(move || {
        let (keys, _) = uni_core::load_keys(false).map_err(|e| e.to_string())?;
        let client = vault_client(&app, cfg, keys)?;
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
            hub: c.origin(),
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

/// Every note tagged `tag` in one request, with content and metadata: the Today view's areas,
/// briefs and Today note.
#[tauri::command]
async fn vault_query(
    app: tauri::AppHandle,
    vault: String,
    tag: String,
    include_content: Option<bool>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<serde_json::Value>, String> {
    with_vault(&app, move |c| {
        tauri::async_runtime::block_on(c.query_tagged_at(
            &vault,
            &tag,
            include_content.unwrap_or(true),
            limit.unwrap_or(100),
            offset.unwrap_or(0),
        ))
        .map_err(|e| e.to_string())
    })
    .await
}

/// Notes with `tag` filtered by indexed metadata (no content): a node's open tasks.
#[tauri::command]
async fn vault_query_meta(
    app: tauri::AppHandle,
    vault: String,
    tag: String,
    metadata: serde_json::Value,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<serde_json::Value>, String> {
    with_vault(&app, move |c| {
        tauri::async_runtime::block_on(c.query_by_metadata_at(&vault, &tag, metadata, limit.unwrap_or(200), offset.unwrap_or(0)))
            .map_err(|e| e.to_string())
    })
    .await
}

/// The `node` notes at or under one node path, in one request (the vault walks `parent` links).
#[tauri::command]
async fn vault_subtree_nodes(
    app: tauri::AppHandle,
    vault: String,
    root: String,
) -> Result<Vec<serde_json::Value>, String> {
    with_vault(&app, move |c| {
        tauri::async_runtime::block_on(c.query_subtree_nodes(&vault, &root)).map_err(|e| e.to_string())
    })
    .await
}

/// Live `task`/`decision` notes on one node or beneath it, in one request (`near` + `then`).
#[tauri::command]
async fn vault_subtree_tasks(
    app: tauri::AppHandle,
    vault: String,
    tag: String,
    root: String,
    states: Vec<String>,
    limit: Option<usize>,
) -> Result<Vec<serde_json::Value>, String> {
    with_vault(&app, move |c| {
        tauri::async_runtime::block_on(c.query_subtree_tasks(&vault, &tag, &root, &states, limit.unwrap_or(200)))
            .map_err(|e| e.to_string())
    })
    .await
}

/// Atomic compare-and-set of a note's `state`, guarded by the revision the user saw (`if_updated_at`, r16). The field is
/// fixed here; the webview cannot pick another.
#[tauri::command]
async fn vault_transition(
    app: tauri::AppHandle,
    vault: String,
    id: String,
    from: serde_json::Value,
    to: serde_json::Value,
    if_updated_at: String,
    metadata: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    with_vault(&app, move |c| {
        tauri::async_runtime::block_on(c.transition_note_with(&vault, &id, "state", from, to, &if_updated_at, metadata))
            .map_err(|e| e.to_string())
    })
    .await
}

/// The running app's version (r14): Settings reads it here when the app plugin's `getVersion` can't answer.
#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Decide an open decision: the `state` compare-and-set and the `decided*` metadata in one update, guarded by the revision whose
/// question was shown (`if_updated_at`). The client refuses any other key or note.
#[tauri::command]
async fn vault_decide(
    app: tauri::AppHandle,
    vault: String,
    id: String,
    from: serde_json::Value,
    to: serde_json::Value,
    metadata: serde_json::Value,
    if_updated_at: String,
) -> Result<serde_json::Value, String> {
    with_vault(&app, move |c| {
        tauri::async_runtime::block_on(c.decide_note(&vault, &id, from, to, metadata, &if_updated_at))
            .map_err(|e| e.to_string())
    })
    .await
}

/// T-212: one tap on a decision card in the chat. The vault's compare-and-set (`state` open -> decided) against the revision the card
/// showed (`if_updated_at`: a question changed since is refused, never answered blind);
/// `already_decided` (the stored answer, nothing written) when another tap or the room got there first. The card posts "Picked: …" in
/// the room only for `picked`.
#[tauri::command]
async fn vault_pick_decision(
    app: tauri::AppHandle,
    vault: Option<String>,
    id: String,
    option: String,
    by: String,
    at: String,
    if_updated_at: String,
    note: Option<String>,
) -> Result<uni_core::parachute::Pick, String> {
    let vault = vault
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| vault_config(&app).vault);
    with_vault(&app, move |c| {
        tauri::async_runtime::block_on(c.pick_decision(&vault, &id, &option, &by, &at, &if_updated_at, note.as_deref())).map_err(|e| e.to_string())
    })
    .await
}

/// T-226: Aaron's words on a decision with no pick: appended to its `notes`, the decision left open (re-read and appended again when
/// another write lands first). The card posts "Note on decision …" in the room only after this returns.
#[tauri::command]
async fn vault_note_decision(app: tauri::AppHandle, vault: Option<String>, id: String, text: String, by: String, at: String) -> Result<serde_json::Value, String> {
    let vault = vault
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| vault_config(&app).vault);
    with_vault(&app, move |c| tauri::async_runtime::block_on(c.note_decision(&vault, &id, &text, &by, &at)).map_err(|e| e.to_string())).await
}

/// Merge `snoozed_until` into a task or decision, guarded by `if_updated_at` (the client refuses any other key or note).
#[tauri::command]
async fn vault_patch_meta(
    app: tauri::AppHandle,
    vault: String,
    id: String,
    metadata: serde_json::Value,
    if_updated_at: String,
) -> Result<serde_json::Value, String> {
    with_vault(&app, move |c| {
        tauri::async_runtime::block_on(c.patch_metadata(&vault, &id, metadata, &if_updated_at))
            .map_err(|e| e.to_string())
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
#[cfg(all(debug_assertions, target_os = "linux"))]
mod t76;
#[cfg(mobile)]
mod mobile;
mod files;
#[cfg(any(target_os = "linux", target_os = "android"))]
mod media_loopback;
mod media_registry;
mod pair_source;
mod secure_store;


/// wry registers a `webkit.messageHandlers.ipc` script message handler in the default script world, which every
/// frame of the page sees, sandboxed `srcdoc` frames included. Tauri on Linux sends invokes through the `ipc://`
/// custom protocol (`scripts/ipc-protocol.js` in tauri); `window.ipc.postMessage` is only its fallback when that
/// fetch fails. Dropping the handler leaves the fetch path working and gives no frame anything to post to.
/// Proof: the sandbox self-test's `webkit.messageHandlers.ipc unreachable` check on the real webview (REPORT-T77).
///
/// Every window the app creates must call this. Today that is the config windows, covered by the loop in `setup`;
/// any `WebviewWindowBuilder`/`add_child` added later must call it on its window too. Failure is logged, not
/// fatal; the self-test pass is keyed on the wry/Tauri versions (`webview_runtime`) so a bump forces a re-run.
#[cfg(target_os = "linux")]
fn close_ipc_handler(window: &tauri::WebviewWindow) {
    use webkit2gtk::{UserContentManagerExt, WebViewExt};
    let label = window.label().to_string();
    let logged = label.clone();
    if let Err(err) = window.with_webview(move |webview| match webview.inner().user_content_manager() {
        Some(manager) => manager.unregister_script_message_handler("ipc"),
        None => tracing::warn!(window = %label, "close_ipc_handler: webview has no user content manager; ipc handler left registered"),
    }) {
        tracing::warn!(window = %logged, error = %err, "close_ipc_handler: with_webview failed; ipc handler left registered");
    }
}

/// The wry and Tauri versions in this build, part of the stored sandbox self-test pass key so a dependency bump
/// (which could move the ipc handler) forces a re-run. wry's version comes from `Cargo.lock` in build.rs.
#[tauri::command]
fn webview_runtime() -> String {
    format!("wry {} tauri {}", env!("UNI_WRY_VERSION"), tauri::VERSION)
}

/// WebRTC ignores CSP, so a sealed area app could send data out through an
/// ICE/TURN request. WebKitGTK ships with `enable-webrtc` off; this makes that
/// explicit so a build or distro default can't silently turn it on. The
/// in-app sandbox self-test (src/interface/selftest) is the proof, not this call.
#[cfg(target_os = "linux")]
fn disable_webrtc(app: &tauri::App) {
    use tauri::Manager;
    use webkit2gtk::{SettingsExt, WebViewExt};
    for (_, window) in app.webview_windows() {
        let _ = window.with_webview(|webview| {
            if let Some(settings) = webview.inner().settings() {
                settings.set_enable_webrtc(false);
                settings.set_enable_media_stream(false);
            }
        });
    }
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
        .plugin(files::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .register_asynchronous_uri_scheme_protocol("unimedia", media_protocol)
        .setup(|_app| {
            #[cfg(mobile)]
            _app.handle().plugin(tauri_plugin_barcode_scanner::init())?;
            // T-124 r22 (Codex 6): the app has no tabs, so macOS keeps its own menu: File and Window say "Close Window" (Cmd+W), which is what
            // Cmd+W does there. The custom "Close Tab" item is gone.
            #[cfg(desktop)]
            {
                _app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
                _app.handle().plugin(tauri_plugin_process::init())?;
                _app.handle().plugin(tauri_plugin_notification::init())?;
                _app.handle().plugin(tauri_plugin_dialog::init())?;
            }
            #[cfg(mobile)]
            mobile::setup(_app);
            #[cfg(all(debug_assertions, target_os = "linux"))]
            t76::replace_window(_app)?;
            #[cfg(target_os = "linux")]
            {
                disable_webrtc(_app);
                {
                    use tauri::Manager;
                    for (_, window) in _app.webview_windows() {
                        close_ipc_handler(&window);
                    }
                }
            }
            tracing::info!(version = %_app.package_info().version, "setup complete; opening window");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            #[cfg(all(debug_assertions, target_os = "linux"))]
            t76::t76_write,
            #[cfg(all(debug_assertions, target_os = "linux"))]
            t76::t76_read,
            webview_runtime,
            log_line,
            get_rooms,
            get_messages,
            approval_messages,
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
            secret_requesters,
            secret_request,
            secret_pin,
            send_secret,
            forget_secret,
            sealed_status,
            sealed_enroll,
            sealed_enrollment_line,
            sealed_card,
            sealed_answer,
            sealed_waiting,
            prepare_voice_message,
            mark_read,
            open_link,
            live_start,
            send_typing,
            live_stop,
            load_older,
            edit_message,
            delete_message,
            search,
            media_bytes,
            media_stream,
            media_pin,
            media_release,
            media_upload,
            voice_transcribe,
            media_save,
            media_open,
            note_download,
            note_share,
            relay_origin,
            cal_session,
            cal_events,
            cal_event,
            cal_conflicts,
            cal_op,
            mail_overview,
            mail_threads,
            mail_thread,
            mail_triage,
            mail_attachment_open,
            mail_mark_seen,
            mail_flag,
            mail_archive,
            mail_draft_save,
            mail_draft_review,
            mail_draft_discard,
            mail_send,
            mail_send_as_uni,
            mail_send_check,
            mail_parked,
            mail_send_approve,
            mail_send_decline,
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
            vault_query,
            vault_query_meta,
            vault_subtree_nodes,
            vault_subtree_tasks,
            vault_transition,
            vault_patch_meta,
            vault_decide,
            vault_pick_decision,
            vault_note_decision,
            app_version,
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

#[cfg(test)]
mod send_gate_tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// Both tests lock the process-wide gates; run in parallel, one holds `SEND_GATE` for 100 ms and the other's timing fails. They take turns.
    static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// r26 (Codex P1 3): the first sync holds `IO_GATE` for its whole run; a send must not wait for it.
    #[tokio::test]
    async fn a_send_does_not_wait_behind_the_sync() {
        let _serial = SERIAL.lock().await;
        let sync = IO_GATE.lock().await; // a cold sync in progress
        let t = Instant::now();
        let got = tokio::time::timeout(Duration::from_millis(500), SEND_GATE.lock()).await;
        assert!(got.is_ok(), "the send path waited for the sync's gate");
        assert!(t.elapsed() < Duration::from_millis(100));
        drop(got);
        drop(sync);
    }

    /// Sends, edits and deletes still keep their own order.
    #[tokio::test]
    async fn sends_wait_for_each_other() {
        let _serial = SERIAL.lock().await;
        let first = SEND_GATE.lock().await;
        let second = tokio::time::timeout(Duration::from_millis(100), SEND_GATE.lock()).await;
        assert!(second.is_err(), "two sends ran at once");
        drop(first);
        assert!(tokio::time::timeout(Duration::from_millis(500), SEND_GATE.lock()).await.is_ok());
    }
}

#[cfg(test)]
mod media_open_tests {
    use super::*;

    fn dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("unimedia-open-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Codex review 2: a cached file must not satisfy an attachment whose `imeta` `x` names another hash.
    #[test]
    fn a_cache_hit_still_checks_the_imeta_hash() {
        let d = dir();
        let data = b"cached file".to_vec();
        let sha = uni_core::media::sha256_hex(&data);
        std::fs::write(d.join(&sha), &data).unwrap();
        let max = uni_core::media::MAX_STREAM_MEDIA_BYTES;
        let err = cached_attachment(&d, &sha, Some(&"f".repeat(64)), max).unwrap_err();
        assert!(err.contains("imeta hash does not match"), "{err}");
        assert_eq!(cached_attachment(&d, &sha, Some(&sha.to_uppercase()), max).unwrap(), Some(d.join(&sha)));
        assert_eq!(cached_attachment(&d, &sha, None, max).unwrap(), Some(d.join(&sha)));
        let _ = std::fs::remove_dir_all(&d);
    }

    fn cached(d: &std::path::Path, data: &[u8]) -> String {
        let sha = uni_core::media::sha256_hex(data);
        std::fs::write(d.join(&sha), data).unwrap();
        sha
    }

    fn leftovers(d: &std::path::Path) -> Vec<String> {
        std::fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(".part")).collect()
    }

    /// Codex T-174 review 1: a copy of the right length but the wrong bytes is not handed to the viewer.
    #[test]
    fn a_same_length_corrupt_copy_is_replaced() {
        let (d, reg) = (dir(), std::sync::Mutex::new(media_registry::Registry::default()));
        let data = b"the real attachment".to_vec();
        let sha = cached(&d, &data);
        std::fs::write(d.join(format!("{sha}.pdf")), vec![b'x'; data.len()]).unwrap();
        let (target, _) = pinned_copy(&reg, &d, &sha, "pdf").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), data);
        assert!(leftovers(&d).is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Codex T-174 review 1: bytes that don't hash to the name are never published, and nothing is left behind.
    #[test]
    fn a_copy_that_fails_its_hash_is_not_published() {
        let (d, reg) = (dir(), std::sync::Mutex::new(media_registry::Registry::default()));
        let sha = cached(&d, b"verified when fetched");
        std::fs::write(d.join(&sha), b"changed on disk since").unwrap();
        let err = pinned_copy(&reg, &d, &sha, "pdf").unwrap_err();
        assert!(err.contains("integrity"), "{err}");
        assert!(!d.join(format!("{sha}.pdf")).exists());
        assert!(leftovers(&d).is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Codex T-174 review 1: a viewer already reading an earlier copy keeps reading it whole; a new copy is a new
    /// file put in its place, never the same file truncated and rewritten.
    #[cfg(unix)]
    #[test]
    fn a_new_copy_replaces_the_file_instead_of_rewriting_it() {
        use std::io::Read as _;
        use std::os::unix::fs::MetadataExt as _;
        let (d, reg) = (dir(), std::sync::Mutex::new(media_registry::Registry::default()));
        let data = vec![7u8; 4096];
        let sha = cached(&d, &data);
        let target = d.join(format!("{sha}.mp4"));
        std::fs::write(&target, b"an older, different copy").unwrap();
        let mut viewer = std::fs::File::open(&target).unwrap();
        pinned_copy(&reg, &d, &sha, "mp4").unwrap();
        assert_ne!(viewer.metadata().unwrap().ino(), std::fs::metadata(&target).unwrap().ino());
        let mut seen = Vec::new();
        viewer.read_to_end(&mut seen).unwrap();
        assert_eq!(seen, b"an older, different copy");
        assert_eq!(std::fs::read(&target).unwrap(), data);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Codex T-174 review 1: two Opens of the same file at once: one writes the copy, the other waits and reuses it.
    #[test]
    fn concurrent_opens_write_the_copy_once() {
        let d = dir();
        let data: Vec<u8> = (0..24 * 1024 * 1024u32).map(|i| (i % 251) as u8).collect();
        let sha = cached(&d, &data);
        let name = format!("{sha}.mp4");
        let start = std::sync::Barrier::new(2);
        let copies: Vec<bool> = std::thread::scope(|s| {
            let runs: Vec<_> = (0..2).map(|_| s.spawn(|| { start.wait(); prepare_open_copy(&d, &sha, &name).unwrap() })).collect();
            runs.into_iter().map(|r| r.join().unwrap()).collect()
        });
        assert_eq!(copies.iter().filter(|c| **c).count(), 1, "{copies:?}");
        assert!(std::fs::read(d.join(&name)).unwrap() == data);
        assert!(leftovers(&d).is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Codex review 2: another download's prune runs while Open's copy is being handed to the OS.
    #[test]
    fn the_opened_copy_survives_a_prune_until_released() {
        let (d, reg) = (dir(), std::sync::Mutex::new(media_registry::Registry::default()));
        // The cache file holds what its name says (Open now checks; T-174 review 1).
        let sha = cached(&d, &[1u8; 64]);
        let (target, name) = pinned_copy(&reg, &d, &sha, "pdf").unwrap();
        assert_eq!(target, d.join(format!("{sha}.pdf")));
        media_registry::lock(&reg).prune(&d, 0); // a concurrent download, cache over budget
        assert!(target.exists(), "the copy was pruned before the viewer could open it");
        media_registry::lock(&reg).release(&name); // the grace period is over
        media_registry::lock(&reg).prune(&d, 0);
        assert!(!target.exists());
        let _ = std::fs::remove_dir_all(&d);
    }
}

#[cfg(test)]
mod media_stream_tests {
    use super::stream_mime;

    #[test]
    fn only_audio_and_video_are_streamed() {
        let u = "https://r/media/abc.mp4";
        assert_eq!(stream_mime(Some("video/mp4"), u).as_deref(), Some("video/mp4"));
        assert_eq!(stream_mime(Some("Audio/MPEG"), u).as_deref(), Some("audio/mpeg"));
        assert_eq!(stream_mime(None, u).as_deref(), Some("video/mp4"));
        assert_eq!(stream_mime(Some(""), "https://r/media/abc.M4A").as_deref(), Some("audio/mp4"));
        assert_eq!(stream_mime(Some("audio/ogg; codecs=opus"), u).as_deref(), Some("audio/ogg"));
        assert_eq!(stream_mime(Some("text/html; x=video/mp4"), u), None);
        // A declared non-media type wins over the extension; header-unsafe values are refused.
        assert_eq!(stream_mime(Some("text/html"), u), None);
        assert_eq!(stream_mime(Some("video/mp4\r\nX-Evil: 1"), u), None);
        assert_eq!(stream_mime(None, "https://r/media/abc.html"), None);
        assert_eq!(stream_mime(None, "https://r/media/abc"), None);
    }
}
