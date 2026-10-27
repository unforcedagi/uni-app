//! T-278 Messages (prototype, behind the `messages` feature): the app's door to `uni-messages`, one Matrix account
//! on this device. Each command is a one-line call into the same core the dev bridge serves to the browser tests;
//! updates go to the webview as the `messages://update` event. Tokens and keys stay in Rust.
//!
//! The store and the saved account (one record: session, store name, store key) live under the app's data folder, the
//! record in a 0600 file; moving it into the OS keychain and Android Keystore, as the device key is kept, is the next
//! step (T-278 DESIGN.md).

use std::sync::Arc;

use tauri::{Emitter, Manager, State};
use uni_messages::{FileSecrets, LinkRow, MessageRow, Messages, MessagesError, RoomRow, Status, Transcriber, Transcribing, Transcript};

pub struct MessagesState(Arc<Messages>);

/// T-313: voice messages are transcribed where Buzz's are: uni-transcribe on the hub's host (faster-whisper), reached
/// with the device key (NIP-98), so no token lives here and the audio goes nowhere but the owner's own box.
struct HubTranscriber(tauri::AppHandle);

impl Transcriber for HubTranscriber {
    fn transcribe(&self, audio: Vec<u8>, mime: String) -> Transcribing {
        let app = self.0.clone();
        Box::pin(async move { crate::transcribe_audio(&app, audio, mime).await.map(|t| t.text) })
    }
}

/// An attachment being opened is written, decrypted, into the media cache (the one folder Android's FileProvider shares
/// with a viewer, files.rs), as `msg-<random>-<name>`: pinned against the cache's pruning while a viewer may still read it,
/// removed after `OPENED_FOR`, and any left by an earlier run removed at the next start.
const OPENED_PREFIX: &str = "msg-";
const OPENED_FOR: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// Make the account's door and forward its updates to the webview.
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?.join("messages");
    let messages = Messages::new(dir.join("data"), Arc::new(FileSecrets::new(dir.join("secrets"))));
    messages.set_transcriber(Arc::new(HubTranscriber(app.handle().clone())));
    if let Ok(dir) = crate::media_cache_dir(app.handle()) {
        // what earlier runs opened: their viewers are long done with it
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            if e.file_name().to_string_lossy().starts_with(OPENED_PREFIX) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    let mut rx = messages.subscribe();
    let handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        use tokio::sync::broadcast::error::RecvError;
        loop {
            match rx.recv().await {
                Ok(update) => {
                    let _ = handle.emit("messages://update", &update);
                }
                // a missed update is made good by the next one: each carries the whole list or room
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            }
        }
    });
    app.manage(MessagesState(messages));
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn an_attachment_name_stays_one_plain_file() {
        use super::disk_name;
        assert_eq!(disk_name("voice note.ogg"), "voice note.ogg");
        assert_eq!(disk_name("../../.bashrc"), "bashrc");
        assert_eq!(disk_name("a/b\\c:d.pdf"), "abcd.pdf");
        assert_eq!(disk_name("..."), "attachment");
        assert_eq!(disk_name("\u{0}\n"), "attachment");
        assert_eq!(disk_name(&"x".repeat(300)).len(), 100);
    }
}

#[tauri::command]
pub async fn messages_status(s: State<'_, MessagesState>) -> Result<Status, MessagesError> {
    s.0.resume().await
}

#[tauri::command]
pub async fn messages_sign_in(s: State<'_, MessagesState>, homeserver: String, user: String, password: String) -> Result<Status, MessagesError> {
    s.0.sign_in(&homeserver, &user, &password).await
}

#[tauri::command]
pub async fn messages_sign_out(s: State<'_, MessagesState>) -> Result<Status, MessagesError> {
    s.0.sign_out().await
}

#[tauri::command]
pub async fn messages_rooms(s: State<'_, MessagesState>) -> Result<Vec<RoomRow>, MessagesError> {
    s.0.rooms().await
}

#[tauri::command]
pub async fn messages_open(s: State<'_, MessagesState>, room_id: String) -> Result<Vec<MessageRow>, MessagesError> {
    s.0.open(&room_id).await
}

#[tauri::command]
pub async fn messages_close(s: State<'_, MessagesState>, room_id: String) -> Result<(), MessagesError> {
    s.0.close(&room_id).await
}

#[tauri::command]
pub async fn messages_send(s: State<'_, MessagesState>, room_id: String, body: String) -> Result<(), MessagesError> {
    s.0.send(&room_id, &body).await
}

#[tauri::command]
pub async fn messages_join(s: State<'_, MessagesState>, room_id: String) -> Result<(), MessagesError> {
    s.0.join(&room_id).await
}

#[tauri::command]
pub async fn messages_older(s: State<'_, MessagesState>, room_id: String) -> Result<bool, MessagesError> {
    s.0.older(&room_id).await
}

#[tauri::command]
pub async fn messages_read(s: State<'_, MessagesState>, room_id: String) -> Result<(), MessagesError> {
    s.0.read(&room_id).await
}

// ── Attachments (T-313): fetched by the core through the homeserver's authenticated media, decrypted in Rust ──

/// An attachment's bytes, as raw IPC (an `ArrayBuffer` in the webview, which plays or shows it from memory).
#[tauri::command]
pub async fn messages_media(s: State<'_, MessagesState>, room_id: String, event_id: String) -> Result<tauri::ipc::Response, MessagesError> {
    Ok(tauri::ipc::Response::new(s.0.media(&room_id, &event_id).await?.bytes))
}

