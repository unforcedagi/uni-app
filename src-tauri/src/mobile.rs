//! Mobile-only (Android/iOS) startup glue. Desktop builds don't compile this.
//!
//! 1. **Own the tokio runtime.** `tokio::task::spawn_blocking` from Tauri's
//!    setup crashes on physical Android devices unless a runtime is entered
//!    (tauri-apps/tauri#13828). We build one multi-thread runtime up front,
//!    hand it to Tauri via `tauri::async_runtime::set`, and keep it alive for
//!    the process lifetime. `uni-core` code should use
//!    `tauri::async_runtime::handle()` (or be called from inside it).
//!
//! 2. **No keyring on Android.** `keyring` 3.x has no Android backend and
//!    silently falls back to an in-memory mock, so it is disabled
//!    (`UNI_NO_KEYRING=1`). The account key comes from Android Keystore via
//!    `secure_store` (paired from Buzz desktop), never from a plaintext file.

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
pub fn setup(_app: &tauri::App) {}

/// Env var names, mirrored from `uni_core::identity` (kept local so this
/// module doesn't depend on uni-core's public surface changing).
mod uni_core_env {
    #[allow(dead_code)]
    pub const NO_KEYRING: &str = "UNI_NO_KEYRING";
}
