//! Local SQLite store.
//!
//! `items` is the unified timeline projection (spec §5): one row per Buzz
//! event or vault note. Phase 1 writes only `source = 'buzz'` rows.
//! `channels` caches discovery output; `sync_state` holds per-channel
//! `since` watermarks so a re-run only pulls new history.

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
CREATE INDEX IF NOT EXISTS items_ts ON items(ts DESC);
CREATE INDEX IF NOT EXISTS items_channel_ts ON items(channel, ts DESC);

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
"#;

impl Store {
    /// Open (or create) the database at `path` and apply the schema.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn })
    }

    /// In-memory store (tests).
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
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

    /// Newest-first slice of the timeline.
    pub fn timeline(&self, limit: usize) -> Result<Vec<Item>> {
        let mut stmt = self.conn.prepare(
            "SELECT source, ref, channel, author, ts, body, mentions_me
             FROM items ORDER BY ts DESC LIMIT ?1",
        )?;
        let rows = stmt
            .query_map(params![limit as i64], |r| {
                Ok(Item {
                    source: r.get(0)?,
                    r#ref: r.get(1)?,
                    channel: r.get(2)?,
                    author: r.get(3)?,
                    ts: r.get(4)?,
                    body: r.get(5)?,
                    mentions_me: r.get::<_, i64>(6)? != 0,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }
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
    }
}
