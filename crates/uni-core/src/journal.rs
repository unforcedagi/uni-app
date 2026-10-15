//! Journal outbox: entries are saved on the device first, then sent to the
//! Parachute vault when the hub is reachable. A voice entry keeps its audio
//! here until the upload succeeds, so nothing is lost offline.
//!
//! Each entry gets a device-side `entry_id` (UUID) recorded in the note's
//! metadata. Sending is idempotent: `create-note` uses `if_exists: ignore`
//! on the entry's path, and a note that comes back with a different
//! `entry_id` is a path collision, so the entry moves to its next path and
//! tries again.
//!
//! Paths (0.1.46): the device files an entry where the server's T-60 sweep
//! would, `Journal/YYYY/MM-DD/HH-MM <first words>` (local time), and hands
//! over the sweep's clash fallbacks as `alternates` (`HH-MM-SS`, then more
//! words; never `-1`). When all of those are taken the entry still saves, at
//! `HH-MM-SS <title> (2)`…, last `(<entry id>)`. An entry queued by an older
//! build keeps its `Notes/YYYY/MM-DD/HH-MM-SS` path and the old `-N`
//! fallback; the sweep files it.
//!
//! A retry is the same composer send again, known by its submission id (or
//! entry id), never by its words: it queues nothing. Other words-for-words
//! the same as an entry still waiting, or sent in the last ten minutes, are
//! held back until the user chooses to save another or keep one.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::parachute::{NewEntry, VaultClient, TRANSCRIPT_PENDING};
use crate::{Error, Result, Store};

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS journal_outbox (
    entry_id    TEXT PRIMARY KEY,
    path        TEXT NOT NULL,
    content     TEXT NOT NULL,
    source      TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    audio       BLOB,
    audio_mime  TEXT,
    note_id     TEXT,
    audio_sent  INTEGER NOT NULL DEFAULT 0,
    attempts    INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT,
    queued_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS journal_sent (
    entry_id    TEXT PRIMARY KEY,
    content     TEXT NOT NULL,
    note_id     TEXT NOT NULL,
    sent_at     INTEGER NOT NULL
);
"#;

/// How long a sent entry's words still count as "already saved".
pub const DUPLICATE_WINDOW_SECS: i64 = 600;

pub(crate) fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(SCHEMA)?;
    // JSON array of paths to try, in order, when `path` is taken.
    add_column(conn, "journal_outbox", "alternates")?;
    // The composer send this entry came from (0.1.46 fix): a retry of the same
    // send is recognised by it (or the entry id), never by its words.
    add_column(conn, "journal_outbox", "submission_id")?;
    add_column(conn, "journal_sent", "submission_id")?;
    add_column(conn, "journal_sent", "created_at")?;
    add_column(conn, "journal_sent", "source")?;
    Ok(())
}

fn add_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<()> {
    let has: bool = conn.query_row(
        &format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name=?1"),
        [column],
        |r| r.get::<_, i64>(0),
    )? > 0;
    if !has {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} TEXT"))?;
    }
    Ok(())
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

/// A queued entry as the UI shows it (no audio bytes).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct QueuedEntry {
    pub entry_id: String,
    pub path: String,
    pub content: String,
    pub source: String,
    pub created_at: String,
    pub has_audio: bool,
    pub note_id: Option<String>,
    pub attempts: i64,
    pub last_error: Option<String>,
    #[serde(skip)]
    pub alternates: Vec<String>,
}

/// What queueing an entry did.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub enum Queued {
    /// Queued as a new entry.
    New,
    /// This composer send (its submission id or entry id) is already queued
    /// or was sent: a retry of the same send, so nothing new is queued.
    Retry,
    /// Other words-for-words the same as an entry waiting or recently saved.
    /// Nothing is queued until the user chooses (save another, or keep one).
    SameWords(SameWords),
}

/// The entry a new one has the same words as.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SameWords {
    /// `waiting` (still on the device: its `entry_id`) or `saved` (in the
    /// vault in the last ten minutes: its note id).
    pub kind: &'static str,
    pub id: String,
    /// When that entry was made (the UI says "your 7:43 entry").
    pub created_at: String,
}

/// One composer send: `id` is made once per send and kept across retries of
/// it; `save_another` is the user's answer to [`Queued::SameWords`].
#[derive(Debug, Clone, Copy)]
pub struct Submission<'a> {
    pub id: &'a str,
    pub save_another: bool,
}

/// What one flush did.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct FlushReport {
    pub sent: Vec<String>,
    pub remaining: usize,
    pub error: Option<String>,
    /// Set when the entry just saved has the same words as another and
    /// nothing was queued: the app asks before saving it.
    pub duplicate: Option<SameWords>,
}

