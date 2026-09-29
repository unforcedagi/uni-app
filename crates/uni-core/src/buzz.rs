//! Buzz relay adapter.
//!
//! Wraps `buzz_ws_client::NostrWsConnection` (NIP-42 auth) and implements the
//! two read primitives Phase 1 needs:
//!
//! - channel discovery: `REQ {kinds:[39002], "#p":[me]}` → `d` tags →
//!   `REQ {kinds:[39000], "#d":[…]}`, skipping `archived=true`
//!   (mirrors `buzz-acp/src/relay.rs:687-733`, but over the WS instead of `/query`).
//! - channel history: `REQ {kinds:[9], "#h":[uuid], since?, limit}` with sub id
//!   `ch-<uuid>`, collected until `EOSE`.
//!
//! The relay fans channel-scoped events out only to subscriptions carrying a
//! matching `#h` (spec §2), so history is one REQ per channel, never a global one.

use std::collections::HashMap;
use std::time::Duration;

use buzz_ws_client::{NostrWsConnection, RelayMessage};
use nostr::{
    Alphabet, Event, EventId, Filter, Keys, Kind, PublicKey, SingleLetterTag, Tag, Timestamp,
};
use serde_json::json;
use uuid::Uuid;

use crate::{Error, Result};

/// Kind constants re-exported from buzz-core via buzz-sdk.
pub use buzz_sdk::kind::{KIND_NIP29_GROUP_MEMBERS, KIND_NIP29_GROUP_METADATA};

/// Kind 9: channel message (NIP-29 / Buzz).
pub const KIND_CHANNEL_MESSAGE: u16 = 9;

/// Kinds that modify or annotate an earlier channel message by `e` reference:
/// NIP-09 deletion (5), NIP-25 reaction (7), Buzz delete-event (9005), Buzz
/// edit (40003). The relay files reactions and kind-5 deletions under their
/// target's channel, so a `#h` query returns them.
pub const AUX_KINDS: [u16; 4] = [5, 7, 9005, 40003];

/// `#h`-scoped filter for edits and deletions in `channel`. Kind 5 events
/// carry no `h` tag of their own, but the relay files them under their
/// target's channel, so an `#h` query returns them.
pub fn channel_aux_filter(channel: Uuid, since: Option<u64>) -> Filter {
    let h_tag = SingleLetterTag::lowercase(Alphabet::H);
    let mut f = Filter::new()
        .kinds(AUX_KINDS.map(Kind::Custom))
        .custom_tags(h_tag, [channel.to_string()])
        .limit(RELAY_MAX_LIMIT as usize);
    if let Some(s) = since {
        f = f.since(Timestamp::from_secs(s));
    }
    f
}

/// First valid `e` tag: the message an edit/deletion targets.
pub fn aux_target(ev: &Event) -> Option<String> {
    ev.tags.iter().find_map(|t| {
        let s = t.as_slice();
        (s.first().map(String::as_str) == Some("e"))
            .then(|| {
                s.get(1)
                    .filter(|v| nostr::EventId::from_hex(v).is_ok())
                    .cloned()
            })
            .flatten()
    })
}

/// Relay-side cap on results per historical filter (ARCHITECTURE.md:161).
pub const RELAY_MAX_LIMIT: u64 = 500;

/// Default per-REQ wait for EOSE.
const REQ_TIMEOUT: Duration = Duration::from_secs(30);

/// Discovered channel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelInfo {
    /// Channel uuid (`d` tag / `h` tag value).
    pub id: Uuid,
    /// `name` tag of the kind-39000 metadata event, if any.
    pub name: Option<String>,
    /// `about` tag, if any.
    pub description: Option<String>,
    /// `archived=true` on the metadata event.
    pub archived: bool,
}

/// Discovery output: joined, non-archived channels and their rosters.
#[derive(Debug, Clone, Default)]
pub struct Discovery {
    /// Channel metadata keyed by uuid.
    pub channels: HashMap<Uuid, ChannelInfo>,
    /// Member pubkeys (canonical hex, deduplicated, in tag order) per channel.
    pub members: HashMap<Uuid, Vec<String>>,
}

/// An authenticated relay connection.
pub struct BuzzClient {
    conn: NostrWsConnection,
    me: PublicKey,
    relay_url: String,
}

