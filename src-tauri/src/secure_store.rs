//! Where this device keeps the account key.
//!
//! - Android: the in-app `KeystorePlugin` (Kotlin, gen/android/.../KeystorePlugin.kt)
//!   encrypts it with a non-exportable AES-256-GCM key in Android Keystore
//!   (alias `uni_identity`); only ciphertext + IV are written, to private prefs.
//! - Desktop: the OS keyring via `uni_core::identity` (service `uni-app`).
//!
//! In both cases the decrypted key is handed to `uni_core` in memory with
//! `set_device_keys`, never through env vars or files, and never logged.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Runtime};
use zeroize::Zeroizing;

/// Secret slot name inside the Keystore plugin's prefs.
#[cfg(target_os = "android")]
const SLOT: &str = "nsec";

static LOADED: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "android")]
pub struct KeystoreHandle<R: Runtime>(tauri::plugin::PluginHandle<R>);

/// The Tauri plugin that registers the Kotlin `KeystorePlugin` (Android only;
/// a no-op elsewhere).
pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("uni-keystore")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle = _api.register_android_plugin("org.unforced.uni", "KeystorePlugin")?;
                _app.manage(KeystoreHandle(handle));
            }
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
fn handle<R: Runtime>(app: &AppHandle<R>) -> Result<tauri::plugin::PluginHandle<R>, String> {
    use tauri::Manager;
    app.try_state::<KeystoreHandle<R>>()
        .map(|h| h.0.clone())
        .ok_or_else(|| "keystore plugin not registered".to_string())
}

/// Persist `nsec` (already validated) for future launches.
pub async fn save<R: Runtime>(_app: &AppHandle<R>, nsec: &Zeroizing<String>) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        #[derive(serde::Serialize)]
        struct Args<'a> {
            name: &'a str,
            secret: &'a str,
        }
        handle(_app)?
            .run_mobile_plugin_async::<serde_json::Value>(
                "saveSecret",
                Args {
                    name: SLOT,
                    secret: nsec.as_str(),
                },
            )
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "android"))]
    {
        let nsec = nsec.clone();
        tauri::async_runtime::spawn_blocking(move || {
            uni_core::store_keyring_nsec(&nsec).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())??;
        Ok(())
    }
}

/// Load the stored key into `uni_core` once per process (Android). On desktop
/// `load_keys` reads the keyring itself, so this is a no-op there.
pub async fn ensure_loaded<R: Runtime>(_app: &AppHandle<R>) -> Result<(), String> {
    if LOADED.load(Ordering::SeqCst) || uni_core::has_device_keys() {
        return Ok(());
    }
    #[cfg(target_os = "android")]
    {
        #[derive(serde::Serialize)]
        struct Args<'a> {
            name: &'a str,
        }
        #[derive(serde::Deserialize)]
        struct Loaded {
            secret: Option<String>,
        }
        let loaded: Loaded = handle(_app)?
            .run_mobile_plugin_async("loadSecret", Args { name: SLOT })
            .await
            .map_err(|e| e.to_string())?;
        if let Some(secret) = loaded.secret.map(Zeroizing::new) {
            let keys = nostr_keys(&secret)?;
            uni_core::set_device_keys(keys);
        }
    }
    LOADED.store(true, Ordering::SeqCst);
    Ok(())
}

/// Delete the stored key and drop it from memory.
pub async fn forget<R: Runtime>(_app: &AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        #[derive(serde::Serialize)]
        struct Args<'a> {
            name: &'a str,
        }
        handle(_app)?
            .run_mobile_plugin_async::<serde_json::Value>("clearSecret", Args { name: SLOT })
            .await
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "android"))]
    {
        tauri::async_runtime::spawn_blocking(|| {
            uni_core::forget_keyring_key().map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())??;
    }
    uni_core::clear_device_keys();
    Ok(())
}

pub fn nostr_keys(secret: &str) -> Result<nostr::Keys, String> {
    nostr::Keys::parse(secret.trim()).map_err(|_| "stored key is not valid".to_string())
}
