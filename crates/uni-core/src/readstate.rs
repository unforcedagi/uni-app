//! Cross-device read markers, wire-compatible with Buzz (NIP-RS over NIP-78).
//!
//! Mirrors Buzz desktop `desktop/src/features/channels/readState/`
//! (`readStateFormat.ts`, `readStateSnapshot.ts`, `readStateManager.ts`) and
//! mobile `mobile/lib/shared/read_state/` exactly:
//!
//! - kind **30078** (parameterized replaceable), one event per client *slot*;
//! - tags `["d", "read-state:<slot>"]` (slot: 1–64 ASCII chars; Buzz uses 32
//!   hex) and exactly one `["t", "read-state"]`;
//! - `content` = NIP-44 v2 encrypted **to self** (our secret key, our own
//!   pubkey) of the JSON blob `{"v":1,"client_id":"<uuid>","contexts":{"<ctx>":<unix secs>}}`;
//! - a channel's context key is its uuid; `thread:<id>` / `msg:<id>` keys are
//!   thread/message markers (this app has no thread-level unread, so they are
//!   ignored on read and never published — other clients keep them in their
//!   own slots, and every reader max-merges across all slots);
//! - merge is `max()` per context, never backwards; `created_at` of a publish
//!   is `max(now, newest fetched read-state created_at + 1)`;
//! - fetch filter `{kinds:[30078], authors:[me], "#t":["read-state"],
//!   since: now-7d, limit: 500}`.
//!
//! Only "publishable" contexts go out: ones the user actually read here
//! ([`Store::mark_read`]) or that arrived from another client — never the
//! first-sight seeds from [`Store::ensure_read_state`] (desktop
//! `seedContextRead` vs `markContextRead`). Multi-slot splitting (desktop's
//! fallback past ~600 channels) is not implemented; publishing refuses
//! instead of emitting an oversized blob.

use std::collections::BTreeMap;

use nostr::nips::nip44;
use nostr::{Alphabet, Event, EventBuilder, Filter, Keys, Kind, SingleLetterTag, Tag, Timestamp};
use serde::{Deserialize, Serialize};

use crate::buzz::BuzzClient;
use crate::{Error, Result, Store};

/// NIP-78 application-specific data (Buzz `KIND_READ_STATE`).
pub const KIND_READ_STATE: u16 = 30078;
/// `d`-tag prefix; the rest is the client's slot id.
pub const READ_STATE_D_TAG_PREFIX: &str = "read-state:";
/// Value of the single required `t` tag.
pub const READ_STATE_T_TAG: &str = "read-state";
/// Fetch limit (Buzz `READ_STATE_FETCH_LIMIT`).
pub const READ_STATE_FETCH_LIMIT: usize = 500;
/// Fetch horizon (Buzz `READ_STATE_HORIZON_SECONDS`, 7 days).
pub const READ_STATE_HORIZON_SECONDS: u64 = 7 * 24 * 60 * 60;
/// Max plaintext bytes of one blob (Buzz `READ_STATE_MAX_PLAINTEXT_BYTES`).
pub const READ_STATE_MAX_PLAINTEXT_BYTES: usize = 32_768;
/// Max contexts in a blob before it's rejected (Buzz `MAX_CONTEXTS`).
const MAX_CONTEXTS: usize = 10_000;
/// Live sub id for our own read-state events.
pub const READ_STATE_SUB_ID: &str = "read-state";

const META_CLIENT_ID: &str = "client_id";
const META_SLOT_ID: &str = "slot_id";
const META_MAX_CREATED_AT: &str = "max_fetched_created_at";
const META_LAST_PUBLISHED: &str = "last_published";

fn last_published_key(keys: &Keys) -> String {
    meta_key(META_LAST_PUBLISHED, keys)
}

/// Decrypted blob. Field order matches desktop's `JSON.stringify`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadStateBlob {
    pub v: u8,
    pub client_id: String,
    pub contexts: BTreeMap<String, u64>,
}

/// A validated, decrypted read-state event.
#[derive(Debug, Clone)]
pub struct ParsedReadState {
    pub d_tag: String,
    pub blob: ReadStateBlob,
    pub created_at: u64,
}

fn now_secs() -> u64 {
    Timestamp::now().as_secs()
}