impl BuzzClient {
    /// Connect to `relay_url` and complete NIP-42 auth with `keys`.
    ///
    /// `auth_tag` is the optional NIP-OA `["auth", <token>]` tag; `None` means
    /// pubkey-only auth.
    pub async fn connect(relay_url: &str, keys: &Keys, auth_tag: Option<&Tag>) -> Result<Self> {
        let conn = NostrWsConnection::connect_authenticated(relay_url, keys, auth_tag).await?;
        Ok(Self {
            conn,
            me: keys.public_key(),
            relay_url: relay_url.to_string(),
        })
    }

    /// Our pubkey.
    pub fn pubkey(&self) -> PublicKey {
        self.me
    }

    /// Relay URL we connected to.
    pub fn relay_url(&self) -> &str {
        &self.relay_url
    }

    /// Send a REQ with `filters` under `sub_id`, collect events until EOSE,
    /// then CLOSE the subscription.
    ///
    /// Returns `Error::SubscriptionClosed` if the relay answers `CLOSED`
    /// (e.g. `restricted: …`) — that is the signal callers use to learn the
    /// relay's allowlist / membership policy.
    pub async fn req_until_eose(&mut self, sub_id: &str, filters: &[Filter]) -> Result<Vec<Event>> {
        let mut frame = vec![json!("REQ"), json!(sub_id)];
        for f in filters {
            frame.push(serde_json::to_value(f).expect("filter serializes"));
        }
        self.conn.send_raw(&serde_json::Value::Array(frame)).await?;

        let mut out = Vec::new();
        let deadline = tokio::time::Instant::now() + REQ_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(buzz_ws_client::WsClientError::Timeout.into());
            }
            match self.conn.next_event(remaining).await? {
                RelayMessage::Event {
                    subscription_id,
                    event,
                } if subscription_id == sub_id => {
                    out.push(*event);
                }
                RelayMessage::Eose { subscription_id } if subscription_id == sub_id => break,
                RelayMessage::Closed {
                    subscription_id,
                    message,
                } if subscription_id == sub_id => {
                    return Err(Error::SubscriptionClosed {
                        sub_id: subscription_id,
                        message,
                    });
                }
                RelayMessage::Notice { message } => {
                    tracing::warn!(sub_id, "relay NOTICE: {message}");
                }
                other => {
                    tracing::debug!(sub_id, "ignoring relay message: {other:?}");
                }
            }
        }

        let _ = self.conn.send_raw(&json!(["CLOSE", sub_id])).await;
        Ok(out)
    }

    /// Channel discovery per `buzz-acp/src/relay.rs:687-733`.
    pub async fn discover_channels(&mut self) -> Result<HashMap<Uuid, ChannelInfo>> {
        Ok(self.discover().await?.channels)
    }

    /// Channel discovery plus each joined channel's member roster. The
    /// kind-39002 events that prove our membership are full roster snapshots,
    /// so the rosters come from the same REQ at no extra cost.
    pub async fn discover(&mut self) -> Result<Discovery> {
        let p_tag = SingleLetterTag::lowercase(Alphabet::P);
        let member_filter = Filter::new()
            .kind(Kind::Custom(KIND_NIP29_GROUP_MEMBERS as u16))
            .custom_tags(p_tag, [self.me.to_hex()]);
        let member_events = self
            .req_until_eose("disc-members", &[member_filter])
            .await?;

        let uuids = extract_member_uuids(&member_events);
        let mut members = parse_member_rosters(&member_events);
        if uuids.is_empty() {
            return Ok(Discovery::default());
        }

        let d_tag = SingleLetterTag::lowercase(Alphabet::D);
        let meta_filter = Filter::new()
            .kind(Kind::Custom(KIND_NIP29_GROUP_METADATA as u16))
            .custom_tags(d_tag, uuids.iter().map(|u| u.to_string()));
        let meta_events = self.req_until_eose("disc-meta", &[meta_filter]).await?;

        let channels = merge_discovered_channels(uuids, &meta_events);
        members.retain(|id, _| channels.contains_key(id));
        Ok(Discovery { channels, members })
    }

    /// Pull kind-9 history for one channel. `since` is exclusive-ish per NIP-01
    /// (`created_at >= since`); callers dedupe by event id anyway.
    pub async fn channel_history(
        &mut self,
        channel: Uuid,
        since: Option<u64>,
        limit: u64,
    ) -> Result<Vec<Event>> {
        let h_tag = SingleLetterTag::lowercase(Alphabet::H);
        let mut filter = Filter::new()
            .kind(Kind::Custom(KIND_CHANNEL_MESSAGE))
            .custom_tags(h_tag, [channel.to_string()])
            .limit(limit.min(RELAY_MAX_LIMIT) as usize);
        if let Some(s) = since {
            filter = filter.since(Timestamp::from_secs(s));
        }
        // Second filter: edits and deletions, so stale / retracted text is
        // corrected on the same pass (own limit, so they never crowd out messages).
        let aux = channel_aux_filter(channel, since);
        self.req_until_eose(&channel_sub_id(channel), &[filter, aux])
            .await
    }

    /// Page of older kind-9 history (`created_at <= until`), plus every
    /// edit / deletion / reaction referencing those messages by `#e` (aux
    /// events can be much newer than their target, so a time window would
    /// miss them). Returns messages and aux events together.
    pub async fn channel_history_before(
        &mut self,
        channel: Uuid,
        until: u64,
        limit: u64,
    ) -> Result<Vec<Event>> {
        let h_tag = SingleLetterTag::lowercase(Alphabet::H);
        let filter = Filter::new()
            .kind(Kind::Custom(KIND_CHANNEL_MESSAGE))
            .custom_tags(h_tag, [channel.to_string()])
            .until(Timestamp::from_secs(until))
            .limit(limit.min(RELAY_MAX_LIMIT) as usize);
        let mut events = self
            .req_until_eose(&format!("older-{channel}"), &[filter])
            .await?;
        let ids: Vec<EventId> = events
            .iter()
            .filter(|e| e.kind.as_u16() == KIND_CHANNEL_MESSAGE)
            .map(|e| e.id)
            .collect();
        for (i, chunk) in ids.chunks(100).enumerate() {
            let aux = Filter::new()
                .kinds(AUX_KINDS.map(Kind::Custom))
                .events(chunk.iter().copied())
                .limit(RELAY_MAX_LIMIT as usize);
            let got = self
                .req_until_eose(&format!("older-aux-{i}-{channel}"), &[aux])
                .await?;
            events.extend(got);
        }
        Ok(events)
    }

    /// Fetch kind-0 profiles for `authors` (one REQ, chunked by 100 authors).
    /// Kind 0 is global-only on the relay (`ingest.rs::is_global_only_kind`),
    /// so no `#h` is needed.
    pub async fn fetch_profiles(&mut self, authors: &[PublicKey]) -> Result<Vec<Event>> {
        let mut out = Vec::new();
        for (i, chunk) in authors.chunks(100).enumerate() {
            let filter = Filter::new()
                .kind(Kind::Custom(KIND_PROFILE))
                .authors(chunk.iter().copied());
            let evs = self
                .req_until_eose(&format!("profiles-{i}"), &[filter])
                .await?;
            out.extend(evs);
        }
        Ok(out)
    }

    /// Send a REQ under `sub_id` and return immediately — the subscription
    /// stays open and its `EVENT`/`EOSE`/`CLOSED` frames arrive through
    /// [`next_message`](Self::next_message).
    /// Send `["EVENT", ev]` without waiting for the relay's OK (ephemeral kinds).
    pub async fn send_event_nowait(&mut self, ev: &Event) -> Result<()> {
        let frame = serde_json::Value::Array(vec![
            json!("EVENT"),
            serde_json::to_value(ev).map_err(|e| Error::Invalid(e.to_string()))?,
        ]);
        self.conn.send_raw(&frame).await?;
        Ok(())
    }

    pub async fn open_sub(&mut self, sub_id: &str, filters: &[Filter]) -> Result<()> {
        let mut frame = vec![json!("REQ"), json!(sub_id)];
        for f in filters {
            frame.push(serde_json::to_value(f).expect("filter serializes"));
        }
        self.conn.send_raw(&serde_json::Value::Array(frame)).await?;
        Ok(())
    }

    /// Open the live `ch-<uuid>` subscription for `channel`: `{kinds:[9],
    /// "#h":[uuid], since?}`. Backfill since the watermark is delivered first,
    /// then `EOSE`, then live events for as long as the connection lasts.
    pub async fn open_channel_sub(&mut self, channel: Uuid, since: Option<u64>) -> Result<()> {
        let h_tag = SingleLetterTag::lowercase(Alphabet::H);
        let mut filter = Filter::new()
            .kind(Kind::Custom(KIND_CHANNEL_MESSAGE))
            .custom_tags(h_tag, [channel.to_string()])
            .limit(RELAY_MAX_LIMIT as usize);
        if let Some(s) = since {
            filter = filter.since(Timestamp::from_secs(s));
        }
        let aux = channel_aux_filter(channel, since);
        // Typing indicators are ephemeral: only ones from the last few seconds.
        let typing = Filter::new()
            .kind(Kind::Custom(crate::typing::KIND_TYPING))
            .custom_tags(h_tag, [channel.to_string()])
            .since(Timestamp::from_secs(
                Timestamp::now().as_secs().saturating_sub(crate::typing::TYPING_TTL_SECS),
            ))
            .limit(10);
        self.open_sub(&channel_sub_id(channel), &[filter, aux, typing])
            .await
    }

    /// Open the global membership-notification subscription
    /// `{kinds:[44100,44101], "#p":[me]}` (NOSTR.md "Membership
    /// Notifications": `#p` must equal the authenticated pubkey).
    pub async fn open_membership_sub(&mut self, since: Option<u64>) -> Result<()> {
        let p_tag = SingleLetterTag::lowercase(Alphabet::P);
        let mut filter = Filter::new()
            .kinds([
                Kind::Custom(KIND_MEMBER_ADDED),
                Kind::Custom(KIND_MEMBER_REMOVED),
            ])
            .custom_tags(p_tag, [self.me.to_hex()]);
        if let Some(s) = since {
            filter = filter.since(Timestamp::from_secs(s));
        }
        self.open_sub(MEMBERSHIP_SUB_ID, &[filter]).await
    }

    /// Open a one-shot metadata lookup for `channel` under `meta-<uuid>`;
    /// the caller CLOSEs it on EOSE.
    pub async fn open_channel_meta_sub(&mut self, channel: Uuid) -> Result<()> {
        let d_tag = SingleLetterTag::lowercase(Alphabet::D);
        let filter = Filter::new()
            .kind(Kind::Custom(KIND_NIP29_GROUP_METADATA as u16))
            .custom_tags(d_tag, [channel.to_string()]);
        self.open_sub(&meta_sub_id(channel), &[filter]).await
    }

    /// CLOSE a subscription.
    pub async fn close_sub(&mut self, sub_id: &str) -> Result<()> {
        self.conn.send_raw(&json!(["CLOSE", sub_id])).await?;
        Ok(())
    }

    /// Next relay message, waiting up to `timeout`. A timeout surfaces as
    /// `Error::Relay(WsClientError::Timeout)` and is not a connection failure.
    pub async fn next_message(&mut self, timeout: Duration) -> Result<RelayMessage> {
        Ok(self.conn.next_event(timeout).await?)
    }

    /// Publish a signed event and wait for its relay acknowledgement.
    pub async fn publish(&mut self, event: Event) -> Result<buzz_ws_client::OkResponse> {
        Ok(self.conn.send_event(event).await?)
    }

    /// Close the connection.
    pub async fn disconnect(self) -> Result<()> {
        self.conn.disconnect().await?;
        Ok(())
    }
}