/// Validate a device-built note path. `Journal/YYYY/MM-DD/HH-MM[-SS][ <first
/// words>]` (0.1.46 on), or the old `Notes/…` with plain segments only (still
/// queued on devices from older builds).
pub fn check_path(path: &str) -> Result<()> {
    let segs: Vec<&str> = path.split('/').collect();
    let plain = |s: &str| !s.is_empty() && s != "." && s != "..";
    let digits = |s: &str, n: usize| s.len() == n && s.bytes().all(|b| b.is_ascii_digit());
    let ok = if path.starts_with("Notes/") {
        path.len() <= 200
            && segs.iter().all(|s| plain(s))
            && path
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_'))
    } else if let ["Journal", year, day, name] = segs.as_slice() {
        let (stamp, title) = name.split_once(' ').unwrap_or((name, ""));
        let hm = stamp.split('-').collect::<Vec<_>>();
        path.chars().count() <= 300
            && digits(year, 4)
            && day.len() == 5
            && digits(&day[..2], 2)
            && &day[2..3] == "-"
            && digits(&day[3..], 2)
            && matches!(hm.len(), 2 | 3)
            && hm.iter().all(|p| digits(p, 2))
            && (stamp == *name || !title.trim().is_empty())
            && !title.starts_with(' ')
            && !title.ends_with(' ')
            && title
                .chars()
                .all(|c| !c.is_control() && !"\\/[]#|:*?\"<>^{}`~".contains(c))
    } else {
        false
    };
    if ok {
        Ok(())
    } else {
        Err(Error::Invalid(format!("bad journal path: {path}")))
    }
}

impl Store {
    /// Queue an entry as its own composer send (submission id = entry id).
    #[allow(clippy::too_many_arguments)]
    pub fn journal_queue(
        &self,
        entry_id: &str,
        path: &str,
        alternates: &[String],
        content: &str,
        source: &str,
        created_at: &str,
        audio: Option<(&[u8], &str)>,
        now: i64,
    ) -> Result<Queued> {
        let send = Submission {
            id: entry_id,
            save_another: false,
        };
        self.journal_submit(
            send, entry_id, path, alternates, content, source, created_at, audio, now,
        )
    }

    /// Queue an entry. Voice entries carry audio and start as a placeholder.
    /// The same send again (its submission id or entry id) is a retry and
    /// queues nothing. A text entry whose words match one still waiting, or
    /// one sent in the last ten minutes, is held back as
    /// [`Queued::SameWords`] unless the user chose to save another.
    #[allow(clippy::too_many_arguments)]
    pub fn journal_submit(
        &self,
        send: Submission<'_>,
        entry_id: &str,
        path: &str,
        alternates: &[String],
        content: &str,
        source: &str,
        created_at: &str,
        audio: Option<(&[u8], &str)>,
        now: i64,
    ) -> Result<Queued> {
        check_path(path)?;
        for p in alternates {
            check_path(p)?;
        }
        if alternates.len() > 8 {
            return Err(Error::Invalid("too many alternate paths".into()));
        }
        if uuid::Uuid::parse_str(entry_id).is_err() || uuid::Uuid::parse_str(send.id).is_err() {
            return Err(Error::Invalid("entry and submission ids must be UUIDs".into()));
        }
        self.conn.execute(
            "DELETE FROM journal_sent WHERE sent_at < ?1",
            [now - DUPLICATE_WINDOW_SECS],
        )?;
        if self.journal_is_retry(send.id, entry_id)? {
            return Ok(Queued::Retry);
        }
        if audio.is_none() && !send.save_another {
            if let Some(same) = self.journal_same_words(content)? {
                return Ok(Queued::SameWords(same));
            }
        }
        let content = match audio {
            Some(_) if content.trim().is_empty() => TRANSCRIPT_PENDING.to_string(),
            Some(_) => format!("{}\n\n{TRANSCRIPT_PENDING}", content.trim()),
            None if content.trim().is_empty() => return Err(Error::Invalid("empty entry".into())),
            None => content.to_string(),
        };
        if let Some((bytes, _)) = audio {
            if bytes.is_empty() || bytes.len() > crate::parachute::MAX_AUDIO_BYTES {
                return Err(Error::Invalid("audio is empty or too large".into()));
            }
        }
        let alternates = (!alternates.is_empty())
            .then(|| serde_json::to_string(alternates))
            .transpose()
            .map_err(|e| Error::Invalid(e.to_string()))?;
        self.conn.execute(
            "INSERT OR IGNORE INTO journal_outbox
               (entry_id, path, content, source, created_at, audio, audio_mime, queued_at, alternates, submission_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                entry_id,
                path,
                content,
                source,
                created_at,
                audio.map(|a| a.0),
                audio.map(|a| a.1),
                now,
                alternates,
                send.id
            ],
        )?;
        Ok(Queued::New)
    }