/// `{kinds:[30078], authors:[me], "#t":["read-state"], since: now-7d, limit: 500}`.
pub fn read_state_filter(keys: &Keys) -> Filter {
    Filter::new()
        .kind(Kind::Custom(KIND_READ_STATE))
        .author(keys.public_key())
        .custom_tags(SingleLetterTag::lowercase(Alphabet::T), [READ_STATE_T_TAG])
        .since(Timestamp::from_secs(now_secs().saturating_sub(READ_STATE_HORIZON_SECONDS)))
        .limit(READ_STATE_FETCH_LIMIT)
}

/// Buzz `isValidReadStateDTag`.
fn valid_d_tag(v: &str) -> bool {
    v.strip_prefix(READ_STATE_D_TAG_PREFIX)
        .is_some_and(|slot| !slot.is_empty() && slot.len() <= 64 && slot.is_ascii())
}

/// Buzz `parseReadStateEvent` + `isValidBlob` + `sanitizeContexts`.
pub fn parse_read_state_event(ev: &Event, keys: &Keys) -> Option<ParsedReadState> {
    if ev.pubkey != keys.public_key() || ev.kind.as_u16() != KIND_READ_STATE {
        return None;
    }
    let tag = |name: &str| {
        ev.tags
            .iter()
            .map(|t| t.as_slice())
            .filter(move |t| t.first().map(String::as_str) == Some(name))
            .collect::<Vec<_>>()
    };
    let d = tag("d");
    if d.len() != 1 {
        return None;
    }
    let d_tag = d[0].get(1).filter(|v| valid_d_tag(v))?.clone();
    if tag("t")
        .iter()
        .filter(|t| t.get(1).map(String::as_str) == Some(READ_STATE_T_TAG))
        .count()
        != 1
    {
        return None;
    }
    let plain = nip44::decrypt(keys.secret_key(), &keys.public_key(), &ev.content).ok()?;
    let v: serde_json::Value = serde_json::from_str(&plain).ok()?;
    let obj = v.as_object()?;
    if obj.get("v").and_then(|x| x.as_u64()) != Some(1) {
        return None;
    }
    let client_id = obj.get("client_id")?.as_str()?;
    if client_id.is_empty() || client_id.chars().count() > 64 {
        return None;
    }
    let ctx = obj.get("contexts")?.as_object()?;
    if ctx.len() > MAX_CONTEXTS {
        return None;
    }
    let contexts = ctx
        .iter()
        .filter(|(k, _)| k.len() <= 256)
        .filter_map(|(k, v)| {
            // Integer JSON numbers only (a float like 1.5 is dropped, as in JS).
            let n = v.as_u64()?;
            (n <= u32::MAX as u64).then(|| (k.clone(), n))
        })
        .collect();
    Some(ParsedReadState {
        d_tag,
        blob: ReadStateBlob {
            v: 1,
            client_id: client_id.to_string(),
            contexts,
        },
        created_at: ev.created_at.as_secs(),
    })
}

/// A channel-level context key (a Buzz channel uuid), as opposed to
/// `thread:` / `msg:` or other client-local keys.
fn is_channel_context(key: &str) -> bool {
    uuid::Uuid::parse_str(key).is_ok_and(|u| u.to_string() == key)
}

/// This install's client id and slot id, created on first use (desktop:
/// `crypto.randomUUID()` / 16 random bytes as hex).
fn identity(store: &Store, keys: &Keys) -> Result<(String, String)> {
    let pk = keys.public_key().to_hex();
    let get_or = |name: &str, make: fn() -> String| -> Result<String> {
        let key = format!("{name}:{pk}");
        if let Some(v) = store.read_sync_meta(&key)? {
            return Ok(v);
        }
        let v = make();
        store.set_read_sync_meta(&key, &v)?;
        Ok(v)
    };
    let client = get_or(META_CLIENT_ID, || uuid::Uuid::new_v4().to_string())?;
    let slot = get_or(META_SLOT_ID, || uuid::Uuid::new_v4().simple().to_string())?;
    Ok((client, slot))
}

fn meta_key(name: &str, keys: &Keys) -> String {
    format!("{name}:{}", keys.public_key().to_hex())
}

fn max_fetched_created_at(store: &Store, keys: &Keys) -> Result<u64> {
    Ok(store
        .read_sync_meta(&meta_key(META_MAX_CREATED_AT, keys))?
        .and_then(|v| v.parse().ok())
        .unwrap_or(0))
}

