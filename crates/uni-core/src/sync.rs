//! One-shot sync: connect → discover → per-channel history → store.

use std::collections::BTreeMap;

use nostr::{Keys, Tag};

use crate::buzz::{event_channel, mentions, BuzzClient, RELAY_MAX_LIMIT};
use crate::store::{Item, Store};
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
    /// Total rows in `items` after the run.
    pub total_items: i64,
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
            // Trust the relay's fan-out, but prefer the event's own `h` tag.
            let channel = event_channel(ev).unwrap_or(ch).to_string();
            let item = Item {
                source: "buzz".into(),
                r#ref: ev.id.to_hex(),
                channel,
                author: ev.pubkey.to_hex(),
                ts: ev.created_at.as_secs() as i64,
                body: ev.content.clone(),
                mentions_me: mentions(ev, &me),
            };
            if store.upsert_item(&item)? {
                inserted += 1;
            }
            max_ts = Some(max_ts.map_or(item.ts, |m| m.max(item.ts)));
        }
        if let Some(ts) = max_ts {
            store.set_since(&ch_str, ts)?;
        }
        report.inserted.insert(ch_str, inserted);
    }

    let _ = client.disconnect().await;
    report.total_items = store.count_items()?;
    Ok(report)
}
