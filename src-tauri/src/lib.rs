//! Shared Tauri conversation bridge. Signing and relay I/O remain in Rust.
use serde::Serialize;
use std::path::PathBuf;
use tauri::Manager;
use uni_core::{send_message, sync_once, ConversationMessage, Store};

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
}

#[derive(Serialize)]
struct RoomView {
    id: String,
    name: String,
    last_message: Option<String>,
    last_ts: Option<i64>,
    mentions: bool,
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
    Ok(MessageView {
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
    })
}

#[tauri::command]
fn get_rooms(app: tauri::AppHandle) -> Result<Vec<RoomView>, String> {
    let store = Store::open(db_path(&app)?).map_err(|e| e.to_string())?;
    store
        .rooms()
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
            })
        })
        .collect()
}

#[tauri::command]
fn get_messages(
    app: tauri::AppHandle,
    channel: String,
    root: Option<String>,
) -> Result<Vec<MessageView>, String> {
    let store = Store::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let rows = match root {
        Some(id) => store.thread_messages(&channel, &id, 300),
        None => store.room_messages(&channel, 300),
    }
    .map_err(|e| e.to_string())?;
    rows.into_iter().map(|m| view(&store, m)).collect()
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
        view(&store, message)
    })
    .await
    .map_err(|e| e.to_string())?
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
        .setup(|_app| {
            #[cfg(mobile)]
            mobile::setup(_app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_rooms,
            get_messages,
            get_identity,
            identity_status,
            identity_forget,
            pairing_start,
            pairing_confirm,
            pairing_cancel,
            refresh,
            post_message
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
