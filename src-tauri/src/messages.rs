//! T-278 Messages (prototype, behind the `messages` feature): the app's door to `uni-messages`, one Matrix account
//! on this device. Each command is a one-line call into the same core the dev bridge serves to the browser tests;
//! updates go to the webview as the `messages://update` event. Tokens and keys stay in Rust.
//!
//! The store and the saved account (one record: session, store name, store key) live under the app's data folder, the
//! record in a 0600 file; moving it into the OS keychain and Android Keystore, as the device key is kept, is the next
//! step (T-278 DESIGN.md).

use std::sync::Arc;

use tauri::{Emitter, Manager, Runtime, State};
use uni_messages::{FileSecrets, MessageRow, Messages, MessagesError, RoomRow, Status};

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