    /// This send (by submission id or entry id) is already queued, or was
    /// sent within the window.
    fn journal_is_retry(&self, submission_id: &str, entry_id: &str) -> Result<bool> {
        let n: i64 = self.conn.query_row(
            "SELECT (SELECT COUNT(*) FROM journal_outbox WHERE entry_id = ?2 OR submission_id = ?1)
                  + (SELECT COUNT(*) FROM journal_sent WHERE entry_id = ?2 OR submission_id = ?1)",
            params![submission_id, entry_id],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }

    /// A text entry with the same words (trimmed) waiting, or sent within the
    /// window (the sent table was pruned by the caller).
    fn journal_same_words(&self, content: &str) -> Result<Option<SameWords>> {
        let words = content.trim();
        if words.is_empty() {
            return Ok(None);
        }
        if let Some(q) = self
            .journal_pending()?
            .into_iter()
            .find(|q| q.source == "text" && !q.has_audio && q.content.trim() == words)
        {
            return Ok(Some(SameWords {
                kind: "waiting",
                id: q.entry_id,
                created_at: q.created_at,
            }));
        }
        let mut st = self.conn.prepare(
            "SELECT content, note_id, COALESCE(created_at, '') FROM journal_sent
             WHERE COALESCE(source, 'text') = 'text' ORDER BY sent_at DESC",
        )?;
        let sent = st
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(sent
            .into_iter()
            .find(|(c, _, _)| c.trim() == words)
            .map(|(_, note, created_at)| SameWords {
                kind: "saved",
                id: note,
                created_at,
            }))
    }

    /// Remember a sent entry for the window: its send (a retry of it is not
    /// queued again) and, for text, its words.
    fn journal_mark_sent(&self, e: &QueuedEntry, note_id: &str, now: i64) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO journal_sent (entry_id, content, note_id, sent_at, submission_id, created_at, source)
             VALUES (?1, ?2, ?3, ?4, (SELECT submission_id FROM journal_outbox WHERE entry_id = ?1), ?5, ?6)",
            params![e.entry_id, e.content, note_id, now, e.created_at, e.source],
        )?;
        Ok(())
    }

    /// The note a sent entry became, while the window remembers it.
    pub fn journal_sent_note(&self, entry_id: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT note_id FROM journal_sent WHERE entry_id = ?1",
                [entry_id],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// Entries not yet fully in the vault, oldest first.
    pub fn journal_pending(&self) -> Result<Vec<QueuedEntry>> {
        let mut st = self.conn.prepare(
            "SELECT entry_id, path, content, source, created_at, audio IS NOT NULL,
                    note_id, attempts, last_error, alternates
             FROM journal_outbox ORDER BY queued_at, entry_id",
        )?;
        let rows = st.query_map([], |r| {
            Ok(QueuedEntry {
                entry_id: r.get(0)?,
                path: r.get(1)?,
                content: r.get(2)?,
                source: r.get(3)?,
                created_at: r.get(4)?,
                has_audio: r.get(5)?,
                note_id: r.get(6)?,
                attempts: r.get(7)?,
                last_error: r.get(8)?,
                alternates: r
                    .get::<_, Option<String>>(9)?
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_default(),
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    fn journal_audio(&self, entry_id: &str) -> Result<Option<(Vec<u8>, String)>> {
        Ok(self
            .conn
            .query_row(
                "SELECT audio, audio_mime FROM journal_outbox WHERE entry_id = ?1 AND audio IS NOT NULL AND audio_sent = 0",
                [entry_id],
                |r| Ok((r.get::<_, Vec<u8>>(0)?, r.get::<_, Option<String>>(1)?)),
            )
            .optional()?
            .map(|(b, m)| (b, m.unwrap_or_else(|| "audio/webm".into()))))
    }

    /// The vault note now exists; a retry only needs the audio.
    fn journal_set_note(&self, entry_id: &str, note_id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE journal_outbox SET note_id = ?2 WHERE entry_id = ?1",
            params![entry_id, note_id],
        )?;
        Ok(())
    }

    /// The audio is in the vault; drop the local copy.
    fn journal_audio_sent(&self, entry_id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE journal_outbox SET audio_sent = 1, audio = NULL WHERE entry_id = ?1",
            [entry_id],
        )?;
        Ok(())
    }

    fn journal_failed(&self, entry_id: &str, error: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE journal_outbox SET attempts = attempts + 1, last_error = ?2 WHERE entry_id = ?1",
            params![entry_id, error],
        )?;
        Ok(())
    }

    fn journal_remove(&self, entry_id: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM journal_outbox WHERE entry_id = ?1", [entry_id])?;
        Ok(())
    }
}

/// Send every queued entry, oldest first. A failed entry records its error and
/// stays queued for the next flush; the rest still go (one bad entry must not
/// hold the journal hostage). Only an unreachable hub stops the pass, since it
/// would fail every remaining entry the same way.
pub async fn flush(store: &Store, client: &VaultClient) -> Result<FlushReport> {
    let mut report = FlushReport::default();
    for entry in store.journal_pending()? {
        match send_one(store, client, &entry).await {
            Ok(note_id) => {
                store.journal_mark_sent(&entry, &note_id, now_secs())?;
                store.journal_remove(&entry.entry_id)?;
                report.sent.push(note_id);
            }
            Err(e) => {
                let msg = e.to_string();
                store.journal_failed(&entry.entry_id, &msg)?;
                let offline = msg.contains("hub unreachable");
                report.error = Some(msg);
                if offline {
                    break;
                }
            }
        }
    }
    report.remaining = store.journal_pending()?.len();
    Ok(report)
}

/// The paths to try for an entry, in order. A `Journal/` entry has the
/// sweep's fallbacks from the device (never `-N`), then the last resort (see
/// [`last_resort_paths`]); an old `Notes/` entry keeps the old `-2`…`-9`
/// suffixes, which the sweep still recognises.
pub fn paths_to_try(e: &QueuedEntry) -> Vec<String> {
    let mut out = vec![e.path.clone()];
    if e.path.starts_with("Notes/") {
        out.extend((2..=9).map(|n| format!("{}-{n}", e.path)));
    } else {
        out.extend(e.alternates.iter().cloned());
        for p in last_resort_paths(e) {
            if !out.iter().any(|o| o.eq_ignore_ascii_case(&p)) {
                out.push(p);
            }
        }
    }
    out
}

/// When the minute, the seconds and the longer titles are all taken, an
/// entry is never stuck: `HH-MM-SS <title> (2)`…`(9)` (time-only for a voice
/// entry still transcribing: `HH-MM-SS (2)`), then `(<entry id>)`, which no
/// other entry can hold. The sweep's `CANON` takes any title after the
/// stamp, so it leaves these where they are.
pub fn last_resort_paths(e: &QueuedEntry) -> Vec<String> {
    let has_seconds = |p: &str| {
        let name = p.rsplit('/').next().unwrap_or_default();
        let stamp = name.split(' ').next().unwrap_or_default();
        stamp.split('-').count() == 3
    };
    let base = std::iter::once(&e.path)
        .chain(e.alternates.iter())
        .find(|p| has_seconds(p))
        .unwrap_or(&e.path);
    (2..=9)
        .map(|n| n.to_string())
        .chain(std::iter::once(e.entry_id.clone()))
        .map(|n| format!("{base} ({n})"))
        .filter(|p| check_path(p).is_ok())
        .collect()
}

async fn send_one(store: &Store, client: &VaultClient, e: &QueuedEntry) -> Result<String> {
    let note_id = match &e.note_id {
        Some(id) => id.clone(),
        None => {
            // A retry may follow a write whose answer was lost (on another path
            // than the first one tried): look for this entry before writing again.
            // A lookup that fails is no answer: the entry stays queued, and only
            // a lookup that succeeded and found nothing lets it write.
            let found = if e.attempts > 0 {
                client.find_entry(&e.entry_id).await?
            } else {
                None
            };
            let note = match found {
                Some(note) => note,
                None => create_on_free_path(client, e).await?,
            };
            store.journal_set_note(&e.entry_id, &note.id)?;
            note.id
        }
    };
    if let Some((bytes, mime)) = store.journal_audio(&e.entry_id)? {
        let ext = if mime.contains("mp4") || mime.contains("m4a") {
            "m4a"
        } else if mime.contains("ogg") {
            "ogg"
        } else {
            "webm"
        };
        client
            .upload_audio(&note_id, &format!("voice.{ext}"), &mime, bytes)
            .await?;
        store.journal_audio_sent(&e.entry_id)?;
    }
    Ok(note_id)
}

async fn create_on_free_path(
    client: &VaultClient,
    e: &QueuedEntry,
) -> Result<crate::parachute::JournalNote> {
    for path in paths_to_try(e) {
        let note = client
            .create_entry(&NewEntry {
                path,
                content: e.content.clone(),
                source: e.source.clone(),
                created_at: Some(e.created_at.clone()),
                entry_id: Some(e.entry_id.clone()),
            })
            .await?;
        if note.entry_id.as_deref() == Some(e.entry_id.as_str()) {
            return Ok(note);
        }
    }
    Err(Error::Vault(format!("path taken: {}", e.path)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "7d6f2c1e-0a4b-4f7e-9c2d-1b3a5e7f9a0b";

    #[test]
    fn queue_validates_and_lists() {
        let s = Store::open_in_memory().unwrap();
        assert!(s
            .journal_queue(ID, "../etc", &[], "x", "text", "t", None, 1)
            .is_err());
        assert!(s
            .journal_queue(
                ID,
                "Notes/2026/09-25/10-00-00",
                &[],
                " ",
                "text",
                "t",
                None,
                1
            )
            .is_err());
        assert!(s
            .journal_queue("nope", "Notes/a", &[], "x", "text", "t", None, 1)
            .is_err());
        s.journal_queue(
            ID,
            "Notes/2026/09-25/10-00-00",
            &[],
            "hi",
            "text",
            "t",
            None,
            1,
        )
        .unwrap();
        // Idempotent on entry id.
        s.journal_queue(
            ID,
            "Notes/2026/09-25/10-00-00",
            &[],
            "hi",
            "text",
            "t",
            None,
            1,
        )
        .unwrap();
        let p = s.journal_pending().unwrap();
        assert_eq!(p.len(), 1);
        assert!(!p[0].has_audio);
    }

    #[test]
    fn voice_entry_is_placeholder_with_audio() {
        let s = Store::open_in_memory().unwrap();
        let audio: &[u8] = b"abc";
        s.journal_queue(
            ID,
            "Notes/2026/09-25/10-00-00",
            &[],
            "",
            "voice",
            "t",
            Some((audio, "audio/webm")),
            1,
        )
        .unwrap();
        let p = s.journal_pending().unwrap();
        assert_eq!(p[0].content, TRANSCRIPT_PENDING);
        assert!(p[0].has_audio);
        assert_eq!(s.journal_audio(ID).unwrap().unwrap().0, b"abc");
    }

    #[test]
    fn outbox_marks_progress() {
        let s = Store::open_in_memory().unwrap();
        let audio: &[u8] = b"abc";
        let path = "Notes/2026/09-25/10-00-00";
        s.journal_queue(
            ID,
            path,
            &[],
            "",
            "voice",
            "t",
            Some((audio, "audio/ogg")),
            1,
        )
        .unwrap();
        s.journal_failed(ID, "offline").unwrap();
        s.journal_set_note(ID, "n1").unwrap();
        let p = &s.journal_pending().unwrap()[0];
        assert_eq!(
            (p.attempts, p.last_error.as_deref(), p.note_id.as_deref()),
            (1, Some("offline"), Some("n1"))
        );
        assert_eq!(s.journal_audio(ID).unwrap().unwrap().1, "audio/ogg");
        s.journal_audio_sent(ID).unwrap();
        assert!(s.journal_audio(ID).unwrap().is_none());
        assert!(!s.journal_pending().unwrap()[0].has_audio);
        s.journal_remove(ID).unwrap();
        assert!(s.journal_pending().unwrap().is_empty());
    }

    const ID2: &str = "8e7a3d2f-1b5c-4a8f-8d3e-2c4b6f8a0b1c";
    const ID3: &str = "9f8b4e3a-2c6d-4b9a-9e4f-3d5c7a9b1c2d";

    #[test]
    fn journal_paths_are_checked() {
        for ok in [
            "Journal/2026/10-14/19-43 Placeholder words about the morning",
            "Journal/2026/10-14/19-43-10 Placeholder words, it's fine",
            "Journal/2026/10-14/19-43",
            "Journal/2026/10-14/19-43-10",
            "Journal/2026/10-14/07-05 Café – über 5 things",
            "Notes/2026/10-14/19-43-10",
            "Notes/2026/10-14/19-43-10-2",
        ] {
            assert!(check_path(ok).is_ok(), "{ok}");
        }
        for bad in [
            "Journal/2026/10-14/19-43 ",
            "Journal/2026/10-14/19-43  two",
            "Journal/2026/10-14/1943 words",
            "Journal/26/10-14/19-43 words",
            "Journal/2026/1014/19-43 words",
            "Journal/2026/10-14/19-43 a/b",
            "Journal/2026/10-14/19-43 a#b",
            "Journal/2026/10-14/19-43 a:b",
            "Journal/2026/10-14/19-43 a\nb",
            "Journal/2026/10-14/x/19-43 words",
            "Journal/../10-14/19-43 words",
            "Inbox/2026/10-14/19-43 words",
            "Notes/2026/10-14/19 43",
        ] {
            assert!(check_path(bad).is_err(), "{bad}");
        }
    }

    const SEND: &str = "a1b2c3d4-0000-4000-8000-000000000001";
    const SEND2: &str = "a1b2c3d4-0000-4000-8000-000000000002";

    fn send(id: &str, save_another: bool) -> Submission<'_> {
        Submission { id, save_another }
    }

    #[test]
    fn same_words_are_held_back_until_the_user_chooses_while_waiting_and_for_ten_minutes_after() {
        let s = Store::open_in_memory().unwrap();
        let p1 = "Journal/2026/10-14/19-43 A placeholder entry about the garden";
        let p2 = "Journal/2026/10-14/19-46 A placeholder entry about the garden";
        let words = "A placeholder entry about the garden.";
        let at = "2026-10-15T01:43:10.000Z";
        let submit = |send: Submission<'_>, id: &str, path: &str, words: &str, now: i64| {
            s.journal_submit(send, id, path, &[], words, "text", at, None, now)
                .unwrap()
        };
        assert_eq!(submit(send(SEND, false), ID, p1, words, 100), Queued::New);
        // another send with the same words (stray whitespace) while the first waits: held back, nothing queued
        let waiting = Queued::SameWords(SameWords {
            kind: "waiting",
            id: ID.into(),
            created_at: at.into(),
        });
        assert_eq!(
            submit(send(SEND2, false), ID2, p2, &format!("  {words}\n"), 280),
            waiting
        );
        assert_eq!(s.journal_pending().unwrap().len(), 1);
        // other words are a new entry
        assert_eq!(
            submit(send(ID3, false), ID3, p2, "Different placeholder words", 282),
            Queued::New
        );
        s.journal_remove(ID3).unwrap();
        // sent: the same words within ten minutes are held back as "saved", with the entry's time
        let e = s.journal_pending().unwrap().remove(0);
        s.journal_mark_sent(&e, "note-1", 300).unwrap();
        s.journal_remove(ID).unwrap();
        assert_eq!(
            submit(send(SEND2, false), ID2, p2, words, 300 + DUPLICATE_WINDOW_SECS - 1),
            Queued::SameWords(SameWords {
                kind: "saved",
                id: "note-1".into(),
                created_at: at.into(),
            })
        );
        assert!(s.journal_pending().unwrap().is_empty());
        // after the window the same words are simply a new entry
        assert_eq!(
            submit(send(SEND2, false), ID2, p2, words, 301 + DUPLICATE_WINDOW_SECS),
            Queued::New
        );
    }

    #[test]
    fn save_another_queues_the_same_words_as_a_second_entry() {
        let s = Store::open_in_memory().unwrap();
        let p1 = "Journal/2026/10-14/19-43 Placeholder check-in";
        let p2 = "Journal/2026/10-14/19-48 Placeholder check-in";
        let words = "Placeholder check-in";
        s.journal_submit(send(SEND, false), ID, p1, &[], words, "text", "t", None, 100)
            .unwrap();
        assert!(matches!(
            s.journal_submit(send(SEND2, false), ID2, p2, &[], words, "text", "t", None, 101)
                .unwrap(),
            Queued::SameWords(_)
        ));
        // the user chose "Save another": the same send, now allowed
        assert_eq!(
            s.journal_submit(send(SEND2, true), ID2, p2, &[], words, "text", "t", None, 102)
                .unwrap(),
            Queued::New
        );
        let ids: Vec<String> = s
            .journal_pending()
            .unwrap()
            .into_iter()
            .map(|q| q.entry_id)
            .collect();
        assert_eq!(ids, vec![ID.to_string(), ID2.to_string()]);
    }

    #[test]
    fn a_retry_of_the_same_send_queues_nothing_and_is_not_same_words() {
        let s = Store::open_in_memory().unwrap();
        let p = "Journal/2026/10-14/19-43 Placeholder words";
        let words = "Placeholder words";
        assert_eq!(
            s.journal_submit(send(SEND, false), ID, p, &[], words, "text", "t", None, 100)
                .unwrap(),
            Queued::New
        );
        // the same send retried (same submission and entry id): a retry, never "same words"
        assert_eq!(
            s.journal_submit(send(SEND, false), ID, p, &[], words, "text", "t", None, 101)
                .unwrap(),
            Queued::Retry
        );
        // the same submission id under a new entry id is still that send
        assert_eq!(
            s.journal_submit(send(SEND, false), ID2, p, &[], words, "text", "t", None, 102)
                .unwrap(),
            Queued::Retry
        );
        assert_eq!(s.journal_pending().unwrap().len(), 1);
        // once sent, a retry of it is not queued again
        let e = s.journal_pending().unwrap().remove(0);
        s.journal_mark_sent(&e, "note-1", 200).unwrap();
        s.journal_remove(ID).unwrap();
        assert_eq!(
            s.journal_submit(send(SEND, true), ID, p, &[], words, "text", "t", None, 201)
                .unwrap(),
            Queued::Retry
        );
        assert!(s.journal_pending().unwrap().is_empty());
        assert!(s
            .journal_submit(send("not-a-uuid", false), ID3, p, &[], words, "text", "t", None, 202)
            .is_err());
    }

    #[test]
    fn a_voice_entry_is_never_a_duplicate() {
        let s = Store::open_in_memory().unwrap();
        let audio: &[u8] = b"abc";
        let p = "Journal/2026/10-14/19-43";
        assert_eq!(
            s.journal_queue(ID, p, &[], "", "voice", "t", Some((audio, "audio/webm")), 1)
                .unwrap(),
            Queued::New
        );
        assert_eq!(
            s.journal_queue(
                ID2,
                p,
                &[],
                "",
                "voice",
                "t",
                Some((audio, "audio/webm")),
                2
            )
            .unwrap(),
            Queued::New
        );
        assert_eq!(s.journal_pending().unwrap().len(), 2);
    }

    #[test]
    fn alternates_are_kept_and_checked() {
        let s = Store::open_in_memory().unwrap();
        let alts = vec!["Journal/2026/10-14/19-43-10 Placeholder".to_string()];
        s.journal_queue(
            ID,
            "Journal/2026/10-14/19-43 Placeholder",
            &alts,
            "Placeholder",
            "text",
            "t",
            None,
            1,
        )
        .unwrap();
        let e = &s.journal_pending().unwrap()[0];
        let tried = paths_to_try(e);
        assert_eq!(
            tried[..4],
            [
                "Journal/2026/10-14/19-43 Placeholder".to_string(),
                alts[0].clone(),
                "Journal/2026/10-14/19-43-10 Placeholder (2)".to_string(),
                "Journal/2026/10-14/19-43-10 Placeholder (3)".to_string(),
            ]
        );
        assert_eq!(
            tried.last().unwrap(),
            &format!("Journal/2026/10-14/19-43-10 Placeholder ({ID})")
        );
        assert_eq!(tried.len(), 2 + 8 + 1);
        assert!(s
            .journal_queue(
                ID2,
                "Journal/2026/10-14/19-43 Other",
                &["../x".into()],
                "Other",
                "text",
                "t",
                None,
                1
            )
            .is_err());
        // an old Notes/ entry keeps the old -N suffixes
        s.journal_queue(
            ID3,
            "Notes/2026/10-14/19-43-10",
            &[],
            "Old",
            "text",
            "t",
            None,
            1,
        )
        .unwrap();
        let old = s
            .journal_pending()
            .unwrap()
            .into_iter()
            .find(|q| q.entry_id == ID3)
            .unwrap();
        let tried = paths_to_try(&old);
        assert_eq!(
            (tried[0].as_str(), tried[1].as_str(), tried.len()),
            (
                "Notes/2026/10-14/19-43-10",
                "Notes/2026/10-14/19-43-10-2",
                9
            )
        );
    }

    fn created(path: &str, entry_id: &str) -> serde_json::Value {
        serde_json::json!({"id": format!("n:{path}"), "path": path, "content": "x", "tags": ["journal"], "metadata": {"source": "text", "entry_id": entry_id}, "createdAt": "2026-10-15T01:43:10.000Z"})
    }
    fn create_args(path: &str, content: &str, entry_id: &str) -> serde_json::Value {
        serde_json::json!({"vault": "scope-test", "content": content, "path": path, "tags": ["journal"], "metadata": {"source": "text", "client": "uni-app", "entry_id": entry_id}, "if_exists": "ignore", "created_at": "2026-10-15T01:43:10.000Z"})
    }

    #[tokio::test]
    async fn an_old_notes_entry_still_flushes_tagged_journal() {
        crate::init_crypto();
        let path = "Notes/2026/10-14/19-43-10";
        let (client, handle) = crate::parachute::surface_tests::server(vec![(
            "create-note",
            create_args(path, "Placeholder words", ID),
            created(path, ID),
        )]);
        let s = Store::open_in_memory().unwrap();
        s.journal_queue(
            ID,
            path,
            &[],
            "Placeholder words",
            "text",
            "2026-10-15T01:43:10.000Z",
            None,
            1,
        )
        .unwrap();
        let r = flush(&s, &client).await.unwrap();
        handle.join().unwrap();
        assert_eq!(
            (r.sent, r.remaining, r.error),
            (vec![format!("n:{path}")], 0, None)
        );
    }

    #[tokio::test]
    async fn a_clash_adds_seconds_never_a_number() {
        crate::init_crypto();
        let p = "Journal/2026/10-14/19-43 Placeholder words";
        let alt = "Journal/2026/10-14/19-43-10 Placeholder words";
        let (client, handle) = crate::parachute::surface_tests::server(vec![
            // the minute's path holds another entry: the vault answers with that note
            (
                "create-note",
                create_args(p, "Placeholder words", ID),
                created(p, ID2),
            ),
            (
                "create-note",
                create_args(alt, "Placeholder words", ID),
                created(alt, ID),
            ),
        ]);
        let s = Store::open_in_memory().unwrap();
        s.journal_queue(
            ID,
            p,
            &[alt.into()],
            "Placeholder words",
            "text",
            "2026-10-15T01:43:10.000Z",
            None,
            1,
        )
        .unwrap();
        let r = flush(&s, &client).await.unwrap();
        handle.join().unwrap();
        assert_eq!(r.sent, vec![format!("n:{alt}")]);
        // and the words now count as saved
        assert_eq!(
            s.journal_queue(
                ID3,
                p,
                &[],
                "Placeholder words",
                "text",
                "t",
                None,
                now_secs()
            )
            .unwrap(),
            Queued::SameWords(SameWords {
                kind: "saved",
                id: format!("n:{alt}"),
                created_at: "2026-10-15T01:43:10.000Z".into(),
            })
        );
    }

    #[test]
    fn a_voice_entry_still_transcribing_falls_back_to_time_only_then_numbered() {
        let s = Store::open_in_memory().unwrap();
        let audio: &[u8] = b"abc";
        s.journal_queue(
            ID,
            "Journal/2026/10-14/19-43",
            &["Journal/2026/10-14/19-43-10".into()],
            "",
            "voice",
            "t",
            Some((audio, "audio/webm")),
            1,
        )
        .unwrap();
        let tried = paths_to_try(&s.journal_pending().unwrap()[0]);
        assert_eq!(
            tried[..3],
            [
                "Journal/2026/10-14/19-43".to_string(),
                "Journal/2026/10-14/19-43-10".to_string(),
                "Journal/2026/10-14/19-43-10 (2)".to_string(),
            ]
        );
        assert_eq!(
            tried.last().unwrap(),
            &format!("Journal/2026/10-14/19-43-10 ({ID})")
        );
        // the sweep's CANON (`Journal/YYYY/MM-DD/(HH-MM(-SS)? )?.+`) holds every candidate,
        // so it leaves them where they are; never a `-N` suffix
        for p in &tried {
            let b = p.as_bytes();
            assert!(!(b[b.len() - 2] == b'-' && b[b.len() - 1].is_ascii_digit()), "{p}");
            assert!(check_path(p).is_ok(), "{p}");
        }
    }

    #[tokio::test]
    async fn three_entries_at_the_same_second_all_save() {
        crate::init_crypto();
        let p = "Journal/2026/10-14/19-43 Placeholder words";
        let alt = "Journal/2026/10-14/19-43-10 Placeholder words";
        let last = "Journal/2026/10-14/19-43-10 Placeholder words (2)";
        let ids = [ID, ID2, ID3];
        let mut script = vec![];
        // the first takes the minute, the second the seconds, the third the last resort
        for (n, id) in ids.iter().enumerate() {
            for (k, path) in [p, alt, last].iter().enumerate().take(n + 1) {
                let holder = if k == n { id } else { &ids[k] };
                script.push((
                    "create-note",
                    create_args(path, "Placeholder words", id),
                    created(path, holder),
                ));
            }
        }
        let (client, handle) = crate::parachute::surface_tests::server(script);
        let s = Store::open_in_memory().unwrap();
        for (n, id) in ids.iter().enumerate() {
            // the same words each time: the user chose "Save another" for the second and third
            let send = Submission {
                id,
                save_another: n > 0,
            };
            assert_eq!(
                s.journal_submit(
                    send,
                    id,
                    p,
                    &[alt.into()],
                    "Placeholder words",
                    "text",
                    "2026-10-15T01:43:10.000Z",
                    None,
                    1,
                )
                .unwrap(),
                Queued::New
            );
        }
        let r = flush(&s, &client).await.unwrap();
        handle.join().unwrap();
        assert_eq!(
            (r.sent, r.remaining, r.error),
            (
                vec![format!("n:{p}"), format!("n:{alt}"), format!("n:{last}")],
                0,
                None
            )
        );
    }

    #[tokio::test]
    async fn a_retry_finds_its_own_earlier_write_by_entry_id() {
        crate::init_crypto();
        let p = "Journal/2026/10-14/19-43 Placeholder words";
        let alt = "Journal/2026/10-14/19-43-10 Placeholder words";
        let (client, handle) = crate::parachute::surface_tests::server(vec![(
            "query-notes",
            serde_json::json!({"vault": "scope-test", "tag": ["journal", "capture"], "tag_match": "any", "metadata": {"entry_id": ID}, "limit": 1, "include_content": true, "content_length": 2000, "include_metadata": ["source", "entry_id"]}),
            serde_json::json!({"notes": [created(alt, ID)]}),
        )]);
        let s = Store::open_in_memory().unwrap();
        s.journal_queue(
            ID,
            p,
            &[alt.into()],
            "Placeholder words",
            "text",
            "2026-10-15T01:43:10.000Z",
            None,
            1,
        )
        .unwrap();
        // the first try wrote at the alternate, but its answer was lost
        s.journal_failed(ID, "hub unreachable: reset").unwrap();
        let r = flush(&s, &client).await.unwrap();
        handle.join().unwrap();
        // found: marked sent with no create (the script holds no create-note)
        assert_eq!((r.sent, r.remaining), (vec![format!("n:{alt}")], 0));
        assert_eq!(
            s.journal_sent_note(ID).unwrap().as_deref(),
            Some(format!("n:{alt}").as_str())
        );
    }

    fn lookup_args() -> serde_json::Value {
        serde_json::json!({"vault": "scope-test", "tag": ["journal", "capture"], "tag_match": "any", "metadata": {"entry_id": ID}, "limit": 1, "include_content": true, "content_length": 2000, "include_metadata": ["source", "entry_id"]})
    }

    fn queue_retry(s: &Store, p: &str, alt: &str) {
        s.journal_queue(
            ID,
            p,
            &[alt.into()],
            "Placeholder words",
            "text",
            "2026-10-15T01:43:10.000Z",
            None,
            1,
        )
        .unwrap();
        s.journal_failed(ID, "hub unreachable: reset").unwrap();
    }

    #[tokio::test]
    async fn a_retry_whose_lookup_fails_never_creates_and_stays_queued() {
        crate::init_crypto();
        let p = "Journal/2026/10-14/19-43 Placeholder words";
        let alt = "Journal/2026/10-14/19-43-10 Placeholder words";
        // the lookup errors; the script holds no create-note, so a create would
        // meet a closed door and report "unreachable", not the lookup's 500
        let (client, handle) = crate::parachute::surface_tests::server(vec![(
            "query-notes",
            lookup_args(),
            serde_json::json!({"http_status": 500, "error": "index rebuilding"}),
        )]);
        let s = Store::open_in_memory().unwrap();
        queue_retry(&s, p, alt);
        let r = flush(&s, &client).await.unwrap();
        handle.join().unwrap();
        assert!(r.sent.is_empty());
        assert_eq!(r.remaining, 1);
        let err = r.error.unwrap();
        assert!(err.contains("hub error 500"), "{err}");
        let q = &s.journal_pending().unwrap()[0];
        assert_eq!((q.attempts, q.note_id.as_deref()), (2, None));
    }

    #[tokio::test]
    async fn a_retry_whose_lookup_finds_nothing_creates() {
        crate::init_crypto();
        let p = "Journal/2026/10-14/19-43 Placeholder words";
        let alt = "Journal/2026/10-14/19-43-10 Placeholder words";
        let (client, handle) = crate::parachute::surface_tests::server(vec![
            (
                "query-notes",
                lookup_args(),
                serde_json::json!({"notes": []}),
            ),
            (
                "create-note",
                create_args(p, "Placeholder words", ID),
                created(p, ID),
            ),
        ]);
        let s = Store::open_in_memory().unwrap();
        queue_retry(&s, p, alt);
        let r = flush(&s, &client).await.unwrap();
        handle.join().unwrap();
        assert_eq!((r.sent, r.remaining, r.error), (vec![format!("n:{p}")], 0, None));
    }
}
