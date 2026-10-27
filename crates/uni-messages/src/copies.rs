//! T-313 (Codex reviews 9b8p17d9, lwoggo26, 61pbw7g4): the decrypted copies of attachments written for the system's
//! viewer. They fail closed:
//!
//! - **One directory per launch.** Every copy is written in `<base>/msgs-open-<random>/`, made for this launch. Quit
//!   removes the whole directory; the next start removes any `msgs-open-*` directory an earlier launch left (one killed
//!   before it could quit) before Messages opens.
//! - **A latch, under the lock the sweep takes.** Copies may be registered only for the account in force (`open_for`),
//!   and none once the app is closing. Ending an account (sign-out, ended on the homeserver, replaced by another
//!   sign-in, the app stopping) and quitting set the latch first, then sweep, in one critical section. Each sign-in's
//!   account name is new, so an account's latch never opens again; quit's is for good.
//! - **The ticket comes before the download, the write happens under the lock.** An open registers its ticket before
//!   it fetches a byte (refused at once if the latch is set). When its bytes are here, the write itself runs under the
//!   registry's lock, after checking the ticket still stands; a ticket the latch took back drops the bytes unwritten. So
//!   no write can land after the sweep, and one that landed before it is in the directory the sweep removes.

use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};

/// The per-launch directories' names start with this. Android's FilesPlugin.mediaFile spells it too: keep them the same.
pub const DIR_PREFIX: &str = "msgs-open-";

#[derive(Default)]
pub(crate) struct Copies {
    /// Registered copies: ticket, file.
    files: Vec<(u64, PathBuf)>,
    next: u64,
    /// This launch's directory, once set; none: files can't be opened here.
    dir: Option<PathBuf>,
    /// The account copies may be registered for; none between accounts.
    account: Option<String>,
    /// The app is quitting: nothing is registered or written again.
    closing: bool,
}

/// A registered copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Ticket(u64);

/// Why a copy can't be registered.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Refused {
    /// The app is quitting, or the account the open began with has ended.
    Closed,
    /// No directory for copies on this device.
    NoDir,
}

/// The registry. A poisoned lock is taken as it is: cleanup must still run.
#[derive(Default)]
pub(crate) struct Registry {
    copies: Mutex<Copies>,
}

