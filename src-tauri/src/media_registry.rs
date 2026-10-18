//! T-172 (Codex review 1, both P2): which cached media the app may serve, and which must stay on disk.
//! Serving rights (`allowed`: verified this session) and pins (media being fetched or playing now) are kept apart,
//! so a prune spares only media in use and the 2 GB budget holds. Both live under one lock and every prune runs
//! while holding it. A fetch pins its hash before it starts, so no other prune can remove the file between its
//! verification and its registration.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{LazyLock, Mutex, MutexGuard};

#[derive(Default)]
pub struct Registry {
    /// Hash → Content-Type, for the `unimedia` protocol and the loopback.
    allowed: HashMap<String, String>,
    /// Hash → how many fetches and players hold it.
    pins: HashMap<String, usize>,
}

pub static MEDIA: LazyLock<Mutex<Registry>> = LazyLock::new(Default::default);

pub fn lock(reg: &Mutex<Registry>) -> MutexGuard<'_, Registry> {
    reg.lock().unwrap_or_else(|e| e.into_inner())
}

impl Registry {
    pub fn content_type(&self, sha: &str) -> Option<String> {
        self.allowed.get(sha).cloned()
    }

    pub fn is_allowed(&self, sha: &str) -> bool {
        self.allowed.contains_key(sha)
    }

    pub fn pin(&mut self, sha: &str) {
        *self.pins.entry(sha.to_string()).or_default() += 1;
    }

    pub fn release(&mut self, sha: &str) {
        if let Some(n) = self.pins.get_mut(sha) {
            *n -= 1;
            if *n == 0 {
                self.pins.remove(sha);
            }
        }
    }

    #[cfg(test)]
    pub fn allow_for_test(&mut self, sha: &str, content_type: &str) {
        self.allowed.insert(sha.to_string(), content_type.to_string());
    }

    /// Trim `dir` to `budget`, least recently used first, sparing pinned files only.
    pub fn prune(&self, dir: &Path, budget: u64) {
        let keep: Vec<String> = self.pins.keys().cloned().collect();
        uni_core::media::prune_cache(dir, &keep, budget);
    }
}

/// Pin `sha`, run `fetch` (true when it downloaded into `dir`), then, under one lock, allow it as `content_type`
/// (if given) and prune after a download. The pin stays with the caller, who releases it when done
/// (`media_release`, or at the end of a save); a failed fetch releases it here.
pub fn fetch_pinned(
    reg: &Mutex<Registry>,
    dir: &Path,
    sha: &str,
    content_type: Option<&str>,
    budget: u64,
    fetch: impl FnOnce() -> Result<bool, String>,
) -> Result<(), String> {
    lock(reg).pin(sha);
    let fetched = fetch();
    let mut r = lock(reg);
    match fetched {
        Err(e) => {
            r.release(sha);
            Err(e)
        }
        Ok(downloaded) => {
            if let Some(ct) = content_type {
                r.allowed.insert(sha.to_string(), ct.to_string());
            }
            if downloaded {
                r.prune(dir, budget);
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("unimedia-reg-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Codex 1, P2: media played earlier this session must not stay pinned, or the cache grows without bound.
    #[test]
    fn only_media_in_use_survives_a_prune() {
        let (d, reg) = (dir(), Mutex::new(Registry::default()));
        for sha in ["playing", "played"] {
            fetch_pinned(&reg, &d, sha, Some("video/mp4"), u64::MAX, || {
                std::fs::write(d.join(sha), [0u8; 10]).unwrap();
                Ok(true)
            })
            .unwrap();
        }
        lock(&reg).release("played"); // its player ended or unmounted
        lock(&reg).prune(&d, 0);
        assert!(d.join("playing").exists(), "a playing video was evicted");
        assert!(!d.join("played").exists(), "a released video stayed pinned past the budget");
        assert!(lock(&reg).is_allowed("played"), "it may still be served if fetched again");
        lock(&reg).release("playing");
        lock(&reg).prune(&d, 0);
        assert!(!d.join("playing").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Codex 1, P2: another download's prune runs between this file's verification and its registration.
    #[test]
    fn a_fetched_file_cannot_be_pruned_before_it_is_registered() {
        let (d, reg) = (dir(), Mutex::new(Registry::default()));
        fetch_pinned(&reg, &d, "new", Some("video/mp4"), u64::MAX, || {
            std::fs::write(d.join("new"), [0u8; 10]).unwrap(); // verified and renamed into place
            lock(&reg).prune(&d, 0); // a concurrent download finishing with the cache over budget
            Ok(true)
        })
        .unwrap();
        assert!(d.join("new").exists(), "evicted before its URL could be served");
        assert_eq!(lock(&reg).content_type("new").as_deref(), Some("video/mp4"));
        // A failed fetch gives its pin back.
        assert!(fetch_pinned(&reg, &d, "bad", None, u64::MAX, || Err("relay answered 404".into())).is_err());
        assert!(!lock(&reg).pins.contains_key("bad"));
        let _ = std::fs::remove_dir_all(&d);
    }
}
