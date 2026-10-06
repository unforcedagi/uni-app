//! Journal outbox: entries are saved on the device first, then sent to the
//! Parachute vault when the hub is reachable. A voice entry keeps its audio
//! here until the upload succeeds, so nothing is lost offline.
//!
//! Each entry gets a device-side `entry_id` (UUID) recorded in the note's
//! metadata. Sending is idempotent: `create-note` uses `if_exists: ignore`
//! on the entry's path, and a note that comes back with a different
//! `entry_id` is a path collision (two entries in one second), so the entry
//! moves to a suffixed path and tries again.

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
"#;

pub(crate) fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(SCHEMA)
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
}

/// What one flush did.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct FlushReport {
    pub sent: Vec<String>,
    pub remaining: usize,
    pub error: Option<String>,
}

/// Characters an entry title never contains (mirrors `entryTitle` in journalCore.ts).
const PATH_FORBIDDEN: &[char] = &[
    '\\', '[', ']', '#', '|', ':', '*', '?', '"', '<', '>', '^', '{', '}', '`', '~',
];

/// Validate a device-built note path (T-60):
/// `Journal/YYYY/MM-DD/[HH-MM[-SS] ]<first words>`, i.e. it matches
/// `^Journal/\d{4}/\d\d-\d\d/(\d\d-\d\d(-\d\d)? )?.+`; no `.`/`..`/empty
/// segments, no control or forbidden characters, at most 200 characters.
fn check_path(path: &str) -> Result<()> {
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    let segs: Vec<&str> = path.split('/').collect();
    let ok = segs.len() == 4
        && segs[0] == "Journal"
        && segs[1].len() == 4
        && digits(segs[1])
        && segs[2].len() == 5
        && digits(&segs[2][..2])
        && &segs[2][2..3] == "-"
        && digits(&segs[2][3..])
        && !matches!(segs[3], "" | "." | "..")
        && segs[3].trim() == segs[3]
        && path.chars().count() <= 200
        && path
            .chars()
            .all(|c| !c.is_control() && !PATH_FORBIDDEN.contains(&c));
    if ok {
        Ok(())
    } else {
        Err(Error::Invalid(format!("bad journal path: {path}")))
    }
}

/// The path to use when `path` is taken by another entry: the same minute and
/// first words, with the entry's seconds added (`HH-MM-SS`). Never a `-N`
/// suffix. `None` when the path has no `HH-MM` stamp or seconds are unknown.
fn clash_path(path: &str, created_at: &str) -> Option<String> {
    let (dir, name) = path.rsplit_once('/')?;
    let b = name.as_bytes();
    let stamped = b.len() >= 5
        && b[..2].iter().all(u8::is_ascii_digit)
        && b[2] == b'-'
        && b[3..5].iter().all(u8::is_ascii_digit)
        && (b.len() == 5 || b[5] == b' ');
    if !stamped {
        return None;
    }
    // ISO `YYYY-MM-DDTHH:MM:SS…`; zone offsets are whole minutes, so UTC seconds
    // equal local seconds.
    let ss = created_at.get(17..19).filter(|s| digits_only(s))?;
    Some(format!("{dir}/{}-{ss}{}", &name[..5], &name[5..]))
}

