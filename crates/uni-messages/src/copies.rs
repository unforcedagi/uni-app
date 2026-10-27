//! T-313 (Codex review 9b8p17d9, P1; lwoggo26, P2): the decrypted copies of attachments written for the system's
//! viewer, by the account they belong to. They go when that account does (signed out, ended on the homeserver, replaced
//! by another sign-in) and when the app quits (`Messages::drop_copies`; one killed instead leaves them to its next
//! start, which removes them).
//!
//! Each copy is registered, with a ticket, before a byte is written. Whatever ends it (`sweep` as an account ends, or
//! as the app quits) takes the ticket back. A write stands only if its ticket is still registered when it has finished:
//! the writer checks that itself, on its own thread, right after writing, and removes its file if not (if the thread
//! fails, its file goes too). So a copy written after the cleanup that should have removed it, the account unchanged
//! or not, is removed by its writer. Quitting waits a moment for writes under way to finish that check.

use std::{
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, MutexGuard},
    time::{Duration, Instant},
};

#[derive(Default)]
pub(crate) struct Copies {
    files: Vec<(u64, String, PathBuf)>,
    next: u64,
    /// Copies registered and not yet checked after writing: quit waits for them. Counted from `add`, so no write can
    /// start unseen between its ticket and its count.
    writing: usize,
}

/// A registered copy: what `finish_write` and `settle` check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Ticket(u64);

/// The registry and the signal a quit waits on. A poisoned lock is taken as it is: cleanup must still run.
#[derive(Default)]
pub(crate) struct Registry {
    copies: Mutex<Copies>,
    settled: Condvar,
}

impl Registry {
    pub(crate) fn lock(&self) -> MutexGuard<'_, Copies> {
        self.copies.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Copies {
    /// A copy about to be written for `account`; counted as being written until `finish_write`.
    pub(crate) fn add(&mut self, account: &str, file: &Path) -> Ticket {
        self.next += 1;
        self.writing += 1;
        self.files.push((self.next, account.to_owned(), file.to_owned()));
        Ticket(self.next)
    }

    fn holds(&self, t: Ticket) -> bool {
        self.files.iter().any(|(id, _, _)| *id == t.0)
    }

    /// The copy `t` doesn't stand: its registration and its file go.
    fn forget(&mut self, t: Ticket, file: &Path) {
        self.files.retain(|(id, _, _)| *id != t.0);
        let _ = std::fs::remove_file(file);
    }

    /// Done with `file`: removed from disk and from the list.
    pub(crate) fn remove(&mut self, file: &Path) {
        self.files.retain(|(_, _, f)| f != file);
        let _ = std::fs::remove_file(file);
    }

    /// The account in force is now `keep` (none: signed out, or the app quitting): every copy of another account is
    /// removed, and its ticket taken back, so one still being written removes itself when it finishes.
    pub(crate) fn sweep(&mut self, keep: Option<&str>) {
        let (gone, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut self.files).into_iter().partition(|(_, a, _)| Some(a.as_str()) != keep);
        self.files = kept;
        for (_, _, f) in gone {
            let _ = std::fs::remove_file(f);
        }
    }

    /// The copy `ticket` has finished writing to `file` (or failed): it stands only if its ticket is still registered;
    /// else whatever ended it ran while it was written, and the file is removed here. Whether it stands.
    pub(crate) fn finish_write(&mut self, ticket: Ticket, file: &Path, ok: bool) -> bool {
        self.writing = self.writing.saturating_sub(1);
        if ok && self.holds(ticket) {
            return true;
        }
        self.forget(ticket, file);
        false
    }

    /// `file` (ticket `ticket`, written for `mine`) is checked again as it's handed over; `now` is the account in force. It
    /// may be handed over only if its ticket is still registered and its account is still in force; else it is removed.
    pub(crate) fn settle(&mut self, ticket: Ticket, file: &Path, mine: &str, now: Option<&str>) -> bool {
        if self.holds(ticket) && now == Some(mine) {
            return true;
        }
        self.forget(ticket, file);
        false
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.files.len()
    }
}

/// Write `bytes` to `file` as the copy `ticket` (from `add`), on a blocking thread: create, write, then check the ticket
/// at once, under the registry's lock, removing the file if it no longer stands. `before_write` runs on that thread
/// first (tests hold a write there). Whether the copy stands.
pub(crate) async fn write_copy(
    reg: Arc<Registry>,
    ticket: Ticket,
    file: PathBuf,
    bytes: Vec<u8>,
    before_write: impl FnOnce() + Send + 'static,
) -> Result<bool, String> {
    let joined = tokio::task::spawn_blocking({
        let (reg, file) = (reg.clone(), file.clone());
        move || {
            before_write();
            let wrote = file.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|_| std::fs::write(&file, &bytes));
            let stands = reg.lock().finish_write(ticket, &file, wrote.is_ok());
            reg.settled.notify_all();
            wrote.map(|_| stands).map_err(|e| e.to_string())
        }
    })
    .await;
    match joined {
        Ok(r) => r,
        Err(e) => {
            // the thread didn't finish its check (it panicked, or the runtime is going): nothing it wrote stands
            reg.lock().finish_write(ticket, &file, false);
            reg.settled.notify_all();
            Err(e.to_string())
        }
    }
}

