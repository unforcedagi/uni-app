//! Local SQLite store.
//!
//! `items` is the unified timeline projection (spec §5): one row per Buzz
//! event or vault note. Phase 1 writes only `source = 'buzz'` rows.
//! `channels` caches discovery output; `sync_state` holds per-channel
//! `since` watermarks so a re-run only pulls new history; `profiles` caches
//! kind-0 metadata for name resolution; `items_fts` is an FTS5 index over
//! `items.body` kept in sync by triggers.
//!
//! Every write is idempotent (`INSERT OR IGNORE` on the `(source, ref)`
//! primary key plus a unique index on `ref`), so a sync pass can be re-run
//! at any time — the mobile model is connect-on-open → one full pass →
//! disconnect.

use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

use crate::Result;

/// One row of the unified timeline.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    /// `buzz` or `vault`.
    pub source: String,
    /// Event id (Buzz) or note id (vault).
    pub r#ref: String,
    /// Channel uuid (Buzz) or note path (vault).
    pub channel: String,
    /// Author pubkey hex (Buzz) or hub principal (vault).
    pub author: String,
    /// Unix seconds.
    pub ts: i64,
    /// Message body / note content.
    pub body: String,
    /// True when a `p` tag names our pubkey.
    pub mentions_me: bool,
}

/// Message and its NIP-10 conversation position.
#[derive(Debug, Clone)]
pub struct ConversationMessage {
    pub item: Item,
    pub root: Option<String>,
    pub parent: Option<String>,
    /// `item.body` is the latest authorized kind-40003 edit, not the original.
    pub edited: bool,
}

/// A main-timeline message with its thread summary.
#[derive(Debug, Clone)]
pub struct TimelineMessage {
    pub message: ConversationMessage,
    /// Cached replies whose NIP-10 root is this message.
    pub reply_count: i64,
    /// Newest cached reply, if any.
    pub last_reply_ts: Option<i64>,
}

/// A channel member from the kind-39002 roster, with its cached profile label.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    pub pubkey: String,
    /// `display_name`, else `name`, from kind 0; `None` if unknown.
    pub name: Option<String>,
}

/// One emoji's reactions on a message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reaction {
    /// Target message id.
    pub target: String,
    /// Emoji as sent (`+` is normalised to 👍 by the UI, not here).
    pub emoji: String,
    /// Distinct reactors.
    pub count: i64,
    /// Our own live reaction event with this emoji, if any (needed to undo).
    pub mine: Option<String>,
}

/// One local search hit: the visible message, its room label, and a short
/// excerpt with matched terms wrapped in [`SNIPPET_START`] / [`SNIPPET_END`].
#[derive(Debug, Clone)]
pub struct SearchHit {
    pub message: ConversationMessage,
    /// Cached channel name, if known.
    pub channel_name: Option<String>,
    /// Excerpt of the visible body (edited text when edited). Plain text plus
    /// marker characters only — never HTML; the UI turns markers into `<mark>`.
    pub snippet: String,
}

/// Start-of-match marker in [`SearchHit::snippet`] (Unicode private use).
pub const SNIPPET_START: char = '\u{E000}';
/// End-of-match marker in [`SearchHit::snippet`] (Unicode private use).
pub const SNIPPET_END: char = '\u{E001}';

/// Joined room with its most recent cached message.
#[derive(Debug, Clone)]
pub struct Room {
    pub id: String,
    pub name: Option<String>,
    pub last_message: Option<String>,
    pub last_ts: Option<i64>,
    /// Unread messages that mention us.
    pub mentions: bool,
    /// Visible messages from others newer than the local read marker.
    pub unread: i64,
}

/// Cached kind-0 profile.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Profile {
    /// Pubkey hex.
    pub pubkey: String,
    /// `name` field.
    pub name: Option<String>,
    /// `display_name` field.
    pub display_name: Option<String>,
    /// `picture` URL.
    pub picture: Option<String>,
    /// `nip05` identifier.
    pub nip05: Option<String>,
    /// `created_at` of the kind-0 event this row came from.
    pub updated_at: i64,
}

impl Profile {
    /// Parse a kind-0 event's JSON content. Unknown fields are ignored;
    /// malformed JSON yields an empty profile (the row still records that
    /// we fetched something, so we don't re-query every sync).
    pub fn from_kind0(pubkey: &str, content: &str, created_at: i64) -> Self {
        let v: serde_json::Value = serde_json::from_str(content).unwrap_or_default();
        let s = |k: &str| {
            v.get(k)
                .and_then(|x| x.as_str())
                .map(str::trim)
                .filter(|x| !x.is_empty())
                .map(str::to_string)
        };
        Self {
            pubkey: pubkey.to_string(),
            name: s("name"),
            display_name: s("display_name"),
            picture: s("picture"),
            nip05: s("nip05"),
            updated_at: created_at,
        }
    }

    /// Best human label: `display_name`, else `name`, else `None`.
    pub fn label(&self) -> Option<&str> {
        self.display_name.as_deref().or(self.name.as_deref())
    }
}

