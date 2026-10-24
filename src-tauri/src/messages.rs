//! T-278 Messages (prototype, behind the `messages` feature): the app's door to `uni-messages`, one Matrix account
//! on this device. Each command is a one-line call into the same core the dev bridge serves to the browser tests;
//! updates go to the webview as the `messages://update` event. Tokens and keys stay in Rust.
//!
//! The store and the saved account (one record: session, store name, store key) live under the app's data folder, the
//! record in a 0600 file; moving it into the OS keychain and Android Keystore, as the device key is kept, is the next
//! step (T-278 DESIGN.md).

use std::sync::Arc;

use tauri::{Emitter, Manager, Runtime, State};
use uni_messages::{FileSecrets, LinkRow, MessageRow, Messages, MessagesError, RoomRow, Status};

pub struct MessagesState(Arc<Messages>);

/// Make the account's door and forward its updates to the webview.
pub fn setup<R: Runtime>(app: &tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?.join("messages");
    let messages = Messages::new(dir.join("data"), Arc::new(FileSecrets::new(dir.join("secrets"))));
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
