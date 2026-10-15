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
//! words; never `-1`). An entry queued by an older build keeps its
//! `Notes/YYYY/MM-DD/HH-MM-SS` path and the old `-N` fallback; the sweep
//! files it.
//!
//! The same words saved twice (an entry that sat offline, then typed again)
//! make one entry: a text entry whose trimmed words match one still waiting,
//! or one sent in the last ten minutes, is not queued again.

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
    let has_alternates: bool = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('journal_outbox') WHERE name='alternates'",
        [],
        |r| r.get::<_, i64>(0),
    )? > 0;
    if !has_alternates {
        // JSON array of paths to try, in order, when `path` is taken.
        conn.execute_batch("ALTER TABLE journal_outbox ADD COLUMN alternates TEXT")?;
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
#[serde(tag = "kind", content = "id", rename_all = "lowercase")]
pub enum Queued {
    /// Queued as a new entry.
    New,
    /// The same words are already waiting to send (that entry's `entry_id`).
    Waiting(String),
    /// The same words reached the vault in the last ten minutes (its note id).
    Saved(String),
}

/// What one flush did.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct FlushReport {
    pub sent: Vec<String>,
    pub remaining: usize,
    pub error: Option<String>,
    /// Set when the entry just saved was a duplicate and nothing new was queued.
    pub duplicate: Option<Queued>,
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
    /// Queue an entry. Voice entries carry audio and start as a placeholder.
    /// A text entry whose words match one still waiting, or one sent in the
    /// last ten minutes, is not queued again: the existing one is returned.
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
        check_path(path)?;
        for p in alternates {
            check_path(p)?;
        }
        if alternates.len() > 8 {
            return Err(Error::Invalid("too many alternate paths".into()));
        }
        if uuid::Uuid::parse_str(entry_id).is_err() {
            return Err(Error::Invalid("entry id must be a UUID".into()));
        }
        if audio.is_none() {
            if let Some(dup) = self.journal_duplicate(entry_id, content, now)? {
                return Ok(dup);
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
               (entry_id, path, content, source, created_at, audio, audio_mime, queued_at, alternates)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                entry_id,
                path,
                content,
                source,
                created_at,
                audio.map(|a| a.0),
                audio.map(|a| a.1),
                now,
                alternates
            ],
        )?;
        Ok(Queued::New)
    }

    /// The same words (trimmed) already waiting, or sent within the window.
    /// The same `entry_id` again is not a duplicate (it is the same entry).
    fn journal_duplicate(&self, entry_id: &str, content: &str, now: i64) -> Result<Option<Queued>> {
        let words = content.trim();
        if words.is_empty() {
            return Ok(None);
        }
        self.conn.execute(
            "DELETE FROM journal_sent WHERE sent_at < ?1",
            [now - DUPLICATE_WINDOW_SECS],
        )?;
        if let Some(q) = self
            .journal_pending()?
            .into_iter()
            .find(|q| q.entry_id != entry_id && !q.has_audio && q.content.trim() == words)
        {
            return Ok(Some(Queued::Waiting(q.entry_id)));
        }
        let mut st = self
            .conn
            .prepare("SELECT entry_id, content, note_id FROM journal_sent ORDER BY sent_at DESC")?;
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
            .find(|(id, c, _)| id != entry_id && c.trim() == words)
            .map(|(_, _, note)| Queued::Saved(note)))
    }

    /// Remember a sent entry's words for the duplicate window.
    fn journal_mark_sent(&self, e: &QueuedEntry, note_id: &str, now: i64) -> Result<()> {
        if e.has_audio || e.content.trim().is_empty() {
            return Ok(());
        }
        self.conn.execute(
            "INSERT OR REPLACE INTO journal_sent (entry_id, content, note_id, sent_at) VALUES (?1, ?2, ?3, ?4)",
            params![e.entry_id, e.content, note_id, now],
        )?;
        Ok(())
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
/// sweep's fallbacks from the device (never `-N`); an old `Notes/` entry
/// keeps the old `-2`…`-9` suffixes, which the sweep still recognises.
pub fn paths_to_try(e: &QueuedEntry) -> Vec<String> {
    let mut out = vec![e.path.clone()];
    if e.path.starts_with("Notes/") {
        out.extend((2..=9).map(|n| format!("{}-{n}", e.path)));
    } else {
        out.extend(e.alternates.iter().cloned());
    }
    out
}

async fn send_one(store: &Store, client: &VaultClient, e: &QueuedEntry) -> Result<String> {
    let note_id = match &e.note_id {
        Some(id) => id.clone(),
        None => {
            // A retry may follow a write whose answer was lost (on another path
            // than the first one tried): look for this entry before writing again.
            let found = if e.attempts > 0 {
                client.find_entry(&e.entry_id).await.ok().flatten()
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

    #[test]
    fn a_duplicate_is_refused_while_waiting_and_for_ten_minutes_after() {
        let s = Store::open_in_memory().unwrap();
        let p1 = "Journal/2026/10-14/19-43 A placeholder entry about the garden";
        let p2 = "Journal/2026/10-14/19-46 A placeholder entry about the garden";
        let words = "A placeholder entry about the garden.";
        assert_eq!(
            s.journal_queue(ID, p1, &[], words, "text", "t", None, 100)
                .unwrap(),
            Queued::New
        );
        // typed again (with stray whitespace) while the first is still waiting: no second entry
        assert_eq!(
            s.journal_queue(
                ID2,
                p2,
                &[],
                &format!("  {words}\n"),
                "text",
                "t",
                None,
                280
            )
            .unwrap(),
            Queued::Waiting(ID.into())
        );
        assert_eq!(s.journal_pending().unwrap().len(), 1);
        // the same entry id again is the same entry, not a duplicate
        assert_eq!(
            s.journal_queue(ID, p1, &[], words, "text", "t", None, 281)
                .unwrap(),
            Queued::New
        );
        assert_eq!(s.journal_pending().unwrap().len(), 1);
        // other words are a new entry
        assert_eq!(
            s.journal_queue(
                ID3,
                p2,
                &[],
                "Different placeholder words",
                "text",
                "t",
                None,
                282
            )
            .unwrap(),
            Queued::New
        );
        s.journal_remove(ID3).unwrap();
        // sent: the same words within ten minutes are "already saved"
        let e = s.journal_pending().unwrap().remove(0);
        s.journal_mark_sent(&e, "note-1", 300).unwrap();
        s.journal_remove(ID).unwrap();
        assert_eq!(
            s.journal_queue(
                ID2,
                p2,
                &[],
                words,
                "text",
                "t",
                None,
                300 + DUPLICATE_WINDOW_SECS - 1
            )
            .unwrap(),
            Queued::Saved("note-1".into())
        );
        assert!(s.journal_pending().unwrap().is_empty());
        // after the window the same words may be written again
        assert_eq!(
            s.journal_queue(
                ID2,
                p2,
                &[],
                words,
                "text",
                "t",
                None,
                301 + DUPLICATE_WINDOW_SECS
            )
            .unwrap(),
            Queued::New
        );
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
        assert_eq!(
            paths_to_try(e),
            vec![
                "Journal/2026/10-14/19-43 Placeholder".to_string(),
                alts[0].clone()
            ]
        );
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
            Queued::Saved(format!("n:{alt}"))
        );
    }

    #[tokio::test]
    async fn every_path_taken_stays_queued_with_an_error() {
        crate::init_crypto();
        let p = "Journal/2026/10-14/19-43 Placeholder words";
        let alt = "Journal/2026/10-14/19-43-10 Placeholder words";
        let (client, handle) = crate::parachute::surface_tests::server(vec![
            (
                "create-note",
                create_args(p, "Placeholder words", ID),
                created(p, ID2),
            ),
            (
                "create-note",
                create_args(alt, "Placeholder words", ID),
                created(alt, ID3),
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
        assert_eq!(r.remaining, 1);
        assert!(r.error.unwrap().contains("path taken"));
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
        assert_eq!((r.sent, r.remaining), (vec![format!("n:{alt}")], 0));
    }
}
