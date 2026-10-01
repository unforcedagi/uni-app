//! Single source session actor: cancellation never waits behind socket I/O.
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::{mpsc, oneshot, watch, Mutex};
use uni_core::pairing_source::PendingSource;

struct Control {
    id: String,
    cancel: watch::Sender<Option<bool>>,
    commands: mpsc::Sender<Request>,
}
enum Request {
    Offer(oneshot::Sender<Result<String, String>>),
    Confirm(oneshot::Sender<Result<(), String>>),
}
static UNLOCK: Mutex<()> = Mutex::const_new(());
static SOURCE: Mutex<Option<Arc<Control>>> = Mutex::const_new(None);

#[derive(serde::Serialize)]
pub struct Started {
    uri: String,
    qr_svg: String,
    expires_in_ms: u64,
}
#[derive(serde::Serialize)]
pub struct Offer {
    sas: String,
}

#[tauri::command]
pub fn pair_source_available() -> bool {
    if cfg!(any(target_os = "macos", target_os = "android")) {
        return true;
    }
    #[cfg(debug_assertions)]
    if std::env::var("UNI_PAIR_NO_UNLOCK").as_deref() == Ok("1") {
        return true;
    }
    false
}

async fn current(id: &str) -> Result<Arc<Control>, String> {
    SOURCE
        .lock()
        .await
        .as_ref()
        .filter(|c| c.id == id)
        .cloned()
        .ok_or_else(|| "pairing session closed or replaced".into())
}
async fn clear(id: &str) {
    let mut slot = SOURCE.lock().await;
    if slot.as_ref().is_some_and(|c| c.id == id) {
        *slot = None;
    }
}

#[tauri::command]
pub async fn pair_source_start(app: AppHandle, session_id: String) -> Result<Started, String> {
    // IDs fence every command, including cancel while the unlock dialog is open.
    uuid::Uuid::parse_str(&session_id).map_err(|_| "invalid pairing session id")?;
    let (cancel, mut cancelled) = watch::channel(None);
    let (commands, receiver) = mpsc::channel(4);
    let control = Arc::new(Control {
        id: session_id.clone(),
        cancel,
        commands,
    });
    {
        let mut slot = SOURCE.lock().await;
        if let Some(old) = slot.replace(control) {
            let _ = old.cancel.send(Some(false));
        }
    }
    // Serialize native prompts; replacing a session first cancels the old prompt.
    let gate = tokio::select! {
        biased;
        _ = cancelled.changed() => { clear(&session_id).await; return Err("pairing cancelled".into()); },
        gate = UNLOCK.lock() => gate,
    };
    // Keep the gate alive until it has dismissed its native prompt on cancellation.
    if let Err(error) =
        crate::secure_store::authenticate(&app, &session_id, cancelled.clone()).await
    {
        clear(&session_id).await;
        return Err(error);
    }
    drop(gate);
    if cancelled.borrow().is_some() {
        clear(&session_id).await;
        return Err("pairing cancelled".into());
    }
    let deadline = tokio::time::Instant::now() + uni_core::pairing::SESSION_TIMEOUT;
    let setup = async {
        let relay = crate::relay_url(&app);
        let http = uni_core::pairing_source::relay_http_base(&relay).map_err(|e| e.to_string())?;
        let pairing = uni_core::pairing_source::resolve_pairing_relay(&relay).await;
        let pending = uni_core::pairing_source::start_source(&pairing)
            .await
            .map_err(|e| e.to_string())?;
        let code = qrcode::QrCode::with_error_correction_level(
            pending.uri().as_bytes(),
            qrcode::EcLevel::M,
        )
        .map_err(|_| "could not render pairing QR")?;
        let started = Started {
            uri: pending.uri().into(),
            qr_svg: code
                .render::<qrcode::render::svg::Color>()
                .min_dimensions(384, 384)
                .quiet_zone(true)
                .build(),
            expires_in_ms: deadline
                .saturating_duration_since(tokio::time::Instant::now())
                .as_millis() as u64,
        };
        Ok::<_, String>((pending, started, deadline, http))
    };
    let result = tokio::select! {
        biased;
        _ = cancelled.changed() => Err("pairing cancelled".into()),
        result = tokio::time::timeout_at(deadline, setup) => result.map_err(|_| "pairing expired".to_string()).and_then(|r| r),
    };
    match result {
        Ok((pending, started, deadline, http)) => {
            // A replaced start may not install itself over its successor.
            if current(&session_id).await.is_err() {
                let _ = pending.cancel(false).await;
                return Err("pairing replaced".into());
            }
            tauri::async_runtime::spawn(run(
                app, session_id, pending, receiver, cancelled, deadline, http,
            ));
            Ok(started)
        }
        Err(error) => {
            clear(&session_id).await;
            Err(error)
        }
    }
}

