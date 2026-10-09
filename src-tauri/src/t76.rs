//! T-76 test harness: debug builds on Linux only, and only when `UNI_T76_DIR` is set.
//! It swaps the default window for one that runs a script file (`UNI_T76_INIT`) before the page's own scripts,
//! and gives that script one command (`t76_write`) to put its results in files under `UNI_T76_DIR`.
//! A release build contains none of this.

use std::path::PathBuf;
use tauri::{App, Manager, WebviewWindowBuilder};

fn dir() -> Option<PathBuf> {
    std::env::var_os("UNI_T76_DIR").map(PathBuf::from)
}

/// Write `contents` to `<UNI_T76_DIR>/<name>`; the name is a bare file name.
#[tauri::command]
pub fn t76_write(name: String, contents: String) -> Result<(), String> {
    let dir = dir().ok_or("harness off")?;
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.starts_with('.') {
        return Err("bad name".into());
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(name), contents).map_err(|e| e.to_string())
}

/// Read `<UNI_T76_DIR>/<name>`; `None` while it does not exist. The driver uses it to wait for the key-injection helper.
#[tauri::command]
pub fn t76_read(name: String) -> Result<Option<String>, String> {
    let dir = dir().ok_or("harness off")?;
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.starts_with('.') {
        return Err("bad name".into());
    }
    Ok(std::fs::read_to_string(dir.join(name)).ok())
}

/// Replace the configured window with one that carries the init script. The new window gets the same WebRTC settings as production.
pub fn replace_window(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let Some(init) = std::env::var_os("UNI_T76_INIT") else { return Ok(()) };
    if dir().is_none() {
        return Ok(());
    }
    let script = std::fs::read_to_string(init)?;
    let mut cfg = app.config().app.windows.first().cloned().ok_or("no window in config")?;
    cfg.label = "t76".into();
    let win = WebviewWindowBuilder::from_config(app.handle(), &cfg)?.initialization_script(script).build()?;
    win.set_size(tauri::LogicalSize::new(1400.0, 900.0))?;
    if let Some(main) = app.get_webview_window("main") {
        main.destroy()?;
    }
    Ok(())
}
