//! T-313 (Codex review 9b8p17d9, P1; lwoggo26, P2): the decrypted copies of attachments written for the system's
//! viewer, by the account they belong to. They go when that account does (signed out, ended on the homeserver, replaced
//! by another sign-in) and when the app quits (`Messages::drop_copies`; one killed instead leaves them to its next
//! start, which removes them).
//!
//! Each copy is registered, with a ticket, before a byte is written. Whatever ends it (`sweep` as an account ends,
//! `close` as the app quits) takes the ticket back. A write stands only if its ticket is still registered when it has
//! finished: the writer checks that itself, on its own thread, right after writing, and removes its file if not. So a
//! copy written after the cleanup that should have removed it, the account unchanged or not, is removed by its writer,
//! and once closed no new copy is registered at all. `close` waits a moment for writes under way to finish that check.

use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

#[derive(Default)]
pub(crate) struct Copies {
    files: Vec<(u64, String, PathBuf)>,
    next: u64,
    /// The app is quitting: no copy is registered any more.
    closed: bool,
    /// Writes under way (registered, not yet checked after writing).
    writing: usize,
}

/// A registered copy: what `settle` and `finish_write` check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Ticket(u64);

impl Copies {
    /// A copy about to be written for `account`, unless the app is quitting.
    pub(crate) fn add(&mut self, account: &str, file: &Path) -> Option<Ticket> {
        if self.closed {
            return None;
        }
        self.next += 1;
        self.files.push((self.next, account.to_owned(), file.to_owned()));
        Some(Ticket(self.next))
    }

    fn holds(&self, t: Ticket) -> bool {
        self.files.iter().any(|(id, _, _)| *id == t.0)
    }

    /// Done with `file`: removed from disk and from the list.
    pub(crate) fn remove(&mut self, file: &Path) {
        self.files.retain(|(_, _, f)| f != file);
        let _ = std::fs::remove_file(file);
    }

    /// The account in force is now `keep` (none: signed out): every copy of another account is removed.
    pub(crate) fn sweep(&mut self, keep: Option<&str>) {
        let (gone, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut self.files).into_iter().partition(|(_, a, _)| Some(a.as_str()) != keep);
        self.files = kept;
        for (_, _, f) in gone {
            let _ = std::fs::remove_file(f);
        }
    }

    /// The app is quitting: every copy is removed, and none is registered from now on.
    pub(crate) fn close(&mut self) {
        self.closed = true;
        self.sweep(None);
    }

    /// The copy with `ticket` has finished writing to `file` (or failed): it stands only if its ticket is still registered;
    /// else whatever ended it ran while it was written, and the file is removed here. Whether it stands.
    pub(crate) fn finish_write(&mut self, ticket: Ticket, file: &Path, ok: bool) -> bool {
        self.writing = self.writing.saturating_sub(1);
        if ok && self.holds(ticket) {
            return true;
        }
        self.files.retain(|(id, _, _)| *id != ticket.0);
        let _ = std::fs::remove_file(file);
        false
    }

    /// `file` (ticket `ticket`, written for `mine`) is checked again as it's handed over; `now` is the account in force. It
    /// may be handed over only if its ticket is still registered and its account is still in force; else it is removed.
    pub(crate) fn settle(&mut self, ticket: Ticket, file: &Path, mine: &str, now: Option<&str>) -> bool {
        if self.holds(ticket) && now == Some(mine) {
            return true;
        }
        self.files.retain(|(id, _, _)| *id != ticket.0);
        let _ = std::fs::remove_file(file);
        false
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.files.len()
    }
}