/// Quit: every copy goes (its ticket taken back), then wait up to `wait` for writes under way to finish their check (each
/// removes its own file). Whether none was left under way. Nothing is closed for good: if the app goes on after all,
/// opening a file works again.
pub(crate) fn close_and_wait(reg: &Registry, wait: Duration) -> bool {
    let mut c = reg.lock();
    c.sweep(None);
    let end = Instant::now() + wait;
    while c.writing > 0 {
        let left = end.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return false;
        }
        c = reg.settled.wait_timeout(c, left).unwrap_or_else(|e| e.into_inner()).0;
    }
    true
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

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
        let tb = c.add("store-b", &b1);
        write(&b1);
        c.sweep(Some("store-b"));
        assert!(!a1.exists() && b1.exists());
        assert_eq!(c.len(), 1);

        // a copy still being written as its account ends: the sweep can't see a file yet, then the write lands; the
        // check after it removes it rather than hand it over
        let t = c.add("store-a", &a2);
        c.sweep(None);
        assert!(!b1.exists());
        write(&a2);
        assert!(!c.settle(t, &a2, "store-a", None));
        assert!(!a2.exists());
        assert!(!c.settle(tb, &b1, "store-b", Some("store-b")), "a swept copy was handed over");
        // replaced by another sign-in meanwhile: the same
        let t = c.add("store-a", &a2);
        write(&a2);
        assert!(!c.settle(t, &a2, "store-a", Some("store-c")));
        assert!(!a2.exists());
        assert_eq!(c.len(), 0);

        // still the account in force: handed over, and removed when done with
        let t = c.add("store-c", &a1);
        write(&a1);
        assert!(c.settle(t, &a1, "store-c", Some("store-c")));
        assert!(a1.exists());
        c.remove(&a1);
        assert!(!a1.exists());
        assert_eq!(c.len(), 0);
    }

    #[test]
    fn codex_lwoggo26_a_copy_written_after_quit_cleanup_is_removed_even_though_its_account_is_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let late = dir.path().join("late");
        let mut c = Copies::default();
        let t = c.add("store-a", &late);
        // the app quits while the copy is still being written: the cleanup finds no file yet
        c.sweep(None);
        // the write lands after it; the account is still the one in force
        write(&late);
        assert!(!c.finish_write(t, &late, true), "a copy finished after quit cleanup stood");
        assert!(!late.exists(), "a decrypted copy outlived quit cleanup");
        assert!(!c.settle(t, &late, "store-a", Some("store-a")));
    }

    /// The race itself, in order every time: a real write, on its thread, held just before it writes while the app's quit
    /// cleanup runs; then let go. However the two fall, no copy is left, and quit waited for the write's check.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn codex_lwoggo26_quit_while_a_copy_is_written_leaves_no_file_and_waits_for_the_writer() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("sub").join("plan.pdf");
        let copies = Arc::new(Registry::default());
        let t = copies.lock().add("store-a", &file);
        let (at_write, held) = (mpsc::channel::<()>(), mpsc::channel::<()>());
        let (reached, go) = (at_write.0, held.1);
        let writer = tokio::spawn(write_copy(copies.clone(), t, file.clone(), b"made-up decrypted bytes".to_vec(), move || {
            reached.send(()).unwrap();
            go.recv().unwrap();
        }));
        at_write.1.recv().unwrap();
        // quit, with the writer held before its write: close at once, then wait for it; let it go while quit waits
        let quitting = {
            let copies = copies.clone();
            std::thread::spawn(move || close_and_wait(&copies, Duration::from_secs(5)))
        };
        std::thread::sleep(Duration::from_millis(50));
        assert!(!quitting.is_finished(), "quit didn't wait for the write under way");
        held.0.send(()).unwrap();
        assert!(quitting.join().unwrap(), "quit gave up waiting");
        assert_eq!(writer.await.unwrap(), Ok(false));
        assert!(!file.exists(), "a decrypted copy written during quit cleanup survived it");
        assert_eq!(copies.lock().len(), 0);
    }

    /// The plain case still stands: written while nothing ends it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_copy_written_while_nothing_ends_it_stands() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("plan.pdf");
        let copies = Arc::new(Registry::default());
        let t = copies.lock().add("store-a", &file);
        assert_eq!(write_copy(copies.clone(), t, file.clone(), b"made-up".to_vec(), || {}).await, Ok(true));
        assert!(file.exists());
        assert!(close_and_wait(&copies, Duration::from_secs(1)));
        assert!(!file.exists());
        // the app goes on after all: a new copy opens as before
        let t = copies.lock().add("store-a", &file);
        assert_eq!(write_copy(copies.clone(), t, file.clone(), b"made-up".to_vec(), || {}).await, Ok(true));
        assert!(file.exists());
    }

    /// Counted from its ticket: a quit between the ticket and the write still waits for it.
    #[test]
    fn a_ticket_counts_as_a_write_under_way_until_it_is_checked() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("plan.pdf");
        let reg = Registry::default();
        let t = reg.lock().add("store-a", &file);
        assert!(!close_and_wait(&reg, Duration::from_millis(50)), "quit didn't see a write that had its ticket");
        write(&file);
        assert!(!reg.lock().finish_write(t, &file, true));
        assert!(!file.exists());
        assert!(close_and_wait(&reg, Duration::from_millis(50)));
    }

    /// The writer's thread panics after writing: its file still goes, and quit doesn't wait on it for good.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_writer_that_panics_leaves_no_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("plan.pdf");
        let reg = Arc::new(Registry::default());
        let t = reg.lock().add("store-a", &file);
        let f = file.clone();
        let got = write_copy(reg.clone(), t, file.clone(), b"made-up".to_vec(), move || {
            write(&f);
            panic!("made-up failure on the writer's thread");
        })
        .await;
        assert!(got.is_err());
        assert!(!file.exists(), "a panicking writer left its file");
        assert!(close_and_wait(&reg, Duration::from_millis(50)));
    }
}
