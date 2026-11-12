//! One-shot sync: connect → discover → per-channel history → profiles → store.
//!
//! A single [`sync_once`] pass is complete and idempotent: every write is an
//! `INSERT OR IGNORE` keyed on the event id, and each channel's REQ uses
//! `since` = that channel's watermark (max `created_at` seen). Re-running it
//! any number of times converges to the same store. This is the phone's
//! whole loop (connect-on-open → `sync_once` → disconnect); the desktop
//! layers [`crate::live`] on top for push after EOSE.

use std::collections::BTreeMap;

use nostr::{Event, JsonUtil, Keys, PublicKey, Tag};

use crate::buzz::{
    aux_target, event_channel, mentions, p_tags, BuzzClient, AUX_KINDS, KIND_CHANNEL_MESSAGE,
    RELAY_MAX_LIMIT,
};
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
    /// Rooms whose read marker advanced from another device's read state.
    pub read_state_advanced: Vec<String>,
    /// Archived identities now hidden from member lists (NIP-IA 13535).
    pub archived: usize,
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
    if crate::secret::parse_request(&ev.content).is_some()
        || crate::sealed::has_enroll_tag(ev)
        || crate::sealed_card::card_kind(&ev.content).is_some()
    {
        // T-176: the secret path re-verifies this before it answers (see `secret::stored_request`); T-234: so do
        // the room's enrollment line (`sealed::stored_enrollment`) and Uni's approval cards (`sealed_card::stored_card`).
        store.put_signed_event(&item.r#ref, &ev.as_json())?;
    } else if ask_shaped(ev) {
        // T-335 one ask: the webview reads asks with the shared rule (src/ask), on the events as they were signed
        store.put_signed_event(&item.r#ref, &ev.as_json())?;
    }
    store.set_message_mentions(&item.r#ref, &p_tags(ev))?;
    let media = crate::media::parse_imeta(ev.tags.iter().map(|t| t.as_slice()));
    if !media.is_empty() {
        store.set_message_media(&item.r#ref, &media)?;
    }
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

/// T-335 one ask: a kind-9 the ask rule (uni-ask SPEC.md) may read: an ask or an answer (a fenced block), a reply that quotes a
/// message (`q`), or a legacy thread reply (`e`), which the rule still counts as an answer's words. Over-keeping is harmless: the
/// rule itself decides what is an ask and what answers one.
pub fn ask_shaped(ev: &Event) -> bool {
    let fenced = ev.content.split('\n').any(|l| {
        let l = l.trim_end_matches('\r');
        l == "```uni-ask" || l == "```uni-answer"
    });
    fenced
        || ev
            .tags
            .iter()
            .any(|t| matches!(t.as_slice().first().map(String::as_str), Some("q") | Some("e")))
}

/// What a channel-subscription event did to the store.
#[derive(Debug, Clone)]
pub enum Ingested {
    /// A kind-9 message (`new == false`: duplicate).
    Message { new: bool, item: Item },
    /// An edit / deletion aimed at `target` (`new == false`: duplicate).
    Aux {
        new: bool,
        kind: u16,
        target: String,
        ts: i64,
    },
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
    if kind == 40003 || kind == 5 {
        // T-335 one ask: an asker's close is an edit of its ask, and a deletion withdraws it; the rule reads them as signed
        store.put_signed_event(&ev.id.to_hex(), &ev.as_json())?;
    }
    let new = store.upsert_aux(
        &ev.id.to_hex(),
        kind as i64,
        &target,
        &ev.pubkey.to_hex(),
        ts,
        &ev.content,
    )?;
    Ok(Ingested::Aux {
        new,
        kind,
        target,
        ts,
    })
}

/// Route any event delivered on a `ch-<uuid>` subscription. An event whose id
/// or signature does not verify is dropped: the relay's word is not proof of
/// who wrote it (the websocket client does not verify on receipt).
pub fn ingest_channel_event(
    store: &Store,
    ev: &Event,
    me: &PublicKey,
    channel: uuid::Uuid,
) -> Result<Ingested> {
    let kind = ev.kind.as_u16();
    if (kind == KIND_CHANNEL_MESSAGE || AUX_KINDS.contains(&kind)) && ev.verify().is_err() {
        tracing::warn!(id = %ev.id, kind, "dropping an event whose id or signature does not verify");
        return Ok(Ingested::Ignored);
    }
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
        if let Ingested::Message { new: true, .. } = ingest_channel_event(store, ev, &me, channel)?
        {
            inserted += 1;
        }
    }
    refresh_profiles(&mut client, store).await?;
    let _ = client.disconnect().await;
    Ok(inserted)
}

/// Store a kind-0 event as a profile row. Returns `true` if stored/replaced.
/// A profile whose signature does not verify is dropped.
pub fn ingest_profile(store: &Store, ev: &Event) -> Result<bool> {
    if ev.verify().is_err() {
        return Ok(false);
    }
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

/// Refresh the cached archived-identity set from the relay's verified
/// kind:13535 snapshot. Returns how many identities are now hidden.
pub async fn refresh_archived(
    client: &mut BuzzClient,
    relay_url: &str,
    store: &Store,
) -> Result<usize> {
    let relay_self = crate::archive::fetch_relay_self(relay_url).await?;
    let archived = crate::archive::fetch_archived(client, &relay_self).await?;
    let archived = crate::archive::without_protected(archived, &client.pubkey().to_hex());
    store.replace_archived(&archived)?;
    Ok(archived.len())
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
    // r25 (Codex 8): where a cold start's time goes: connect + auth, discovery, then each room's history
    let t0 = std::time::Instant::now();
    let mut client = BuzzClient::connect(relay_url, keys, auth_tag).await?;
    tracing::info!(relay = relay_url, ms = t0.elapsed().as_millis() as u64, "authenticated (NIP-42)");

    let discovery = client.discover().await?;
    tracing::info!(ms = t0.elapsed().as_millis() as u64, rooms = discovery.channels.len(), archived = discovery.archived.len(), "sync: rooms discovered");
    let channels = discovery.channels;
    let now = nostr::Timestamp::now().as_secs() as i64;
    for ci in channels.values() {
        store.upsert_channel_kind(
            &ci.id.to_string(),
            ci.name.as_deref(),
            ci.description.as_deref(),
            ci.archived,
            ci.dm,
            now,
        )?;
        report.channels.insert(ci.id.to_string(), ci.name.clone());
    }
    // A room archived on the relay after we cached it leaves the room list.
    // It is not in `channels`, so no history is fetched for it.
    for ch in &discovery.archived {
        store.mark_channel_archived(&ch.to_string(), now)?;
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
        tracing::info!(ms = t0.elapsed().as_millis() as u64, channel = %ch_str, events = events.len(), first_sync = since.is_none(), "sync: room history fetched");
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

    // Cross-device read markers (Buzz NIP-RS, kind 30078). Best effort: a
    // failure here must not fail the message sync.
    match crate::readstate::fetch_read_state(&mut client, keys, store).await {
        Ok(adv) => report.read_state_advanced = adv,
        Err(e) => tracing::warn!("read-state fetch failed: {e}"),
    }

    // NIP-IA archived identities (retired agents). Best effort: on any
    // failure keep the cached set rather than un-hiding or failing the sync.
    match refresh_archived(&mut client, relay_url, store).await {
        Ok(n) => report.archived = n,
        Err(e) => tracing::warn!("archived-identities fetch failed: {e}"),
    }

    let (requested, stored) = refresh_profiles(&mut client, store).await?;
    report.profiles_requested = requested;
    report.profiles_stored = stored;
    tracing::info!(ms = t0.elapsed().as_millis() as u64, "sync: done");

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

    /// T-335 one ask: the events the ask rule reads are kept as signed (an ask, a quoted answer, a legacy thread reply, the asker's
    /// close and a deletion); an ordinary message is not; `since` bounds the read.
    #[test]
    fn ask_events_keeps_what_the_ask_rule_reads_as_signed() {
        let store = Store::open_in_memory().unwrap();
        let (uni, me) = (Keys::generate(), Keys::generate());
        let ch = uuid::Uuid::new_v4();
        let h = || Tag::parse(vec!["h".to_string(), ch.to_string()]).unwrap();
        let at = |t: u64| nostr::Timestamp::from(t);
        let ask = EventBuilder::new(Kind::Custom(9), "Pick one\nWhy\n\n```uni-ask\n{\"v\":1}\n```")
            .tags([h()]).custom_created_at(at(1_000)).sign_with_keys(&uni).unwrap();
        let id = ask.id.to_hex();
        let plain = EventBuilder::new(Kind::Custom(9), "just talk").tags([h()]).custom_created_at(at(1_001)).sign_with_keys(&me).unwrap();
        let answer = EventBuilder::new(Kind::Custom(9), "my words")
            .tags([h(), Tag::parse(vec!["q".to_string(), id.clone(), String::new(), uni.public_key().to_hex()]).unwrap()])
            .custom_created_at(at(1_002)).sign_with_keys(&me).unwrap();
        let legacy = EventBuilder::new(Kind::Custom(9), "under it")
            .tags([h(), Tag::parse(vec!["e".to_string(), id.clone(), String::new(), "reply".to_string()]).unwrap()])
            .custom_created_at(at(1_003)).sign_with_keys(&me).unwrap();
        let close = EventBuilder::new(Kind::Custom(40003), "Closed (done): Pick one")
            .tags([h(), Tag::parse(vec!["e".to_string(), id.clone()]).unwrap()]).custom_created_at(at(1_004)).sign_with_keys(&uni).unwrap();
        let gone = EventBuilder::new(Kind::Custom(5), "")
            .tags([Tag::parse(vec!["e".to_string(), id.clone()]).unwrap()]).custom_created_at(at(1_005)).sign_with_keys(&uni).unwrap();
        for ev in [&ask, &plain, &answer, &legacy, &close, &gone] {
            ingest_channel_event(&store, ev, &me.public_key(), ch).unwrap();
        }
        let got: Vec<Event> = store.ask_events(0, 100).unwrap().iter().map(|j| Event::from_json(j).unwrap()).collect();
        let ids: Vec<String> = got.iter().map(|e| e.id.to_hex()).collect();
        assert_eq!(ids, [&gone, &close, &legacy, &answer, &ask].map(|e| e.id.to_hex()));
        assert!(got.iter().all(|e| e.verify().is_ok()), "kept exactly as signed");
        assert_eq!(store.ask_events(1_003, 100).unwrap().len(), 3);
        assert_eq!(store.ask_events(0, 2).unwrap().len(), 2);
        // a message the relay removed (NIP-29 9005) is gone for the rule too
        store.upsert_aux(&"9".repeat(64), 9005, &answer.id.to_hex(), &uni.public_key().to_hex(), 1_006, "").unwrap();
        let after: Vec<String> = store.ask_events(0, 100).unwrap().iter().map(|j| Event::from_json(j).unwrap().id.to_hex()).collect();
        assert!(!after.contains(&answer.id.to_hex()) && after.len() == 4);
    }

    #[test]
    fn ingest_persists_imeta_attachments() {
        let store = Store::open_in_memory().unwrap();
        let keys = Keys::generate();
        let ch = uuid::Uuid::new_v4();
        let sha = "ab".repeat(32);
        let url = format!("https://buzz.example/media/{sha}.jpg");
        let tags = vec![
            Tag::parse(vec!["h", &ch.to_string()]).unwrap(),
            Tag::parse(vec![
                "imeta",
                &format!("url {url}"),
                "m image/jpeg",
                &format!("x {sha}"),
                "dim 10x20",
            ])
            .unwrap(),
            Tag::parse(vec![
                "imeta",
                "url https://buzz.example/media/notes.pdf",
                "m application/pdf",
                "filename notes.pdf",
            ])
            .unwrap(),
        ];
        let ev = EventBuilder::new(Kind::Custom(9), format!("![image]({url})"))
            .tags(tags)
            .sign_with_keys(&keys)
            .unwrap();
        ingest_message(&store, &ev, &keys.public_key(), ch).unwrap();
        // Re-ingesting the same event is idempotent.
        ingest_message(&store, &ev, &keys.public_key(), ch).unwrap();
        let media = store.message_media(&[ev.id.to_hex()]).unwrap();
        assert_eq!(media.len(), 2);
        assert_eq!(media[0].1.url, url);
        assert_eq!(media[0].1.sha256.as_deref(), Some(sha.as_str()));
        assert_eq!(media[0].1.dim.as_deref(), Some("10x20"));
        assert_eq!(media[1].1.filename.as_deref(), Some("notes.pdf"));
        assert_eq!(media[1].1.sha256, None);
    }
}
