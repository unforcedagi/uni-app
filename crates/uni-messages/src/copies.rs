//! T-313 (Codex review 9b8p17d9, P1): the decrypted copies of attachments written for the system's viewer, by the
//! account they belong to. They go when that account does (signed out, ended on the homeserver, replaced by another
//! sign-in, or the app quitting): `sweep` runs as the account ends, and a copy finished after that is removed by
//! `settle` instead of being handed over. A copy is registered before it is written, so a sweep while it is written
//! can't miss it.

use std::path::{Path, PathBuf};

#[derive(Default)]
pub(crate) struct Copies {
    files: Vec<(String, PathBuf)>,
}

impl Copies {
    /// A copy about to be written for `account`.
    pub(crate) fn add(&mut self, account: &str, file: &Path) {
        self.files.push((account.to_owned(), file.to_owned()));
    }

    /// Done with `file`: removed from disk and from the list.
    pub(crate) fn remove(&mut self, file: &Path) {
        self.files.retain(|(_, f)| f != file);
        let _ = std::fs::remove_file(file);
    }

    /// The account in force is now `keep` (none: signed out): every copy of another account is removed.
    pub(crate) fn sweep(&mut self, keep: Option<&str>) {
        let (gone, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut self.files).into_iter().partition(|(a, _)| Some(a.as_str()) != keep);
        self.files = kept;
        for (_, f) in gone {
            let _ = std::fs::remove_file(f);
        }
    }

    /// `file`, written for `mine`, is finished; `now` is the account in force. It may be handed over only if they are the
    /// same; else the account ended while it was written (and may have been swept already): it is removed.
    pub(crate) fn settle(&mut self, file: &Path, mine: &str, now: Option<&str>) -> bool {
        if now == Some(mine) {
            return true;
        }
        self.remove(file);
        false
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.files.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(p: &Path) {
        std::fs::write(p, b"made-up attachment").unwrap();
    }

    #[test]
    fn copies_go_with_their_account_and_one_finished_after_it_ended_is_never_handed_over() {
        let dir = tempfile::tempdir().unwrap();
        let (a1, a2, b1) = (dir.path().join("a1"), dir.path().join("a2"), dir.path().join("b1"));
        let mut c = Copies::default();

        // the account ends: its copies go, another account's stay
        c.add("store-a", &a1);
        write(&a1);
        c.add("store-b", &b1);
        write(&b1);
        c.sweep(Some("store-b"));
        assert!(!a1.exists() && b1.exists());
        assert_eq!(c.len(), 1);

        // a copy still being written as its account ends: the sweep can't see a file yet, then the write lands; the
        // settle after it removes it rather than hand it over
        c.add("store-a", &a2);
        c.sweep(None);
        assert!(!b1.exists());
        write(&a2);
        assert!(!c.settle(&a2, "store-a", None));
        assert!(!a2.exists());
        // replaced by another sign-in meanwhile: the same
        c.add("store-a", &a2);
        write(&a2);
        assert!(!c.settle(&a2, "store-a", Some("store-c")));
        assert!(!a2.exists());
        assert_eq!(c.len(), 0);

        // still the account in force: handed over, and removed when done with
        c.add("store-c", &a1);
        write(&a1);
        assert!(c.settle(&a1, "store-c", Some("store-c")));
        assert!(a1.exists());
        c.remove(&a1);
        assert!(!a1.exists());
        assert_eq!(c.len(), 0);
    }
}
