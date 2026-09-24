//! Shared Tauri conversation bridge. Signing and relay I/O remain in Rust.
use serde::Serialize;
use std::{path::PathBuf, sync::Mutex};
use tauri::Manager;
use uni_core::{send_message, sync_once, ConversationMessage, Store};

// Serialize foreground refresh and send so SQLite and relay watermarks cannot race.
static IO_GATE: Mutex<()> = Mutex::new(());

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

fn relay_url() -> String {
    std::env::var("UNI_RELAY_URL").unwrap_or_else(|_| "wss://buzz.unforced.org".into())
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
fn get_identity() -> Result<String, String> {
    uni_core::load_keys(false)
        .map(|(keys, _)| keys.public_key().to_hex())
        .map_err(|e| e.to_string())
}

// SQLite Connection is !Send. Run the entire async core operation inside the
// blocking task, with its own runtime context, then return only Send data.
#[tauri::command]
async fn refresh(app: tauri::AppHandle) -> Result<SyncView, String> {
    let path = db_path(&app)?;
    let url = relay_url();
    tauri::async_runtime::spawn_blocking(move || {
        let _gate = IO_GATE.lock().map_err(|e| e.to_string())?;
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
    let path = db_path(&app)?;
    let url = relay_url();
    tauri::async_runtime::spawn_blocking(move || {
        let _gate = IO_GATE.lock().map_err(|e| e.to_string())?;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(mobile)]
    mobile::init_runtime();
    uni_core::init_crypto();
    tauri::Builder::default()
        .setup(|_app| {
            #[cfg(mobile)]
            mobile::setup(_app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_rooms,
            get_messages,
            get_identity,
            refresh,
            post_message
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