/// Kind 0: profile metadata.
pub const KIND_PROFILE: u16 = 0;
/// Kind 44100: relay-signed "member added" notification.
pub const KIND_MEMBER_ADDED: u16 = 44100;
/// Kind 44101: relay-signed "member removed" notification.
pub const KIND_MEMBER_REMOVED: u16 = 44101;
/// Sub id for the global membership-notification subscription.
pub const MEMBERSHIP_SUB_ID: &str = "membership";

/// `meta-<uuid>` — one-shot channel metadata lookup opened from the live loop.
pub fn meta_sub_id(channel: Uuid) -> String {
    format!("meta-{channel}")
}

/// Parse a `ch-<uuid>` sub id back to its channel.
pub fn channel_of_sub_id(sub_id: &str) -> Option<Uuid> {
    sub_id.strip_prefix("ch-").and_then(|s| s.parse().ok())
}

/// Connection probe result (no key needed; safe to run with any relay).
#[derive(Debug, Clone)]
pub struct ProbeReport {
    /// Whether the relay sent a NIP-42 `AUTH` challenge proactively.
    pub challenge_received: bool,
    /// What the relay answered to a kind-9 REQ sent *before* authenticating.
    pub pre_auth_req: String,
    /// Result of NIP-42 auth with the given key (`ok` or the rejection reason).
    pub auth_result: String,
}

