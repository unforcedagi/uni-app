//! Where the saved account lives: one record with its session (access token, device id), store name and store key.

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use rand::RngCore;

/// A small named-secret slot. The desktop app is meant to keep these in the OS keychain and Android in the Keystore,
/// as it keeps the device key (DESIGN.md, "On the device"); the prototype uses [`FileSecrets`].
pub trait Secrets: Send + Sync + 'static {
    fn get(&self, name: &str) -> Result<Option<String>, String>;
    /// Replace the value in one step: whatever happens (a full disk, a crash), it is the old value or the new one.
    fn set(&self, name: &str, value: &str) -> Result<(), String>;
    fn delete(&self, name: &str) -> Result<(), String>;
}

/// Secrets as files readable only by this user (0600 in a 0700 folder).
pub struct FileSecrets {
    dir: PathBuf,
}

impl FileSecrets {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        FileSecrets { dir: dir.into() }
    }

    fn path(&self, name: &str) -> Result<PathBuf, String> {
        if name.is_empty() || name.len() > 64 || !name.bytes().all(|b| b.is_ascii_lowercase() || b == b'-') {
            return Err("bad secret name".into());
        }
        Ok(self.dir.join(name))
    }

    /// Remove the temporary files an interrupted write of `name` left behind (a crash between writing and renaming):
    /// they hold the value too. One writer per name at a time, as the account's changes take turns.
    fn sweep(&self, name: &str) {
        let Ok(entries) = fs::read_dir(&self.dir) else { return };
        let prefix = format!(".{name}.");
        for e in entries.flatten() {
            let file = e.file_name().to_string_lossy().into_owned();
            if file.starts_with(&prefix) && file.ends_with(".tmp") {
                let _ = fs::remove_file(e.path());
            }
        }
    }
}

fn private_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

impl Secrets for FileSecrets {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        match fs::read_to_string(self.path(name)?) {
            Ok(s) => Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    /// Written whole to a new temporary file, synced, then renamed over the old one: the rename is the one step that
    /// changes the value, so once it is done this reports success. The folder is synced after it; if that fails, the
    /// new value is in place but might not survive a power cut, which is logged rather than reported (an error would
    /// say the value didn't change, and it did).
    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        let path = self.path(name)?;
        private_dir(&self.dir)?;
        self.sweep(name);
        let tmp = self.dir.join(format!(".{name}.{}.tmp", random_hex(6)));
        let written = (|| {
            let mut opts = fs::OpenOptions::new();
            opts.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut f = opts.open(&tmp)?;
            f.write_all(value.as_bytes())?;
            f.sync_all()?;
            fs::rename(&tmp, &path)
        })();
        if let Err(e) = written {
            let _ = fs::remove_file(&tmp);
            return Err(e.to_string());
        }
        #[cfg(unix)]
        if let Err(e) = fs::File::open(&self.dir).and_then(|d| d.sync_all()) {
            tracing::warn!("the secrets folder wasn't synced after a write: {e}");
        }
        Ok(())
    }

    fn delete(&self, name: &str) -> Result<(), String> {
        let path = self.path(name)?;
        self.sweep(name);
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// `n` random bytes as hex, from the OS's generator.
pub(crate) fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    rand::rng().fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_secret_is_private_to_this_user_and_its_name_cant_leave_the_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let s = FileSecrets::new(tmp.path().join("secrets"));
        assert_eq!(s.get("session").unwrap(), None);
        s.set("session", "one").unwrap();
        s.set("session", "two").unwrap();
        assert_eq!(s.get("session").unwrap().as_deref(), Some("two"));
        assert_eq!(fs::read_dir(tmp.path().join("secrets")).unwrap().count(), 1, "no temporary file is left behind");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&tmp.path().join("secrets/session")), 0o600);
            assert_eq!(mode(&tmp.path().join("secrets")), 0o700);
        }
        for bad in ["../escape", "a/b", "", ".hidden", "Session"] {
            assert!(s.set(bad, "x").is_err(), "{bad:?} must be refused");
        }
        s.delete("session").unwrap();
        s.delete("session").unwrap();
        assert_eq!(s.get("session").unwrap(), None);

        // an interrupted write's temporary file (it holds the value) goes with the next write, and with a delete
        fs::write(tmp.path().join("secrets/.session.0a1b2c.tmp"), "one").unwrap();
        s.set("session", "three").unwrap();
        assert_eq!(fs::read_dir(tmp.path().join("secrets")).unwrap().count(), 1, "the leftover went with the write");
        fs::write(tmp.path().join("secrets/.session.0a1b2c.tmp"), "three").unwrap();
        s.delete("session").unwrap();
        assert_eq!(fs::read_dir(tmp.path().join("secrets")).unwrap().count(), 0, "the leftover went with the delete");
    }
}
