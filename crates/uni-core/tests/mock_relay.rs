//! End-to-end tests against an in-process mock Buzz relay.
//!
//! The mock speaks the subset of NIP-01/NIP-42 the relay uses (spec §2):
//! proactive `AUTH` challenge, `NOTICE auth-required` before auth, `OK` on
//! the kind-22242 AUTH event (rejecting pubkeys not in its member set with
//! `restricted: not a relay member`, exactly what `wss://buzz.unforced.org`
//! answers), then `EVENT`/`EOSE` for kind 39002/39000/9/0 REQs, `CLOSED
//! restricted` for `#h` REQs on channels the pubkey is not a member of, and
//! the p-gate on kind 44100/44101 (`#p` must equal the authed pubkey).
//!
//! Subscriptions stay open after EOSE: events published through
//! [`MockRelay::publish`] are fanned out to every live connection whose
//! filters match, so live mode and reconnect are testable in-process.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use nostr::{Keys, Kind, Tag};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc, watch};
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

use uni_core::{
    delete_message, edit_message, remove_reaction, run_live, send_reaction, sync_older, sync_once,
    Backoff, LiveConfig, LiveEvent, Store,
};

/// Control messages from a test to the relay.
#[derive(Clone, Debug)]
enum Ctl {
    /// Store and fan out an event.
    Publish(Value),
    /// Drop every live connection (simulates a network blip).
    DropAll,
}

struct MockRelay {
    members: HashSet<String>,
    events: Mutex<Vec<Value>>,
    /// Channel uuids the members may read.
    member_channels: Mutex<HashSet<String>>,
    ctl: broadcast::Sender<Ctl>,
    /// Count of AUTH events that succeeded (proves re-AUTH on reconnect).
    auths_ok: Mutex<u32>,
    /// Count of accepted connections.
    connections: Mutex<u32>,
    /// Sub ids the client has CLOSEd (proves the client side of a leave).
    closed_subs: Mutex<Vec<String>>,
    /// Pairing-relay mode: accept NIP-42 AUTH from any key (ephemeral
    /// NIP-AB session keys are never relay members).
    open_auth: std::sync::atomic::AtomicBool,
    /// T-234: store the next EVENT, then drop the connection without its OK (an OK lost on the way back).
    drop_next_ok: std::sync::atomic::AtomicBool,
    /// T-234: refuse the next EVENT without storing it.
    reject_next: std::sync::atomic::AtomicBool,
    /// T-234: answer an `ids`-only REQ with CLOSED (a relay that won't look an event up by id alone).
    close_id_lookups: std::sync::atomic::AtomicBool,
}

impl MockRelay {
    fn new(members: Vec<String>, member_channels: Vec<Uuid>, events: Vec<Value>) -> Arc<Self> {
        let (ctl, _) = broadcast::channel(64);
        Arc::new(Self {
            members: members.into_iter().collect(),
            events: Mutex::new(events),
            member_channels: Mutex::new(member_channels.iter().map(|u| u.to_string()).collect()),
            ctl,
            auths_ok: Mutex::new(0),
            connections: Mutex::new(0),
            closed_subs: Mutex::new(Vec::new()),
            open_auth: std::sync::atomic::AtomicBool::new(false),
            drop_next_ok: std::sync::atomic::AtomicBool::new(false),
            reject_next: std::sync::atomic::AtomicBool::new(false),
            close_id_lookups: std::sync::atomic::AtomicBool::new(false),
        })
    }

    /// A relay behaving like the NIP-AB pairing relay: anyone may auth,
    /// kind-24134 events are routed to live `#p` subscriptions.
    fn pairing() -> Arc<Self> {
        let r = Self::new(vec![], vec![], vec![]);
        r.open_auth.store(true, std::sync::atomic::Ordering::SeqCst);
        r
    }

    fn publish(&self, ev: Value) {
        self.events.lock().unwrap().push(ev.clone());
        let _ = self.ctl.send(Ctl::Publish(ev));
    }

    fn drop_all(&self) {
        let _ = self.ctl.send(Ctl::DropAll);
    }

    fn grant_channel(&self, ch: Uuid) {
        self.member_channels.lock().unwrap().insert(ch.to_string());
    }

    /// Store an addressable event (kind 39000 metadata, say) the way the relay
    /// does: it replaces the stored one with the same kind, author and `d` tag.
    fn replace(&self, ev: Value) {
        let same = |e: &Value| {
            e["kind"] == ev["kind"]
                && e["pubkey"] == ev["pubkey"]
                && tag_values(e, "d") == tag_values(&ev, "d")
        };
        self.events.lock().unwrap().retain(|e| !same(e));
        self.publish(ev);
    }

    async fn start(self: &Arc<Self>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        tokio::spawn(serve(listener, self.clone()));
        url
    }
}

fn tag_values<'a>(ev: &'a Value, name: &str) -> Vec<&'a str> {
    ev["tags"]
        .as_array()
        .map(|tags| {
            tags.iter()
                .filter(|t| t[0].as_str() == Some(name))
                .filter_map(|t| t[1].as_str())
                .collect()
        })
        .unwrap_or_default()
}

fn matches(filter: &Value, ev: &Value) -> bool {
    if let Some(ids) = filter["ids"].as_array() {
        if !ids.iter().any(|i| i.as_str() == ev["id"].as_str()) {
            return false;
        }
    }
    if let Some(kinds) = filter["kinds"].as_array() {
        if !kinds.iter().any(|k| k.as_u64() == ev["kind"].as_u64()) {
            return false;
        }
    }
    if let Some(authors) = filter["authors"].as_array() {
        if !authors.iter().any(|a| a.as_str() == ev["pubkey"].as_str()) {
            return false;
        }
    }
    for (k, v) in filter.as_object().unwrap() {
        if let Some(tag) = k.strip_prefix('#') {
            let wanted: Vec<&str> = v
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|x| x.as_str())
                .collect();
            let have = tag_values(ev, tag);
            if !have.iter().any(|h| wanted.contains(h)) {
                return false;
            }
        }
    }
    if let Some(since) = filter["since"].as_u64() {
        if ev["created_at"].as_u64().unwrap_or(0) < since {
            return false;
        }
    }
    if let Some(until) = filter["until"].as_u64() {
        if ev["created_at"].as_u64().unwrap_or(0) > until {
            return false;
        }
    }
    true
}

async fn serve(listener: TcpListener, relay: Arc<MockRelay>) {
    loop {
        let (stream, _) = listener.accept().await.unwrap();
        *relay.connections.lock().unwrap() += 1;
        let relay = relay.clone();
        tokio::spawn(async move {
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            let mut ctl = relay.ctl.subscribe();
            let challenge = Uuid::new_v4().to_string();
            ws.send(Message::Text(json!(["AUTH", challenge]).to_string().into()))
                .await
                .unwrap();
            let mut authed: Option<String> = None;
            // sub id → filters, kept open after EOSE for fan-out.
            let mut subs: HashMap<String, Vec<Value>> = HashMap::new();
            loop {
                tokio::select! {
                    c = ctl.recv() => {
                        match c {
                            Ok(Ctl::DropAll) => { let _ = ws.close(None).await; return; }
                            Ok(Ctl::Publish(ev)) => {
                                if authed.is_none() { continue; }
                                for (sub, filters) in &subs {
                                    if filters.iter().any(|f| matches(f, &ev)) {
                                        let _ = ws.send(Message::Text(json!(["EVENT", sub, ev]).to_string().into())).await;
                                    }
                                }
                            }
                            Err(_) => {}
                        }
                    }
                    msg = ws.next() => {
                        let Some(Ok(msg)) = msg else { return };
                        let Message::Text(text) = msg else { continue };
                        let frame: Vec<Value> = serde_json::from_str(&text).unwrap();
                        match frame[0].as_str().unwrap() {
                            "AUTH" => {
                                let ev = &frame[1];
                                let id = ev["id"].as_str().unwrap();
                                let pk = ev["pubkey"].as_str().unwrap().to_string();
                                let ok_challenge = tag_values(ev, "challenge") == vec![challenge.as_str()];
                                let (ok, reason) = if !ok_challenge {
                                    (false, "auth-required: bad challenge")
                                } else if !relay.members.contains(&pk)
                                    && !relay.open_auth.load(std::sync::atomic::Ordering::SeqCst)
                                {
                                    (false, "restricted: not a relay member")
                                } else {
                                    authed = Some(pk.clone());
                                    *relay.auths_ok.lock().unwrap() += 1;
                                    (true, "")
                                };
                                ws.send(Message::Text(json!(["OK", id, ok, reason]).to_string().into()))
                                    .await
                                    .unwrap();
                            }
                            "EVENT" => {
                                let ev = &frame[1];
                                let id = ev["id"].as_str().unwrap();
                                let rejected = relay.reject_next.swap(false, std::sync::atomic::Ordering::SeqCst);
                                // like Buzz, a gift wrap (1059) is accepted whoever signed it: its signer is a throwaway key
                                let accepted = !rejected && (authed.as_deref() == ev["pubkey"].as_str() || (authed.is_some() && ev["kind"] == 1059))
                                    && ev["content"] != "reject-me"
                                    && serde_json::from_value::<nostr::Event>(ev.clone())
                                        .is_ok_and(|e| e.verify().is_ok());
                                if accepted { relay.publish(ev.clone()); }
                                if relay.drop_next_ok.swap(false, std::sync::atomic::Ordering::SeqCst) {
                                    let _ = ws.close(None).await;
                                    return;
                                }
                                ws.send(Message::Text(json!(["OK", id, accepted,
                                    if accepted { "" } else { "restricted: rejected" }]).to_string().into())).await.unwrap();
                            }
                            "REQ" => {
                                let sub = frame[1].as_str().unwrap().to_string();
                                let Some(me) = authed.clone() else {
                                    ws.send(Message::Text(
                                        json!(["NOTICE", "auth-required: authenticate before subscribing"]).to_string().into(),
                                    ))
                                    .await
                                    .unwrap();
                                    continue;
                                };
                                let filters: Vec<Value> = frame[2..].to_vec();
                                // Channel-scoped REQ: enforce membership like the real relay.
                                let mut closed = None;
                                for f in &filters {
                                    if let Some(hs) = f["#h"].as_array() {
                                        let allowed = relay.member_channels.lock().unwrap();
                                        if hs.iter().any(|h| !allowed.contains(h.as_str().unwrap())) {
                                            closed = Some("restricted: not a channel member");
                                        }
                                    }
                                    // p-gated kinds (44100/44101) need #p == authed pubkey.
                                    let p_gated = f["kinds"].as_array().map(|ks| {
                                        ks.iter().any(|k| matches!(k.as_u64(), Some(44100 | 44101)))
                                    }).unwrap_or(false);
                                    if p_gated {
                                        let ps = f["#p"].as_array().cloned().unwrap_or_default();
                                        if ps.is_empty() || ps.iter().any(|p| p.as_str() != Some(me.as_str())) {
                                            closed = Some("restricted: p-gated events require #p matching your pubkey");
                                        }
                                    }
                                }
                                if relay.close_id_lookups.load(std::sync::atomic::Ordering::SeqCst)
                                    && filters.iter().any(|f| f["ids"].is_array() && f["kinds"].is_null())
                                {
                                    closed = Some("restricted: scope the query");
                                }
                                if let Some(reason) = closed {
                                    ws.send(Message::Text(json!(["CLOSED", sub, reason]).to_string().into()))
                                        .await
                                        .unwrap();
                                    continue;
                                }
                                // r26: a slow room history (`MOCK_HISTORY_DELAY_MS`, off by default), to stand in for the real relay's cold sync
                                if filters.iter().any(|f| f["#h"].is_array()) {
                                    if let Some(ms) = std::env::var("MOCK_HISTORY_DELAY_MS").ok().and_then(|v| v.parse::<u64>().ok()) {
                                        tokio::time::sleep(Duration::from_millis(ms)).await;
                                    }
                                }
                                let snapshot = relay.events.lock().unwrap().clone();
                                // Per filter: the newest `limit` matches (NIP-01), deduped across filters.
                                let mut out: Vec<&Value> = Vec::new();
                                for f in &filters {
                                    let mut hits: Vec<&Value> = snapshot.iter().filter(|ev| matches(f, ev)).collect();
                                    if let Some(limit) = f["limit"].as_u64() {
                                        hits.sort_by_key(|ev| std::cmp::Reverse(ev["created_at"].as_u64()));
                                        hits.truncate(limit as usize);
                                    }
                                    for ev in hits {
                                        if !out.iter().any(|o| o["id"] == ev["id"]) {
                                            out.push(ev);
                                        }
                                    }
                                }
                                for ev in out {
                                    ws.send(Message::Text(json!(["EVENT", sub, ev]).to_string().into()))
                                        .await
                                        .unwrap();
                                }
                                ws.send(Message::Text(json!(["EOSE", sub]).to_string().into()))
                                    .await
                                    .unwrap();
                                subs.insert(sub, filters);
                            }
                            "CLOSE" => {
                                let sub = frame[1].as_str().unwrap();
                                subs.remove(sub);
                                relay.closed_subs.lock().unwrap().push(sub.to_string());
                            }
                            _ => {}
                        }
                    }
                }
            }
        });
    }
}

fn signed(keys: &Keys, kind: u16, tags: Vec<Vec<String>>, content: &str, ts: u64) -> Value {
    // Build via UnsignedEvent so tags are kept verbatim: `EventBuilder`
    // strips a self-`p` tag at sign time, but real Buzz kind-9 events carry
    // one (the sender self-p-tags; spec §2), and `mentions_me` must see it.
    let tags: Vec<Tag> = tags.into_iter().map(|t| Tag::parse(t).unwrap()).collect();
    let unsigned = nostr::UnsignedEvent::new(
        keys.public_key(),
        nostr::Timestamp::from_secs(ts),
        Kind::Custom(kind),
        tags,
        content,
    );
    let ev = unsigned.sign_with_keys(keys).unwrap();
    serde_json::to_value(ev).unwrap()
}

