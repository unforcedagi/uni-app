//! Mobile-only (Android/iOS) startup glue. Desktop builds don't compile this.
//!
//! 1. **Own the tokio runtime.** `tokio::task::spawn_blocking` from Tauri's
//!    setup crashes on physical Android devices unless a runtime is entered
//!    (tauri-apps/tauri#13828). We build one multi-thread runtime up front,
//!    hand it to Tauri via `tauri::async_runtime::set`, and keep it alive for
//!    the process lifetime. `uni-core` code should use
//!    `tauri::async_runtime::handle()` (or be called from inside it).
//!
//! 2. **DEV-ONLY key fallback (Android).** `keyring` 3.x has no Android
//!    backend and silently resolves to its in-memory `mock` store, which
//!    persists nothing. Until the Android Keystore backend lands (see
//!    uni-app-mobile.md §4), debug builds read an nsec from
//!    `<app_data_dir>/dev-nsec` (written with `adb shell run-as`, see
//!    docs/android-devices.md) and expose it as `UNI_NSEC`. Release builds
//!    never do this. The mock keyring is skipped (`UNI_NO_KEYRING=1`) so
//!    nobody mistakes it for real storage.

use std::sync::OnceLock;

static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

/// Call before `tauri::Builder` is created.
pub fn init_runtime() {
    // Before any threads exist: env mutation is only sound single-threaded.
    #[cfg(target_os = "android")]
    std::env::set_var(uni_core_env::NO_KEYRING, "1");

    let rt = RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("uni-rt")
            .build()
            .expect("build tokio runtime")
    });
    tauri::async_runtime::set(rt.handle().clone());
}

/// Call from the Tauri `setup` hook.
#[allow(unused_variables)]
pub fn setup(app: &tauri::App) {
    #[cfg(all(target_os = "android", debug_assertions))]
    dev_nsec_fallback(app);
}

#[cfg(all(target_os = "android", debug_assertions))]
fn dev_nsec_fallback(app: &tauri::App) {
    use tauri::Manager;
    // DEV ONLY — plaintext key file in the app's private data dir.
    if std::env::var(uni_core_env::NSEC).is_ok() {
        return;
    }
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    let path = dir.join("dev-nsec");
    match std::fs::read_to_string(&path) {
        Ok(s) if !s.trim().is_empty() => {
            std::env::set_var(uni_core_env::NSEC, s.trim());
            tracing::warn!(
                "DEV: loaded nsec from {} (debug build only)",
                path.display()
            );
        }
        _ => tracing::info!("DEV: no {} — app runs without an identity", path.display()),
    }
}

/// Env var names, mirrored from `uni_core::identity` (kept local so this
/// module doesn't depend on uni-core's public surface changing).
mod uni_core_env {
    #[allow(dead_code)]
    pub const NSEC: &str = "UNI_NSEC";
    #[allow(dead_code)]
    pub const NO_KEYRING: &str = "UNI_NO_KEYRING";
}
