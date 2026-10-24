//! Where an account's two secrets live: the store passphrase and the session (access token and device id).

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

    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        let path = self.path(name)?;
        private_dir(&self.dir)?;
        let tmp = path.with_extension("tmp");
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp).map_err(|e| e.to_string())?;
        f.write_all(value.as_bytes()).and_then(|_| f.sync_all()).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &path).map_err(|e| e.to_string())
    }

    fn delete(&self, name: &str) -> Result<(), String> {
        match fs::remove_file(self.path(name)?) {
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
    }
}