/// Probe the relay: connect, note the proactive AUTH challenge, send one REQ
/// before authenticating (records the relay's `CLOSED`/`NOTICE`), then
/// attempt NIP-42 auth with `keys`. Never fails on relay policy — the report
/// carries the outcome.
pub async fn probe(relay_url: &str, keys: &Keys, auth_tag: Option<&Tag>) -> Result<ProbeReport> {
    let mut conn = NostrWsConnection::connect(relay_url).await?;

    // The relay should push ["AUTH", challenge] first; give it a moment.
    let mut challenge_received = false;
    let mut pre_auth_req = String::from("(no response within 5s)");

    let req = json!([
        "REQ",
        "probe",
        serde_json::to_value(
            Filter::new()
                .kind(Kind::Custom(KIND_CHANNEL_MESSAGE))
                .limit(1)
        )
        .expect("filter")
    ]);
    conn.send_raw(&req).await?;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match conn.next_event(remaining).await {
            Ok(RelayMessage::Auth { .. }) => challenge_received = true,
            Ok(RelayMessage::Closed {
                subscription_id,
                message,
            }) if subscription_id == "probe" => {
                pre_auth_req = format!("CLOSED: {message}");
                break;
            }
            Ok(RelayMessage::Notice { message }) => {
                pre_auth_req = format!("NOTICE: {message}");
                break;
            }
            Ok(RelayMessage::Eose { subscription_id }) if subscription_id == "probe" => {
                pre_auth_req = "EOSE (relay answered an unauthenticated REQ)".into();
                break;
            }
            Ok(RelayMessage::Event { .. }) => {
                pre_auth_req = "EVENT (relay served data without auth!)".into();
                break;
            }
            Ok(_) => {}
            Err(buzz_ws_client::WsClientError::Timeout) => break,
            Err(e) => return Err(e.into()),
        }
    }

    let auth_result = match conn.authenticate(keys, auth_tag).await {
        Ok(()) => "ok".to_string(),
        Err(e) => e.to_string(),
    };
    let _ = conn.disconnect().await;

    Ok(ProbeReport {
        challenge_received,
        pre_auth_req,
        auth_result,
    })
}

