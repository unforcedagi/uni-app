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
//!
//! T-204: a note's markdown (text the UI already has, not a cached file) is
//! saved the same ways: Android's Downloads through MediaStore, and on desktop
//! the system Save dialog, opened in Downloads with the note's name filled in.
//! On Android it can also go to the share sheet.

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
        let home = app.path().home_dir().ok();
        // Linux without xdg-user-dirs (`user-dirs.dirs`) has no named Downloads folder: use ~/Downloads.
        let dir = app
            .path()
            .download_dir()
            .ok()
            .or_else(|| home.as_ref().map(|h| h.join("Downloads")))
            .ok_or("Couldn't find a Downloads folder on this computer")?;
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

/// T-204: a file name the UI made safe (`src/noteDownload.ts`), checked again
/// here: one plain name, not hidden, no control characters, at most 255 bytes.
pub fn valid_note_name(name: &str) -> bool {
    !name.trim().is_empty()
        && name.len() <= 255
        && !name.starts_with('.')
        && !name.chars().any(|c| c.is_control() || c == '/' || c == '\\')
}

/// T-204: save a note's markdown as `name`. Desktop asks where with the Save
/// dialog (`None` when the user cancels); Android puts it in Downloads. Returns
/// where it went, as the confirmation shows it.
pub async fn save_note<R: Runtime>(
    window: &tauri::Window<R>,
    name: &str,
    text: String,
) -> Result<Option<String>, String> {
    if !valid_note_name(name) {
        return Err("bad file name".into());
    }
    #[cfg(target_os = "android")]
    {
        #[derive(serde::Serialize)]
        struct Args<'a> {
            name: &'a str,
            text: String,
            mime: &'a str,
        }
        #[derive(serde::Deserialize)]
        struct Saved {
            name: String,
        }
        let saved: Saved = handle(window.app_handle())?
            .run_mobile_plugin_async("saveTextToDownloads", Args { name, text, mime: "text/markdown" })
            .await
            .map_err(|e| e.to_string())?;
        Ok(Some(format!("Downloads/{}", saved.name)))
    }
    #[cfg(desktop)]
    {
        use tauri::Manager;
        use tauri_plugin_dialog::DialogExt;
        let app = window.app_handle();
        let home = app.path().home_dir().ok();
        let downloads = app.path().download_dir().ok().or_else(|| home.as_ref().map(|h| h.join("Downloads")));
        let mut dialog = app.dialog().file().set_parent(window).set_file_name(name).add_filter("Markdown", &["md"]);
        if let Some(dir) = downloads.filter(|d| std::fs::create_dir_all(d).is_ok()) {
            dialog = dialog.set_directory(dir);
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        dialog.save_file(move |picked| {
            let _ = tx.send(picked);
        });
        let Some(picked) = rx.await.map_err(|_| "the Save dialog closed unexpectedly".to_string())? else {
            return Ok(None);
        };
        let path = picked.into_path().map_err(|e| e.to_string())?;
        let written = path.clone();
        tauri::async_runtime::spawn_blocking(move || write_replacing(&written, text.as_bytes()))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("Couldn't save the note: {e}"))?;
        tracing::info!(path = %path.display(), "note_download: saved");
        Ok(Some(shown(&path, home.as_deref())))
    }
    #[cfg(not(any(desktop, target_os = "android")))]
    {
        let _ = (window, text);
        Err("Saving files isn't supported on this device yet".into())
    }
}

/// Write `bytes` to `path` through a hidden temporary file in the same folder,
/// so a reader never sees half a note. The user chose `path` in the Save
/// dialog, which already asked before replacing a file there.
#[cfg(desktop)]
fn write_replacing(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let dir = path.parent().ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no folder"))?;
    let tmp = dir.join(format!(".{}.uni-part", uuid::Uuid::new_v4()));
    let written = (|| {
        let mut out = std::fs::File::create(&tmp)?;
        out.write_all(bytes)?;
        out.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

/// T-204: hand a note's markdown to the Android share sheet as `name`.
pub async fn share_note<R: Runtime>(
    app: &AppHandle<R>,
    name: &str,
    text: String,
    title: Option<&str>,
) -> Result<(), String> {
    if !valid_note_name(name) {
        return Err("bad file name".into());
    }
    #[cfg(target_os = "android")]
    {
        #[derive(serde::Serialize)]
        struct Args<'a> {
            name: &'a str,
            text: String,
            title: Option<&'a str>,
            mime: &'a str,
        }
        handle(app)?
            .run_mobile_plugin_async::<serde_json::Value>("shareText", Args { name, text, title, mime: "text/markdown" })
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, text, title);
        Err("Sharing is only on Android; use Download .md".into())
    }
}

#[cfg(test)]
mod name_tests {
    use super::valid_note_name;

    #[test]
    fn note_names_are_one_plain_file_name() {
        assert!(valid_note_name("Plans 1019 draft.md"));
        assert!(valid_note_name("Garden 🌱 notes.md"));
        assert!(valid_note_name(&format!("{}.md", "長".repeat(40))));
        for bad in ["", "  ", ".md", "../x.md", "a/b.md", "a\\b.md", "a\nb.md", "a\u{7}b.md"] {
            assert!(!valid_note_name(bad), "{bad:?}");
        }
        assert!(!valid_note_name(&format!("{}.md", "長".repeat(90))));
    }
}

#[cfg(all(test, desktop))]
mod tests {
    use super::*;

    #[test]
    fn a_saved_note_replaces_the_chosen_file_and_leaves_no_temporary() {
        let dir = std::env::temp_dir().join(format!("uni-t204-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("Note.md");
        std::fs::write(&path, "old").unwrap();
        let text = "# Note\r\nbody without final newline 🌱";
        write_replacing(&path, text.as_bytes()).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), text.as_bytes());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn saved_location_is_shown_from_home() {
        let home = Path::new("/home/a");
        assert_eq!(shown(Path::new("/home/a/Downloads/x.pdf"), Some(home)), "~/Downloads/x.pdf");
        assert_eq!(shown(Path::new("/mnt/d/x.pdf"), Some(home)), "/mnt/d/x.pdf");
        assert_eq!(shown(Path::new("/mnt/d/x.pdf"), None), "/mnt/d/x.pdf");
    }
}