fn d(u: Uuid) -> Vec<String> {
    vec!["d".to_string(), u.to_string()]
}
fn h(u: Uuid) -> Vec<String> {
    vec!["h".to_string(), u.to_string()]
}
fn p(k: &Keys) -> Vec<String> {
    vec!["p".to_string(), k.public_key().to_hex()]
}
fn named(name: &str, v: &str) -> Vec<String> {
    vec![name.to_string(), v.to_string()]
}

/// Common fixture: relay key, me, other; channels a (Uni), b (heartbeat),
/// archived, not-mine; seed messages; `other` has a kind-0 profile.
struct Fixture {
    relay_keys: Keys,
    me: Keys,
    other: Keys,
    ch_a: Uuid,
    ch_b: Uuid,
    relay: Arc<MockRelay>,
    url: String,
}

async fn fixture() -> Fixture {
    fixture_with(Keys::generate(), Keys::generate(), Uuid::new_v4()).await
}

/// The fixture with these keys and Uni's room (T-234's crosscheck brings its own synthetic keys and room).
async fn fixture_with(me: Keys, other: Keys, ch_a: Uuid) -> Fixture {
    let relay_keys = Keys::generate();
    let ch_b = Uuid::new_v4();
    let ch_archived = Uuid::new_v4();
    let ch_not_mine = Uuid::new_v4();

    let events = vec![
        // Membership (39002) — relay-signed, #p = me.
        signed(&relay_keys, 39002, vec![d(ch_a), p(&me), p(&other)], "", 1),
        signed(&relay_keys, 39002, vec![d(ch_b), p(&me)], "", 1),
        signed(&relay_keys, 39002, vec![d(ch_archived), p(&me)], "", 1),
        signed(&relay_keys, 39002, vec![d(ch_not_mine), p(&other)], "", 1),
        // Metadata (39000).
        signed(
            &relay_keys,
            39000,
            vec![d(ch_a), named("name", "Uni"), named("about", "core")],
            "",
            1,
        ),
        signed(
            &relay_keys,
            39000,
            vec![d(ch_b), named("name", "heartbeat")],
            "",
            1,
        ),
        signed(
            &relay_keys,
            39000,
            vec![
                d(ch_archived),
                named("name", "old"),
                named("archived", "true"),
            ],
            "",
            1,
        ),
        // Profiles (kind 0): `other` has one, `me` does not.
        signed(
            &other,
            0,
            vec![],
            r#"{"name":"astra","display_name":"AstraJi","picture":"https://x/a.png"}"#,
            50,
        ),
        // Messages (kind 9).
        signed(&other, 9, vec![h(ch_a), p(&other)], "hello a1", 100),
        signed(&other, 9, vec![h(ch_a), p(&other), p(&me)], "@me a2", 101),
        signed(&me, 9, vec![h(ch_a), p(&me)], "my own", 102),
        signed(&other, 9, vec![h(ch_b), p(&other)], "hello b1", 200),
        signed(&other, 9, vec![h(ch_archived), p(&other)], "archived", 300),
        signed(&other, 9, vec![h(ch_not_mine), p(&other)], "not mine", 400),
        // Non-kind-9 noise in a channel must not be stored.
        signed(
            &other,
            7,
            vec![h(ch_a), vec!["e".into(), "00".repeat(32)]],
            "+",
            103,
        ),
    ];

    let relay = MockRelay::new(
        vec![me.public_key().to_hex()],
        vec![ch_a, ch_b, ch_archived],
        events,
    );
    let url = relay.start().await;
    Fixture {
        relay_keys,
        me,
        other,
        ch_a,
        ch_b,
        relay,
        url,
    }
}

/// T-263: the Journal offers rooms, never direct messages. Sync reads Buzz's DM marks (`t=dm`, `hidden`) into the room
/// list, and a room the relay later marks as a DM is listed as one on the next sync.
#[tokio::test]
async fn sync_lists_direct_messages_as_dms() {
    let f = fixture().await;
    let me_hex = f.me.public_key().to_hex();
    let store = Store::open_in_memory().unwrap();
    let dm_of = |s: &Store| -> Vec<(String, Option<bool>)> {
        let mut v: Vec<(String, Option<bool>)> = s
            .rooms_for(Some(&me_hex))
            .unwrap()
            .into_iter()
            .map(|r| (r.id, r.dm))
            .collect();
        v.sort();
        v
    };
    sync_once(&f.url, &f.me, None, &store).await.unwrap();
    let mut rooms = vec![
        (f.ch_a.to_string(), Some(false)),
        (f.ch_b.to_string(), Some(false)),
    ];
    rooms.sort();
    assert_eq!(dm_of(&store), rooms);

    f.relay.replace(signed(
        &f.relay_keys,
        39000,
        vec![
            d(f.ch_b),
            named("name", "DM"),
            vec!["hidden".into()],
            named("t", "dm"),
        ],
        "",
        2,
    ));
    sync_once(&f.url, &f.me, None, &store).await.unwrap();
    let mut rooms = vec![
        (f.ch_a.to_string(), Some(false)),
        (f.ch_b.to_string(), Some(true)),
    ];
    rooms.sort();
    assert_eq!(dm_of(&store), rooms);
}