async fn run(
    app: AppHandle,
    id: String,
    mut pending: PendingSource,
    mut requests: mpsc::Receiver<Request>,
    mut cancelled: watch::Receiver<Option<bool>>,
    deadline: tokio::time::Instant,
    http: String,
) {
    let mut offered = false;
    let work = async {
        while let Some(request) = requests.recv().await {
            match request {
                Request::Offer(reply) => {
                    let result = pending.wait_offer().await.map_err(|e| e.to_string());
                    offered = result.is_ok();
                    let failed = result.is_err();
                    let _ = reply.send(result);
                    if failed {
                        break;
                    }
                }
                Request::Confirm(reply) => {
                    if !offered {
                        let _ = reply.send(Err("compare the codes before confirming".into()));
                        continue;
                    }
                    let result = async {
                        crate::secure_store::ensure_loaded(&app).await?;
                        let (keys, _) = uni_core::load_keys(false).map_err(|e| e.to_string())?;
                        pending
                            .send_confirmed(&keys, &http)
                            .await
                            .map_err(|e| e.to_string())
                    }
                    .await;
                    let _ = reply.send(result);
                    break;
                }
            }
        }
    };
    tokio::select! {
        biased;
        _ = cancelled.changed() => {},
        _ = tokio::time::sleep_until(deadline) => {},
        _ = work => {},
    }
    let codes_differ = cancelled.borrow().unwrap_or(false);
    let _ = pending.cancel(codes_differ).await;
    clear(&id).await;
}

#[tauri::command]
pub async fn pair_source_wait_offer(session_id: String) -> Result<Offer, String> {
    let control = current(&session_id).await?;
    let (reply, receive) = oneshot::channel();
    control
        .commands
        .send(Request::Offer(reply))
        .await
        .map_err(|_| "pairing closed")?;
    let sas = receive
        .await
        .map_err(|_| "pairing cancelled or expired")??;
    current(&session_id).await?;
    Ok(Offer { sas })
}
#[tauri::command]
pub async fn pair_source_confirm(session_id: String) -> Result<(), String> {
    let control = current(&session_id).await?;
    let (reply, receive) = oneshot::channel();
    control
        .commands
        .send(Request::Confirm(reply))
        .await
        .map_err(|_| "pairing closed")?;
    receive.await.map_err(|_| "pairing cancelled or expired")?
}
#[tauri::command]
pub async fn pair_source_cancel(session_id: String, codes_differ: bool) -> Result<(), String> {
    if let Ok(control) = current(&session_id).await {
        let _ = control.cancel.send(Some(codes_differ));
    }
    clear(&session_id).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stale_generation_cannot_address_or_clear_successor() {
        let (cancel, mut cancelled) = watch::channel(None);
        let (commands, _receiver) = mpsc::channel(1);
        let old = Arc::new(Control {
            id: "old".into(),
            cancel,
            commands,
        });
        *SOURCE.lock().await = Some(old.clone());
        assert!(current("old").await.is_ok());
        let (cancel, _cancelled) = watch::channel(None);
        let (commands, _receiver) = mpsc::channel(1);
        *SOURCE.lock().await = Some(Arc::new(Control {
            id: "new".into(),
            cancel,
            commands,
        }));
        old.cancel.send(Some(true)).unwrap();
        cancelled.changed().await.unwrap();
        assert_eq!(*cancelled.borrow(), Some(true));
        assert!(current("old").await.is_err());
        clear("old").await;
        assert!(current("new").await.is_ok());
        pair_source_cancel("old".into(), false).await.unwrap();
        assert!(current("new").await.is_ok());
        clear("new").await;
    }
}