/// `ch-<uuid>` — same convention as buzz-acp (`relay.rs:3509`).
pub fn channel_sub_id(channel: Uuid) -> String {
    format!("ch-{channel}")
}

/// Extract channel uuids from the `d` tags of kind-39002 events.
pub fn extract_member_uuids(events: &[Event]) -> Vec<Uuid> {
    let mut out = Vec::new();
    for ev in events {
        for tag in ev.tags.iter() {
            let s = tag.as_slice();
            if s.first().map(String::as_str) == Some("d") {
                if let Some(Ok(u)) = s.get(1).map(|v| v.parse::<Uuid>()) {
                    if !out.contains(&u) {
                        out.push(u);
                    }
                }
            }
        }
    }
    out
}

/// Member rosters from kind-39002 snapshots: `d` = channel uuid, each valid
/// `p` tag = member. The newest snapshot per channel wins (ties: larger event
/// id, so the choice is deterministic); invalid pubkeys are dropped.
pub fn parse_member_rosters(events: &[Event]) -> HashMap<Uuid, Vec<String>> {
    let mut newest: HashMap<Uuid, &Event> = HashMap::new();
    for ev in events {
        if ev.kind != Kind::Custom(KIND_NIP29_GROUP_MEMBERS as u16) {
            continue;
        }
        let Some(ch) = ev.tags.iter().find_map(|t| {
            let s = t.as_slice();
            (s.first().map(String::as_str) == Some("d"))
                .then(|| s.get(1).and_then(|v| v.parse::<Uuid>().ok()))
                .flatten()
        }) else {
            continue;
        };
        match newest.get(&ch) {
            Some(cur) if (cur.created_at, cur.id) >= (ev.created_at, ev.id) => {}
            _ => {
                newest.insert(ch, ev);
            }
        }
    }
    newest
        .into_iter()
        .map(|(ch, ev)| {
            let mut out: Vec<String> = Vec::new();
            for t in ev.tags.iter() {
                let s = t.as_slice();
                if s.first().map(String::as_str) != Some("p") {
                    continue;
                }
                if let Some(pk) = s.get(1).and_then(|v| PublicKey::from_hex(v).ok()) {
                    let hex = pk.to_hex();
                    if !out.contains(&hex) {
                        out.push(hex);
                    }
                }
            }
            (ch, out)
        })
        .collect()
}

