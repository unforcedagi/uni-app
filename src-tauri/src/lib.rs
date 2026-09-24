//! Uni desktop shell — Tauri 2 backend.
//!
//! Exposes `get_timeline(limit)` to the React frontend, returning the newest
//! items from the synced SQLite store plus resolved channel + author names.

use serde::Serialize;
use std::path::PathBuf;
use tauri::Manager;
use uni_core::Store;

#[derive(Serialize, Clone)]
#[serde(rename_all = "snake_case")]
struct TimelineItem {
    source: String,
    #[serde(rename = "ref")]
    r#ref: String,
    channel: String,
    author: String,
    author_name: String,
    channel_name: String,
    ts: i64,
    body: String,
    mentions_me: bool,
}

/// Resolve the database path used by the app.
///
/// Tauri sets `app_data_dir()` to e.g. `~/Library/Application Support/uni-app-tauri`
/// on macOS. The database lives there as `uni.db`.
fn db_path(app: &tauri::AppHandle) -> PathBuf {
    let mut dir = app.path().app_data_dir().expect("app data dir");
    std::fs::create_dir_all(&dir).ok();
    dir.push("uni.db");
    dir
}

#[tauri::command]
fn get_timeline(app: tauri::AppHandle, limit: usize) -> Result<Vec<TimelineItem>, String> {
    let path = db_path(&app);
    let store = Store::open(&path).map_err(|e| format!("open store: {e}"))?;
    let items = store
        .timeline(limit)
        .map_err(|e| format!("query timeline: {e}"))?;

    let mut out = Vec::with_capacity(items.len());
    for it in items {
        let author_name = store
            .display_name(&it.author)
            .unwrap_or_else(|_| it.author[..8.min(it.author.len())].to_string());
        let channel_name = store
            .channel_name(&it.channel)
            .unwrap_or(None)
            .unwrap_or_default();
        out.push(TimelineItem {
            source: it.source,
            r#ref: it.r#ref,
            channel: it.channel,
            author: it.author,
            author_name,
            channel_name,
            ts: it.ts,
            body: it.body,
            mentions_me: it.mentions_me,
        });
    }
    Ok(out)
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
        .invoke_handler(tauri::generate_handler![get_timeline])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
