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

/// Joined room with its most recent cached message.
#[derive(Debug, Clone)]
pub struct Room {
    pub id: String,
    pub name: Option<String>,
    pub last_message: Option<String>,
    pub last_ts: Option<i64>,
    pub mentions: bool,
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
    conn: Connection,
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

CREATE TABLE IF NOT EXISTS profiles (
    pubkey       TEXT PRIMARY KEY,
    name         TEXT,
    display_name TEXT,
    picture      TEXT,
    nip05        TEXT,
    updated_at   INTEGER NOT NULL
);
"#;

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

impl Store {
    /// Open (or create) the database at `path` and apply the schema.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
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
                (SELECT COUNT(*) FROM message_refs x JOIN items j ON j.ref=x.ref
                  WHERE x.root=i.ref AND j.channel=i.channel AND j.ref<>i.ref),
                (SELECT MAX(j.ts) FROM message_refs x JOIN items j ON j.ref=x.ref
                  WHERE x.root=i.ref AND j.channel=i.channel AND j.ref<>i.ref)
             FROM items i LEFT JOIN message_refs r ON r.ref=i.ref
             WHERE i.source='buzz' AND i.channel=?1
               AND (r.root IS NULL OR r.root=i.ref
                    OR NOT EXISTS(SELECT 1 FROM items k WHERE k.ref=r.root AND k.channel=i.channel))
             ORDER BY i.ts DESC,i.ref DESC LIMIT ?2",
        )?;
        let mut rows = stmt
            .query_map(params![channel, limit.min(500) as i64], |r| {
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
            "SELECT i.source,i.ref,i.channel,i.author,i.ts,i.body,i.mentions_me,r.root,r.parent
             FROM items i LEFT JOIN message_refs r ON r.ref=i.ref
             WHERE i.source='buzz' AND i.channel=?1
             ORDER BY i.ts DESC,i.ref DESC LIMIT ?2",
        )?;
        let mut rows = stmt
            .query_map(params![channel, limit.min(500) as i64], row_to_message)?
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
            "SELECT i.source,i.ref,i.channel,i.author,i.ts,i.body,i.mentions_me,r.root,r.parent
             FROM items i LEFT JOIN message_refs r ON r.ref=i.ref
             WHERE i.source='buzz' AND i.channel=?1 AND (i.ref=?2 OR r.root=?2)
             ORDER BY i.ts ASC,i.ref ASC LIMIT ?3",
        )?;
        let rows = stmt
            .query_map(
                params![channel, root, limit.min(500) as i64],
                row_to_message,
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Joined channels, sorted with Uni first and the most active rooms next.
    pub fn rooms(&self) -> Result<Vec<Room>> {
        let mut stmt = self.conn.prepare(
            "SELECT c.id,c.name,
                (SELECT body FROM items WHERE source='buzz' AND channel=c.id ORDER BY ts DESC,ref DESC LIMIT 1),
                (SELECT ts FROM items WHERE source='buzz' AND channel=c.id ORDER BY ts DESC,ref DESC LIMIT 1),
                EXISTS(SELECT 1 FROM items WHERE source='buzz' AND channel=c.id AND mentions_me=1)
             FROM channels c WHERE archived=0
             ORDER BY CASE WHEN lower(c.name)='uni' THEN 0 ELSE 1 END,
                      (SELECT MAX(ts) FROM items WHERE source='buzz' AND channel=c.id) DESC,c.id",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Room {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    last_message: r.get(2)?,
                    last_ts: r.get(3)?,
                    mentions: r.get::<_, i64>(4)? != 0,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Find an existing message in a channel, including its thread ancestry.
    pub fn message(&self, channel: &str, id: &str) -> Result<Option<ConversationMessage>> {
        Ok(self
            .conn
            .query_row(
                "SELECT i.source,i.ref,i.channel,i.author,i.ts,i.body,i.mentions_me,r.root,r.parent
             FROM items i LEFT JOIN message_refs r ON r.ref=i.ref
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
             ORDER BY bm25(items_fts), i.ts DESC LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![q, limit as i64], row_to_item)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }
}

fn row_to_message(r: &rusqlite::Row<'_>) -> rusqlite::Result<ConversationMessage> {
    Ok(ConversationMessage {
        item: row_to_item(r)?,
        root: r.get(7)?,
        parent: r.get(8)?,
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
}