/// SQLite-backed store.
pub struct Store {
    pub(crate) conn: Connection,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS items (
    source      TEXT    NOT NULL,
    ref         TEXT    NOT NULL,
    channel     TEXT    NOT NULL,
    author      TEXT    NOT NULL,
    ts          INTEGER NOT NULL,
    body        TEXT    NOT NULL,
    mentions_me INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (source, ref)
);
CREATE UNIQUE INDEX IF NOT EXISTS items_ref ON items(ref);
CREATE INDEX IF NOT EXISTS items_ts ON items(ts DESC);
CREATE INDEX IF NOT EXISTS items_channel_ts ON items(channel, ts DESC);
CREATE INDEX IF NOT EXISTS items_author ON items(author);

CREATE TABLE IF NOT EXISTS channels (
    id          TEXT PRIMARY KEY,
    name        TEXT,
    description TEXT,
    archived    INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
    channel     TEXT PRIMARY KEY,
    since       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS message_refs (
    ref TEXT PRIMARY KEY,
    root TEXT,
    parent TEXT
);
CREATE INDEX IF NOT EXISTS message_refs_root ON message_refs(root);

CREATE TABLE IF NOT EXISTS channel_members (
    channel TEXT NOT NULL,
    pubkey  TEXT NOT NULL,
    PRIMARY KEY (channel, pubkey)
);

CREATE TABLE IF NOT EXISTS message_mentions (
    ref    TEXT NOT NULL,
    pubkey TEXT NOT NULL,
    PRIMARY KEY (ref, pubkey)
);

-- Edits (40003) and deletions (5 / 9005) that reference a message by `e`.
-- Kept separately so arrival order never matters: the `visible_items` view
-- applies them at read time, whether they came before or after the target.
CREATE TABLE IF NOT EXISTS aux_events (
    id      TEXT PRIMARY KEY,
    kind    INTEGER NOT NULL,
    target  TEXT NOT NULL,
    author  TEXT NOT NULL,
    ts      INTEGER NOT NULL,
    content TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS aux_events_target ON aux_events(target, kind);

-- Local read marker per room (newest message ts the user has seen).
-- `publishable` (added by migration) = the user read it here or another
-- device reported it; first-sight seeds stay local (see readstate.rs).
CREATE TABLE IF NOT EXISTS read_state (
    channel TEXT PRIMARY KEY,
    read_ts INTEGER NOT NULL
);

-- Small key/value state for cross-device read sync (client id, slot id,
-- newest read-state created_at, last published contexts).
CREATE TABLE IF NOT EXISTS read_sync_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- NIP-92 `imeta` attachments of a kind-9 message, in tag order.
CREATE TABLE IF NOT EXISTS message_media (
    ref      TEXT NOT NULL,
    idx      INTEGER NOT NULL,
    url      TEXT NOT NULL,
    mime     TEXT,
    sha256   TEXT,
    size     INTEGER,
    dim      TEXT,
    blurhash TEXT,
    alt      TEXT,
    filename TEXT,
    PRIMARY KEY (ref, idx)
);

CREATE TABLE IF NOT EXISTS profiles (
    pubkey       TEXT PRIMARY KEY,
    name         TEXT,
    display_name TEXT,
    picture      TEXT,
    nip05        TEXT,
    updated_at   INTEGER NOT NULL
);
"#;

/// Timeline projection with edits and deletions applied: a deleted message
/// (kind 5 or 9005, both relay-authorized) is absent, and `body` is the newest
/// kind-40003 edit signed by the original author (ties: larger event id). An
/// edit that was itself deleted is ignored. Recreated on every open so its
/// definition can evolve.
const VIEW_SCHEMA: &str = r#"
DROP VIEW IF EXISTS visible_items;
CREATE VIEW visible_items AS
SELECT i.source, i.ref, i.channel, i.author, i.ts,
       COALESCE(e.content, i.body) AS body,
       i.mentions_me,
       (e.content IS NOT NULL) AS edited,
       e.id AS edit_id
FROM items i
LEFT JOIN aux_events e ON e.id = (
    SELECT x.id FROM aux_events x
    WHERE x.target = i.ref AND x.kind = 40003 AND x.author = i.author
      AND NOT EXISTS (SELECT 1 FROM aux_events dx WHERE dx.target = x.id AND dx.kind IN (5, 9005))
    ORDER BY x.ts DESC, x.id DESC LIMIT 1)
WHERE NOT EXISTS (SELECT 1 FROM aux_events d WHERE d.target = i.ref AND d.kind IN (5, 9005));
"#;

/// Kind 5: NIP-09 deletion.
pub const KIND_DELETION: i64 = 5;
/// Kind 9005: Buzz / NIP-29 delete-event.
pub const KIND_DELETE_EVENT: i64 = 9005;
/// Kind 40003: Buzz message edit.
pub const KIND_EDIT: i64 = 40003;
/// Kind 7: NIP-25 reaction (content is the emoji; `+` means a like).
pub const KIND_REACTION: i64 = 7;

/// FTS5 external-content index over `items.body`, synced by triggers.
/// `content_rowid` is the implicit SQLite rowid of `items`.
const FTS_SCHEMA: &str = r#"
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
    body, content='items', content_rowid='rowid', tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
    INSERT INTO items_fts(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
    INSERT INTO items_fts(items_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
END;
CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
    INSERT INTO items_fts(items_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
    INSERT INTO items_fts(rowid, body) VALUES (new.rowid, new.body);
END;
"#;

/// FTS5 index over kind-40003 edit text, so a message is found by what it
/// says now (the `items_fts` row still holds the original). A plain (not
/// external-content) table keyed by the `aux_events` rowid: only edits are
/// indexed, and aux rows are never updated or deleted.
const EDITS_FTS_SCHEMA: &str = r#"
CREATE VIRTUAL TABLE IF NOT EXISTS edits_fts USING fts5(body, tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS aux_edit_ai AFTER INSERT ON aux_events WHEN new.kind = 40003 BEGIN
    INSERT INTO edits_fts(rowid, body) VALUES (new.rowid, new.content);
END;
"#;

impl Store {
    /// Open (or create) the database at `path` and apply the schema.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let conn = Connection::open(path)?;
        // busy_timeout: the live loop and a foreground refresh/send each own a
        // connection; let a writer wait briefly instead of failing SQLITE_BUSY.
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
        )?;
        Self::init(conn)
    }

    /// In-memory store (tests).
    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.execute_batch(SCHEMA)?;
        // If the FTS table is being created for the first time on a database
        // that already has items (schema upgrade), rebuild the index from
        // the content table so old rows are searchable.
        let had_fts: bool = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='items_fts'",
            [],
            |r| r.get::<_, i64>(0),
        )? > 0;
        conn.execute_batch(FTS_SCHEMA)?;
        if !had_fts {
            conn.execute("INSERT INTO items_fts(items_fts) VALUES ('rebuild')", [])?;
        }
        let had_edits_fts: bool = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='edits_fts'",
            [],
            |r| r.get::<_, i64>(0),
        )? > 0;
        conn.execute_batch(EDITS_FTS_SCHEMA)?;
        if !had_edits_fts {
            // Upgrade: index edits that arrived before this table existed.
            conn.execute(
                "INSERT INTO edits_fts(rowid, body) SELECT rowid, content FROM aux_events WHERE kind = 40003",
                [],
            )?;
        }
        conn.execute_batch(VIEW_SCHEMA)?;
        let has_publishable: bool = conn.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('read_state') WHERE name='publishable'",
            [],
            |r| r.get::<_, i64>(0),
        )? > 0;
        if !has_publishable {
            conn.execute_batch(
                "ALTER TABLE read_state ADD COLUMN publishable INTEGER NOT NULL DEFAULT 0",
            )?;
        }
        crate::journal::init_schema(&conn)?;
        Ok(Self { conn })
    }

    /// Insert an item; returns `true` if it was new (PK conflict = duplicate).
    pub fn upsert_item(&self, item: &Item) -> Result<bool> {
        let n = self.conn.execute(
            "INSERT OR IGNORE INTO items (source, ref, channel, author, ts, body, mentions_me)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                item.source,
                item.r#ref,
                item.channel,
                item.author,
                item.ts,
                item.body,
                item.mentions_me as i64
            ],
        )?;
        Ok(n == 1)
    }

    /// Record an edit / deletion event aimed at `target`. Idempotent; returns
    /// `true` if new. Unknown kinds are rejected so the view stays honest.
    pub fn upsert_aux(
        &self,
        id: &str,
        kind: i64,
        target: &str,
        author: &str,
        ts: i64,
        content: &str,
    ) -> Result<bool> {
        if ![KIND_DELETION, KIND_DELETE_EVENT, KIND_EDIT, KIND_REACTION].contains(&kind) {
            return Err(crate::Error::Invalid(format!(
                "not an edit/delete kind: {kind}"
            )));
        }
        let n = self.conn.execute(
            "INSERT OR IGNORE INTO aux_events (id, kind, target, author, ts, content)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, kind, target, author, ts, content],
        )?;
        Ok(n == 1)
    }