/// Canonical hex pubkeys named by the event's `p` tags, deduplicated.
pub fn p_tags(ev: &Event) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in ev.tags.iter() {
        let s = t.as_slice();
        if s.first().map(String::as_str) != Some("p") {
            continue;
        }
        if let Some(pk) = s.get(1).and_then(|v| PublicKey::from_hex(v).ok()) {
            let hex = pk.to_hex();
            if !out.contains(&hex) {
                out.push(hex);
            }
        }
    }
    out
}

/// Merge membership uuids with kind-39000 metadata, dropping `archived=true`
/// channels (mirrors `buzz-acp` `merge_discovered_channels`).
pub fn merge_discovered_channels(uuids: Vec<Uuid>, meta: &[Event]) -> HashMap<Uuid, ChannelInfo> {
    let mut info: HashMap<Uuid, ChannelInfo> = uuids
        .iter()
        .map(|u| {
            (
                *u,
                ChannelInfo {
                    id: *u,
                    name: None,
                    description: None,
                    archived: false,
                },
            )
        })
        .collect();

    for ev in meta {
        let mut d = None;
        let mut name = None;
        let mut about = None;
        let mut archived = false;
        for tag in ev.tags.iter() {
            let s = tag.as_slice();
            match (s.first().map(String::as_str), s.get(1)) {
                (Some("d"), Some(v)) => d = v.parse::<Uuid>().ok(),
                (Some("name"), Some(v)) => name = Some(v.clone()),
                (Some("about"), Some(v)) => about = Some(v.clone()),
                (Some("archived"), Some(v)) => archived = v == "true",
                _ => {}
            }
        }
        if let Some(u) = d {
            if let Some(ci) = info.get_mut(&u) {
                ci.name = name;
                ci.description = about;
                ci.archived = archived;
            }
        }
    }

    info.retain(|_, ci| !ci.archived);
    info
}

/// The `h` tag of a kind-9 event, if present and a uuid.
pub fn event_channel(ev: &Event) -> Option<Uuid> {
    ev.tags.iter().find_map(|t| {
        let s = t.as_slice();
        if s.first().map(String::as_str) == Some("h") {
            s.get(1).and_then(|v| v.parse().ok())
        } else {
            None
        }
    })
}