fn note_created_at(store: &Store, keys: &Keys, created_at: u64) -> Result<()> {
    // Ignore implausible future timestamps (mobile `_isPlausibleCreatedAt`).
    if created_at > now_secs() + 10 * 60 {
        return Ok(());
    }
    if created_at > max_fetched_created_at(store, keys)? {
        store.set_read_sync_meta(&meta_key(META_MAX_CREATED_AT, keys), &created_at.to_string())?;
    }
    Ok(())
}

/// Merge our own read-state events into `read_state` with `max()` per
/// channel. Returns the channels whose marker advanced (sorted, deduped).
pub fn apply_read_state_events(store: &Store, keys: &Keys, events: &[Event]) -> Result<Vec<String>> {
    let (client_id, slot_id) = identity(store, keys)?;
    let mut advanced = std::collections::BTreeSet::new();
    let mut slot_taken = false;
    for ev in events {
        let Some(parsed) = parse_read_state_event(ev, keys) else {
            continue;
        };
        note_created_at(store, keys, parsed.created_at)?;
        // Another client squatting on our d-tag: rotate our slot so we never
        // replace its blob (desktop `mergeEvents` conflict detection).
        if parsed.d_tag == format!("{READ_STATE_D_TAG_PREFIX}{slot_id}") && parsed.blob.client_id != client_id {
            slot_taken = true;
        }
        for (ctx, ts) in &parsed.blob.contexts {
            if is_channel_context(ctx) && store.merge_read_marker(ctx, *ts as i64)? {
                advanced.insert(ctx.clone());
            }
        }
    }
    if slot_taken {
        store.set_read_sync_meta(&meta_key(META_SLOT_ID, keys), &uuid::Uuid::new_v4().simple().to_string())?;
    }
    Ok(advanced.into_iter().collect())
}

/// The contexts this client would publish now.
fn current_contexts(store: &Store) -> Result<BTreeMap<String, u64>> {
    Ok(store
        .publishable_read_markers()?
        .into_iter()
        .filter(|(k, ts)| is_channel_context(k) && *ts > 0 && *ts <= u32::MAX as i64)
        .map(|(k, ts)| (k, ts as u64))
        .collect())
}

/// True when there is something new to publish since the last accepted one.
pub fn read_state_dirty(store: &Store, keys: &Keys) -> Result<bool> {
    let current = current_contexts(store)?;
    if current.is_empty() {
        return Ok(false);
    }
    let last: Option<BTreeMap<String, u64>> = store
        .read_sync_meta(&last_published_key(keys))?
        .and_then(|s| serde_json::from_str(&s).ok());
    Ok(last.as_ref() != Some(&current))
}

/// Build and sign this client's read-state event for the current markers,
/// or `None` if nothing changed since the last accepted publish.
pub fn build_read_state_event(store: &Store, keys: &Keys) -> Result<Option<(Event, BTreeMap<String, u64>)>> {
    if !read_state_dirty(store, keys)? {
        return Ok(None);
    }
    let contexts = current_contexts(store)?;
    let (client_id, slot_id) = identity(store, keys)?;
    let blob = ReadStateBlob {
        v: 1,
        client_id,
        contexts: contexts.clone(),
    };
    let plain = serde_json::to_string(&blob).map_err(|e| Error::Invalid(e.to_string()))?;
    if plain.len() > READ_STATE_MAX_PLAINTEXT_BYTES {
        return Err(Error::Invalid(format!(
            "read state for {} rooms exceeds one {READ_STATE_MAX_PLAINTEXT_BYTES}-byte slot",
            contexts.len()
        )));
    }
    let content = nip44::encrypt(keys.secret_key(), &keys.public_key(), plain, nip44::Version::V2)
        .map_err(|e| Error::Invalid(format!("nip44 encrypt: {e}")))?;
    let tag = |a: &str, b: &str| Tag::parse([a, b]).map_err(|e| Error::Invalid(e.to_string()));
    let tags = vec![
        tag("d", &format!("{READ_STATE_D_TAG_PREFIX}{slot_id}"))?,
        tag("t", READ_STATE_T_TAG)?,
    ];
    let created_at = now_secs().max(max_fetched_created_at(store, keys)? + 1);
    let ev = EventBuilder::new(Kind::Custom(KIND_READ_STATE), content)
        .tags(tags)
        .custom_created_at(Timestamp::from_secs(created_at))
        .sign_with_keys(keys)
        .map_err(|e| Error::Invalid(format!("sign read state: {e}")))?;
    Ok(Some((ev, contexts)))
}