#[tokio::test]
async fn compose_publishes_and_stores_only_relay_accepted_replies() {
    let f = fixture().await;
    let store = Store::open_in_memory().unwrap();
    sync_once(&f.url, &f.me, None, &store).await.unwrap();
    let root = store
        .room_messages(&f.ch_a.to_string(), 20)
        .unwrap()
        .into_iter()
        .find(|m| m.item.body == "hello a1")
        .unwrap();
    let sent = tokio::time::timeout(
        Duration::from_secs(3),
        uni_core::send_message(
            &f.url,
            &f.me,
            None,
            &store,
            f.ch_a,
            "reply to Uni",
            Some(&root.item.r#ref),
            &[f.other.public_key().to_hex()],
        ),
    )
    .await
    .expect("relay must answer")
    .unwrap();
    let reply = store
        .message(&f.ch_a.to_string(), &sent.r#ref)
        .unwrap()
        .unwrap();
    assert_eq!(reply.root.as_deref(), Some(root.item.r#ref.as_str()));
    assert_eq!(reply.parent.as_deref(), Some(root.item.r#ref.as_str()));
    let published = f
        .relay
        .events
        .lock()
        .unwrap()
        .iter()
        .find(|e| e["id"] == sent.r#ref)
        .cloned()
        .unwrap();
    assert!(tag_values(&published, "h").contains(&f.ch_a.to_string().as_str()));
    assert!(tag_values(&published, "p").contains(&f.other.public_key().to_hex().as_str()));
    assert!(tag_values(&published, "p").contains(&f.me.public_key().to_hex().as_str()));
    assert_eq!(store.count_items().unwrap(), 5);
    // The bound recipient is recorded as a mention of the stored message.
    assert!(store
        .message_mentions(&sent.r#ref)
        .unwrap()
        .contains(&f.other.public_key().to_hex()));
    // Roster from kind 39002, names from kind 0.
    let members = store.channel_members(&f.ch_a.to_string()).unwrap();
    assert_eq!(members.len(), 2);
    assert_eq!(members[0].pubkey, f.other.public_key().to_hex());
    assert_eq!(members[0].name.as_deref(), Some("AstraJi"));
    assert_eq!(members[1].pubkey, f.me.public_key().to_hex());
    // Thread replies are counted on the root and kept out of the main timeline.
    let timeline = store.room_timeline(&f.ch_a.to_string(), 50).unwrap();
    let root_row = timeline
        .iter()
        .find(|t| t.message.item.r#ref == root.item.r#ref)
        .unwrap();
    assert_eq!(root_row.reply_count, 1);
    assert!(!timeline.iter().any(|t| t.message.item.r#ref == sent.r#ref));

    let nested = uni_core::send_message(
        &f.url,
        &f.me,
        None,
        &store,
        f.ch_a,
        "nested reply",
        Some(&sent.r#ref),
        &[],
    )
    .await
    .unwrap();
    let nested_record = store
        .message(&f.ch_a.to_string(), &nested.r#ref)
        .unwrap()
        .unwrap();
    assert_eq!(
        nested_record.root.as_deref(),
        Some(root.item.r#ref.as_str())
    );
    assert_eq!(nested_record.parent.as_deref(), Some(sent.r#ref.as_str()));
    assert_eq!(
        store
            .thread_messages(&f.ch_a.to_string(), &root.item.r#ref, 20)
            .unwrap()
            .len(),
        3
    );

    let err = tokio::time::timeout(
        Duration::from_secs(3),
        uni_core::send_message(&f.url, &f.me, None, &store, f.ch_a, "reject-me", None, &[]),
    )
    .await
    .expect("relay must reject")
    .unwrap_err();
    assert!(err.to_string().contains("relay rejected"));
    assert_eq!(store.count_items().unwrap(), 6);
}

#[tokio::test]
async fn sync_against_mock_relay() {
    let f = fixture().await;
    let me_hex = f.me.public_key().to_hex();

    // 1. Unknown pubkey is rejected at AUTH (matches the real relay's answer).
    let stranger = Keys::generate();
    let store = Store::open_in_memory().unwrap();
    let err = sync_once(&f.url, &stranger, None, &store)
        .await
        .unwrap_err();
    assert!(
        err.to_string().contains("restricted: not a relay member"),
        "got: {err}"
    );

    // 2. Member: discovery + history + store.
    let store = Store::open_in_memory().unwrap();
    let report = sync_once(&f.url, &f.me, None, &store).await.unwrap();
    assert_eq!(report.pubkey, me_hex);
    assert_eq!(
        report.channels.len(),
        2,
        "archived channel dropped: {:?}",
        report.channels
    );
    assert_eq!(report.channels[&f.ch_a.to_string()].as_deref(), Some("Uni"));
    assert_eq!(
        report.channels[&f.ch_b.to_string()].as_deref(),
        Some("heartbeat")
    );
    assert!(
        report.channel_errors.is_empty(),
        "{:?}",
        report.channel_errors
    );
    // 3 messages + the fixture's kind-7 reaction (fetched as aux, never an item).
    assert_eq!(report.fetched[&f.ch_a.to_string()], 4);
    assert_eq!(report.inserted[&f.ch_a.to_string()], 3);
    assert_eq!(report.fetched[&f.ch_b.to_string()], 1);
    assert_eq!(report.total_items, 4);

    let counts = store.count_by_channel("buzz").unwrap();
    let mut expected = vec![(f.ch_a.to_string(), 3), (f.ch_b.to_string(), 1)];
    expected.sort();
    assert_eq!(counts, expected);

    let tl = store.timeline(10).unwrap();
    assert_eq!(tl[0].body, "hello b1");
    let mentions: Vec<_> = tl
        .iter()
        .filter(|i| i.mentions_me)
        .map(|i| i.body.as_str())
        .collect();
    assert_eq!(mentions, vec!["my own", "@me a2"]);
    assert_eq!(
        store.since_for(&f.ch_a.to_string()).unwrap(),
        Some(103),
        "watermark includes aux (the fixture reaction at 103)"
    );
    assert_eq!(store.since_for(&f.ch_b.to_string()).unwrap(), Some(200));

    // 3. Second run is incremental and idempotent.
    let report2 = sync_once(&f.url, &f.me, None, &store).await.unwrap();
    assert_eq!(report2.inserted.values().sum::<usize>(), 0);
    assert_eq!(report2.total_items, 4);
    // `since` is inclusive per NIP-01, so exactly the watermark event is re-fetched.
    assert_eq!(report2.fetched[&f.ch_a.to_string()], 1);
}

/// T-177: a room archived on the relay after this device cached it. Discovery
/// drops archived rooms, so without an explicit mark the cached row stayed in
/// the room list forever; unarchiving (the rollback) must bring it back.
#[tokio::test]
async fn sync_hides_a_cached_room_once_archived_and_shows_it_again_when_unarchived() {
    let f = fixture().await;
    let me_hex = f.me.public_key().to_hex();
    let store = Store::open_in_memory().unwrap();
    let b = f.ch_b.to_string();
    // What `get_rooms` lists.
    let listed = |s: &Store| -> Vec<String> {
        let mut ids: Vec<String> = s
            .rooms_for(Some(&me_hex))
            .unwrap()
            .into_iter()
            .map(|r| r.id)
            .collect();
        ids.sort();
        ids
    };
    let mut both = vec![f.ch_a.to_string(), b.clone()];
    both.sort();

    sync_once(&f.url, &f.me, None, &store).await.unwrap();
    assert_eq!(listed(&store), both);

    // A message lands after that sync, then the relay archives the room.
    f.relay.publish(signed(
        &f.other,
        9,
        vec![h(f.ch_b), p(&f.other)],
        "b2 before the archive",
        210,
    ));
    f.relay.replace(signed(
        &f.relay_keys,
        39000,
        vec![
            d(f.ch_b),
            named("name", "heartbeat"),
            named("archived", "true"),
        ],
        "",
        2,
    ));
    let report = sync_once(&f.url, &f.me, None, &store).await.unwrap();
    assert_eq!(
        listed(&store),
        vec![f.ch_a.to_string()],
        "the archived room is still listed"
    );
    assert!(!report.channels.contains_key(&b), "{:?}", report.channels);
    assert!(
        !report.fetched.contains_key(&b),
        "history fetched for an archived room"
    );

    // Unarchived: the next sync lists it again, under its name, and catches
    // up from its watermark.
    f.relay.replace(signed(
        &f.relay_keys,
        39000,
        vec![d(f.ch_b), named("name", "heartbeat")],
        "",
        3,
    ));
    let report = sync_once(&f.url, &f.me, None, &store).await.unwrap();
    assert_eq!(
        listed(&store),
        both,
        "the unarchived room did not come back"
    );
    assert_eq!(report.channels[&b].as_deref(), Some("heartbeat"));
    assert!(store
        .room_messages(&b, 10)
        .unwrap()
        .iter()
        .any(|m| m.item.body == "b2 before the archive"));
}

#[tokio::test]
async fn sync_is_incremental_and_idempotent_across_new_events() {
    let f = fixture().await;
    let store = Store::open_in_memory().unwrap();
    let r1 = sync_once(&f.url, &f.me, None, &store).await.unwrap();
    assert_eq!(r1.total_items, 4);

    // New events land on the relay while we're disconnected (phone model).
    f.relay.publish(signed(
        &f.other,
        9,
        vec![h(f.ch_a), p(&f.other)],
        "later a3",
        150,
    ));
    f.relay.publish(signed(
        &f.other,
        9,
        vec![h(f.ch_b), p(&f.other), p(&f.me)],
        "later b2 @me",
        250,
    ));
    // An old event that predates the watermark (e.g. relay backfill) is
    // NOT fetched again — `since` filters it — but if it had been, the
    // unique index would ignore it.
    f.relay.publish(signed(
        &f.other,
        9,
        vec![h(f.ch_a), p(&f.other)],
        "ancient",
        10,
    ));

    let r2 = sync_once(&f.url, &f.me, None, &store).await.unwrap();
    // ch_a: watermark 102 → fetches the 102 event (inclusive) + 150. ch_b: 200 + 250.
    assert_eq!(r2.fetched[&f.ch_a.to_string()], 2);
    assert_eq!(r2.inserted[&f.ch_a.to_string()], 1);
    assert_eq!(r2.fetched[&f.ch_b.to_string()], 2);
    assert_eq!(r2.inserted[&f.ch_b.to_string()], 1);
    assert_eq!(r2.total_items, 6);
    assert_eq!(store.since_for(&f.ch_a.to_string()).unwrap(), Some(150));
    assert_eq!(store.since_for(&f.ch_b.to_string()).unwrap(), Some(250));

    // Third pass: nothing new; watermark events re-fetched, all ignored.
    let r3 = sync_once(&f.url, &f.me, None, &store).await.unwrap();
    assert_eq!(r3.inserted.values().sum::<usize>(), 0);
    assert_eq!(r3.total_items, 6);

    // Unique index on `ref`: the same event id under a different source is
    // still rejected, so a duplicate can never enter the timeline twice.
    let dup = uni_core::Item {
        source: "vault".into(),
        r#ref: store.timeline(1).unwrap()[0].r#ref.clone(),
        channel: "x".into(),
        author: "y".into(),
        ts: 1,
        body: "dup".into(),
        mentions_me: false,
    };
    assert!(!store.upsert_item(&dup).unwrap());
    assert_eq!(store.count_items().unwrap(), 6);
}

#[tokio::test]
async fn sync_caches_profiles_and_show_resolves_names() {
    let f = fixture().await;
    let store = Store::open_in_memory().unwrap();
    let r = sync_once(&f.url, &f.me, None, &store).await.unwrap();
    // Two distinct authors (me, other); only `other` has a kind 0.
    assert_eq!(r.profiles_requested, 2);
    assert_eq!(r.profiles_stored, 1);
    let other_hex = f.other.public_key().to_hex();
    let me_hex = f.me.public_key().to_hex();
    assert_eq!(store.display_name(&other_hex).unwrap(), "AstraJi");
    assert_eq!(
        store.display_name(&me_hex).unwrap(),
        format!("{}…", &me_hex[..8])
    );
    let prof = store.profile(&other_hex).unwrap().unwrap();
    assert_eq!(prof.name.as_deref(), Some("astra"));
    assert_eq!(prof.picture.as_deref(), Some("https://x/a.png"));
    assert_eq!(prof.updated_at, 50);

    // A newer kind 0 replaces; second sync re-requests only missing authors.
    f.relay.publish(signed(
        &f.other,
        0,
        vec![],
        r#"{"display_name":"Astra v2"}"#,
        60,
    ));
    let r2 = sync_once(&f.url, &f.me, None, &store).await.unwrap();
    assert_eq!(r2.profiles_requested, 1, "only `me` is still missing");
    assert_eq!(
        store.display_name(&other_hex).unwrap(),
        "AstraJi",
        "sync only asks for missing authors; the live loop refreshes on kind 0"
    );

    // Names are usable for `show`: channel name + display name both resolve.
    assert_eq!(
        store.channel_name(&f.ch_a.to_string()).unwrap().as_deref(),
        Some("Uni")
    );
}

#[tokio::test]
async fn fts_search_over_synced_items() {
    let f = fixture().await;
    let store = Store::open_in_memory().unwrap();
    sync_once(&f.url, &f.me, None, &store).await.unwrap();

    let hits = store.search("hello", 10).unwrap();
    let mut bodies: Vec<_> = hits.iter().map(|i| i.body.as_str()).collect();
    bodies.sort();
    assert_eq!(bodies, vec!["hello a1", "hello b1"]);
    assert_eq!(store.search("@me", 10).unwrap()[0].body, "@me a2");
    assert!(store.search("archived", 10).unwrap().is_empty());
    assert!(store.search("mine", 10).unwrap().is_empty());
    assert_eq!(store.search("own", 10).unwrap()[0].body, "my own");
}

/// Drain live events until `pred` returns true or `timeout` elapses.
async fn wait_for(
    rx: &mut mpsc::UnboundedReceiver<LiveEvent>,
    seen: &mut Vec<LiveEvent>,
    timeout: Duration,
    pred: impl Fn(&LiveEvent) -> bool,
) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return false;
        }
        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Some(ev)) => {
                let hit = pred(&ev);
                seen.push(ev);
                if hit {
                    return true;
                }
            }
            _ => return false,
        }
    }
}

fn live_cfg(url: &str) -> LiveConfig {
    let mut cfg = LiveConfig::new(url);
    cfg.poll_timeout = Duration::from_millis(50);
    cfg.backoff =
        Backoff::new(Duration::from_millis(20), Duration::from_millis(80)).with_max_attempts(5);
    cfg
}

#[tokio::test]
async fn live_appends_new_events_after_eose_and_stops_cleanly() {
    let f = fixture().await;
    let store = Store::open_in_memory().unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let (stop_tx, stop_rx) = watch::channel(false);

    let url = f.url.clone();
    let me = f.me.clone();
    let store_ref = &store;
    let runner = async move { run_live(live_cfg(&url), &me, None, store_ref, tx, stop_rx).await };

    let driver = async {
        let mut seen = Vec::new();
        assert!(
            wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(
                e,
                LiveEvent::Connected { reconnect: 0 }
            ))
            .await
        );
        // Both channel backfills complete (EOSE each); the archived channel
        // is never subscribed.
        let mut eose = 0;
        while eose < 2 {
            assert!(
                wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(
                    e,
                    LiveEvent::Eose { .. }
                ))
                .await
            );
            eose += 1;
        }
        let backfilled: Vec<_> = seen
            .iter()
            .filter_map(|e| match e {
                LiveEvent::Message { item, new: true } => Some(item.body.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(backfilled.len(), 4, "{backfilled:?}");
        assert_eq!(store.count_items().unwrap(), 4);

        // Live: an event published after EOSE arrives and is stored.
        f.relay.publish(signed(
            &f.other,
            9,
            vec![h(f.ch_a), p(&f.other), p(&f.me)],
            "live @me",
            500,
        ));
        assert!(
            wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(
                e,
                LiveEvent::Message { item, new: true } if item.body == "live @me" && item.mentions_me
            ))
            .await,
            "{seen:?}"
        );
        assert_eq!(store.count_items().unwrap(), 5);
        assert_eq!(store.since_for(&f.ch_a.to_string()).unwrap(), Some(500));

        // A live event on a channel we're not a member of never arrives
        // (the relay only fans out to matching #h subs, and we have none).
        let nm = Uuid::new_v4();
        f.relay
            .publish(signed(&f.other, 9, vec![h(nm), p(&f.other)], "leak?", 501));
        // Kind-7 noise on our channel is ignored too.
        f.relay.publish(signed(
            &f.other,
            7,
            vec![h(f.ch_a), vec!["e".into(), "11".repeat(32)]],
            "+",
            502,
        ));
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(store.count_items().unwrap(), 5);

        // Live kind-0 for the unknown author gets fetched once backfill is done.
        // The profile sub is opened as soon as the *last* channel EOSE lands
        // (`maybe_open_profile_sub` runs on EOSE), so its `Profiles` event
        // races the live publish above: it may already be in `seen` (the
        // usual order on Linux) or still be in flight (seen on macOS). Accept
        // either — the behaviour under test is "fetched after backfill", not
        // "fetched after the first live message".
        let is_profiles = |e: &LiveEvent| matches!(e, LiveEvent::Profiles { .. });
        assert!(
            seen.iter().any(is_profiles)
                || wait_for(&mut rx, &mut seen, Duration::from_secs(5), is_profiles).await,
            "{seen:?}"
        );
        // …and never before backfill finished.
        let last_eose = seen
            .iter()
            .rposition(|e| matches!(e, LiveEvent::Eose { .. }))
            .unwrap();
        let first_profiles = seen.iter().position(is_profiles).unwrap();
        assert!(first_profiles > last_eose, "{seen:?}");
        assert_eq!(
            store.display_name(&f.other.public_key().to_hex()).unwrap(),
            "AstraJi"
        );

        // Stop → clean exit.
        stop_tx.send(true).unwrap();
        assert!(
            wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(
                e,
                LiveEvent::Stopped { .. }
            ))
            .await
        );
    };

    let (r, _) = tokio::join!(runner, driver);
    r.unwrap();

    // And a one-shot sync afterwards agrees with what live wrote.
    let r = sync_once(&f.url, &f.me, None, &store).await.unwrap();
    assert_eq!(r.inserted.values().sum::<usize>(), 0);
    assert_eq!(r.total_items, 5);
}

#[tokio::test]
async fn live_reconnects_with_backoff_and_reauths() {
    let f = fixture().await;
    let store = Store::open_in_memory().unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let (stop_tx, stop_rx) = watch::channel(false);

    let url = f.url.clone();
    let me = f.me.clone();
    let store_ref = &store;
    let runner = async move { run_live(live_cfg(&url), &me, None, store_ref, tx, stop_rx).await };

    let driver = async {
        let mut seen = Vec::new();
        assert!(
            wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(
                e,
                LiveEvent::Connected { reconnect: 0 }
            ))
            .await
        );
        for _ in 0..2 {
            assert!(
                wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(
                    e,
                    LiveEvent::Eose { .. }
                ))
                .await
            );
        }
        assert_eq!(*f.relay.auths_ok.lock().unwrap(), 1);

        // Kill the socket; expect Disconnected → Connected{1} with a fresh AUTH.
        f.relay.drop_all();
        assert!(
            wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(
                e,
                LiveEvent::Disconnected { .. }
            ))
            .await,
            "{seen:?}"
        );
        assert!(
            wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(
                e,
                LiveEvent::Connected { reconnect: 1 }
            ))
            .await,
            "{seen:?}"
        );
        assert_eq!(*f.relay.auths_ok.lock().unwrap(), 2, "re-AUTH on reconnect");

        // Subs are re-opened from the watermarks: backfill re-fetches only
        // the watermark events (dupes, new=false) and nothing is inserted.
        for _ in 0..2 {
            assert!(
                wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(
                    e,
                    LiveEvent::Eose { .. }
                ))
                .await
            );
        }
        assert_eq!(store.count_items().unwrap(), 4);

        // Live delivery works on the new connection.
        f.relay.publish(signed(
            &f.other,
            9,
            vec![h(f.ch_b), p(&f.other)],
            "after reconnect",
            600,
        ));
        assert!(
            wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(
                e,
                LiveEvent::Message { item, new: true } if item.body == "after reconnect"
            ))
            .await,
            "{seen:?}"
        );
        assert_eq!(store.count_items().unwrap(), 5);

        // Drop twice in a row: the second retry delay must be longer than
        // the first (exponential), and both reconnect.
        f.relay.drop_all();
        assert!(
            wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(
                e,
                LiveEvent::Connected { reconnect: 2 }
            ))
            .await,
            "{seen:?}"
        );
        let delays: Vec<Duration> = seen
            .iter()
            .filter_map(|e| match e {
                LiveEvent::Disconnected { retry_in, .. } => Some(*retry_in),
                _ => None,
            })
            .collect();
        // Backoff resets after each successful auth, so both are the base delay.
        assert_eq!(delays, vec![Duration::from_millis(20); 2]);

        stop_tx.send(true).unwrap();
        assert!(
            wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(
                e,
                LiveEvent::Stopped { .. }
            ))
            .await
        );
    };

    let (r, _) = tokio::join!(runner, driver);
    r.unwrap();
    assert!(*f.relay.connections.lock().unwrap() >= 3);
}

/// T-177 in live mode: the relay pushes no metadata change to live subs, so
/// an archive (or unarchive) reaches the room list on the next connection's
/// discovery.
#[tokio::test]
async fn live_reconnect_hides_a_room_archived_meanwhile_and_shows_it_again_when_unarchived() {
    let f = fixture().await;
    let store = Store::open_in_memory().unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let (stop_tx, stop_rx) = watch::channel(false);

    let url = f.url.clone();
    let me = f.me.clone();
    let store_ref = &store;
    let runner = async move { run_live(live_cfg(&url), &me, None, store_ref, tx, stop_rx).await };
    let listed = |s: &Store| {
        s.rooms()
            .unwrap()
            .iter()
            .any(|r| r.id == f.ch_b.to_string())
    };

    let driver = async {
        let mut seen = Vec::new();
        for _ in 0..2 {
            assert!(
                wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(
                    e,
                    LiveEvent::Eose { .. }
                ))
                .await
            );
        }
        assert!(listed(&store));

        // Archived while we're connected; the next connection hides it and
        // opens no sub for it (only the Uni room backfills).
        f.relay.replace(signed(
            &f.relay_keys,
            39000,
            vec![
                d(f.ch_b),
                named("name", "heartbeat"),
                named("archived", "true"),
            ],
            "",
            2,
        ));
        f.relay.drop_all();
        assert!(
            wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(
                e,
                LiveEvent::Connected { reconnect: 1 }
            ))
            .await,
            "{seen:?}"
        );
        assert!(
            wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(
                e,
                LiveEvent::Eose { channel } if *channel == f.ch_a
            ))
            .await,
            "{seen:?}"
        );
        assert!(!listed(&store), "the archived room is still listed");

        // Unarchived: the next connection lists it again and re-subscribes.
        f.relay.replace(signed(
            &f.relay_keys,
            39000,
            vec![d(f.ch_b), named("name", "heartbeat")],
            "",
            3,
        ));
        f.relay.drop_all();
        assert!(
            wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(
                e,
                LiveEvent::Eose { channel } if *channel == f.ch_b
            ))
            .await,
            "{seen:?}"
        );
        assert!(listed(&store), "the unarchived room did not come back");

        stop_tx.send(true).unwrap();
        assert!(
            wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(
                e,
                LiveEvent::Stopped { .. }
            ))
            .await
        );
    };

    let (r, _) = tokio::join!(runner, driver);
    r.unwrap();
}