/// A voice message's words, transcribed once on the owner's box and kept in the account's encrypted store.
#[tauri::command]
pub async fn messages_transcript(s: State<'_, MessagesState>, room_id: String, event_id: String) -> Result<Transcript, MessagesError> {
    s.0.transcript(&room_id, &event_id).await
}

/// A file name for the disk: the event's name with anything a path could use removed, never hidden, never empty.
fn disk_name(name: &str) -> String {
    let clean: String = name.chars().filter(|c| !c.is_control() && !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')).collect();
    let clean = clean.trim().trim_start_matches('.').trim();
    let clean: String = clean.chars().take(100).collect();
    if clean.is_empty() { "attachment".into() } else { clean }
}

/// Open an attachment in the app the system picks for its type: written, decrypted, into the media cache (the core's
/// `write_copy`, which removes it when the account ends and never hands over one finished after), handed over
/// (desktop: the default app; Android: a content:// URI, see files.rs), and removed after `OPENED_FOR`.
#[tauri::command]
pub async fn messages_open_file(app: tauri::AppHandle, s: State<'_, MessagesState>, room_id: String, event_id: String) -> Result<(), MessagesError> {
    use crate::media_registry::{lock, MEDIA};
    let fail = |message: String| MessagesError::Server { message };
    let dir = crate::media_cache_dir(&app).map_err(fail)?;
    // the event's file name, made one plain name, after a prefix of this open's own
    let media = s.0.media_info(&room_id, &event_id).await?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let name = format!("{OPENED_PREFIX}{}-{}", &id[..12], disk_name(&media.name));
    let named = dir.join(&name);
    // pinned against the media cache's pruning for as long as a viewer may read it
    lock(&MEDIA).pin(&name);
    let release = {
        let messages = s.0.clone();
        move |file: &std::path::Path| {
            messages.drop_copy(file);
            lock(&MEDIA).release(&name);
        }
    };
    let mime = match s.0.write_copy(&room_id, &event_id, &named).await {
        Ok(m) => m,
        Err(e) => {
            release(&named);
            return Err(e);
        }
    };
    let opened = crate::files::open(&app, &named, Some(mime.as_str())).await.map_err(fail);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(OPENED_FOR).await;
        release(&named);
    });
    opened
}

// ── Linking accounts (T-282): the bridge bots' logins, read as steps (uni-messages link.rs) ──

#[tauri::command]
pub async fn messages_links(s: State<'_, MessagesState>) -> Result<Vec<LinkRow>, MessagesError> {
    s.0.links().await
}

#[tauri::command]
pub async fn messages_link_check(s: State<'_, MessagesState>, network: String) -> Result<LinkRow, MessagesError> {
    s.0.link_check(&network).await
}

#[tauri::command]
pub async fn messages_link_start(s: State<'_, MessagesState>, network: String, flow: Option<String>, relogin: Option<String>) -> Result<LinkRow, MessagesError> {
    s.0.link_start(&network, flow.as_deref(), relogin.as_deref()).await
}

#[tauri::command]
pub async fn messages_link_send(s: State<'_, MessagesState>, network: String, value: String) -> Result<LinkRow, MessagesError> {
    s.0.link_send(&network, &value).await
}

#[tauri::command]
pub async fn messages_link_cancel(s: State<'_, MessagesState>, network: String) -> Result<LinkRow, MessagesError> {
    s.0.link_cancel(&network).await
}

// ── Signing in with this device (T-282): the Matrix door on the hub's host trades a NIP-98 signature by the device
// key for a one-time login token, so no Matrix password reaches the device. ──

fn door_err(e: uni_core::matrix_door::DoorError) -> MessagesError {
    use uni_core::matrix_door::DoorError;
    match e {
        DoorError::Unreachable(message) => MessagesError::Unreachable { message },
        DoorError::Refused(message) => MessagesError::Refused { message },
        DoorError::Failed(message) => MessagesError::Server { message },
    }
}

/// The door's origins for this app's hub, and the device key to sign with.
async fn door(app: &tauri::AppHandle) -> Result<(String, Option<String>, nostr::Keys), MessagesError> {
    let invalid = |message: String| MessagesError::Invalid { message };
    crate::secure_store::ensure_loaded(app).await.map_err(invalid)?;
    let hub = crate::vault_config(app).hub;
    let (base, alias) = uni_core::matrix_door::door_urls(&hub).ok_or_else(|| invalid(format!("no Matrix door for the hub {hub} (it must be https)")))?;
    let keys = tauri::async_runtime::spawn_blocking(|| uni_core::load_keys(false).map(|(k, _)| k))
        .await
        .map_err(|e| invalid(e.to_string()))?
        .map_err(|e| MessagesError::Refused { message: format!("This device has no key to sign in with yet: pair it first ({e}).") })?;
    Ok((base, alias, keys))
}

#[tauri::command]
pub async fn messages_sign_in_device(app: tauri::AppHandle, s: State<'_, MessagesState>) -> Result<Status, MessagesError> {
    let (base, alias, keys) = door(&app).await?;
    let login = uni_core::matrix_door::login(&base, alias.as_deref(), &keys).await.map_err(door_err)?;
    s.0.sign_in_token(&login.homeserver, &login.login_token).await
}

#[tauri::command]
pub async fn messages_telegram_keys(app: tauri::AppHandle, api_id: String, api_hash: String) -> Result<(), MessagesError> {
    let (base, alias, keys) = door(&app).await?;
    uni_core::matrix_door::telegram_keys(&base, alias.as_deref(), &keys, &api_id, &api_hash).await.map_err(door_err)
}
