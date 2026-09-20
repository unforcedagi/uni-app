//! One-shot sync: connect → discover → per-channel history → profiles → store.
//!
//! A single [`sync_once`] pass is complete and idempotent: every write is an
//! `INSERT OR IGNORE` keyed on the event id, and each channel's REQ uses
//! `since` = that channel's watermark (max `created_at` seen). Re-running it
//! any number of times converges to the same store. This is the phone's
//! whole loop (connect-on-open → `sync_once` → disconnect); the desktop
//! layers [`crate::live`] on top for push after EOSE.

use std::collections::BTreeMap;

use nostr::{Event, Keys, PublicKey, Tag};

use crate::buzz::{event_channel, mentions, BuzzClient, RELAY_MAX_LIMIT};
use crate::store::{Item, Profile, Store};
use crate::Result;

/// What a sync run did.
#[derive(Debug, Default, Clone)]
pub struct SyncReport {
    /// Our pubkey (hex).
    pub pubkey: String,
    /// Channels discovered (non-archived), keyed by uuid string.
    pub channels: BTreeMap<String, Option<String>>,
    /// Events fetched per channel (this run, before dedupe).
    pub fetched: BTreeMap<String, usize>,
    /// New rows inserted per channel (this run).
    pub inserted: BTreeMap<String, usize>,
    /// Per-channel errors (e.g. `CLOSED restricted`), channel → message.
    pub channel_errors: BTreeMap<String, String>,
    /// Kind-0 profiles requested this run (authors with no cached row).
    pub profiles_requested: usize,
    /// Kind-0 profiles received and stored this run.
    pub profiles_stored: usize,
    /// Total rows in `items` after the run.
    pub total_items: i64,
}

/// Project a kind-9 event into the store. Returns `(inserted, ts)`.
///
/// `fallback_channel` is the channel whose subscription delivered the event,
/// used only when the event carries no parseable `h` tag.
pub fn ingest_message(
    store: &Store,
    ev: &Event,
    me: &PublicKey,
    fallback_channel: uuid::Uuid,
) -> Result<(bool, Item)> {
    let channel = event_channel(ev).unwrap_or(fallback_channel).to_string();
    let item = Item {
        source: "buzz".into(),
        r#ref: ev.id.to_hex(),
        channel,
        author: ev.pubkey.to_hex(),
        ts: ev.created_at.as_secs() as i64,
        body: ev.content.clone(),
        mentions_me: mentions(ev, me),
    };
    let inserted = store.upsert_item(&item)?;
    Ok((inserted, item))
}

/// Store a kind-0 event as a profile row. Returns `true` if stored/replaced.
pub fn ingest_profile(store: &Store, ev: &Event) -> Result<bool> {
    let p = Profile::from_kind0(
        &ev.pubkey.to_hex(),
        &ev.content,
        ev.created_at.as_secs() as i64,
    );
    store.upsert_profile(&p)
}

/// Fetch kind-0 profiles for every item author with no cached row.
/// Returns `(requested, stored)`.
pub async fn refresh_profiles(client: &mut BuzzClient, store: &Store) -> Result<(usize, usize)> {
    let missing: Vec<PublicKey> = store
        .authors_without_profile()?
        .iter()
        .filter_map(|h| PublicKey::from_hex(h).ok())
        .collect();
    if missing.is_empty() {
        return Ok((0, 0));
    }
    let events = client.fetch_profiles(&missing).await?;
    let mut stored = 0;
    for ev in &events {
        if ingest_profile(store, ev)? {
            stored += 1;
        }
    }
    Ok((missing.len(), stored))
}

/// Run one sync against `relay_url` into `store`.
///
/// Discovery failure is fatal (returned as `Err`); a per-channel `CLOSED` is
/// recorded in `channel_errors` and the run continues with the next channel.
pub async fn sync_once(
    relay_url: &str,
    keys: &Keys,
    auth_tag: Option<&Tag>,
    store: &Store,
) -> Result<SyncReport> {
    let mut report = SyncReport {
        pubkey: keys.public_key().to_hex(),
        ..Default::default()
    };

    crate::init_crypto();
    let mut client = BuzzClient::connect(relay_url, keys, auth_tag).await?;
    tracing::info!(relay = relay_url, "authenticated (NIP-42)");

    let channels = client.discover_channels().await?;
    let now = nostr::Timestamp::now().as_secs() as i64;
    for ci in channels.values() {
        store.upsert_channel(
            &ci.id.to_string(),
            ci.name.as_deref(),
            ci.description.as_deref(),
            ci.archived,
            now,
        )?;
        report.channels.insert(ci.id.to_string(), ci.name.clone());
    }

    let me = client.pubkey();
    let mut ids: Vec<_> = channels.keys().copied().collect();
    ids.sort();
    for ch in ids {
        let ch_str = ch.to_string();
        let since = store.since_for(&ch_str)?.map(|s| s as u64);
        let events = match client.channel_history(ch, since, RELAY_MAX_LIMIT).await {
            Ok(evs) => evs,
            Err(crate::Error::SubscriptionClosed { message, .. }) => {
                tracing::warn!(channel = %ch_str, "CLOSED: {message}");
                report.channel_errors.insert(ch_str, message);
                continue;
            }
            Err(e) => return Err(e),
        };
        report.fetched.insert(ch_str.clone(), events.len());

        let mut inserted = 0usize;
        let mut max_ts: Option<i64> = since.map(|s| s as i64);
        for ev in &events {
            let (new, item) = ingest_message(store, ev, &me, ch)?;
            if new {
                inserted += 1;
            }
            max_ts = Some(max_ts.map_or(item.ts, |m| m.max(item.ts)));
        }
        if let Some(ts) = max_ts {
            store.set_since(&ch_str, ts)?;
        }
        report.inserted.insert(ch_str, inserted);
    }

    let (requested, stored) = refresh_profiles(&mut client, store).await?;
    report.profiles_requested = requested;
    report.profiles_stored = stored;

    let _ = client.disconnect().await;
    report.total_items = store.count_items()?;
    Ok(report)
}