/// Fetch our read-state events and merge them (the step `sync_once` runs).
pub async fn fetch_read_state(client: &mut BuzzClient, keys: &Keys, store: &Store) -> Result<Vec<String>> {
    let events = client
        .req_until_eose("read-state-fetch", &[read_state_filter(keys)])
        .await?;
    apply_read_state_events(store, keys, &events)
}

/// Publish this client's merged markers (callers debounce). Merges the
/// relay's copy first so the blob never regresses another device's reads.
/// Returns `true` if an event was accepted, `false` if nothing changed.
pub async fn publish_read_state(
    relay_url: &str,
    keys: &Keys,
    auth_tag: Option<&Tag>,
    store: &Store,
) -> Result<bool> {
    if !read_state_dirty(store, keys)? {
        return Ok(false);
    }
    crate::init_crypto();
    let mut client = BuzzClient::connect(relay_url, keys, auth_tag).await?;
    let result = async {
        fetch_read_state(&mut client, keys, store).await?;
        let Some((ev, contexts)) = build_read_state_event(store, keys)? else {
            return Ok(false);
        };
        let created_at = ev.created_at.as_secs();
        let ok = client.publish(ev).await?;
        if !ok.accepted {
            return Err(Error::RelayRejected(ok.message));
        }
        note_created_at(store, keys, created_at)?;
        let json = serde_json::to_string(&contexts).map_err(|e| Error::Invalid(e.to_string()))?;
        store.set_read_sync_meta(&last_published_key(keys), &json)?;
        Ok(true)
    }
    .await;
    let _ = client.disconnect().await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blob_event(keys: &Keys, d: &str, blob: &str, ts: u64) -> Event {
        let content = nip44::encrypt(keys.secret_key(), &keys.public_key(), blob, nip44::Version::V2).unwrap();
        EventBuilder::new(Kind::Custom(KIND_READ_STATE), content)
            .tags([Tag::parse(["d", d]).unwrap(), Tag::parse(["t", "read-state"]).unwrap()])
            .custom_created_at(Timestamp::from_secs(ts))
            .sign_with_keys(keys)
            .unwrap()
    }

    #[test]
    fn parse_validates_like_buzz() {
        let k = Keys::generate();
        let ch = uuid::Uuid::new_v4().to_string();
        let good = format!(r#"{{"v":1,"client_id":"c","contexts":{{"{ch}":100,"thread:x":5,"bad":-1,"f":1.5}}}}"#);
        let p = parse_read_state_event(&blob_event(&k, "read-state:ab", &good, 10), &k).unwrap();
        assert_eq!(p.blob.contexts.len(), 2);
        assert_eq!(p.blob.contexts[&ch], 100);
        // Wrong version, bad d-tag, someone else's key: rejected.
        assert!(parse_read_state_event(&blob_event(&k, "read-state:ab", r#"{"v":2,"client_id":"c","contexts":{}}"#, 10), &k).is_none());
        assert!(parse_read_state_event(&blob_event(&k, "read-state:", &good, 10), &k).is_none());
        assert!(parse_read_state_event(&blob_event(&k, "other", &good, 10), &k).is_none());
        assert!(parse_read_state_event(&blob_event(&k, "read-state:ab", &good, 10), &Keys::generate()).is_none());
    }

    #[test]
    fn merge_is_max_and_seed_is_not_published() {
        let k = Keys::generate();
        let s = Store::open_in_memory().unwrap();
        let (a, b) = (uuid::Uuid::new_v4().to_string(), uuid::Uuid::new_v4().to_string());
        s.ensure_read_state(&a, 50).unwrap();
        s.ensure_read_state(&b, 500).unwrap();
        // Seeds are local-only.
        assert!(!read_state_dirty(&s, &k).unwrap());
        let blob = format!(r#"{{"v":1,"client_id":"desk","contexts":{{"{a}":100,"{b}":200}}}}"#);
        let adv = apply_read_state_events(&s, &k, &[blob_event(&k, "read-state:dd", &blob, now_secs())]).unwrap();
        assert_eq!(adv, vec![a.clone()]);
        let m = s.publishable_read_markers().unwrap();
        assert_eq!((m[&a], m[&b]), (100, 500)); // b never went backwards
        let (ev, ctx) = build_read_state_event(&s, &k).unwrap().unwrap();
        assert_eq!(ctx.len(), 2);
        assert!(ev.created_at.as_secs() > now_secs() - 5);
    }
}