impl Registry {
    pub(crate) fn lock(&self) -> MutexGuard<'_, Copies> {
        self.copies.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Copies {
    /// Use `<base>/msgs-open-<random>/` for this launch's copies, after removing every copies directory an earlier launch
    /// left in `base`. Its path.
    pub(crate) fn set_dir(&mut self, base: &Path) -> PathBuf {
        clear_leftovers(base, self.dir.as_deref());
        let dir = base.join(format!("{DIR_PREFIX}{}", crate::secrets::random_hex(8)));
        self.dir = Some(dir.clone());
        dir
    }

    /// From now on copies may be registered for `account` (an account starts running). Not after quit: that latch is
    /// for good.
    pub(crate) fn open_for(&mut self, account: &str) {
        if !self.closing {
            self.account = Some(account.to_owned());
        }
    }

    /// The account in force ends: latch first (nothing more registers for it), then every copy goes.
    pub(crate) fn end_account(&mut self) {
        self.account = None;
        self.sweep();
    }

    /// The app quits: latch for good, every copy goes, and this launch's directory with them.
    pub(crate) fn close(&mut self) {
        self.closing = true;
        self.account = None;
        self.sweep();
        if let Some(dir) = &self.dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    fn sweep(&mut self) {
        for (_, f) in std::mem::take(&mut self.files) {
            let _ = std::fs::remove_file(f);
        }
    }

    /// A copy named `name` about to be fetched for `account`: its ticket and the file it will be, or why not.
    pub(crate) fn register(&mut self, account: &str, name: &str) -> Result<(Ticket, PathBuf), Refused> {
        if self.closing || self.account.as_deref() != Some(account) {
            return Err(Refused::Closed);
        }
        let file = self.dir.as_ref().ok_or(Refused::NoDir)?.join(name);
        self.next += 1;
        self.files.push((self.next, file.clone()));
        Ok((Ticket(self.next), file))
    }

    /// Whether `ticket` still stands (as its copy is handed over).
    pub(crate) fn stands(&self, t: Ticket) -> bool {
        self.files.iter().any(|(id, _)| *id == t.0)
    }

    /// The copy `t` doesn't stand (its open gave up, or it ended): its registration and its file go.
    pub(crate) fn forget(&mut self, t: Ticket) {
        if let Some(at) = self.files.iter().position(|(id, _)| *id == t.0) {
            let (_, f) = self.files.remove(at);
            let _ = std::fs::remove_file(f);
        }
    }

    /// The bytes for `ticket` are here: written now, if it still stands; else dropped unwritten. Whether it stands. Runs
    /// under the registry's lock (the caller holds it), so no sweep can come between the check and the write.
    fn write_now(&mut self, ticket: Ticket, bytes: &[u8]) -> std::io::Result<bool> {
        let Some(file) = self.files.iter().find(|(id, _)| *id == ticket.0).map(|(_, f)| f.clone()) else { return Ok(false) };
        if self.closing {
            self.forget(ticket);
            return Ok(false);
        }
        let wrote = file.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|_| {
            let mut out = std::fs::OpenOptions::new().write(true).create_new(true).open(&file)?;
            out.write_all(bytes)
        });
        if wrote.is_err() {
            self.forget(ticket);
        }
        wrote.map(|_| true)
    }

    /// Done with `file`: removed from disk and from the list.
    pub(crate) fn remove(&mut self, file: &Path) {
        self.files.retain(|(_, f)| f != file);
        let _ = std::fs::remove_file(file);
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.files.len()
    }
}

/// A file name for the disk: the event's name with anything a path could use removed, never hidden, never empty.
pub(crate) fn file_name(name: &str) -> String {
    let clean: String = name.chars().filter(|c| !c.is_control() && !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')).collect();
    let clean = clean.trim().trim_start_matches('.').trim();
    let clean: String = clean.chars().take(100).collect();
    if clean.is_empty() {
        "attachment".into()
    } else {
        clean
    }
}

/// Remove every copies directory in `base` but `keep`: what earlier launches left.
pub(crate) fn clear_leftovers(base: &Path, keep: Option<&Path>) {
    for e in std::fs::read_dir(base).into_iter().flatten().flatten() {
        let path = e.path();
        let ours = e.file_name().to_string_lossy().starts_with(DIR_PREFIX);
        let dir = std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir());
        if ours && dir && Some(path.as_path()) != keep {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

/// Write `bytes` as the copy `ticket`, on a blocking thread, under the registry's lock (see `write_now`).
/// `before_write` runs on that thread, holding the lock, first (tests hold a write there). Whether the copy stands.
pub(crate) async fn write_copy(reg: Arc<Registry>, ticket: Ticket, bytes: Vec<u8>, before_write: impl FnOnce() + Send + 'static) -> Result<bool, String> {
    let joined = tokio::task::spawn_blocking({
        let reg = reg.clone();
        move || {
            let mut c = reg.lock();
            before_write();
            c.write_now(ticket, &bytes).map_err(|e| e.to_string())
        }
    })
    .await;
    match joined {
        Ok(r) => r,
        Err(e) => {
            // the thread didn't finish (it panicked, or the runtime is going): nothing it wrote stands
            reg.lock().forget(ticket);
            Err(e.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{sync::mpsc, time::Duration};

    use super::*;

    fn setup() -> (tempfile::TempDir, Arc<Registry>, PathBuf) {
        let base = tempfile::tempdir().unwrap();
        let reg = Arc::new(Registry::default());
        let dir = reg.lock().set_dir(base.path());
        reg.lock().open_for("store-a");
        (base, reg, dir)
    }

    /// Review 61pbw7g4, the order it named, every time: the ticket is taken, the download is under way, the app quits,
    /// and only then do the bytes arrive. Nothing is written, and nothing new registers.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_download_that_completes_after_quit_cleanup_leaves_no_file() {
        let (_base, reg, dir) = setup();
        let (ticket, file) = reg.lock().register("store-a", "plan.pdf").unwrap();
        // ... downloading ...
        reg.lock().close();
        // the bytes arrive
        assert_eq!(write_copy(reg.clone(), ticket, b"made-up decrypted bytes".to_vec(), || {}).await, Ok(false));
        assert!(!file.exists(), "a decrypted copy was written after quit cleanup");
        assert!(!dir.exists(), "quit left this launch's directory (or the late write made it again)");
        assert_eq!(reg.lock().register("store-a", "other.pdf"), Err(Refused::Closed));
        // an account starting after quit doesn't reopen it
        reg.lock().open_for("store-b");
        assert_eq!(reg.lock().register("store-b", "other.pdf"), Err(Refused::Closed));
        assert_eq!(reg.lock().len(), 0);
    }

    /// The same order for an account that ends (signed out, replaced): its open never writes, and never registers again,
    /// even if it asks under its old account's name.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_download_that_completes_after_its_account_ended_leaves_no_file() {
        let (_base, reg, _dir) = setup();
        let (ticket, file) = reg.lock().register("store-a", "plan.pdf").unwrap();
        reg.lock().end_account();
        assert_eq!(write_copy(reg.clone(), ticket, b"made-up".to_vec(), || {}).await, Ok(false));
        assert!(!file.exists());
        assert_eq!(reg.lock().register("store-a", "again.pdf"), Err(Refused::Closed));
        // the next account opens files as before
        reg.lock().open_for("store-b");
        let (t, f) = reg.lock().register("store-b", "plan.pdf").unwrap();
        assert_eq!(write_copy(reg.clone(), t, b"made-up".to_vec(), || {}).await, Ok(true));
        assert!(f.exists() && reg.lock().stands(t));
        // and it goes when that account does
        reg.lock().end_account();
        assert!(!f.exists() && !reg.lock().stands(t));
    }

    /// A write under way when the app quits: quit waits for that one write (it holds the lock), then removes it with the
    /// directory. Held on the writer's thread so the order is the same every time.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn quit_during_a_write_removes_it_with_the_directory() {
        let (_base, reg, dir) = setup();
        let (ticket, file) = reg.lock().register("store-a", "plan.pdf").unwrap();
        let (reached_tx, reached) = mpsc::channel::<()>();
        let (go, go_rx) = mpsc::channel::<()>();
        let writer = tokio::spawn(write_copy(reg.clone(), ticket, b"made-up decrypted bytes".to_vec(), move || {
            reached_tx.send(()).unwrap();
            go_rx.recv().unwrap();
        }));
        reached.recv().unwrap();
        let quitting = {
            let reg = reg.clone();
            std::thread::spawn(move || reg.lock().close())
        };
        std::thread::sleep(Duration::from_millis(50));
        assert!(!quitting.is_finished(), "quit didn't wait for the write under way");
        go.send(()).unwrap();
        quitting.join().unwrap();
        assert_eq!(writer.await.unwrap(), Ok(true));
        assert!(!file.exists() && !dir.exists(), "a copy written as the app quit survived it");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_writer_that_panics_leaves_no_registration() {
        let (_base, reg, _dir) = setup();
        let (ticket, file) = reg.lock().register("store-a", "plan.pdf").unwrap();
        let got = write_copy(reg.clone(), ticket, b"made-up".to_vec(), || panic!("made-up failure on the writer's thread")).await;
        assert!(got.is_err());
        assert!(!file.exists() && !reg.lock().stands(ticket));
        // and the lock it poisoned still works for cleanup
        reg.lock().close();
    }

    /// The next start, before Messages opens: what earlier launches left is removed; anything else in the folder stays.
    #[test]
    fn the_next_start_removes_copies_an_earlier_launch_left() {
        let base = tempfile::tempdir().unwrap();
        let left = base.path().join(format!("{DIR_PREFIX}0123abcd"));
        std::fs::create_dir_all(&left).unwrap();
        std::fs::write(left.join("plan.pdf"), b"made-up decrypted bytes").unwrap();
        let cached = base.path().join("0f".repeat(32));
        std::fs::write(&cached, b"another feature's cache").unwrap();
        // a file that only looks like one of ours stays: only directories are copies
        let lookalike = base.path().join(format!("{DIR_PREFIX}note.txt"));
        std::fs::write(&lookalike, b"x").unwrap();
        let reg = Registry::default();
        let dir = reg.lock().set_dir(base.path());
        assert!(!left.exists(), "an earlier launch's copies survived the next start");
        assert!(cached.exists() && lookalike.exists());
        assert!(dir.starts_with(base.path()) && dir.file_name().unwrap().to_string_lossy().starts_with(DIR_PREFIX));
    }

    #[test]
    fn an_attachment_name_stays_one_plain_file() {
        assert_eq!(file_name("voice note.ogg"), "voice note.ogg");
        assert_eq!(file_name("../../.bashrc"), "bashrc");
        assert_eq!(file_name("a/b\\c:d.pdf"), "abcd.pdf");
        assert_eq!(file_name("..."), "attachment");
        assert_eq!(file_name("\u{0}\n"), "attachment");
        assert_eq!(file_name(&"x".repeat(300)).len(), 100);
    }

    #[test]
    fn nothing_registers_without_a_directory_or_for_another_account() {
        let reg = Registry::default();
        reg.lock().open_for("store-a");
        assert_eq!(reg.lock().register("store-a", "x"), Err(Refused::NoDir));
        let base = tempfile::tempdir().unwrap();
        reg.lock().set_dir(base.path());
        assert_eq!(reg.lock().register("store-b", "x"), Err(Refused::Closed));
        assert!(reg.lock().register("store-a", "x").is_ok());
    }
}