#[tokio::test]
async fn live_backoff_grows_and_gives_up_when_relay_is_down() {
    // Nothing listening on this port.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    drop(listener);

    let store = Store::open_in_memory().unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let (_stop_tx, stop_rx) = watch::channel(false);
    let mut cfg = LiveConfig::new(&url);
    cfg.backoff =
        Backoff::new(Duration::from_millis(10), Duration::from_millis(40)).with_max_attempts(4);
    let me = Keys::generate();
    let started = tokio::time::Instant::now();
    let r = run_live(cfg, &me, None, &store, tx, stop_rx).await;
    assert!(r.is_err());
    let elapsed = started.elapsed();

    let mut delays = Vec::new();
    let mut stopped = None;
    while let Ok(ev) = rx.try_recv() {
        match ev {
            LiveEvent::Disconnected { retry_in, .. } => delays.push(retry_in),
            LiveEvent::Stopped { reason } => stopped = Some(reason),
            _ => {}
        }
    }
    assert_eq!(
        delays,
        vec![
            Duration::from_millis(10),
            Duration::from_millis(20),
            Duration::from_millis(40),
            Duration::from_millis(40)
        ]
    );
    assert!(elapsed >= Duration::from_millis(110), "{elapsed:?}");
    assert!(stopped.unwrap().contains("exhausted"));
}

#[tokio::test]
async fn live_auth_rejection_is_fatal_not_retried() {
    let f = fixture().await;
    let store = Store::open_in_memory().unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let (_stop_tx, stop_rx) = watch::channel(false);
    let stranger = Keys::generate();
    let err = run_live(live_cfg(&f.url), &stranger, None, &store, tx, stop_rx)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("restricted: not a relay member"));
    let mut n_disc = 0;
    while let Ok(ev) = rx.try_recv() {
        if matches!(ev, LiveEvent::Disconnected { .. }) {
            n_disc += 1;
        }
    }
    assert_eq!(
        n_disc, 0,
        "policy rejection must not enter the backoff loop"
    );
}

/// T-263 (Codex py51n3jd P2): a DM joined while live is stored with its kind unknown, then marked a DM when its metadata lands, and
/// that raises a room-list event, so a Journal chip offered in between is taken away.
#[tokio::test]
async fn live_new_dm_is_marked_when_its_metadata_lands_and_the_room_list_is_told() {
    let f = fixture().await;
    let store = Store::open_in_memory().unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let (stop_tx, stop_rx) = watch::channel(false);
    let url = f.url.clone();
    let me = f.me.clone();
    let store_ref = &store;
    let runner = async move { run_live(live_cfg(&url), &me, None, store_ref, tx, stop_rx).await };
    let driver = async {
        let mut seen = Vec::new();
        for _ in 0..2 {
            assert!(
                wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(
                    e,
                    LiveEvent::Eose { .. }
                ))
                .await
            );
        }
        let ch_dm = Uuid::new_v4();
        f.relay.grant_channel(ch_dm);
        f.relay.publish(signed(
            &f.relay_keys,
            39000,
            vec![
                d(ch_dm),
                named("name", "DM"),
                vec!["hidden".into()],
                named("t", "dm"),
            ],
            "",
            700,
        ));
        f.relay.publish(signed(
            &f.relay_keys,
            44100,
            vec![p(&f.me), h(ch_dm)],
            "",
            nostr::Timestamp::now().as_secs(),
        ));
        assert!(
            wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(
                e,
                LiveEvent::ChannelMeta { channel } if *channel == ch_dm
            ))
            .await,
            "{seen:?}"
        );
        let row = store
            .rooms()
            .unwrap()
            .into_iter()
            .find(|r| r.id == ch_dm.to_string())
            .unwrap();
        assert_eq!(row.dm, Some(true));
        assert_eq!(row.name.as_deref(), Some("DM"));
        stop_tx.send(true).unwrap();
    };
    let (res, ()) = tokio::join!(runner, driver);
    res.unwrap();
}

#[tokio::test]
async fn live_membership_notification_opens_new_channel_sub() {
    let f = fixture().await;
    let store = Store::open_in_memory().unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let (stop_tx, stop_rx) = watch::channel(false);

    let url = f.url.clone();
    let me = f.me.clone();
    let store_ref = &store;
    let runner = async move { run_live(live_cfg(&url), &me, None, store_ref, tx, stop_rx).await };

    let driver = async {
        let mut seen = Vec::new();
        for _ in 0..2 {
            assert!(
                wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(
                    e,
                    LiveEvent::Eose { .. }
                ))
                .await
            );
        }
        // Relay adds us to a new channel: 39000 metadata + 44100 notification.
        let ch_new = Uuid::new_v4();
        f.relay.grant_channel(ch_new);
        f.relay.publish(signed(
            &f.relay_keys,
            39000,
            vec![d(ch_new), named("name", "fresh")],
            "",
            700,
        ));
        f.relay.publish(signed(
            &f.relay_keys,
            44100,
            vec![p(&f.me), h(ch_new)],
            "",
            nostr::Timestamp::now().as_secs(),
        ));
        assert!(
            wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(
                e,
                LiveEvent::ChannelAdded { channel } if *channel == ch_new
            ))
            .await,
            "{seen:?}"
        );
        assert!(
            wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(
                e,
                LiveEvent::Eose { channel } if *channel == ch_new
            ))
            .await
        );
        // Its live traffic now arrives.
        f.relay.publish(signed(
            &f.other,
            9,
            vec![h(ch_new), p(&f.other)],
            "in fresh",
            701,
        ));
        assert!(
            wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(
                e,
                LiveEvent::Message { item, new: true } if item.body == "in fresh"
            ))
            .await,
            "{seen:?}"
        );
        // Wait until the meta lookup has landed the name.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while store.channel_name(&ch_new.to_string()).unwrap().is_none() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "channel name not stored"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(
            store.channel_name(&ch_new.to_string()).unwrap().as_deref(),
            Some("fresh")
        );

        // A 44101 for someone else must not touch us; one for us closes the sub.
        f.relay.publish(signed(
            &f.relay_keys,
            44101,
            vec![p(&f.other), h(ch_new)],
            "",
            nostr::Timestamp::now().as_secs(),
        ));
        f.relay.publish(signed(
            &f.relay_keys,
            44101,
            vec![p(&f.me), h(ch_new)],
            "",
            nostr::Timestamp::now().as_secs(),
        ));
        assert!(
            wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(
                e,
                LiveEvent::ChannelRemoved { channel } if *channel == ch_new
            ))
            .await,
            "{seen:?}"
        );
        // Wait for the client's CLOSE to reach the relay, then prove no
        // more traffic from that channel is stored.
        let want = uni_core::buzz::channel_sub_id(ch_new);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while !f.relay.closed_subs.lock().unwrap().contains(&want) {
            assert!(tokio::time::Instant::now() < deadline, "CLOSE not sent");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        f.relay.publish(signed(
            &f.other,
            9,
            vec![h(ch_new), p(&f.other)],
            "after leave",
            702,
        ));
        tokio::time::sleep(Duration::from_millis(200)).await;
        while let Ok(ev) = rx.try_recv() {
            seen.push(ev);
        }
        assert!(
            store.search("after leave", 5).unwrap().is_empty(),
            "tail={:?}",
            &seen[seen.len() - 3..]
        );

        stop_tx.send(true).unwrap();
    };
    let (r, _) = tokio::join!(runner, driver);
    r.unwrap();
}

// ---------------------------------------------------------------------------
// NIP-AB pairing: buzz-core's *source* role (what Buzz desktop runs) against
// uni-core's target driver, routed through the mock relay by `#p`.
// ---------------------------------------------------------------------------

mod pairing_e2e {
    use super::*;
    use buzz_core::kind::KIND_PAIRING;
    use buzz_core::pairing::{qr::encode_qr, AbortReason, PairingSession, PayloadType};
    use buzz_ws_client::{NostrWsConnection, RelayMessage};
    use nostr::nips::nip19::ToBech32;
    use nostr::{EventBuilder, RelayUrl};
    use zeroize::Zeroizing;

    /// Source side (Buzz desktop), connected + subscribed; returns the link.
    struct Source {
        session: PairingSession,
        conn: NostrWsConnection,
        uri: String,
    }

    async fn source(url: &str) -> Source {
        let (session, qr) = PairingSession::new_source(url.to_string());
        let uri = encode_qr(&qr);
        let mut conn = NostrWsConnection::connect(url).await.unwrap();
        let challenge = loop {
            if let RelayMessage::Auth { challenge } =
                conn.next_event(Duration::from_secs(5)).await.unwrap()
            {
                break challenge;
            }
        };
        let auth = session
            .sign_event(EventBuilder::auth(challenge, RelayUrl::parse(url).unwrap()))
            .unwrap();
        conn.send_raw(&json!(["AUTH", auth])).await.unwrap();
        let filter = json!({"kinds":[KIND_PAIRING], "#p":[session.pubkey().to_hex()]});
        conn.send_raw(&json!(["REQ", "src", filter])).await.unwrap();
        loop {
            if let RelayMessage::Eose { .. } =
                conn.next_event(Duration::from_secs(5)).await.unwrap()
            {
                break;
            }
        }
        Source { session, conn, uri }
    }

    impl Source {
        async fn next(&mut self) -> nostr::Event {
            loop {
                match self.conn.next_event(Duration::from_secs(10)).await.unwrap() {
                    RelayMessage::Event { event, .. } => return *event,
                    RelayMessage::Ok(ok) => assert!(ok.accepted, "relay rejected: {}", ok.message),
                    _ => {}
                }
            }
        }
        async fn send(&mut self, ev: &nostr::Event) {
            self.conn.send_raw(&json!(["EVENT", ev])).await.unwrap();
        }
        /// Wait for the target's offer; return the SAS the source displays.
        async fn take_offer(&mut self) -> String {
            let ev = self.next().await;
            self.session.handle_offer(&ev).expect("valid offer")
        }
    }

    fn identity_payload(keys: &Keys, claimed: &Keys) -> Zeroizing<String> {
        Zeroizing::new(
            json!({
                "relayUrl": "https://buzz.example.com",
                "pubkey": claimed.public_key().to_hex(),
                "nsec": keys.secret_key().to_bech32().unwrap(),
            })
            .to_string(),
        )
    }

    #[tokio::test]
    async fn pairing_delivers_nsec_after_both_sides_confirm() {
        let relay = MockRelay::pairing();
        let url = relay.start().await;
        let mut src = source(&url).await;
        let account = Keys::generate();

        let pending = uni_core::pairing::start(&src.uri).await.expect("start");
        let source_sas = src.take_offer().await;
        assert_eq!(pending.sas(), source_sas, "both devices show the same code");
        assert_eq!(pending.sas().len(), 6);

        // Buzz desktop user clicks "codes match": sas-confirm + payload.
        let confirm = src.session.confirm_sas().unwrap();
        src.send(&confirm).await;
        let payload = src
            .session
            .send_payload(PayloadType::Custom, identity_payload(&account, &account))
            .unwrap();
        src.send(&payload).await;

        let got = pending.confirm().await.expect("identity received");
        assert_eq!(got.pubkey, account.public_key());
        assert_eq!(
            got.nsec.as_str(),
            account.secret_key().to_bech32().unwrap().as_str()
        );
        assert_eq!(got.relay_url.as_deref(), Some("wss://buzz.example.com"));

        let complete = src.next().await;
        src.session
            .handle_complete(&complete)
            .expect("complete(success)");
    }

    #[tokio::test]
    async fn target_declining_the_code_aborts_with_sas_mismatch() {
        let relay = MockRelay::pairing();
        let url = relay.start().await;
        let mut src = source(&url).await;

        let pending = uni_core::pairing::start(&src.uri).await.unwrap();
        src.take_offer().await;
        pending.cancel(true).await.unwrap();

        let abort = src.next().await;
        assert_eq!(
            src.session.handle_abort(&abort).expect("abort from target"),
            AbortReason::SasMismatch
        );
    }

    #[tokio::test]
    async fn source_declining_the_code_fails_the_target() {
        let relay = MockRelay::pairing();
        let url = relay.start().await;
        let mut src = source(&url).await;

        let pending = uni_core::pairing::start(&src.uri).await.unwrap();
        src.take_offer().await;
        let abort = src
            .session
            .abort(AbortReason::SasMismatch)
            .unwrap()
            .unwrap();
        src.send(&abort).await;

        let err = pending.confirm().await.expect_err("must not pair");
        assert!(err.to_string().contains("cancelled"), "{err}");
    }

    #[tokio::test]
    async fn payload_with_mismatched_pubkey_is_rejected() {
        let relay = MockRelay::pairing();
        let url = relay.start().await;
        let mut src = source(&url).await;
        let account = Keys::generate();
        let liar = Keys::generate();

        let pending = uni_core::pairing::start(&src.uri).await.unwrap();
        src.take_offer().await;
        let confirm = src.session.confirm_sas().unwrap();
        src.send(&confirm).await;
        let payload = src
            .session
            .send_payload(PayloadType::Custom, identity_payload(&account, &liar))
            .unwrap();
        src.send(&payload).await;

        let err = pending.confirm().await.expect_err("mismatch must fail");
        assert!(err.to_string().contains("does not match"), "{err}");
    }

    #[tokio::test]
    async fn garbage_link_is_rejected_before_any_network() {
        assert!(uni_core::pairing::start("nostrpair://nope").await.is_err());
        assert!(uni_core::pairing::start("https://example.com")
            .await
            .is_err());
    }
}

fn e(id: &str) -> Vec<String> {
    vec!["e".to_string(), id.to_string()]
}