/// Write `bytes` to `file` as the copy `ticket`, on a blocking thread: create, write, then check the ticket at once,
/// under the registry's lock, removing the file if it no longer stands. `before_write` runs on that thread first (tests
/// hold a write there). Whether the copy stands.
pub(crate) async fn write_copy(
    copies: std::sync::Arc<Mutex<Copies>>,
    ticket: Ticket,
    file: PathBuf,
    bytes: Vec<u8>,
    before_write: impl FnOnce() + Send + 'static,
) -> Result<bool, String> {
    copies.lock().unwrap().writing += 1;
    let joined = tokio::task::spawn_blocking({
        let copies = copies.clone();
        move || {
            before_write();
            let wrote = file.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|_| std::fs::write(&file, &bytes));
            let stands = copies.lock().unwrap().finish_write(ticket, &file, wrote.is_ok());
            wrote.map(|_| stands).map_err(|e| e.to_string())
        }
    })
    .await;
    match joined {
        Ok(r) => r,
        Err(e) => {
            // the thread didn't finish its check (it panicked, or the runtime is going): nothing it wrote stands
            let mut c = copies.lock().unwrap();
            c.files.retain(|(id, _, _)| *id != ticket.0);
            c.writing = c.writing.saturating_sub(1);
            Err(e.to_string())
        }
    }
}

/// Quit: close the registry, then wait up to `wait` for writes under way to finish their check (each removes its own
/// file). Whether none was left under way.
pub(crate) fn close_and_wait(copies: &Mutex<Copies>, wait: Duration) -> bool {
    copies.lock().unwrap().close();
    let end = Instant::now() + wait;
    loop {
        if copies.lock().unwrap().writing == 0 {
            return true;
        }
        if Instant::now() >= end {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{mpsc, Arc};

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
        c.add("store-a", &a1).unwrap();
        write(&a1);
        let tb = c.add("store-b", &b1).unwrap();
        write(&b1);
        c.sweep(Some("store-b"));
        assert!(!a1.exists() && b1.exists());
        assert_eq!(c.len(), 1);

        // a copy still being written as its account ends: the sweep can't see a file yet, then the write lands; the
        // check after it removes it rather than hand it over
        let t = c.add("store-a", &a2).unwrap();
        c.sweep(None);
        assert!(!b1.exists());
        write(&a2);
        assert!(!c.settle(t, &a2, "store-a", None));
        assert!(!a2.exists());
        assert!(!c.settle(tb, &b1, "store-b", Some("store-b")), "a swept copy was handed over");
        // replaced by another sign-in meanwhile: the same
        let t = c.add("store-a", &a2).unwrap();
        write(&a2);
        assert!(!c.settle(t, &a2, "store-a", Some("store-c")));
        assert!(!a2.exists());
        assert_eq!(c.len(), 0);

        // still the account in force: handed over, and removed when done with
        let t = c.add("store-c", &a1).unwrap();
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
        let t = c.add("store-a", &late).unwrap();
        // the app quits while the copy is still being written: the cleanup finds no file yet
        c.close();
        // the write lands after it; the account is still the one in force
        write(&late);
        assert!(!c.finish_write(t, &late, true), "a copy finished after quit cleanup stood");
        assert!(!late.exists(), "a decrypted copy outlived quit cleanup");
        assert!(!c.settle(t, &late, "store-a", Some("store-a")));
        // and once closed, nothing new is registered
        assert!(c.add("store-a", &late).is_none());
    }

    /// The race itself, in order every time: a real write, on its thread, held just before it writes while the app's quit
    /// cleanup runs; then let go. However the two fall, no copy is left, and quit waited for the write's check.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn codex_lwoggo26_quit_while_a_copy_is_written_leaves_no_file_and_waits_for_the_writer() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("sub").join("plan.pdf");
        let copies = Arc::new(Mutex::new(Copies::default()));
        let t = copies.lock().unwrap().add("store-a", &file).unwrap();
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
        assert_eq!(copies.lock().unwrap().len(), 0);
    }

    /// The plain case still stands: written while nothing ends it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_copy_written_while_nothing_ends_it_stands() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("plan.pdf");
        let copies = Arc::new(Mutex::new(Copies::default()));
        let t = copies.lock().unwrap().add("store-a", &file).unwrap();
        assert_eq!(write_copy(copies.clone(), t, file.clone(), b"made-up".to_vec(), || {}).await, Ok(true));
        assert!(file.exists());
        assert!(close_and_wait(&copies, Duration::from_secs(1)));
        assert!(!file.exists());
    }
}
