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

use crate::buzz::{aux_target, event_channel, mentions, p_tags, BuzzClient, AUX_KINDS, KIND_CHANNEL_MESSAGE, RELAY_MAX_LIMIT};
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
    store.set_message_mentions(&item.r#ref, &p_tags(ev))?;
    let mut root = None;
    let mut parent = None;
    for tag in ev.tags.iter() {
        let parts = tag.as_slice();
        if parts.first().map(String::as_str) != Some("e") {
            continue;
        }
        let Some(id) = parts
            .get(1)
            .filter(|id| nostr::EventId::from_hex(id).is_ok())
        else {
            continue;
        };
        match parts.get(3).map(String::as_str) {
            Some("root") => root = Some(id.as_str()),
            Some("reply") => parent = Some(id.as_str()),
            _ => {}
        }
    }
    if root.is_none() {
        root = parent;
    }
    if parent.is_some() {
        store.set_message_refs(&item.r#ref, root, parent)?;
    }
    Ok((inserted, item))
}

/// What a channel-subscription event did to the store.
#[derive(Debug, Clone)]
pub enum Ingested {
    /// A kind-9 message (`new == false`: duplicate).
    Message { new: bool, item: Item },
    /// An edit / deletion aimed at `target` (`new == false`: duplicate).
    Aux { new: bool, kind: u16, target: String, ts: i64 },
    /// Some other kind, or an aux event with no valid target; ignored.
    Ignored,
}

/// Record an edit (40003) or deletion (5 / 9005). The relay has already
/// authorized it (edit ownership, delete permission); the store's view
/// additionally requires an edit's signer to be the message author.
pub fn ingest_aux(store: &Store, ev: &Event) -> Result<Ingested> {
    let kind = ev.kind.as_u16();
    let Some(target) = aux_target(ev) else {
        return Ok(Ingested::Ignored);
    };
    let ts = ev.created_at.as_secs() as i64;
    let new = store.upsert_aux(
        &ev.id.to_hex(),
        kind as i64,
        &target,
        &ev.pubkey.to_hex(),
        ts,
        &ev.content,
    )?;
    Ok(Ingested::Aux { new, kind, target, ts })
}

/// Route any event delivered on a `ch-<uuid>` subscription.
pub fn ingest_channel_event(
    store: &Store,
    ev: &Event,
    me: &PublicKey,
    channel: uuid::Uuid,
) -> Result<Ingested> {
    let kind = ev.kind.as_u16();
    if kind == KIND_CHANNEL_MESSAGE {
        let (new, item) = ingest_message(store, ev, me, channel)?;
        Ok(Ingested::Message { new, item })
    } else if AUX_KINDS.contains(&kind) {
        ingest_aux(store, ev)
    } else {
        Ok(Ingested::Ignored)
    }
}

/// Load one page of older history for `channel` (messages strictly older
/// than the oldest cached one, with their edits / deletions / reactions).
/// Returns how many new messages were stored; `0` means the start of the
/// room's history has been reached. Never moves the live `since` watermark
/// or the read marker: older messages are history, not news.
pub async fn sync_older(
    relay_url: &str,
    keys: &Keys,
    auth_tag: Option<&Tag>,
    store: &Store,
    channel: uuid::Uuid,
    limit: u64,
) -> Result<usize> {
    let ch = channel.to_string();
    let Some(oldest) = store.oldest_ts(&ch)? else {
        return Ok(0);
    };
    crate::init_crypto();
    let mut client = BuzzClient::connect(relay_url, keys, auth_tag).await?;
    // `until` is inclusive; same-second siblings of the oldest message are
    // re-fetched and deduped by id rather than skipped.
    let events = client
        .channel_history_before(channel, oldest.max(0) as u64, limit)
        .await?;
    let me = client.pubkey();
    let mut inserted = 0usize;
    for ev in &events {
        if let Ingested::Message { new: true, .. } = ingest_channel_event(store, ev, &me, channel)? {
            inserted += 1;
        }
    }
    refresh_profiles(&mut client, store).await?;
    let _ = client.disconnect().await;
    Ok(inserted)
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

    let discovery = client.discover().await?;
    let channels = discovery.channels;
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
    for (ch, members) in &discovery.members {
        store.replace_channel_members(&ch.to_string(), members)?;
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
            let ts = match ingest_channel_event(store, ev, &me, ch)? {
                Ingested::Message { new, item } => {
                    inserted += new as usize;
                    item.ts
                }
                Ingested::Aux { ts, .. } => ts,
                Ingested::Ignored => continue,
            };
            max_ts = Some(max_ts.map_or(ts, |m| m.max(ts)));
        }
        if let Some(ts) = max_ts {
            store.set_since(&ch_str, ts)?;
        }
        // First sight of this room (or first run after upgrade): what we just
        // backfilled counts as read; only later arrivals are unread.
        store.ensure_read_state(&ch_str, max_ts.unwrap_or(0))?;
        report.inserted.insert(ch_str, inserted);
    }

    let (requested, stored) = refresh_profiles(&mut client, store).await?;
    report.profiles_requested = requested;
    report.profiles_stored = stored;

    let _ = client.disconnect().await;
    report.total_items = store.count_items()?;
    Ok(report)
}

#[cfg(test)]
mod conversation_tests {
    use super::*;
    use nostr::{EventBuilder, Kind, Tag};
    #[test]
    fn ingest_persists_nip10_root_and_parent() {
        let store = Store::open_in_memory().unwrap();
        let keys = Keys::generate();
        let ch = uuid::Uuid::new_v4();
        let root = "a".repeat(64);
        let parent = "b".repeat(64);
        let tags = vec![
            Tag::parse(vec!["h", &ch.to_string()]).unwrap(),
            Tag::parse(vec!["e", &root, "", "root"]).unwrap(),
            Tag::parse(vec!["e", &parent, "", "reply"]).unwrap(),
        ];
        let ev = EventBuilder::new(Kind::Custom(9), "reply")
            .tags(tags)
            .sign_with_keys(&keys)
            .unwrap();
        ingest_message(&store, &ev, &keys.public_key(), ch).unwrap();
        let stored = store
            .message(&ch.to_string(), &ev.id.to_hex())
            .unwrap()
            .unwrap();
        assert_eq!(stored.root.as_deref(), Some(root.as_str()));
        assert_eq!(stored.parent.as_deref(), Some(parent.as_str()));
    }
}