/// Edits (40003) and deletions (9005, and kind 5 as Buzz desktop sends it,
/// with an `h` tag) are pulled on sync and applied: edited text replaces the
/// original, deleted messages vanish. Then the same arrives live after EOSE,
/// and the live loop reports it so the UI can re-render.
#[tokio::test]
async fn sync_and_live_apply_edits_and_deletions() {
    let f = fixture().await;
    let store = Store::open_in_memory().unwrap();
    let ch = f.ch_a.to_string();
    let find = |body: &str| {
        f.relay
            .events
            .lock()
            .unwrap()
            .iter()
            .find(|e| e["content"] == body)
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let a1 = find("hello a1");
    let a2 = find("@me a2");
    let own = find("my own");
    f.relay.publish(signed(
        &f.other,
        40003,
        vec![h(f.ch_a), e(&a1)],
        "hello a1 (fixed)",
        110,
    ));
    // An edit by someone other than the author is not applied.
    f.relay
        .publish(signed(&f.me, 40003, vec![h(f.ch_a), e(&a2)], "forged", 111));
    f.relay.publish(signed(
        &f.relay_keys,
        9005,
        vec![h(f.ch_a), e(&own)],
        "",
        112,
    ));

    sync_once(&f.url, &f.me, None, &store).await.unwrap();
    let bodies = |s: &Store| -> Vec<(String, bool)> {
        s.room_timeline(&ch, 50)
            .unwrap()
            .into_iter()
            .map(|t| (t.message.item.body, t.message.edited))
            .collect()
    };
    assert_eq!(
        bodies(&store),
        vec![("hello a1 (fixed)".into(), true), ("@me a2".into(), false)]
    );
    // Backfill seeded the read marker: nothing unread yet.
    let me_hex = f.me.public_key().to_hex();
    assert_eq!(store.rooms_for(Some(&me_hex)).unwrap()[0].unread, 0);

    // Live: a new message, then its edit, then a kind-5 delete of a2.
    let (tx, mut rx) = mpsc::unbounded_channel();
    let (stop_tx, stop_rx) = watch::channel(false);
    let url = f.url.clone();
    let me = f.me.clone();
    let store_ref = &store;
    let runner = async move { run_live(live_cfg(&url), &me, None, store_ref, tx, stop_rx).await };
    let driver = async {
        let mut seen = Vec::new();
        let mut eose = 0;
        while eose < 2 {
            assert!(
                wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(
                    e,
                    LiveEvent::Eose { .. }
                ))
                .await
            );
            eose += 1;
        }
        let live = signed(&f.other, 9, vec![h(f.ch_a), p(&f.other)], "live one", 600);
        let live_id = live["id"].as_str().unwrap().to_string();
        f.relay.publish(live);
        assert!(
            wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(
                e,
                LiveEvent::Message { new: true, .. }
            ))
            .await
        );
        assert_eq!(store.rooms_for(Some(&me_hex)).unwrap()[0].unread, 1);

        f.relay.publish(signed(
            &f.other,
            40003,
            vec![h(f.ch_a), e(&live_id)],
            "live one, edited",
            601,
        ));
        assert!(
            wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(
                e,
                LiveEvent::Aux { kind: 40003, .. }
            ))
            .await
        );
        f.relay
            .publish(signed(&f.other, 5, vec![h(f.ch_a), e(&a2)], "", 602));
        assert!(
            wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(
                e,
                LiveEvent::Aux { kind: 5, .. }
            ))
            .await
        );
        assert_eq!(
            bodies(&store),
            vec![
                ("hello a1 (fixed)".into(), true),
                ("live one, edited".into(), true)
            ]
        );
        stop_tx.send(true).unwrap();
        assert!(
            wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(
                e,
                LiveEvent::Stopped { .. }
            ))
            .await
        );
    };
    let (r, _) = tokio::join!(runner, driver);
    r.unwrap();
    store.mark_read(&ch).unwrap();
    assert_eq!(store.rooms_for(Some(&me_hex)).unwrap()[0].unread, 0);
}

/// Reactions: someone else's arrive on sync (grouped per emoji, duplicates
/// from one reactor count once); ours publishes in Buzz's shape (kind 7, one
/// `e` tag) and is undone with a kind-5 that only we can issue.
#[tokio::test]
async fn reactions_sync_send_and_undo() {
    let f = fixture().await;
    let store = Store::open_in_memory().unwrap();
    let ch = f.ch_a.to_string();
    let a1 = f
        .relay
        .events
        .lock()
        .unwrap()
        .iter()
        .find(|e| e["content"] == "hello a1")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    // The relay files reactions under the target's channel (`#h` matches).
    f.relay
        .publish(signed(&f.other, 7, vec![h(f.ch_a), e(&a1)], "🔥", 120));
    f.relay
        .publish(signed(&f.other, 7, vec![h(f.ch_a), e(&a1)], "🔥", 121));
    sync_once(&f.url, &f.me, None, &store).await.unwrap();
    let me_hex = f.me.public_key().to_hex();
    let r = store
        .reactions(std::slice::from_ref(&a1), Some(&me_hex))
        .unwrap();
    assert_eq!(r.len(), 1);
    assert_eq!(
        (r[0].emoji.as_str(), r[0].count, r[0].mine.is_none()),
        ("🔥", 1, true)
    );

    let rid = send_reaction(&f.url, &f.me, None, &store, f.ch_a, &a1, "🔥")
        .await
        .unwrap();
    let sent = f
        .relay
        .events
        .lock()
        .unwrap()
        .iter()
        .find(|e| e["id"] == rid.as_str())
        .cloned()
        .unwrap();
    assert_eq!(sent["kind"], 7);
    assert_eq!(tag_values(&sent, "e"), vec![a1.as_str()]);
    let r = store
        .reactions(std::slice::from_ref(&a1), Some(&me_hex))
        .unwrap();
    assert_eq!((r[0].count, r[0].mine.as_deref()), (2, Some(rid.as_str())));

    // Can't undo someone else's reaction.
    let theirs = f
        .relay
        .events
        .lock()
        .unwrap()
        .iter()
        .find(|e| e["kind"] == 7 && e["pubkey"] == f.other.public_key().to_hex().as_str())
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(remove_reaction(&f.url, &f.me, None, &store, &theirs)
        .await
        .is_err());

    remove_reaction(&f.url, &f.me, None, &store, &rid)
        .await
        .unwrap();
    let del = f
        .relay
        .events
        .lock()
        .unwrap()
        .iter()
        .find(|e| e["kind"] == 5)
        .cloned()
        .unwrap();
    assert_eq!(tag_values(&del, "e"), vec![rid.as_str()]);
    let r = store
        .reactions(std::slice::from_ref(&a1), Some(&me_hex))
        .unwrap();
    assert_eq!((r[0].count, r[0].mine.is_none()), (1, true));
    // Reactions never count as messages or unread.
    assert_eq!(store.room_timeline(&ch, 50).unwrap().len(), 3);
}

/// Older history: with a small window, sync only has the newest messages;
/// `sync_older` pages back (with `until`) and pulls aux events for the page
/// by `#e`, even when they are newer than the page. Read marker unaffected.
#[tokio::test]
async fn sync_older_pages_back_with_aux() {
    let f = fixture().await;
    let store = Store::open_in_memory().unwrap();
    let ch = f.ch_b.to_string();
    let me_hex = f.me.public_key().to_hex();
    // First sync sees only "hello b1" (ts 200) and sets the watermark there.
    sync_once(&f.url, &f.me, None, &store).await.unwrap();
    assert_eq!(store.room_timeline(&ch, 500).unwrap().len(), 1);
    // 30 older messages (ts 10..39) surface on the relay afterwards, e.g.
    // history from before we joined; plus a much later edit of the oldest.
    let mut first = String::new();
    for i in 0..30u64 {
        let ev = signed(
            &f.other,
            9,
            vec![h(f.ch_b), p(&f.other)],
            &format!("old {i}"),
            10 + i,
        );
        if i == 0 {
            first = ev["id"].as_str().unwrap().to_string();
        }
        f.relay.publish(ev);
    }
    f.relay.publish(signed(
        &f.other,
        40003,
        vec![h(f.ch_b), e(&first)],
        "old 0 (edited)",
        900,
    ));
    // Incremental sync is `since`-bounded, so it can't reach them.
    sync_once(&f.url, &f.me, None, &store).await.unwrap();
    assert_eq!(store.room_timeline(&ch, 500).unwrap().len(), 1);
    let unread = |s: &Store| {
        s.rooms_for(Some(&me_hex))
            .unwrap()
            .into_iter()
            .find(|r| r.id == ch)
            .unwrap()
            .unread
    };
    let unread_before = unread(&store);

    // `until` is inclusive, so each page re-fetches the boundary message
    // (dedup by id): 19 new, then the remaining 11.
    assert_eq!(
        sync_older(&f.url, &f.me, None, &store, f.ch_b, 20)
            .await
            .unwrap(),
        19
    );
    assert_eq!(
        sync_older(&f.url, &f.me, None, &store, f.ch_b, 20)
            .await
            .unwrap(),
        11
    );
    assert_eq!(
        sync_older(&f.url, &f.me, None, &store, f.ch_b, 20)
            .await
            .unwrap(),
        0,
        "start of history"
    );
    let tl = store.room_timeline(&ch, 500).unwrap();
    assert_eq!(tl.len(), 31);
    assert_eq!(
        (tl[0].message.item.body.as_str(), tl[0].message.edited),
        ("old 0 (edited)", true)
    );
    assert_eq!(unread(&store), unread_before, "history is not news");
}

