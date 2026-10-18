//! T-174: where a saved attachment goes, and how one is opened. The file is
//! already in the media cache (Blossom auth and SHA-256 check done in Rust);
//! the cache is private to the app, so neither the user nor a file manager can
//! see it there.
//!
//! - Android: the in-app `FilesPlugin` (Kotlin, gen/android/.../FilesPlugin.kt).
//!   Save copies into the public Downloads collection through MediaStore (no
//!   storage permission); Open hands the file to the app for its type as a
//!   FileProvider `content://` URI with a read grant.
//! - Desktop: Save copies into the user's Downloads folder; Open uses the OS
//!   default handler.
//! - Anywhere else: both say they can't, instead of doing nothing.

use std::path::Path;

use tauri::{AppHandle, Runtime};

#[cfg(target_os = "android")]
pub struct FilesHandle<R: Runtime>(tauri::plugin::PluginHandle<R>);

/// The Tauri plugin that registers the Kotlin `FilesPlugin` (Android only; a no-op elsewhere).
pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("uni-files")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle = _api.register_android_plugin("org.unforced.uni", "FilesPlugin")?;
                _app.manage(FilesHandle(handle));
            }
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
fn handle<R: Runtime>(app: &AppHandle<R>) -> Result<tauri::plugin::PluginHandle<R>, String> {
    use tauri::Manager;
    app.try_state::<FilesHandle<R>>()
        .map(|h| h.0.clone())
        .ok_or_else(|| "file plugin not registered".to_string())
}

/// `~/Downloads/x.pdf` rather than `/home/aaron/Downloads/x.pdf`.
#[cfg(desktop)]
fn shown(path: &Path, home: Option<&Path>) -> String {
    match home.and_then(|h| path.strip_prefix(h).ok()) {
        Some(rest) => format!("~/{}", rest.display()),
        None => path.display().to_string(),
    }
}

/// Put the cached file where the user finds it, as `name`. Returns where it
/// went, as the confirmation shows it (`Downloads/x.pdf`, `~/Downloads/x.pdf`).
pub async fn save<R: Runtime>(
    app: &AppHandle<R>,
    cached: &Path,
    name: &str,
    mime: Option<&str>,
) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        #[derive(serde::Serialize)]
        struct Args<'a> {
            path: &'a str,
            name: &'a str,
            mime: Option<&'a str>,
        }
        #[derive(serde::Deserialize)]
        struct Saved {
            name: String,
        }
        let saved: Saved = handle(app)?
            .run_mobile_plugin_async(
                "saveToDownloads",
                Args { path: &cached.to_string_lossy(), name, mime },
            )
            .await
            .map_err(|e| e.to_string())?;
        Ok(format!("Downloads/{}", saved.name))
    }
    #[cfg(desktop)]
    {
        use tauri::Manager;
        let _ = mime;
        let dir = app
            .path()
            .download_dir()
            .map_err(|_| "Couldn't find a Downloads folder on this computer".to_string())?;
        let home = app.path().home_dir().ok();
        let (cached, name) = (cached.to_path_buf(), name.to_string());
        let path = tauri::async_runtime::spawn_blocking(move || uni_core::media::export_file(&cached, &dir, &name))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("Couldn't save to Downloads: {e}"))?;
        tracing::info!(path = %path.display(), "media_save: saved to Downloads");
        Ok(shown(&path, home.as_deref()))
    }
    #[cfg(not(any(desktop, target_os = "android")))]
    {
        let _ = (app, cached, name, mime);
        Err("Saving files isn't supported on this device yet".into())
    }
}

/// Open a cached file (its copy with the right extension) in the app the
/// system picks for its type.
pub async fn open<R: Runtime>(app: &AppHandle<R>, file: &Path, mime: Option<&str>) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        #[derive(serde::Serialize)]
        struct Args<'a> {
            path: &'a str,
            mime: Option<&'a str>,
        }
        handle(app)?
            .run_mobile_plugin_async::<serde_json::Value>("openFile", Args { path: &file.to_string_lossy(), mime })
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(desktop)]
    {
        use tauri_plugin_opener::OpenerExt;
        let _ = mime;
        app.opener()
            .open_path(file.to_string_lossy(), None::<&str>)
            .map_err(|e| format!("Couldn't open the file: {e}"))
    }
    #[cfg(not(any(desktop, target_os = "android")))]
    {
        let _ = (app, file, mime);
        Err("Opening files isn't supported on this device yet".into())
    }
}

#[cfg(all(test, desktop))]
mod tests {
    use super::*;

    #[test]
    fn saved_location_is_shown_from_home() {
        let home = Path::new("/home/a");
        assert_eq!(shown(Path::new("/home/a/Downloads/x.pdf"), Some(home)), "~/Downloads/x.pdf");
        assert_eq!(shown(Path::new("/mnt/d/x.pdf"), Some(home)), "/mnt/d/x.pdf");
        assert_eq!(shown(Path::new("/mnt/d/x.pdf"), None), "/mnt/d/x.pdf");
    }
}