fn digits_only(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

impl Store {
    /// Queue an entry. Voice entries carry audio and start as a placeholder.
    #[allow(clippy::too_many_arguments)]
    pub fn journal_queue(
        &self,
        entry_id: &str,
        path: &str,
        content: &str,
        source: &str,
        created_at: &str,
        audio: Option<(&[u8], &str)>,
        now: i64,
    ) -> Result<()> {
        check_path(path)?;
        if uuid::Uuid::parse_str(entry_id).is_err() {
            return Err(Error::Invalid("entry id must be a UUID".into()));
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
        self.conn.execute(
            "INSERT OR IGNORE INTO journal_outbox
               (entry_id, path, content, source, created_at, audio, audio_mime, queued_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                entry_id,
                path,
                content,
                source,
                created_at,
                audio.map(|a| a.0),
                audio.map(|a| a.1),
                now
            ],
        )?;
        Ok(())
    }

    /// Entries not yet fully in the vault, oldest first.
    pub fn journal_pending(&self) -> Result<Vec<QueuedEntry>> {
        let mut st = self.conn.prepare(
            "SELECT entry_id, path, content, source, created_at, audio IS NOT NULL,
                    note_id, attempts, last_error
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

async fn send_one(store: &Store, client: &VaultClient, e: &QueuedEntry) -> Result<String> {
    let note_id = match &e.note_id {
        Some(id) => id.clone(),
        None => {
            let mut path = e.path.clone();
            let mut with_seconds = false;
            let note = loop {
                let note = client
                    .create_entry(&NewEntry {
                        path: path.clone(),
                        content: e.content.clone(),
                        source: e.source.clone(),
                        created_at: Some(e.created_at.clone()),
                        entry_id: Some(e.entry_id.clone()),
                    })
                    .await?;
                if note.entry_id.as_deref() == Some(e.entry_id.as_str()) {
                    break note;
                }
                // Another entry has this minute and these first words: add seconds once.
                match (with_seconds, clash_path(&e.path, &e.created_at)) {
                    (false, Some(p)) => {
                        path = p;
                        with_seconds = true;
                    }
                    _ => return Err(Error::Vault(format!("path taken: {path}"))),
                }
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

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "7d6f2c1e-0a4b-4f7e-9c2d-1b3a5e7f9a0b";

    #[test]
    fn check_path_accepts_journal_titles_and_rejects_the_rest() {
        for ok in [
            "Journal/2026/09-25/10-00",
            "Journal/2026/09-25/10-00-07",
            "Journal/2026/10-06/15-58 Walking by the creek this evening",
            "Journal/2026/10-06/15-58-07 Walking, then chai",
            "Journal/2026/10-06/Walking by the creek",
            "Journal/2026/10-06/07-03 Café über naïve",
        ] {
            assert!(check_path(ok).is_ok(), "{ok}");
        }
        let long = format!("Journal/2026/09-25/{}", "a".repeat(190));
        for bad in [
            "Notes/2026/09-25/10-00-00",
            "Journal/2026/09/2026-09-25 1000 Morning",
            "Journal/2026/09-25/a/b",
            "Journal/2026/09-25/",
            "Journal/2026/09-25/..",
            "Journal/26/09-25/x",
            "Journal/2026/0925/x",
            "Journal/2026/09-25/a:b",
            "Journal/2026/09-25/a#b",
            "Journal/2026/09-25/a\\b",
            "Journal/2026/09-25/a\nb",
            long.as_str(),
        ] {
            assert!(check_path(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn clash_adds_seconds_never_a_counter() {
        let at = "2026-10-06T21:58:07.123Z";
        assert_eq!(
            clash_path("Journal/2026/10-06/15-58 Walking", at).as_deref(),
            Some("Journal/2026/10-06/15-58-07 Walking")
        );
        assert_eq!(
            clash_path("Journal/2026/10-06/15-58", at).as_deref(),
            Some("Journal/2026/10-06/15-58-07")
        );
        assert_eq!(clash_path("Journal/2026/10-06/Walking", at), None);
        assert_eq!(clash_path("Journal/2026/10-06/15-58 Walking", "t"), None);
        let p = clash_path("Journal/2026/10-06/15-58 Walking", at).unwrap();
        assert!(check_path(&p).is_ok());
    }

    #[test]
    fn queue_validates_and_lists() {
        let s = Store::open_in_memory().unwrap();
        assert!(s
            .journal_queue(ID, "../etc", "x", "text", "t", None, 1)
            .is_err());
        assert!(s
            .journal_queue(
                ID,
                "Journal/2026/09-25/10-00 Morning sit",
                " ",
                "text",
                "t",
                None,
                1
            )
            .is_err());
        assert!(s
            .journal_queue(
                "nope",
                "Journal/2026/09-25/10-00 Morning sit",
                "x",
                "text",
                "t",
                None,
                1
            )
            .is_err());
        s.journal_queue(
            ID,
            "Journal/2026/09-25/10-00 Morning sit",
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
            "Journal/2026/09-25/10-00 Morning sit",
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
            "Journal/2026/09-25/10-00 Morning sit",
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
        let path = "Journal/2026/09-25/10-00 Morning sit";
        s.journal_queue(ID, path, "", "voice", "t", Some((audio, "audio/ogg")), 1)
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
}