/// Editing and deleting our own messages, in Buzz desktop's exact shapes:
/// kind 40003 `[h, e]` with the new text, and kind 5 `[h, e]` with empty
/// content. Someone else's message is refused locally (nothing published).
#[tokio::test]
async fn edit_and_delete_own_messages() {
    let f = fixture().await;
    let store = Store::open_in_memory().unwrap();
    let ch = f.ch_a.to_string();
    sync_once(&f.url, &f.me, None, &store).await.unwrap();
    let find = |content: &str| {
        f.relay
            .events
            .lock()
            .unwrap()
            .iter()
            .find(|e| e["content"] == content)
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let mine = find("my own");
    let theirs = find("hello a1");
    let published = || f.relay.events.lock().unwrap().len();

    let eid = edit_message(
        &f.url,
        &f.me,
        None,
        &store,
        f.ch_a,
        &mine,
        "  my own (fixed)\n ",
    )
    .await
    .unwrap();
    let sent = f
        .relay
        .events
        .lock()
        .unwrap()
        .iter()
        .find(|e| e["id"] == eid.as_str())
        .cloned()
        .unwrap();
    assert_eq!(sent["kind"], 40003);
    assert_eq!(sent["content"], "my own (fixed)");
    assert_eq!(tag_values(&sent, "h"), vec![ch.as_str()]);
    assert_eq!(tag_values(&sent, "e"), vec![mine.as_str()]);
    assert_eq!(sent["tags"].as_array().unwrap().len(), 2);
    let m = store.message(&ch, &mine).unwrap().unwrap();
    assert_eq!((m.item.body.as_str(), m.edited), ("my own (fixed)", true));

    // Refused locally: someone else's message, empty text, unknown target.
    let before = published();
    assert!(
        edit_message(&f.url, &f.me, None, &store, f.ch_a, &theirs, "forged")
            .await
            .is_err()
    );
    assert!(delete_message(&f.url, &f.me, None, &store, f.ch_a, &theirs)
        .await
        .is_err());
    assert!(
        edit_message(&f.url, &f.me, None, &store, f.ch_a, &mine, "   ")
            .await
            .is_err()
    );
    assert!(
        delete_message(&f.url, &f.me, None, &store, f.ch_a, &"00".repeat(32))
            .await
            .is_err()
    );
    // Wrong room for the target is refused too.
    assert!(delete_message(&f.url, &f.me, None, &store, f.ch_b, &mine)
        .await
        .is_err());
    assert_eq!(published(), before);
    assert_eq!(
        store.message(&ch, &theirs).unwrap().unwrap().item.body,
        "hello a1"
    );

    let did = delete_message(&f.url, &f.me, None, &store, f.ch_a, &mine)
        .await
        .unwrap();
    let del = f
        .relay
        .events
        .lock()
        .unwrap()
        .iter()
        .find(|e| e["id"] == did.as_str())
        .cloned()
        .unwrap();
    assert_eq!(del["kind"], 5);
    assert_eq!(del["content"], "");
    assert_eq!(tag_values(&del, "h"), vec![ch.as_str()]);
    assert_eq!(tag_values(&del, "e"), vec![mine.as_str()]);
    let tl = store.room_timeline(&ch, 50).unwrap();
    assert!(tl.iter().all(|t| t.message.item.r#ref != mine));
    assert_eq!(tl.len(), 2);
    assert!(store.message(&ch, &mine).unwrap().is_none());
    // Re-sync keeps it gone (the relay echoes our kind 5 back).
    sync_once(&f.url, &f.me, None, &store).await.unwrap();
    assert!(store
        .room_timeline(&ch, 50)
        .unwrap()
        .iter()
        .all(|t| t.message.item.r#ref != mine));
}

// ── Cross-device read state (Buzz NIP-RS, kind 30078) ─────────────────────

/// A read-state event as Buzz desktop publishes it (`readStateManager.ts`
/// `publishOneSlot`): NIP-44 v2 to self, `d=read-state:<slot>`, `t=read-state`.
fn desktop_read_state(keys: &Keys, slot: &str, client_id: &str, contexts: Value, ts: u64) -> Value {
    use nostr::nips::nip44;
    let blob = json!({"v": 1, "client_id": client_id, "contexts": contexts}).to_string();
    let content = nip44::encrypt(
        keys.secret_key(),
        &keys.public_key(),
        blob,
        nip44::Version::V2,
    )
    .unwrap();
    signed(
        keys,
        30078,
        vec![
            named("d", &format!("read-state:{slot}")),
            named("t", "read-state"),
        ],
        &content,
        ts,
    )
}

fn now() -> u64 {
    nostr::Timestamp::now().as_secs()
}

fn unread(store: &Store, me: &Keys, ch: Uuid) -> i64 {
    store
        .rooms_for(Some(&me.public_key().to_hex()))
        .unwrap()
        .into_iter()
        .find(|r| r.id == ch.to_string())
        .unwrap()
        .unread
}

#[tokio::test]
async fn read_state_newer_remote_clears_unread_older_never_regresses() {
    let f = fixture().await;
    let store = Store::open_in_memory().unwrap();
    sync_once(&f.url, &f.me, None, &store).await.unwrap();
    // New messages from others after first sight: unread on this device.
    f.relay.publish(signed(
        &f.other,
        9,
        vec![h(f.ch_a), p(&f.other)],
        "new a",
        150,
    ));
    f.relay.publish(signed(
        &f.other,
        9,
        vec![h(f.ch_b), p(&f.other)],
        "new b",
        250,
    ));
    sync_once(&f.url, &f.me, None, &store).await.unwrap();
    assert_eq!(
        (unread(&store, &f.me, f.ch_a), unread(&store, &f.me, f.ch_b)),
        (1, 1)
    );

    // Desktop read #a up to 150; its (older) marker for #b predates what we
    // already had. A foreign key's event is ignored (authors=[me] + pubkey check).
    let slot = "0123456789abcdef0123456789abcdef";
    f.relay.publish(desktop_read_state(
        &f.me,
        slot,
        "desktop-client",
        json!({ f.ch_a.to_string(): 150, f.ch_b.to_string(): 10, "thread:x": 999 }),
        now(),
    ));
    f.relay.publish(desktop_read_state(
        &f.other,
        slot,
        "evil",
        json!({ f.ch_b.to_string(): 999 }),
        now(),
    ));
    let r = sync_once(&f.url, &f.me, None, &store).await.unwrap();
    assert_eq!(r.read_state_advanced, vec![f.ch_a.to_string()]);
    assert_eq!(unread(&store, &f.me, f.ch_a), 0);
    assert_eq!(unread(&store, &f.me, f.ch_b), 1);
    assert_eq!(store.read_marker(&f.ch_b.to_string()).unwrap(), Some(200));

    // Idempotent: re-sync advances nothing.
    let r = sync_once(&f.url, &f.me, None, &store).await.unwrap();
    assert!(r.read_state_advanced.is_empty());
}

#[tokio::test]
async fn read_state_publish_has_exact_desktop_shape() {
    use nostr::nips::nip44;
    let f = fixture().await;
    let store = Store::open_in_memory().unwrap();
    sync_once(&f.url, &f.me, None, &store).await.unwrap();
    // First-sight seeds alone are never published.
    assert!(!uni_core::read_state_dirty(&store, &f.me).unwrap());
    assert!(!uni_core::publish_read_state(&f.url, &f.me, None, &store)
        .await
        .unwrap());

    // Another device already read #b; we read #a here.
    f.relay.publish(desktop_read_state(
        &f.me,
        "desk",
        "desktop-client",
        json!({ f.ch_b.to_string(): 200 }),
        now(),
    ));
    f.relay.publish(signed(
        &f.other,
        9,
        vec![h(f.ch_a), p(&f.other)],
        "new a",
        150,
    ));
    sync_once(&f.url, &f.me, None, &store).await.unwrap();
    assert!(store.mark_read(&f.ch_a.to_string()).unwrap());
    assert!(uni_core::publish_read_state(&f.url, &f.me, None, &store)
        .await
        .unwrap());
    // Nothing changed since: no second publish.
    assert!(!uni_core::publish_read_state(&f.url, &f.me, None, &store)
        .await
        .unwrap());

    let mine: Vec<Value> = f
        .relay
        .events
        .lock()
        .unwrap()
        .iter()
        .filter(|e| e["kind"] == 30078 && tag_values(e, "d") != vec!["read-state:desk"])
        .cloned()
        .collect();
    assert_eq!(mine.len(), 1, "{mine:?}");
    let ev = &mine[0];
    assert_eq!(ev["pubkey"], f.me.public_key().to_hex());
    let tags = ev["tags"].as_array().unwrap();
    assert_eq!(tags.len(), 2);
    assert_eq!(tags[0][0], "d");
    let slot = tags[0][1]
        .as_str()
        .unwrap()
        .strip_prefix("read-state:")
        .unwrap();
    assert!(
        slot.len() == 32 && slot.chars().all(|c| c.is_ascii_hexdigit()),
        "{slot}"
    );
    assert_eq!(tags[1], json!(["t", "read-state"]));
    assert!(ev["created_at"].as_u64().unwrap() + 5 >= now());
    let plain = nip44::decrypt(
        f.me.secret_key(),
        &f.me.public_key(),
        ev["content"].as_str().unwrap(),
    )
    .unwrap();
    // Exact desktop JSON shape and key order: {"v":1,"client_id":…,"contexts":{…}}.
    assert!(plain.starts_with(r#"{"v":1,"client_id":""#), "{plain}");
    let blob: Value = serde_json::from_str(&plain).unwrap();
    assert_eq!(blob.as_object().unwrap().len(), 3);
    assert!(Uuid::parse_str(blob["client_id"].as_str().unwrap()).is_ok());
    assert_eq!(
        blob["contexts"],
        json!({ f.ch_a.to_string(): 150, f.ch_b.to_string(): 200 })
    );
}

#[tokio::test]
async fn live_read_state_from_desktop_arrives_in_real_time() {
    let f = fixture().await;
    let store = Store::open_in_memory().unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let (stop_tx, stop_rx) = watch::channel(false);
    let url = f.url.clone();
    let me = f.me.clone();
    let store_ref = &store;
    let runner = async move { run_live(live_cfg(&url), &me, None, store_ref, tx, stop_rx).await };
    let driver = async {
        let mut seen = Vec::new();
        let mut eose = 0;
        while eose < 2 {
            assert!(
                wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(
                    e,
                    LiveEvent::Eose { .. }
                ))
                .await
            );
            eose += 1;
        }
        f.relay.publish(signed(
            &f.other,
            9,
            vec![h(f.ch_a), p(&f.other)],
            "new a",
            150,
        ));
        assert!(
            wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(
                e,
                LiveEvent::Message { new: true, .. }
            ))
            .await
        );
        assert_eq!(unread(&store, &f.me, f.ch_a), 1);
        f.relay.publish(desktop_read_state(
            &f.me,
            "desk",
            "desktop-client",
            json!({ f.ch_a.to_string(): 150 }),
            now(),
        ));
        let ch = f.ch_a.to_string();
        assert!(
            wait_for(
                &mut rx,
                &mut seen,
                Duration::from_secs(5),
                |e| matches!(e, LiveEvent::ReadState { channels } if channels == &vec![ch.clone()])
            )
            .await,
            "{seen:?}"
        );
        assert_eq!(unread(&store, &f.me, f.ch_a), 0);
        // An older marker arriving live is a no-op (no event, no regression).
        f.relay.publish(desktop_read_state(
            &f.me,
            "desk",
            "desktop-client",
            json!({ f.ch_a.to_string(): 1 }),
            now(),
        ));
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(store.read_marker(&ch).unwrap(), Some(150));
        stop_tx.send(true).unwrap();
        assert!(
            wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(
                e,
                LiveEvent::Stopped { .. }
            ))
            .await
        );
        assert!(
            !seen
                .iter()
                .filter(|e| matches!(e, LiveEvent::ReadState { .. }))
                .nth(1)
                .is_some(),
            "{seen:?}"
        );
    };
    let (r, _) = tokio::join!(runner, driver);
    r.unwrap();
}

/// r26 (Codex P1 3): serves a relay with five rooms for the app's cold-send walk, until killed. Not a test: `cargo test -p uni-core --offline
/// --test mock_relay -- --ignored serve_for_the_walk`, with `MOCK_MEMBER_HEX` (the member's public key), `MOCK_PORT`, and `MOCK_HISTORY_DELAY_MS`
/// (each room's history answers this late, so the first sync takes about five times as long).
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn serve_for_the_walk() {
    let member = std::env::var("MOCK_MEMBER_HEX").expect("MOCK_MEMBER_HEX");
    let port = std::env::var("MOCK_PORT").unwrap_or_else(|_| "19391".into());
    let relay_keys = Keys::generate();
    let other = Keys::generate();
    let member_pk = nostr::PublicKey::from_hex(&member).unwrap();
    let chans: Vec<Uuid> = (0..5).map(|_| Uuid::new_v4()).collect();
    let mut events = Vec::new();
    for (i, ch) in chans.iter().enumerate() {
        let name = ["walk-send", "walk-two", "walk-three", "walk-four", "walk-five"][i];
        events.push(signed(&relay_keys, 39002, vec![d(*ch), p(&other), vec!["p".into(), member.clone()]], "", 1));
        events.push(signed(&relay_keys, 39000, vec![d(*ch), named("name", name)], "", 1));
        for n in 0..60u64 {
            events.push(signed(&other, 9, vec![h(*ch), p(&other)], &format!("{name} message {n}"), 100 + n));
        }
    }
    let _ = member_pk;
    let relay = MockRelay::new(vec![member], chans.clone(), events);
    let listener = TcpListener::bind(format!("127.0.0.1:{port}")).await.unwrap();
    println!("serving ws://127.0.0.1:{port}");
    serve(listener, relay).await;
}

/// T-176 (Codex review P1): a relay that lies about who wrote a secret request. It serves Uni's real
/// request, the same request with its one-time key swapped for the relay's own, a request it signed
/// itself but labelled as Uni's, a forged "stored" receipt and a forged edit. Through the real sync and
/// live paths only the genuine events are stored, and only the genuine request can be answered (with
/// its own one-time key).
#[tokio::test]
async fn a_lying_relay_cannot_forge_a_secret_request_or_receipt() {
    use uni_core::secret::{check_answerable, parse_request, seal_delivery, stored_request};

    let f = fixture().await;
    let uni = Keys::generate();
    let relay_op = Keys::generate();
    let (one_time, theirs) = (Keys::generate(), Keys::generate());
    let ts = now();
    let request = |rpk: &Keys, rid: &str| {
        format!(
            "🔐 Uni is asking for a secret\n\n```uni-secret-request\n{}\n```",
            json!({"v":1,"rid":rid,"name":"tailscale-api","label":"Tailscale API token","purpose":"list devices",
                   "store":"~/.config/uni/tailscale-api","keep_days":30,"expires":ts + 900,
                   "rpk":rpk.public_key().to_hex()})
        )
    };
    let forge_as_uni = |mut v: Value| {
        v["pubkey"] = uni.public_key().to_hex().into();
        v
    };
    let genuine = signed(&uni, 9, vec![h(f.ch_a)], &request(&one_time, &"1".repeat(32)), ts);
    let mut swapped = genuine.clone();
    swapped["content"] = request(&theirs, &"1".repeat(32)).into();
    let relabelled = forge_as_uni(signed(&relay_op, 9, vec![h(f.ch_a)], &request(&theirs, &"2".repeat(32)), ts + 1));
    let receipt = forge_as_uni(signed(
        &relay_op,
        9,
        vec![h(f.ch_a)],
        "🔒 Stored\n\n```uni-secret-stored\n{\"v\":1,\"rid\":\"11111111111111111111111111111111\",\"name\":\"tailscale-api\",\"until\":1}\n```",
        ts + 2,
    ));
    let edit = forge_as_uni(signed(
        &relay_op,
        40003,
        vec![h(f.ch_a), vec!["e".into(), genuine["id"].as_str().unwrap().into()]],
        &request(&theirs, &"1".repeat(32)),
        ts + 3,
    ));
    for ev in [&swapped, &relabelled, &receipt, &edit] {
        f.relay.publish(ev.clone());
    }
    let store = Store::open_in_memory().unwrap();
    sync_once(&f.url, &f.me, None, &store).await.unwrap();
    let ch = f.ch_a.to_string();
    let swapped_id = swapped["id"].as_str().unwrap();
    assert!(store.message(&ch, swapped_id).unwrap().is_none(), "the key-swapped request was stored");
    assert!(stored_request(&store, &ch, swapped_id).is_err());

    // The swapped copy has the genuine one's id, so the relay served it instead; now it serves the real one.
    f.relay.events.lock().unwrap().retain(|e| e != &swapped);
    f.relay.publish(genuine.clone());
    sync_once(&f.url, &f.me, None, &store).await.unwrap();
    let bodies: Vec<String> = store.room_messages(&ch, 50).unwrap().into_iter().map(|m| m.item.body).collect();
    assert_eq!(bodies.iter().filter(|b| b.contains("uni-secret")).count(), 1, "{bodies:#?}");
    assert!(!bodies.iter().any(|b| b.contains(&theirs.public_key().to_hex())), "a forged request or edit was stored");
    assert!(!bodies.iter().any(|b| b.contains("uni-secret-stored")), "a forged receipt was stored");

    // The genuine request answers to its own one-time key; the forged ones can't be answered at all.
    let gid = genuine["id"].as_str().unwrap();
    let asked = stored_request(&store, &ch, gid).unwrap();
    check_answerable(&asked, &[uni.public_key()], ts).unwrap();
    assert_eq!(asked.one_time_key, one_time.public_key());
    let wrap = seal_delivery(&f.me, &asked, "t176-dummy-mock", ts).unwrap();
    assert!(nostr::nips::nip44::decrypt(theirs.secret_key(), &wrap.pubkey, &wrap.content).is_err());
    assert!(nostr::nips::nip44::decrypt(one_time.secret_key(), &wrap.pubkey, &wrap.content).is_ok());
    assert!(stored_request(&store, &ch, relabelled["id"].as_str().unwrap()).is_err());

    // Live: a forged request pushed after EOSE is dropped too.
    let store = Store::open_in_memory().unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let (stop_tx, stop_rx) = watch::channel(false);
    let (url, me, store_ref) = (f.url.clone(), f.me.clone(), &store);
    let runner = async move { run_live(live_cfg(&url), &me, None, store_ref, tx, stop_rx).await };
    let driver = async {
        let mut seen = Vec::new();
        for _ in 0..2 {
            assert!(wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(e, LiveEvent::Eose { .. })).await);
        }
        let late = forge_as_uni(signed(&relay_op, 9, vec![h(f.ch_a)], &request(&theirs, &"3".repeat(32)), ts + 10));
        f.relay.publish(late.clone());
        f.relay.publish(signed(&f.other, 9, vec![h(f.ch_a)], "after the forgery", ts + 11));
        assert!(
            wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(
                e, LiveEvent::Message { item, .. } if item.body == "after the forgery"))
            .await
        );
        assert!(store.message(&ch, late["id"].as_str().unwrap()).unwrap().is_none());
        assert!(!seen.iter().any(|e| matches!(e, LiveEvent::Message { item, .. } if parse_request(&item.body).is_some() && item.r#ref != gid)));
        stop_tx.send(true).unwrap();
    };
    let (res, ()) = tokio::join!(runner, driver);
    res.unwrap();
}

/// T-234: what the relay holds that carries the enrollment tag.
/// (by the fixture's `me`; the look-alikes another member posts are not counted)
fn enrollments(relay: &MockRelay) -> Vec<Value> {
    let me = relay.members.iter().next().unwrap().clone();
    relay.events.lock().unwrap().iter().filter(|e| tag_values(e, "t") == vec![uni_core::sealed::ENROLL_TAG] && e["pubkey"] == me).cloned().collect()
}

/// T-234: enabling approvals through the app's own path (`sealed::enroll`): signed by the synthetic identity, put
/// only into a room the trusted Uni (`other` here) is in, and published once. The relay's copy is checked field by
/// field, as Uni's broker reads it.
#[tokio::test]
async fn enrollment_is_signed_routed_and_published_once() {
    use uni_core::sealed;
    let f = fixture().await;
    let store = Store::open_in_memory().unwrap();
    sync_once(&f.url, &f.me, None, &store).await.unwrap();
    let uni = f.other.public_key();
    let dir = tempfile::tempdir().unwrap();
    let now = nostr::Timestamp::now().as_secs();

    // The status offers only the room Uni is in.
    let st = sealed::status(&f.me, &uni, &store, dir.path()).unwrap();
    assert_eq!(st.rooms.iter().map(|r| r.id.clone()).collect::<Vec<_>>(), vec![f.ch_a.to_string()]);
    assert!(st.enrolled.is_none());

    // A room without Uni is refused before anything is signed or sent.
    let err = sealed::enroll(&f.url, &f.me, None, &store, f.ch_b, &uni, dir.path(), now).await.unwrap_err();
    assert!(err.to_string().contains("isn't a member"), "{err}");
    assert!(enrollments(&f.relay).is_empty());
    assert!(!dir.path().join(sealed::PENDING_FILE).exists());

    // The relay can't be reached: an error, nothing recorded.
    let dead = { let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap(); format!("ws://{}", l.local_addr().unwrap()) };
    assert!(sealed::enroll(&dead, &f.me, None, &store, f.ch_a, &uni, dir.path(), now).await.is_err());
    assert!(sealed::status(&f.me, &uni, &store, dir.path()).unwrap().enrolled.is_none());

    let record = sealed::enroll(&f.url, &f.me, None, &store, f.ch_a, &uni, dir.path(), now).await.unwrap();
    let on_relay = enrollments(&f.relay);
    assert_eq!(on_relay.len(), 1);
    let ev = &on_relay[0];
    assert_eq!(record.event_id, ev["id"].as_str().unwrap());
    assert!(!dir.path().join(sealed::PENDING_FILE).exists(), "the pending event goes once recorded");

    // What the broker gets: kind 9 in Uni's room, signed by this identity, the documented fields, no mention of Uni.
    let parsed: nostr::Event = serde_json::from_value(ev.clone()).unwrap();
    parsed.verify().unwrap();
    assert_eq!(ev["kind"], 9);
    assert_eq!(ev["pubkey"], f.me.public_key().to_hex());
    assert_eq!(tag_values(ev, "h"), vec![f.ch_a.to_string().as_str()]);
    assert_eq!(tag_values(ev, "p"), vec![f.me.public_key().to_hex().as_str()]);
    let seal_pub = sealed::derive_seal_key(&f.me).unwrap().public_key().to_hex();
    let content: Value = serde_json::from_str(ev["content"].as_str().unwrap()).unwrap();
    assert_eq!(content, json!({"v": 1, "seal_pub": seal_pub, "for": uni.to_hex()}));
    assert_eq!(sealed::verify_enrollment(&parsed, &f.me.public_key(), &uni).unwrap().seal_pub, seal_pub);
    assert!(!ev.to_string().contains(&f.me.secret_key().to_secret_hex()));
    assert_eq!(
        (record.identity.as_str(), record.uni.as_str(), record.seal_pub.as_str(), record.channel.as_str()),
        (f.me.public_key().to_hex().as_str(), uni.to_hex().as_str(), seal_pub.as_str(), f.ch_a.to_string().as_str())
    );

    // Cross-check (run by hand): `T234_ENROLLMENT_OUT=<file>` writes this synthetic run's event and keys for the
    // uni-ops reference broker (`sealed enroll`) and `app_sim`, which must accept it and derive the same key.
    if let Ok(out) = std::env::var("T234_ENROLLMENT_OUT") {
        let dump = json!({"event": ev, "me_sk": f.me.secret_key().to_secret_hex(), "uni_sk": f.other.secret_key().to_secret_hex()});
        std::fs::write(out, dump.to_string()).unwrap();
    }

    // The room's line is drawn only from a kept, verified enrollment for this Uni.
    assert_eq!(sealed::stored_enrollment(&store, &f.ch_a.to_string(), &record.event_id, &uni).unwrap(), Some(f.me.public_key().to_hex()));
    assert_eq!(sealed::stored_enrollment(&store, &f.ch_a.to_string(), &record.event_id, &f.me.public_key()).unwrap(), None);
    assert_eq!(sealed::stored_enrollment(&store, &f.ch_b.to_string(), &record.event_id, &uni).unwrap(), None);
    // a member's look-alike body (no tag) and a tagged one for another key are ordinary messages
    let body = ev["content"].as_str().unwrap();
    let lookalike = signed(&f.other, 9, vec![h(f.ch_a), p(&f.other)], body, now);
    let wrong_uni = signed(&f.other, 9, vec![h(f.ch_a), p(&f.other), named("t", sealed::ENROLL_TAG)],
        &json!({"v": 1, "seal_pub": seal_pub, "for": f.other.public_key().to_hex().replace('a', "b")}).to_string(), now);
    for fake in [lookalike, wrong_uni] {
        f.relay.publish(fake.clone());
        sync_once(&f.url, &f.me, None, &store).await.unwrap();
        let id = fake["id"].as_str().unwrap();
        assert!(store.message(&f.ch_a.to_string(), id).unwrap().is_some());
        assert_eq!(sealed::stored_enrollment(&store, &f.ch_a.to_string(), id, &uni).unwrap(), None);
    }

    // Enable again (a second tap, a restart): the record answers, nothing new is published.
    let again = sealed::enroll(&f.url, &f.me, None, &store, f.ch_a, &uni, dir.path(), now + 60).await.unwrap();
    assert_eq!(again, record);
    assert_eq!(enrollments(&f.relay).len(), 1);
    assert_eq!(sealed::status(&f.me, &uni, &store, dir.path()).unwrap().enrolled, Some(record));
}

/// T-234: the relay stored the enrollment but its OK never came back. The retry finds it by id and records it; it
/// isn't signed or sent again. The same when the relay had it but this device couldn't write its record.
#[tokio::test]
async fn a_lost_ok_or_a_failed_record_never_makes_a_second_enrollment() {
    use uni_core::sealed;
    let f = fixture().await;
    let store = Store::open_in_memory().unwrap();
    sync_once(&f.url, &f.me, None, &store).await.unwrap();
    let uni = f.other.public_key();
    let now = nostr::Timestamp::now().as_secs();

    let dir = tempfile::tempdir().unwrap();
    f.relay.drop_next_ok.store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(sealed::enroll(&f.url, &f.me, None, &store, f.ch_a, &uni, dir.path(), now).await.is_err());
    assert_eq!(enrollments(&f.relay).len(), 1, "the relay has it");
    assert!(sealed::status(&f.me, &uni, &store, dir.path()).unwrap().enrolled.is_none());
    // much later, after a restart (only the files remain)
    let record = sealed::enroll(&f.url, &f.me, None, &store, f.ch_a, &uni, dir.path(), now + 3600).await.unwrap();
    assert_eq!(enrollments(&f.relay).len(), 1);
    assert_eq!(record.event_id, enrollments(&f.relay)[0]["id"].as_str().unwrap());

    // The relay takes it but the record can't be written: an error that says Uni has it, and the retry records the
    // same event.
    let dir = tempfile::tempdir().unwrap();
    let f2 = fixture().await;
    let store2 = Store::open_in_memory().unwrap();
    sync_once(&f2.url, &f2.me, None, &store2).await.unwrap();
    let uni2 = f2.other.public_key();
    std::fs::create_dir(dir.path().join(sealed::RECORD_FILE)).unwrap(); // a folder where the file goes: rename fails
    let err = sealed::enroll(&f2.url, &f2.me, None, &store2, f2.ch_a, &uni2, dir.path(), now).await.unwrap_err();
    assert!(err.to_string().contains("Uni has the enrollment"), "{err}");
    assert!(dir.path().join(sealed::PENDING_FILE).exists());
    std::fs::remove_dir(dir.path().join(sealed::RECORD_FILE)).unwrap();
    let record = sealed::enroll(&f2.url, &f2.me, None, &store2, f2.ch_a, &uni2, dir.path(), now + 30).await.unwrap();
    assert_eq!(enrollments(&f2.relay).len(), 1);
    assert_eq!(record.event_id, enrollments(&f2.relay)[0]["id"].as_str().unwrap());
}

/// T-234: refused by the relay, the retry sends the very same event while it is young; an old one is signed afresh.
#[tokio::test]
async fn a_refused_enrollment_is_resent_as_the_same_event_while_young() {
    use uni_core::sealed;
    let f = fixture().await;
    let store = Store::open_in_memory().unwrap();
    sync_once(&f.url, &f.me, None, &store).await.unwrap();
    let uni = f.other.public_key();
    let now = nostr::Timestamp::now().as_secs();
    let pending_id = |dir: &std::path::Path| -> String {
        let ev: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(sealed::PENDING_FILE)).unwrap()).unwrap();
        ev["id"].as_str().unwrap().to_string()
    };

    let dir = tempfile::tempdir().unwrap();
    f.relay.reject_next.store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(sealed::enroll(&f.url, &f.me, None, &store, f.ch_a, &uni, dir.path(), now).await.is_err());
    assert!(enrollments(&f.relay).is_empty());
    let first = pending_id(dir.path());
    let record = sealed::enroll(&f.url, &f.me, None, &store, f.ch_a, &uni, dir.path(), now + 30).await.unwrap();
    assert_eq!(record.event_id, first, "the same event");

    // (another second: at `now` this identity's event is the one already on the relay, same id)
    let (dir, later) = (tempfile::tempdir().unwrap(), now + 100);
    f.relay.reject_next.store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(sealed::enroll(&f.url, &f.me, None, &store, f.ch_a, &uni, dir.path(), later).await.is_err());
    let old = pending_id(dir.path());
    let record = sealed::enroll(&f.url, &f.me, None, &store, f.ch_a, &uni, dir.path(), later + sealed::RETRY_SAME_EVENT_SECS + 1).await.unwrap();
    assert_ne!(record.event_id, old, "too old for the relay: signed afresh");
}

/// T-234: a relay that refuses the lookup by id doesn't lock Try again out: the young event is resent, same id.
#[tokio::test]
async fn a_refused_lookup_still_lets_try_again_post_the_same_event() {
    use uni_core::sealed;
    let f = fixture().await;
    let store = Store::open_in_memory().unwrap();
    sync_once(&f.url, &f.me, None, &store).await.unwrap();
    let uni = f.other.public_key();
    let now = nostr::Timestamp::now().as_secs();
    let dir = tempfile::tempdir().unwrap();
    f.relay.reject_next.store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(sealed::enroll(&f.url, &f.me, None, &store, f.ch_a, &uni, dir.path(), now).await.is_err());
    let ev: Value = serde_json::from_str(&std::fs::read_to_string(dir.path().join(sealed::PENDING_FILE)).unwrap()).unwrap();
    f.relay.close_id_lookups.store(true, std::sync::atomic::Ordering::SeqCst);
    let record = sealed::enroll(&f.url, &f.me, None, &store, f.ch_a, &uni, dir.path(), now + 30).await.unwrap();
    assert_eq!(record.event_id, ev["id"].as_str().unwrap());
    assert_eq!(enrollments(&f.relay).len(), 1);
}

/// T-234: two Enables at once (two windows, a remounted Settings) publish one enrollment, and both get its record.
#[tokio::test]
async fn concurrent_enables_publish_once() {
    use uni_core::sealed;
    let f = fixture().await;
    let store = Store::open_in_memory().unwrap();
    sync_once(&f.url, &f.me, None, &store).await.unwrap();
    let uni = f.other.public_key();
    let dir = tempfile::tempdir().unwrap();
    let now = nostr::Timestamp::now().as_secs();
    let store2 = Store::open_in_memory().unwrap();
    sync_once(&f.url, &f.me, None, &store2).await.unwrap();
    let (a, b) = tokio::join!(
        sealed::enroll(&f.url, &f.me, None, &store, f.ch_a, &uni, dir.path(), now),
        sealed::enroll(&f.url, &f.me, None, &store2, f.ch_a, &uni, dir.path(), now + 1),
    );
    assert_eq!(a.unwrap(), b.unwrap());
    assert_eq!(enrollments(&f.relay).len(), 1);
}

/// T-234: the cache says Uni is in the room, the relay's roster now says it isn't: refused, nothing sent.
#[tokio::test]
async fn enrollment_checks_the_relays_roster_not_the_cache() {
    use uni_core::sealed;
    let f = fixture().await;
    let store = Store::open_in_memory().unwrap();
    sync_once(&f.url, &f.me, None, &store).await.unwrap();
    let uni = f.other.public_key();
    let dir = tempfile::tempdir().unwrap();
    f.relay.publish(signed(&f.relay_keys, 39002, vec![d(f.ch_a), p(&f.me)], "", 2));
    assert!(sealed::status(&f.me, &uni, &store, dir.path()).unwrap().rooms.iter().any(|r| r.id == f.ch_a.to_string()));
    let err = sealed::enroll(&f.url, &f.me, None, &store, f.ch_a, &uni, dir.path(), nostr::Timestamp::now().as_secs()).await.unwrap_err();
    assert!(err.to_string().contains("isn't a member"), "{err}");
    assert!(enrollments(&f.relay).is_empty());
}

/// T-234 cards: a card as the broker builds it (uni-ops `sealed.py` `_fields`): the data key sealed to `seal_pub`.
fn sealed_fields(seal_pub: &nostr::PublicKey, credential: &str, class: &str, action: &str, payload: Value, ttl_s: u64, expires: u64) -> (Value, Keys) {
    use nostr::nips::nip44;
    let one_time = Keys::generate();
    let esk = Keys::generate();
    let ct = format!("{:0>64}", credential.len());
    let inner = json!({"v": 1, "name": credential, "class": class, "dek": "5a".repeat(32), "ct_sha256": ct}).to_string();
    let dek_box = nip44::encrypt(esk.secret_key(), seal_pub, inner, nip44::Version::V2).unwrap();
    let f = json!({
        "v": 1, "rid": &Keys::generate().public_key().to_hex()[..32], "action": action, "credential": credential, "class": class,
        "scope": format!("Synthetic {action} for the test"), "ttl_s": ttl_s, "uses": 1,
        "payload_digest": uni_core::sealed_card::payload_digest(action, &payload).unwrap(), "payload": payload, "expires": expires,
        "rpk": one_time.public_key().to_hex(), "box": {"epk": esk.public_key().to_hex(), "dek_box": dek_box, "ct_sha256": ct},
    });
    (f, one_time)
}

fn wraps(relay: &MockRelay) -> Vec<Value> {
    relay.events.lock().unwrap().iter().filter(|e| e["kind"] == 1059).cloned().collect()
}

/// One card to answer: the event, the tap, and what must happen (None: answered; Some: the card's refusal line).
struct CardCase {
    event: Value,
    decision: uni_core::sealed_card::Decision,
    rids: Vec<String>,
    expect: Option<String>,
}

/// T-234: Uni's cards answered through the app's own path (`sealed_card::answer`) against the mock relay: each request
/// gets exactly one wrap, `p`-tagged to Uni, whatever the taps; a second tap sends nothing; a different second answer
/// is refused; a card repeating an answered request is refused and sends nothing; refused cards send nothing.
///
/// Cross-check (run by `research/t234-sealed-creds/app/cards_crosscheck.py`): `T234_CARDS_IN=<file>` brings the
/// synthetic keys, the room and the cards the reference broker made; `T234_CARDS_OUT=<file>` gets the wraps the relay
/// took, for that broker's `on_wrap`.
#[tokio::test]
async fn sealed_cards_are_answered_once_through_the_relay() {
    use uni_core::sealed_card::{self as card, Decision};
    let input: Option<Value> = std::env::var("T234_CARDS_IN").ok().map(|p| serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap());
    let key = |v: &Value, k: &str| Keys::new(nostr::SecretKey::from_hex(v[k].as_str().unwrap()).unwrap());
    let (me, uni, room) = match &input {
        Some(v) => (key(v, "me_sk"), key(v, "uni_sk"), v["channel"].as_str().unwrap().parse().unwrap()),
        None => (Keys::generate(), Keys::generate(), Uuid::new_v4()),
    };
    let f = fixture_with(me, uni, room).await;
    let uni = f.other.public_key();
    let now = nostr::Timestamp::now().as_secs();
    let seal_pub = uni_core::sealed::derive_seal_key(&f.me).unwrap().public_key();
    let decision = |s: &str| if s == "deny" { Decision::Deny } else { Decision::Approve };

    let cases: Vec<CardCase> = match &input {
        Some(v) => v["cards"].as_array().unwrap().iter().map(|c| CardCase {
            event: c["event"].clone(),
            decision: decision(c["decision"].as_str().unwrap()),
            rids: c["rids"].as_array().unwrap().iter().map(|r| r.as_str().unwrap().to_string()).collect(),
            expect: c["expect"].as_str().map(str::to_string),
        }).collect(),
        None => {
            let post = |body: String| signed(&f.other, 9, vec![h(f.ch_a), p(&f.other)], &body, now);
            let single = |fl: &Value| post(format!("🔑 **Uni asks**\n\n```{}\n{}\n```", card::CARD_FENCE, fl));
            let (dns, _) = sealed_fields(&seal_pub, "dns-zone", "powerful", "dns.edit", json!({"name": "demo", "zone": "example.org"}), 600, now + 900);
            let (pages, _) = sealed_fields(&seal_pub, "pages-deploy", "routine", "deploy.pages", json!({"files": 3}), 3600, now + 900);
            let (mint, _) = sealed_fields(&seal_pub, "cf-parent", "powerful", "mint.cloudflare",
                json!({"v": 1, "template": "r2-read", "bucket": "example-bucket", "child_ttl_s": null, "purpose": "backups", "destination": "sealed:r2-backups", "then": "seal"}), 60, now + 900);
            let rows: Vec<Value> = ["r2-a", "r2-b", "r2-c"].iter()
                .map(|n| sealed_fields(&seal_pub, n, "routine", "r2.list", Value::Null, 50_400, now + 3600).0).collect();
            let morning = post(format!("🔑 **Uni's morning card**\n\n```{}\n{}\n```", card::MORNING_FENCE, json!({"v": 1, "rows": rows})));
            let rid = |fl: &Value| fl["rid"].as_str().unwrap().to_string();
            // the dns request again under a new card (Uni signed it again, or a relay re-serves it): a replay
            let replay = post(format!("again\n\n```{}\n{}\n```", card::CARD_FENCE, dns));
            let expired = sealed_fields(&seal_pub, "late", "routine", "r2.list", Value::Null, 60, now - 1).0;
            let forged = signed(&f.me, 9, vec![h(f.ch_a), p(&f.me)], &format!("```{}\n{}\n```", card::CARD_FENCE, pages), now);
            vec![
                CardCase { event: single(&dns), decision: Decision::Approve, rids: vec![rid(&dns)], expect: None },
                CardCase { event: single(&pages), decision: Decision::Deny, rids: vec![rid(&pages)], expect: None },
                CardCase { event: single(&mint), decision: Decision::Approve, rids: vec![rid(&mint)], expect: None },
                CardCase { event: morning, decision: Decision::Approve, rids: vec![rid(&rows[0]), rid(&rows[2])], expect: None },
                CardCase { event: replay, decision: Decision::Approve, rids: vec![rid(&dns)], expect: Some("This card repeats a request that was already answered.".into()) },
                CardCase { event: single(&expired), decision: Decision::Approve, rids: vec![rid(&expired)], expect: Some("This card has expired.".into()) },
                CardCase { event: forged, decision: Decision::Approve, rids: vec![rid(&pages)], expect: Some("Not signed by Uni.".into()) },
            ]
        }
    };
    for c in &cases {
        f.relay.publish(c.event.clone());
    }
    let store = Store::open_in_memory().unwrap();
    sync_once(&f.url, &f.me, None, &store).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let room = f.ch_a.to_string();
    let seal = uni_core::sealed::derive_seal_key(&f.me).unwrap();
    let mut out = Vec::new();

    // Needs you lists exactly the cards that can be answered now
    let mut answerable: Vec<String> = cases.iter().filter(|c| c.expect.is_none()).map(|c| c.event["id"].as_str().unwrap().to_string()).collect();
    let listed = card::waiting(&store, &f.me.public_key().to_hex(), &uni, &seal, &card::Answers::default(), now).unwrap();
    let mut listed_ids: Vec<String> = listed.iter().map(|w| w.reference.clone()).collect();
    listed_ids.retain(|id| !cases.iter().any(|c| c.event["id"] == *id && c.expect.as_deref() == Some("This card repeats a request that was already answered.")));
    listed_ids.sort();
    answerable.sort();
    assert_eq!(listed_ids, answerable);

    for c in &cases {
        let id = c.event["id"].as_str().unwrap();
        let before = wraps(&f.relay).len();
        let answers = card::Answers::load(dir.path()).unwrap();
        let ev = card::stored_card(&store, &room, id);
        if let Some(why) = &c.expect {
            if let Ok(ev) = &ev {
                assert_eq!(card::view(ev, &uni, &seal, &answers, now).refused.as_deref(), Some(why.as_str()), "{id}");
                let err = card::answer(&f.url, &f.me, None, ev, &uni, c.decision, &c.rids, dir.path(), now).await.unwrap_err();
                assert!(err.to_string().ends_with(why.as_str()), "{err}");
            }
            assert_eq!(wraps(&f.relay).len(), before, "a refused card sends nothing");
            continue;
        }
        let ev = ev.unwrap();
        let v = card::view(&ev, &uni, &seal, &answers, now);
        assert_eq!(v.refused, None, "{id}");
        let got = card::answer(&f.url, &f.me, None, &ev, &uni, c.decision, &c.rids, dir.path(), now).await.unwrap();
        assert_eq!(got.len(), c.rids.len());
        assert!(got.iter().all(|a| a.sent && a.wrap.is_none() && a.decision == c.decision));
        let new: Vec<Value> = wraps(&f.relay)[before..].to_vec();
        assert_eq!(new.len(), c.rids.len(), "one wrap per request");
        for w in &new {
            assert_eq!(tag_values(w, "p"), vec![uni.to_hex().as_str()]);
            assert!(!w.to_string().contains(&"5a".repeat(32)), "the data key is only inside the encryption");
            out.push(json!({"card": id, "wrap": w}));
        }
        // a second tap (a double press, a reload): nothing new goes out
        card::answer(&f.url, &f.me, None, &ev, &uni, c.decision, &c.rids, dir.path(), now + 1).await.unwrap();
        assert_eq!(wraps(&f.relay).len(), before + c.rids.len());
        // the other decision, or another row of the card: refused, nothing sent
        let other = if c.decision == Decision::Approve { Decision::Deny } else { Decision::Approve };
        assert!(card::answer(&f.url, &f.me, None, &ev, &uni, other, &c.rids, dir.path(), now + 2).await.is_err());
        let v = card::view(&ev, &uni, &seal, &card::Answers::load(dir.path()).unwrap(), now);
        if v.rows.len() > c.rids.len() {
            let left: Vec<String> = v.rows.iter().filter(|r| r.answer.is_none()).map(|r| r.rid.clone()).collect();
            assert!(card::answer(&f.url, &f.me, None, &ev, &uni, c.decision, &left, dir.path(), now + 2).await.is_err());
        }
        assert_eq!(wraps(&f.relay).len(), before + c.rids.len());
        assert!(v.rows.iter().all(|r| r.answer.as_ref().map(|a| a.decision) == c.rids.contains(&r.rid).then_some(c.decision)));
        // answered: no longer waiting in Needs you
        let answers = card::Answers::load(dir.path()).unwrap();
        assert!(!card::waiting(&store, &f.me.public_key().to_hex(), &uni, &seal, &answers, now).unwrap().iter().any(|w| w.reference == id));
    }
    if let Ok(path) = std::env::var("T234_CARDS_OUT") {
        std::fs::write(path, json!({"wraps": out}).to_string()).unwrap();
    }
    // nothing secret was kept on disk: the answers file holds public facts only
    let kept = std::fs::read_to_string(dir.path().join(card::ANSWERS_FILE)).unwrap();
    assert!(!kept.contains(&"5a".repeat(32)) && !kept.contains(&f.me.secret_key().to_secret_hex()));
}

/// T-234 cards: the relay refuses the answer. Try again sends the very same wrap (the decision was kept before it
/// went out), and nothing else; a dead relay leaves the answer kept and unsent.
#[tokio::test]
async fn a_refused_answer_is_retried_as_the_same_wrap() {
    use uni_core::sealed_card::{self as card, Decision};
    let f = fixture().await;
    let uni = f.other.public_key();
    let now = nostr::Timestamp::now().as_secs();
    let seal_pub = uni_core::sealed::derive_seal_key(&f.me).unwrap().public_key();
    let (fl, _) = sealed_fields(&seal_pub, "dns-zone", "powerful", "dns.edit", json!({"name": "demo"}), 600, now + 900);
    let ev = signed(&f.other, 9, vec![h(f.ch_a), p(&f.other)], &format!("```{}\n{}\n```", card::CARD_FENCE, fl), now);
    f.relay.publish(ev.clone());
    let store = Store::open_in_memory().unwrap();
    sync_once(&f.url, &f.me, None, &store).await.unwrap();
    let ev = card::stored_card(&store, &f.ch_a.to_string(), ev["id"].as_str().unwrap()).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let rids = vec![fl["rid"].as_str().unwrap().to_string()];

    let dead = { let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap(); format!("ws://{}", l.local_addr().unwrap()) };
    assert!(card::answer(&dead, &f.me, None, &ev, &uni, Decision::Approve, &rids, dir.path(), now).await.is_err());
    let kept = card::Answers::load(dir.path()).unwrap();
    assert_eq!(kept.answers.len(), 1);
    assert!(!kept.answers[0].sent);
    let first: nostr::Event = serde_json::from_str(kept.answers[0].wrap.as_deref().unwrap()).unwrap();

    f.relay.reject_next.store(true, std::sync::atomic::Ordering::SeqCst);
    let err = card::answer(&f.url, &f.me, None, &ev, &uni, Decision::Approve, &rids, dir.path(), now + 5).await.unwrap_err();
    assert!(err.to_string().contains("rejected"), "{err}");
    assert!(wraps(&f.relay).is_empty());
    // changing one's mind after a failed send isn't possible: one request, one decision
    assert!(card::answer(&f.url, &f.me, None, &ev, &uni, Decision::Deny, &rids, dir.path(), now + 6).await.is_err());
    card::answer(&f.url, &f.me, None, &ev, &uni, Decision::Approve, &rids, dir.path(), now + 10).await.unwrap();
    let on_relay = wraps(&f.relay);
    assert_eq!(on_relay.len(), 1);
    assert_eq!(on_relay[0]["id"], first.id.to_hex(), "the same wrap");
    assert!(card::Answers::load(dir.path()).unwrap().answers[0].sent);
}