    /// Seed a room's read marker if it has none (first sight of the room, or
    /// the first run after upgrading): history that predates it counts as read.
    pub fn ensure_read_state(&self, channel: &str, ts: i64) -> Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO read_state (channel, read_ts) VALUES (?1, ?2)",
            params![channel, ts],
        )?;
        Ok(())
    }

    /// Mark `channel` read up to its newest cached message (never goes back).
    /// Returns `true` if the marker advanced (i.e. there is something new to
    /// sync to other devices).
    pub fn mark_read(&self, channel: &str) -> Result<bool> {
        let before = self.read_marker(channel)?;
        self.conn.execute(
            "INSERT INTO read_state (channel, read_ts, publishable)
             VALUES (?1, COALESCE((SELECT MAX(ts) FROM items WHERE channel = ?1), 0), 1)
             ON CONFLICT(channel) DO UPDATE SET read_ts = MAX(read_ts, excluded.read_ts),
                                                publishable = 1",
            params![channel],
        )?;
        Ok(self.read_marker(channel)? > before)
    }

    /// A room's read marker, if any.
    pub fn read_marker(&self, channel: &str) -> Result<Option<i64>> {
        Ok(self
            .conn
            .query_row(
                "SELECT read_ts FROM read_state WHERE channel = ?1",
                params![channel],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// Merge a marker reported by another device: `max()` with the local
    /// one, never backwards; the room becomes publishable either way.
    /// Returns `true` if the local marker advanced.
    pub fn merge_read_marker(&self, channel: &str, ts: i64) -> Result<bool> {
        let before = self.read_marker(channel)?;
        self.conn.execute(
            "INSERT INTO read_state (channel, read_ts, publishable) VALUES (?1, ?2, 1)
             ON CONFLICT(channel) DO UPDATE SET read_ts = MAX(read_ts, excluded.read_ts),
                                                publishable = 1",
            params![channel, ts],
        )?;
        Ok(before.is_none_or(|b| ts > b))
    }

    /// Markers this device may publish (read here or reported by another
    /// device; never first-sight seeds).
    pub fn publishable_read_markers(&self) -> Result<std::collections::BTreeMap<String, i64>> {
        let mut stmt = self
            .conn
            .prepare("SELECT channel, read_ts FROM read_state WHERE publishable = 1")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    /// Read-sync key/value state.
    pub fn read_sync_meta(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT value FROM read_sync_meta WHERE key = ?1",
                params![key],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// Set a read-sync key/value.
    pub fn set_read_sync_meta(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO read_sync_meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// Upsert a discovered channel.
    pub fn upsert_channel(
        &self,
        id: &str,
        name: Option<&str>,
        description: Option<&str>,
        archived: bool,
        now: i64,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO channels (id, name, description, archived, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name, description = excluded.description,
               archived = excluded.archived, updated_at = excluded.updated_at",
            params![id, name, description, archived as i64, now],
        )?;
        Ok(())
    }

    /// Channel name by uuid string, if cached.
    pub fn channel_name(&self, id: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT name FROM channels WHERE id = ?1",
                params![id],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    }

    /// Per-channel `since` watermark (max `ts` seen), if any.
    pub fn since_for(&self, channel: &str) -> Result<Option<i64>> {
        Ok(self
            .conn
            .query_row(
                "SELECT since FROM sync_state WHERE channel = ?1",
                params![channel],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// Advance the watermark (never goes backwards).
    pub fn set_since(&self, channel: &str, since: i64) -> Result<()> {
        self.conn.execute(
            "INSERT INTO sync_state (channel, since) VALUES (?1, ?2)
             ON CONFLICT(channel) DO UPDATE SET since = MAX(since, excluded.since)",
            params![channel, since],
        )?;
        Ok(())
    }

    /// Upsert a profile; a row is only replaced by a newer `updated_at`.
    /// Returns `true` if the row was inserted or replaced.
    pub fn upsert_profile(&self, p: &Profile) -> Result<bool> {
        let n = self.conn.execute(
            "INSERT INTO profiles (pubkey, name, display_name, picture, nip05, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(pubkey) DO UPDATE SET
               name = excluded.name, display_name = excluded.display_name,
               picture = excluded.picture, nip05 = excluded.nip05,
               updated_at = excluded.updated_at
             WHERE excluded.updated_at > profiles.updated_at",
            params![
                p.pubkey,
                p.name,
                p.display_name,
                p.picture,
                p.nip05,
                p.updated_at
            ],
        )?;
        Ok(n == 1)
    }

    /// Cached profile for `pubkey`, if any.
    pub fn profile(&self, pubkey: &str) -> Result<Option<Profile>> {
        Ok(self
            .conn
            .query_row(
                "SELECT pubkey, name, display_name, picture, nip05, updated_at
                 FROM profiles WHERE pubkey = ?1",
                params![pubkey],
                |r| {
                    Ok(Profile {
                        pubkey: r.get(0)?,
                        name: r.get(1)?,
                        display_name: r.get(2)?,
                        picture: r.get(3)?,
                        nip05: r.get(4)?,
                        updated_at: r.get(5)?,
                    })
                },
            )
            .optional()?)
    }

    /// Human label for `pubkey`: cached `display_name` / `name`, else the
    /// first 8 hex chars followed by `…`.
    pub fn display_name(&self, pubkey: &str) -> Result<String> {
        if let Some(p) = self.profile(pubkey)? {
            if let Some(l) = p.label() {
                return Ok(l.to_string());
            }
        }
        Ok(format!("{}…", &pubkey[..8.min(pubkey.len())]))
    }

    /// Distinct item authors and channel members with no `profiles` row
    /// (candidates for a kind-0 fetch).
    pub fn authors_without_profile(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT pk FROM (
                SELECT author AS pk FROM items WHERE source = 'buzz'
                UNION SELECT pubkey AS pk FROM channel_members
             ) WHERE pk NOT IN (SELECT pubkey FROM profiles)
             ORDER BY pk",
        )?;
        let rows = stmt
            .query_map([], |r| r.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Count items per channel for `source`.
    pub fn count_by_channel(&self, source: &str) -> Result<Vec<(String, i64)>> {
        let mut stmt = self.conn.prepare(
            "SELECT channel, COUNT(*) FROM items WHERE source = ?1 GROUP BY channel ORDER BY channel",
        )?;
        let rows = stmt
            .query_map(params![source], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Total item count.
    pub fn count_items(&self) -> Result<i64> {
        Ok(self
            .conn
            .query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))?)
    }

    /// Total profile count.
    pub fn count_profiles(&self) -> Result<i64> {
        Ok(self
            .conn
            .query_row("SELECT COUNT(*) FROM profiles", [], |r| r.get(0))?)
    }

    /// Store NIP-10 reply references after the item is inserted. An old database
    /// with no reference rows still reads its legacy messages as roots.
    pub fn set_message_refs(
        &self,
        id: &str,
        root: Option<&str>,
        parent: Option<&str>,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO message_refs(ref,root,parent) VALUES (?1,?2,?3)
             ON CONFLICT(ref) DO UPDATE SET root=excluded.root,parent=excluded.parent",
            params![id, root, parent],
        )?;
        Ok(())
    }

    /// Replace a channel's cached member roster (latest kind-39002 snapshot).
    pub fn replace_channel_members(&self, channel: &str, members: &[String]) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM channel_members WHERE channel = ?1",
            params![channel],
        )?;
        for pk in members {
            tx.execute(
                "INSERT OR IGNORE INTO channel_members (channel, pubkey) VALUES (?1, ?2)",
                params![channel, pk],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Cached members of `channel` with profile labels, named members first
    /// (case-insensitive by label), then unnamed by pubkey.
    pub fn channel_members(&self, channel: &str) -> Result<Vec<Member>> {
        let mut stmt = self.conn.prepare(
            "SELECT m.pubkey, COALESCE(p.display_name, p.name)
             FROM channel_members m LEFT JOIN profiles p ON p.pubkey = m.pubkey
             WHERE m.channel = ?1",
        )?;
        let mut rows = stmt
            .query_map(params![channel], |r| {
                Ok(Member {
                    pubkey: r.get(0)?,
                    name: r.get(1)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.sort_by(|a, b| match (&a.name, &b.name) {
            (Some(x), Some(y)) => x
                .to_lowercase()
                .cmp(&y.to_lowercase())
                .then_with(|| a.pubkey.cmp(&b.pubkey)),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a.pubkey.cmp(&b.pubkey),
        });
        Ok(rows)
    }

    /// Record the `p`-tag pubkeys of a message (replaces any previous set).
    pub fn set_message_mentions(&self, id: &str, pubkeys: &[String]) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM message_mentions WHERE ref = ?1", params![id])?;
        for pk in pubkeys {
            tx.execute(
                "INSERT OR IGNORE INTO message_mentions (ref, pubkey) VALUES (?1, ?2)",
                params![id, pk],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Record a message's `imeta` attachments (replaces any previous set).
    pub fn set_message_media(&self, id: &str, media: &[crate::media::MediaRef]) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM message_media WHERE ref = ?1", params![id])?;
        for (i, m) in media.iter().enumerate() {
            tx.execute(
                "INSERT INTO message_media (ref, idx, url, mime, sha256, size, dim, blurhash, alt, filename)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![id, i as i64, m.url, m.mime, m.sha256, m.size, m.dim, m.blurhash, m.alt, m.filename],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Attachments of `ids`, as `(ref, media)` in tag order (one query).
    pub fn message_media(&self, ids: &[String]) -> Result<Vec<(String, crate::media::MediaRef)>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let marks = vec!["?"; ids.len()].join(",");
        let mut stmt = self.conn.prepare(&format!(
            "SELECT ref, url, mime, sha256, size, dim, blurhash, alt, filename
             FROM message_media WHERE ref IN ({marks}) ORDER BY ref, idx"
        ))?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(ids.iter()), |r| {
                Ok((
                    r.get(0)?,
                    crate::media::MediaRef {
                        url: r.get(1)?,
                        mime: r.get(2)?,
                        sha256: r.get(3)?,
                        size: r.get(4)?,
                        dim: r.get(5)?,
                        blurhash: r.get(6)?,
                        alt: r.get(7)?,
                        filename: r.get(8)?,
                    },
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// `p`-tag pubkeys recorded for a message, sorted.
    pub fn message_mentions(&self, id: &str) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT pubkey FROM message_mentions WHERE ref = ?1 ORDER BY pubkey")?;
        let rows = stmt
            .query_map(params![id], |r| r.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Main timeline for a room: roots and standalone messages only, each with
    /// its thread summary. Replies whose root is cached in this room live in
    /// the thread view; a reply whose root is not cached stays visible here so
    /// nothing disappears. Chronological in the returned window.
    pub fn room_timeline(&self, channel: &str, limit: usize) -> Result<Vec<TimelineMessage>> {
        let mut stmt = self.conn.prepare(
            "SELECT i.source,i.ref,i.channel,i.author,i.ts,i.body,i.mentions_me,r.root,r.parent,
                (SELECT COUNT(*) FROM message_refs x JOIN visible_items j ON j.ref=x.ref
                  WHERE x.root=i.ref AND j.channel=i.channel AND j.ref<>i.ref),
                (SELECT MAX(j.ts) FROM message_refs x JOIN visible_items j ON j.ref=x.ref
                  WHERE x.root=i.ref AND j.channel=i.channel AND j.ref<>i.ref),
                i.edited
             FROM visible_items i LEFT JOIN message_refs r ON r.ref=i.ref
             WHERE i.source='buzz' AND i.channel=?1
               AND (r.root IS NULL OR r.root=i.ref
                    OR NOT EXISTS(SELECT 1 FROM visible_items k WHERE k.ref=r.root AND k.channel=i.channel))
             ORDER BY i.ts DESC,i.ref DESC LIMIT ?2",
        )?;
        let mut rows = stmt
            .query_map(params![channel, limit.min(5000) as i64], |r| {
                Ok(TimelineMessage {
                    message: row_to_message(r)?,
                    reply_count: r.get(9)?,
                    last_reply_ts: r.get(10)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.reverse();
        Ok(rows)
    }

    /// One joined room's recent messages, chronological in the returned window.
    pub fn room_messages(&self, channel: &str, limit: usize) -> Result<Vec<ConversationMessage>> {
        let mut stmt = self.conn.prepare(
            "SELECT i.source,i.ref,i.channel,i.author,i.ts,i.body,i.mentions_me,r.root,r.parent,i.edited
             FROM visible_items i LEFT JOIN message_refs r ON r.ref=i.ref
             WHERE i.source='buzz' AND i.channel=?1
             ORDER BY i.ts DESC,i.ref DESC LIMIT ?2",
        )?;
        let mut rows = stmt
            .query_map(params![channel, limit.min(5000) as i64], row_to_message)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.reverse();
        Ok(rows)
    }

    /// A root and its cached descendants, fenced to the same channel.
    pub fn thread_messages(
        &self,
        channel: &str,
        root: &str,
        limit: usize,
    ) -> Result<Vec<ConversationMessage>> {
        let mut stmt = self.conn.prepare(
            "SELECT i.source,i.ref,i.channel,i.author,i.ts,i.body,i.mentions_me,r.root,r.parent,i.edited
             FROM visible_items i LEFT JOIN message_refs r ON r.ref=i.ref
             WHERE i.source='buzz' AND i.channel=?1 AND (i.ref=?2 OR r.root=?2)
             ORDER BY i.ts ASC,i.ref ASC LIMIT ?3",
        )?;
        let rows = stmt
            .query_map(
                params![channel, root, limit.min(5000) as i64],
                row_to_message,
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Joined channels, sorted with Uni first and the most active rooms next.
    /// No unread counts (see [`Store::rooms_for`]).
    pub fn rooms(&self) -> Result<Vec<Room>> {
        self.rooms_for(None)
    }

    /// Joined channels with unread state relative to `me`: messages newer than
    /// the room's read marker, not authored by `me`, that are still visible
    /// (deleted ones never count). Thread replies count too (Buzz: thread
    /// activity contributes). `mentions` is "an unread message mentions me".
    /// A room with no read marker yet has nothing unread.
    pub fn rooms_for(&self, me: Option<&str>) -> Result<Vec<Room>> {
        let mut stmt = self.conn.prepare(
            "SELECT c.id,c.name,
                (SELECT body FROM visible_items WHERE source='buzz' AND channel=c.id ORDER BY ts DESC,ref DESC LIMIT 1),
                (SELECT ts FROM visible_items WHERE source='buzz' AND channel=c.id ORDER BY ts DESC,ref DESC LIMIT 1),
                EXISTS(SELECT 1 FROM visible_items v WHERE v.source='buzz' AND v.channel=c.id AND v.mentions_me=1
                       AND v.ts > rs.read_ts AND v.author IS NOT ?1),
                (SELECT COUNT(*) FROM visible_items v WHERE v.source='buzz' AND v.channel=c.id
                       AND v.ts > rs.read_ts AND v.author IS NOT ?1)
             FROM channels c LEFT JOIN read_state rs ON rs.channel=c.id
             WHERE archived=0
             ORDER BY CASE WHEN lower(c.name)='uni' THEN 0 ELSE 1 END,
                      (SELECT MAX(ts) FROM visible_items WHERE source='buzz' AND channel=c.id) DESC,c.id",
        )?;
        let rows = stmt
            .query_map(params![me], |r| {
                Ok(Room {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    last_message: r.get(2)?,
                    last_ts: r.get(3)?,
                    mentions: r.get::<_, Option<i64>>(4)?.unwrap_or(0) != 0,
                    unread: r.get::<_, Option<i64>>(5)?.unwrap_or(0),
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Live reactions on `targets`, grouped by (target, emoji). A reaction
    /// removed by a kind-5/9005 deletion is gone; one reactor counts once per
    /// emoji however many duplicates they sent. Ordered by first use, so pills
    /// keep a stable order as counts change.
    pub fn reactions(&self, targets: &[String], me: Option<&str>) -> Result<Vec<Reaction>> {
        if targets.is_empty() {
            return Ok(Vec::new());
        }
        let marks = vec!["?"; targets.len()].join(",");
        let sql = format!(
            "SELECT target, content, COUNT(DISTINCT author), MIN(ts),
                    MAX(CASE WHEN author = ?1 THEN id END)
             FROM aux_events a
             WHERE kind = 7 AND target IN ({marks})
               AND NOT EXISTS (SELECT 1 FROM aux_events d WHERE d.target = a.id AND d.kind IN (5, 9005))
             GROUP BY target, content
             ORDER BY target, MIN(ts), content"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let mut args: Vec<&dyn rusqlite::ToSql> = vec![&me];
        args.extend(targets.iter().map(|t| t as &dyn rusqlite::ToSql));
        let rows = stmt
            .query_map(args.as_slice(), |r| {
                Ok(Reaction {
                    target: r.get(0)?,
                    emoji: r.get(1)?,
                    count: r.get(2)?,
                    mine: r.get(4)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// True when `id` is a kind-7 reaction signed by `me`.
    pub fn is_own_reaction(&self, id: &str, me: &str) -> Result<bool> {
        Ok(self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM aux_events WHERE id=?1 AND kind=7 AND author=?2)",
            params![id, me],
            |r| r.get::<_, i64>(0),
        )? != 0)
    }

    /// Oldest cached message ts in a room (the paging cursor for older history).
    pub fn oldest_ts(&self, channel: &str) -> Result<Option<i64>> {
        Ok(self.conn.query_row(
            "SELECT MIN(ts) FROM items WHERE source='buzz' AND channel=?1",
            params![channel],
            |r| r.get(0),
        )?)
    }

    /// Find an existing message in a channel, including its thread ancestry.
    pub fn message(&self, channel: &str, id: &str) -> Result<Option<ConversationMessage>> {
        Ok(self
            .conn
            .query_row(
                "SELECT i.source,i.ref,i.channel,i.author,i.ts,i.body,i.mentions_me,r.root,r.parent,i.edited
             FROM visible_items i LEFT JOIN message_refs r ON r.ref=i.ref
             WHERE i.source='buzz' AND i.channel=?1 AND i.ref=?2",
                params![channel, id],
                row_to_message,
            )
            .optional()?)
    }

    /// Newest-first slice of the timeline.
    pub fn timeline(&self, limit: usize) -> Result<Vec<Item>> {
        let mut stmt = self.conn.prepare(
            "SELECT source, ref, channel, author, ts, body, mentions_me
             FROM items ORDER BY ts DESC LIMIT ?1",
        )?;
        let rows = stmt
            .query_map(params![limit as i64], row_to_item)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Full-text search over `items.body`, best match first (bm25), then newest.
    ///
    /// `query` is treated literally (escaped and phrase-quoted) so user
    /// punctuation never reaches the FTS5 parser. Words match by prefix.
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<Item>> {
        let q = fts_literal_query(query);
        if q.is_empty() {
            return Ok(Vec::new());
        }
        let mut stmt = self.conn.prepare(
            "SELECT i.source, i.ref, i.channel, i.author, i.ts, i.body, i.mentions_me
             FROM items_fts f JOIN items i ON i.rowid = f.rowid
             WHERE items_fts MATCH ?1
               AND NOT EXISTS (SELECT 1 FROM aux_events d WHERE d.target = i.ref AND d.kind IN (5, 9005))
             ORDER BY bm25(items_fts), i.ts DESC LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![q, limit as i64], row_to_item)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }
}

impl Store {
    /// Search what messages say *now*: a hit is a visible Buzz message (not
    /// deleted) whose current body matches — the original text for unedited
    /// messages, the latest authorized edit for edited ones (an edited
    /// message is not found by words it no longer contains). Best match first
    /// (bm25), then newest. `query` is literal (see [`fts_literal_query`]).
    pub fn search_messages(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
        let q = fts_literal_query(query);
        let limit = limit.clamp(1, 500) as i64;
        if q.is_empty() {
            return Ok(Vec::new());
        }
        // snippet(): column 0, markers, ellipsis, ~16 tokens. Both arms select
        // the same shape; bm25 from different indexes is close enough to
        // interleave for a personal cache.
        let sql = format!(
            "SELECT * FROM (
               SELECT v.source,v.ref,v.channel,v.author,v.ts,v.body,v.mentions_me,r.root,r.parent,v.edited,
                      c.name, snippet(items_fts,0,'{s}','{e}','…',16) AS snip, bm25(items_fts) AS rank
               FROM items_fts f JOIN items i ON i.rowid=f.rowid
               JOIN visible_items v ON v.ref=i.ref AND v.edited=0
               LEFT JOIN message_refs r ON r.ref=v.ref LEFT JOIN channels c ON c.id=v.channel
               WHERE items_fts MATCH ?1 AND v.source='buzz'
               UNION ALL
               SELECT v.source,v.ref,v.channel,v.author,v.ts,v.body,v.mentions_me,r.root,r.parent,v.edited,
                      c.name, snippet(edits_fts,0,'{s}','{e}','…',16) AS snip, bm25(edits_fts) AS rank
               FROM edits_fts f JOIN aux_events a ON a.rowid=f.rowid
               JOIN visible_items v ON v.edit_id=a.id
               LEFT JOIN message_refs r ON r.ref=v.ref LEFT JOIN channels c ON c.id=v.channel
               WHERE edits_fts MATCH ?1 AND v.source='buzz'
             ) ORDER BY rank, ts DESC, ref DESC LIMIT ?2",
            s = SNIPPET_START,
            e = SNIPPET_END
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params![q, limit], |r| {
                Ok(SearchHit {
                    message: row_to_message(r)?,
                    channel_name: r.get(10)?,
                    snippet: r.get(11)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }
}

fn row_to_message(r: &rusqlite::Row<'_>) -> rusqlite::Result<ConversationMessage> {
    Ok(ConversationMessage {
        item: row_to_item(r)?,
        root: r.get(7)?,
        parent: r.get(8)?,
        edited: r.get::<_, Option<i64>>("edited")?.unwrap_or(0) != 0,
    })
}

fn row_to_item(r: &rusqlite::Row<'_>) -> rusqlite::Result<Item> {
    Ok(Item {
        source: r.get(0)?,
        r#ref: r.get(1)?,
        channel: r.get(2)?,
        author: r.get(3)?,
        ts: r.get(4)?,
        body: r.get(5)?,
        mentions_me: r.get::<_, i64>(6)? != 0,
    })
}

/// Turn free text into a safe FTS5 query: each whitespace-separated token
/// becomes a quoted prefix term (`"tok"*`), ANDed together. Embedded double
/// quotes are doubled per FTS5 string rules.
pub fn fts_literal_query(text: &str) -> String {
    text.split_whitespace()
        .map(|t| format!("\"{}\"*", t.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(r: &str, ch: &str, ts: i64) -> Item {
        Item {
            source: "buzz".into(),
            r#ref: r.into(),
            channel: ch.into(),
            author: "aa".into(),
            ts,
            body: format!("body {r}"),
            mentions_me: false,
        }
    }

    #[test]
    fn reactions_group_dedupe_and_honour_deletions() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_item(&item("m1", "c1", 10)).unwrap();
        let t = vec!["m1".to_string()];
        s.upsert_aux("r1", 7, "m1", "bob", 11, "🔥").unwrap();
        s.upsert_aux("r2", 7, "m1", "bob", 12, "🔥").unwrap(); // dup reactor
        s.upsert_aux("r3", 7, "m1", "me", 13, "🔥").unwrap();
        s.upsert_aux("r4", 7, "m1", "me", 14, "+").unwrap();
        let r = s.reactions(&t, Some("me")).unwrap();
        assert_eq!(
            r.iter()
                .map(|x| (x.emoji.as_str(), x.count, x.mine.as_deref()))
                .collect::<Vec<_>>(),
            vec![("🔥", 2, Some("r3")), ("+", 1, Some("r4"))]
        );
        s.upsert_aux("d1", 5, "r3", "me", 15, "").unwrap();
        s.upsert_aux("d2", 5, "r4", "me", 15, "").unwrap();
        let r = s.reactions(&t, Some("me")).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!((r[0].count, r[0].mine.as_deref()), (1, None));
        assert!(s.is_own_reaction("r1", "bob").unwrap());
        assert!(!s.is_own_reaction("r1", "me").unwrap());
        assert!(!s.is_own_reaction("m1", "aa").unwrap());
        // Reactions never surface as messages or unread.
        s.ensure_read_state("c1", 0).unwrap();
        assert_eq!(s.room_messages("c1", 50).unwrap().len(), 1);
        assert_eq!(s.oldest_ts("c1").unwrap(), Some(10));
        assert_eq!(s.oldest_ts("nope").unwrap(), None);
    }

    #[test]
    fn upsert_is_idempotent_and_counts() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.upsert_item(&item("e1", "c1", 10)).unwrap());
        assert!(!s.upsert_item(&item("e1", "c1", 10)).unwrap());
        assert!(s.upsert_item(&item("e2", "c1", 11)).unwrap());
        assert!(s.upsert_item(&item("e3", "c2", 12)).unwrap());
        assert_eq!(s.count_items().unwrap(), 3);
        assert_eq!(
            s.count_by_channel("buzz").unwrap(),
            vec![("c1".to_string(), 2), ("c2".to_string(), 1)]
        );
        let tl = s.timeline(2).unwrap();
        assert_eq!(tl[0].r#ref, "e3");
        assert_eq!(tl[1].r#ref, "e2");
    }

    #[test]
    fn since_watermark_monotonic() {
        let s = Store::open_in_memory().unwrap();
        assert_eq!(s.since_for("c1").unwrap(), None);
        s.set_since("c1", 100).unwrap();
        s.set_since("c1", 50).unwrap();
        assert_eq!(s.since_for("c1").unwrap(), Some(100));
        s.set_since("c1", 150).unwrap();
        assert_eq!(s.since_for("c1").unwrap(), Some(150));
    }

    #[test]
    fn channels_upsert() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_channel("u1", Some("Uni"), None, false, 1).unwrap();
        s.upsert_channel("u1", Some("Uni2"), Some("d"), true, 2)
            .unwrap();
        let (name, archived): (String, i64) = s
            .conn
            .query_row(
                "SELECT name, archived FROM channels WHERE id='u1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(name, "Uni2");
        assert_eq!(archived, 1);
        assert_eq!(s.channel_name("u1").unwrap().as_deref(), Some("Uni2"));
        assert_eq!(s.channel_name("nope").unwrap(), None);
    }

    #[test]
    fn profiles_newest_wins_and_resolve_names() {
        let s = Store::open_in_memory().unwrap();
        let pk = "ab".repeat(32);
        assert_eq!(s.display_name(&pk).unwrap(), "abababab…");

        let p1 = Profile::from_kind0(&pk, r#"{"name":"astra","picture":"x"}"#, 10);
        assert!(s.upsert_profile(&p1).unwrap());
        assert_eq!(s.display_name(&pk).unwrap(), "astra");

        // Older event must not overwrite.
        let old = Profile::from_kind0(&pk, r#"{"name":"stale"}"#, 5);
        assert!(!s.upsert_profile(&old).unwrap());
        assert_eq!(s.display_name(&pk).unwrap(), "astra");

        // Newer with display_name wins over name.
        let newer = Profile::from_kind0(&pk, r#"{"name":"astra","display_name":"AstraJi"}"#, 20);
        assert!(s.upsert_profile(&newer).unwrap());
        assert_eq!(s.display_name(&pk).unwrap(), "AstraJi");
        assert_eq!(s.profile(&pk).unwrap().unwrap().picture, None);

        // Malformed content still records a fetch.
        let bad = Profile::from_kind0("cc", "not json", 1);
        assert_eq!(bad.label(), None);
        assert!(s.upsert_profile(&bad).unwrap());
        assert_eq!(s.display_name("cc").unwrap(), "cc…");
    }

    #[test]
    fn authors_without_profile_lists_missing_only() {
        let s = Store::open_in_memory().unwrap();
        let mut a = item("e1", "c1", 1);
        a.author = "a1".into();
        let mut b = item("e2", "c1", 2);
        b.author = "b2".into();
        s.upsert_item(&a).unwrap();
        s.upsert_item(&b).unwrap();
        assert_eq!(s.authors_without_profile().unwrap(), vec!["a1", "b2"]);
        s.upsert_profile(&Profile::from_kind0("a1", "{}", 1))
            .unwrap();
        assert_eq!(s.authors_without_profile().unwrap(), vec!["b2"]);
    }

    #[test]
    fn fts_search_matches_body_and_is_literal() {
        let s = Store::open_in_memory().unwrap();
        let mk = |r: &str, body: &str, ts: i64| Item {
            body: body.into(),
            ..item(r, "c1", ts)
        };
        s.upsert_item(&mk("e1", "[done] ref: pull/749 merged to next", 10))
            .unwrap();
        s.upsert_item(&mk("e2", "heartbeat: nothing new", 11))
            .unwrap();
        s.upsert_item(&mk("e3", "the PR didn't merge — eleven-day delay", 12))
            .unwrap();

        let hits = s.search("merge", 10).unwrap();
        let refs: Vec<_> = hits.iter().map(|i| i.r#ref.as_str()).collect();
        assert!(refs.contains(&"e1") && refs.contains(&"e3"), "{refs:?}");

        // Punctuation is literal, never FTS5 syntax.
        assert_eq!(s.search("didn't", 10).unwrap()[0].r#ref, "e3");
        assert_eq!(s.search("eleven-day", 10).unwrap()[0].r#ref, "e3");
        assert_eq!(s.search("\"quoted\" OR x", 10).unwrap().len(), 0);
        assert_eq!(s.search("   ", 10).unwrap().len(), 0);
        // Multi-token AND + prefix.
        assert_eq!(s.search("heart noth", 10).unwrap()[0].r#ref, "e2");
        assert_eq!(s.search("heart merged", 10).unwrap().len(), 0);
        assert_eq!(fts_literal_query("a \"b\""), "\"a\"* \"\"\"b\"\"\"*");
    }

    #[test]
    fn conversation_queries_preserve_threads_and_legacy_rows() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_channel("c1", Some("Uni"), None, false, 1).unwrap();
        s.upsert_channel("c2", Some("Other"), None, false, 1)
            .unwrap();
        s.upsert_item(&item("root", "c1", 10)).unwrap();
        s.upsert_item(&item("direct", "c1", 11)).unwrap();
        s.upsert_item(&item("nested", "c1", 12)).unwrap();
        s.upsert_item(&item("elsewhere", "c2", 13)).unwrap();
        s.set_message_refs("direct", Some("root"), Some("root"))
            .unwrap();
        s.set_message_refs("nested", Some("root"), Some("direct"))
            .unwrap();
        assert_eq!(
            s.room_messages("c1", 20)
                .unwrap()
                .iter()
                .map(|m| m.item.r#ref.as_str())
                .collect::<Vec<_>>(),
            vec!["root", "direct", "nested"]
        );
        let thread = s.thread_messages("c1", "root", 20).unwrap();
        assert_eq!(
            thread
                .iter()
                .map(|m| m.item.r#ref.as_str())
                .collect::<Vec<_>>(),
            vec!["root", "direct", "nested"]
        );
        assert_eq!(thread[2].parent.as_deref(), Some("direct"));
        s.upsert_item(&item("orphan", "c1", 14)).unwrap();
        s.set_message_refs("orphan", Some("unfetched"), Some("unfetched"))
            .unwrap();
        assert_eq!(
            s.thread_messages("c1", "unfetched", 20).unwrap()[0]
                .item
                .r#ref,
            "orphan"
        );
        assert!(s.thread_messages("c2", "root", 20).unwrap().is_empty());
        let rooms = s.rooms().unwrap();
        assert_eq!(rooms[0].id, "c1");
        assert_eq!(rooms[0].last_message.as_deref(), Some("body orphan"));
        assert_eq!(rooms[1].id, "c2");
    }

    #[test]
    fn room_timeline_hides_cached_thread_replies_and_counts_them() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_item(&item("root", "c1", 10)).unwrap();
        s.upsert_item(&item("plain", "c1", 11)).unwrap();
        s.upsert_item(&item("r1", "c1", 12)).unwrap();
        s.upsert_item(&item("r2", "c1", 15)).unwrap();
        s.upsert_item(&item("orphan", "c1", 16)).unwrap();
        s.set_message_refs("r1", Some("root"), Some("root"))
            .unwrap();
        s.set_message_refs("r2", Some("root"), Some("r1")).unwrap();
        s.set_message_refs("orphan", Some("missing"), Some("missing"))
            .unwrap();
        let tl = s.room_timeline("c1", 50).unwrap();
        let refs: Vec<_> = tl.iter().map(|t| t.message.item.r#ref.as_str()).collect();
        assert_eq!(refs, vec!["root", "plain", "orphan"]);
        assert_eq!(tl[0].reply_count, 2);
        assert_eq!(tl[0].last_reply_ts, Some(15));
        assert_eq!(tl[1].reply_count, 0);
        assert_eq!(tl[1].last_reply_ts, None);
        assert_eq!(tl[2].message.root.as_deref(), Some("missing"));
    }

    #[test]
    fn channel_members_join_profiles_and_feed_profile_fetch() {
        let s = Store::open_in_memory().unwrap();
        let (a, b, c) = ("a".repeat(64), "b".repeat(64), "c".repeat(64));
        s.replace_channel_members("c1", &[c.clone(), a.clone(), b.clone()])
            .unwrap();
        s.upsert_profile(&Profile::from_kind0(&a, r#"{"name":"zed"}"#, 1))
            .unwrap();
        s.upsert_profile(&Profile::from_kind0(&b, r#"{"display_name":"Uni"}"#, 1))
            .unwrap();
        let m = s.channel_members("c1").unwrap();
        assert_eq!(
            m.iter()
                .map(|m| (m.pubkey.as_str(), m.name.as_deref()))
                .collect::<Vec<_>>(),
            vec![
                (b.as_str(), Some("Uni")),
                (a.as_str(), Some("zed")),
                (c.as_str(), None)
            ]
        );
        assert_eq!(s.authors_without_profile().unwrap(), vec![c.clone()]);
        // Replacement drops members who left.
        s.replace_channel_members("c1", std::slice::from_ref(&a))
            .unwrap();
        assert_eq!(s.channel_members("c1").unwrap().len(), 1);
        assert!(s.channel_members("c2").unwrap().is_empty());
    }

    #[test]
    fn message_mentions_roundtrip() {
        let s = Store::open_in_memory().unwrap();
        s.set_message_mentions("e1", &["bb".into(), "aa".into(), "aa".into()])
            .unwrap();
        assert_eq!(s.message_mentions("e1").unwrap(), vec!["aa", "bb"]);
        s.set_message_mentions("e1", &[]).unwrap();
        assert!(s.message_mentions("e1").unwrap().is_empty());
    }

    #[test]
    fn fts_rebuild_on_schema_upgrade() {
        // Simulate a pre-FTS database: items exist, no items_fts table.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute(
            "INSERT INTO items (source, ref, channel, author, ts, body, mentions_me)
             VALUES ('buzz','old','c','a',1,'legacy searchable row',0)",
            [],
        )
        .unwrap();
        let s = Store::init(conn).unwrap();
        assert_eq!(s.search("legacy", 5).unwrap().len(), 1);
    }

    #[test]
    fn message_media_table_added_to_existing_database() {
        // A pre-media database (no message_media table) upgrades on open.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute_batch("DROP TABLE message_media").unwrap();
        let s = Store::init(conn).unwrap();
        let m = crate::media::MediaRef {
            url: "https://r/media/x".into(),
            ..Default::default()
        };
        s.set_message_media("e1", std::slice::from_ref(&m)).unwrap();
        assert_eq!(
            s.message_media(&["e1".into(), "e2".into()]).unwrap(),
            vec![("e1".to_string(), m)]
        );
        s.set_message_media("e1", &[]).unwrap();
        assert!(s.message_media(&["e1".into()]).unwrap().is_empty());
    }

    #[test]
    fn edits_apply_latest_by_author_and_deletions_hide() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_channel("c1", Some("Uni"), None, false, 1).unwrap();
        s.upsert_item(&item("m1", "c1", 10)).unwrap(); // author "aa"
        s.upsert_item(&item("m2", "c1", 11)).unwrap();
        s.upsert_item(&item("m3", "c1", 12)).unwrap();
        // Edit arrives before an older edit: newest ts wins regardless of order.
        s.upsert_aux("e2", KIND_EDIT, "m1", "aa", 30, "second edit")
            .unwrap();
        s.upsert_aux("e1", KIND_EDIT, "m1", "aa", 20, "first edit")
            .unwrap();
        // An edit by someone else is ignored.
        s.upsert_aux("ex", KIND_EDIT, "m1", "zz", 40, "hijack")
            .unwrap();
        // Deletions: kind 9005 and kind 5 both hide the target.
        s.upsert_aux("d2", KIND_DELETE_EVENT, "m2", "mod", 21, "")
            .unwrap();
        s.upsert_aux("d3", KIND_DELETION, "m3", "aa", 22, "")
            .unwrap();
        // Duplicate is a no-op; unknown kinds rejected.
        assert!(!s
            .upsert_aux("d3", KIND_DELETION, "m3", "aa", 22, "")
            .unwrap());
        assert!(s.upsert_aux("r", 1, "m1", "aa", 1, "x").is_err());

        let tl = s.room_timeline("c1", 50).unwrap();
        assert_eq!(tl.len(), 1);
        assert_eq!(tl[0].message.item.body, "second edit");
        assert!(tl[0].message.edited);
        assert!(s
            .room_messages("c1", 50)
            .unwrap()
            .iter()
            .all(|m| m.item.r#ref == "m1"));
        assert!(s.message("c1", "m2").unwrap().is_none());
        // Deleted text is not searchable; edited text is still found by original (FTS indexes items).
        assert!(s.search("m3", 10).unwrap().is_empty());
        // Room preview uses the edited body.
        assert_eq!(
            s.rooms().unwrap()[0].last_message.as_deref(),
            Some("second edit")
        );

        // Deleting the newest edit falls back to the previous one.
        s.upsert_aux("de2", KIND_DELETION, "e2", "aa", 50, "")
            .unwrap();
        assert_eq!(
            s.room_timeline("c1", 50).unwrap()[0].message.item.body,
            "first edit"
        );
    }

    #[test]
    fn search_messages_finds_current_text_only() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_channel("c1", Some("parachute"), None, false, 1)
            .unwrap();
        let mk = |r: &str, body: &str, ts: i64| Item {
            body: body.into(),
            ..item(r, "c1", ts)
        };
        s.upsert_item(&mk("m1", "relay wakeups need a push proxy", 10))
            .unwrap();
        s.upsert_item(&mk("m2", "unrelated lunch plans", 11))
            .unwrap();
        s.upsert_item(&mk("m3", "deleted relay secret", 12))
            .unwrap();
        s.upsert_item(&mk("m4", "thread reply about relay", 13))
            .unwrap();
        s.set_message_refs("m4", Some("m1"), Some("m1")).unwrap();
        s.upsert_item(&Item {
            channel: "c2".into(),
            ..mk("m5", "relay in an unnamed room", 14)
        })
        .unwrap();

        // Edit m2 by its author; a hijack edit by someone else must not count.
        s.upsert_aux("e1", KIND_EDIT, "m2", "aa", 20, "now about the fcm gateway")
            .unwrap();
        s.upsert_aux("ex", KIND_EDIT, "m1", "zz", 21, "hijacked zebra")
            .unwrap();
        s.upsert_aux("d3", KIND_DELETION, "m3", "aa", 22, "")
            .unwrap();

        let refs = |q: &str| {
            s.search_messages(q, 20)
                .unwrap()
                .into_iter()
                .map(|h| h.message.item.r#ref)
                .collect::<Vec<_>>()
        };
        // Edited message: found by new text, not by the old text.
        assert_eq!(refs("gateway"), vec!["m2"]);
        assert!(refs("lunch").is_empty());
        // Deleted message is never found; foreign edits are not searchable.
        assert!(!refs("relay").contains(&"m3".to_string()));
        assert!(refs("secret").is_empty());
        assert!(refs("zebra").is_empty());
        let mut r = refs("relay");
        r.sort();
        assert_eq!(r, vec!["m1", "m4", "m5"]);
        // Literal query handling and blank query.
        assert!(refs("   ").is_empty());
        assert!(refs("\"relay\" OR lunch").is_empty());

        let hits = s.search_messages("gateway", 5).unwrap();
        let h = &hits[0];
        assert!(h.message.edited);
        assert_eq!(h.message.item.body, "now about the fcm gateway");
        assert_eq!(h.channel_name.as_deref(), Some("parachute"));
        assert_eq!(
            h.snippet,
            format!("now about the fcm {SNIPPET_START}gateway{SNIPPET_END}")
        );
        // Thread position and unknown channel names come through.
        let reply = s.search_messages("thread", 5).unwrap();
        assert_eq!(reply[0].message.root.as_deref(), Some("m1"));
        let unnamed = s.search_messages("unnamed", 5).unwrap();
        assert_eq!(unnamed[0].channel_name, None);
        // Prefix match gets the whole token marked.
        let pre = s.search_messages("wake", 5).unwrap();
        assert!(
            pre[0]
                .snippet
                .contains(&format!("{SNIPPET_START}wakeups{SNIPPET_END}")),
            "{}",
            pre[0].snippet
        );

        // Deleting the edit falls back to the original text, which is searchable again.
        s.upsert_aux("de1", KIND_DELETION, "e1", "aa", 30, "")
            .unwrap();
        assert_eq!(refs("lunch"), vec!["m2"]);
        assert!(refs("gateway").is_empty());
    }

    #[test]
    fn edits_fts_backfills_on_upgrade() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute_batch(
            "INSERT INTO items (source, ref, channel, author, ts, body) VALUES ('buzz','m','c','a',1,'before');
             INSERT INTO aux_events (id, kind, target, author, ts, content) VALUES ('e',40003,'m','a',2,'after words');",
        )
        .unwrap();
        let s = Store::init(conn).unwrap();
        assert_eq!(s.search_messages("after", 5).unwrap().len(), 1);
        assert!(s.search_messages("before", 5).unwrap().is_empty());
    }

    #[test]
    fn deleted_replies_leave_thread_counts() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_item(&item("root", "c1", 10)).unwrap();
        s.upsert_item(&item("r1", "c1", 11)).unwrap();
        s.upsert_item(&item("r2", "c1", 12)).unwrap();
        s.set_message_refs("r1", Some("root"), Some("root"))
            .unwrap();
        s.set_message_refs("r2", Some("root"), Some("root"))
            .unwrap();
        s.upsert_aux("d", KIND_DELETE_EVENT, "r2", "aa", 13, "")
            .unwrap();
        let tl = s.room_timeline("c1", 50).unwrap();
        assert_eq!(tl[0].reply_count, 1);
        assert_eq!(tl[0].last_reply_ts, Some(11));
        assert_eq!(s.thread_messages("c1", "root", 50).unwrap().len(), 2);
        // Deleted root: its replies resurface in the main timeline (nothing disappears silently).
        s.upsert_aux("dr", KIND_DELETE_EVENT, "root", "aa", 14, "")
            .unwrap();
        let refs: Vec<_> = s
            .room_timeline("c1", 50)
            .unwrap()
            .into_iter()
            .map(|t| t.message.item.r#ref)
            .collect();
        assert_eq!(refs, vec!["r1"]);
    }

    #[test]
    fn unread_counts_follow_read_marker_and_skip_own_and_deleted() {
        let s = Store::open_in_memory().unwrap();
        let me = "aa";
        s.upsert_channel("c1", Some("Uni"), None, false, 1).unwrap();
        s.upsert_channel("c2", Some("Other"), None, false, 1)
            .unwrap();
        s.upsert_item(&item("old", "c1", 10)).unwrap();
        // No marker yet: nothing unread.
        assert_eq!(s.rooms_for(Some(me)).unwrap()[0].unread, 0);
        s.ensure_read_state("c1", 10).unwrap();
        s.ensure_read_state("c1", 999).unwrap(); // seeding never moves an existing marker
        let other = |r: &str, ts: i64, mention: bool| Item {
            author: "bb".into(),
            mentions_me: mention,
            ..item(r, "c1", ts)
        };
        s.upsert_item(&other("n1", 11, false)).unwrap();
        s.upsert_item(&other("n2", 12, true)).unwrap();
        s.upsert_item(&other("n3", 13, false)).unwrap();
        s.upsert_item(&item("mine", "c1", 14)).unwrap(); // own message: not unread
        s.upsert_aux("d", KIND_DELETE_EVENT, "n3", "bb", 15, "")
            .unwrap();
        let r = &s.rooms_for(Some(me)).unwrap()[0];
        assert_eq!((r.id.as_str(), r.unread, r.mentions), ("c1", 2, true));
        s.mark_read("c1").unwrap();
        let r = &s.rooms_for(Some(me)).unwrap()[0];
        assert_eq!((r.unread, r.mentions), (0, false));
        // Other rooms unaffected; rooms() without identity still lists them.
        assert_eq!(s.rooms().unwrap().len(), 2);
    }
}