/// True if any `p` tag names `me`.
pub fn mentions(ev: &Event, me: &PublicKey) -> bool {
    let me_hex = me.to_hex();
    ev.tags.iter().any(|t| {
        let s = t.as_slice();
        s.first().map(String::as_str) == Some("p")
            && s.get(1)
                .map(|v| v.eq_ignore_ascii_case(&me_hex))
                .unwrap_or(false)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::EventBuilder;

    fn signed(kind: u16, tags: Vec<Vec<&str>>, content: &str, keys: &Keys) -> Event {
        let tags: Vec<Tag> = tags
            .into_iter()
            .map(|t| Tag::parse(t.iter().map(|s| s.to_string()).collect::<Vec<_>>()).unwrap())
            .collect();
        EventBuilder::new(Kind::Custom(kind), content)
            .tags(tags)
            .sign_with_keys(keys)
            .unwrap()
    }

    #[test]
    fn discovery_merge_skips_archived_and_keeps_unknown() {
        let keys = Keys::generate();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let c = Uuid::new_v4();
        let members = vec![
            signed(39002, vec![vec!["d", &a.to_string()]], "", &keys),
            signed(39002, vec![vec!["d", &b.to_string()]], "", &keys),
            signed(39002, vec![vec!["d", &c.to_string()]], "", &keys),
            signed(39002, vec![vec!["d", &a.to_string()]], "", &keys), // dup
            signed(39002, vec![vec!["d", "not-a-uuid"]], "", &keys),
        ];
        let uuids = extract_member_uuids(&members);
        assert_eq!(uuids.len(), 3);

        let meta = vec![
            signed(
                39000,
                vec![
                    vec!["d", &a.to_string()],
                    vec!["name", "Uni"],
                    vec!["about", "core"],
                ],
                "",
                &keys,
            ),
            signed(
                39000,
                vec![
                    vec!["d", &b.to_string()],
                    vec!["name", "old"],
                    vec!["archived", "true"],
                ],
                "",
                &keys,
            ),
        ];
        let merged = merge_discovered_channels(uuids, &meta);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[&a].name.as_deref(), Some("Uni"));
        assert_eq!(merged[&a].description.as_deref(), Some("core"));
        assert!(!merged.contains_key(&b));
        assert!(merged[&c].name.is_none());
    }

    #[test]
    fn mentions_and_channel_extraction() {
        let me = Keys::generate();
        let other = Keys::generate();
        let ch = Uuid::new_v4();
        let ev = signed(
            9,
            vec![
                vec!["h", &ch.to_string()],
                vec!["p", &me.public_key().to_hex().to_uppercase()],
            ],
            "hi",
            &other,
        );
        assert_eq!(event_channel(&ev), Some(ch));
        assert!(mentions(&ev, &me.public_key()));
        assert!(!mentions(&ev, &other.public_key()));
    }

    #[test]
    fn member_rosters_take_newest_snapshot_and_valid_pubkeys() {
        let relay = Keys::generate();
        let (a, b, c) = (Keys::generate(), Keys::generate(), Keys::generate());
        let ch = Uuid::new_v4();
        let other = Uuid::new_v4();
        let snap = |ts: u64, d: &Uuid, ps: Vec<String>| {
            let mut tags = vec![Tag::parse(vec!["d".to_string(), d.to_string()]).unwrap()];
            for p in ps {
                tags.push(Tag::parse(vec!["p".to_string(), p]).unwrap());
            }
            EventBuilder::new(Kind::Custom(39002), "")
                .tags(tags)
                .custom_created_at(Timestamp::from_secs(ts))
                .sign_with_keys(&relay)
                .unwrap()
        };
        let events = vec![
            snap(
                10,
                &ch,
                vec![a.public_key().to_hex(), b.public_key().to_hex()],
            ),
            snap(
                20,
                &ch,
                vec![
                    a.public_key().to_hex().to_uppercase(),
                    c.public_key().to_hex(),
                    "not-a-key".into(),
                    a.public_key().to_hex(),
                ],
            ),
            snap(5, &other, vec![b.public_key().to_hex()]),
            signed(9, vec![vec!["d", &ch.to_string()]], "noise", &relay),
        ];
        let rosters = parse_member_rosters(&events);
        assert_eq!(
            rosters[&ch],
            vec![a.public_key().to_hex(), c.public_key().to_hex()]
        );
        assert_eq!(rosters[&other], vec![b.public_key().to_hex()]);
    }

    #[test]
    fn p_tags_are_canonical_and_deduplicated() {
        let k = Keys::generate();
        let hex = k.public_key().to_hex();
        let upper = hex.to_uppercase();
        let ev = signed(
            9,
            vec![
                vec!["p", &hex],
                vec!["p", &upper],
                vec!["p", "zz"],
                vec!["e", &hex],
            ],
            "hi",
            &k,
        );
        assert_eq!(p_tags(&ev), vec![hex]);
    }

    #[test]
    fn sub_id_convention() {
        let u = Uuid::nil();
        assert_eq!(channel_sub_id(u), format!("ch-{u}"));
    }
}
