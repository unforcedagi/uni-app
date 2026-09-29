//! Desktop file log: `~/Library/Logs/org.unforced.uni/uni.log` on macOS
//! (`$XDG_STATE_HOME`/`~/.local/state/org.unforced.uni/uni.log` elsewhere).
//! Started before Tauri so a launch that stalls or panics still leaves a trail.
//! Rotates once at 5 MB to `uni.log.1`. `RUST_LOG` overrides the default filter.
use std::fs::{self, OpenOptions};
use std::path::PathBuf;
use std::sync::Mutex;

const MAX_BYTES: u64 = 5 * 1024 * 1024;

fn log_dir() -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var_os("HOME")?);
    if cfg!(target_os = "macos") {
        return Some(home.join("Library/Logs/org.unforced.uni"));
    }
    let state = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local/state"));
    Some(state.join("org.unforced.uni"))
}

pub fn init() {
    let Some(dir) = log_dir() else { return };
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("uni.log");
    if fs::metadata(&path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let _ = fs::rename(&path, dir.join("uni.log.1"));
    }
    let Ok(file) = OpenOptions::new().create(true).append(true).open(&path) else { return };
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,uni_core=debug,uni_app_tauri_lib=debug"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_ansi(false)
        .with_writer(Mutex::new(file))
        .try_init();
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        tracing::error!("panic: {info}");
        default_hook(info);
    }));
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        os = std::env::consts::OS,
        "Uni starting"
    );
}
