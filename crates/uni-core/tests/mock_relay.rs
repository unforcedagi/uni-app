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

use uni_core::{run_live, sync_once, Backoff, LiveConfig, LiveEvent, Store};

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
        })
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
                                } else if !relay.members.contains(&pk) {
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
                                if let Some(reason) = closed {
                                    ws.send(Message::Text(json!(["CLOSED", sub, reason]).to_string().into()))
                                        .await
                                        .unwrap();
                                    continue;
                                }
                                let snapshot = relay.events.lock().unwrap().clone();
                                for ev in &snapshot {
                                    if filters.iter().any(|f| matches(f, ev)) {
                                        ws.send(Message::Text(json!(["EVENT", sub, ev]).to_string().into()))
                                            .await
                                            .unwrap();
                                    }
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
    let relay_keys = Keys::generate();
    let me = Keys::generate();
    let other = Keys::generate();
    let ch_a = Uuid::new_v4();
    let ch_b = Uuid::new_v4();
    let ch_archived = Uuid::new_v4();
    let ch_not_mine = Uuid::new_v4();

    let events = vec![
        // Membership (39002) — relay-signed, #p = me.
        signed(&relay_keys, 39002, vec![d(ch_a), p(&me)], "", 1),
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
    assert_eq!(report.fetched[&f.ch_a.to_string()], 3);
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
    assert_eq!(store.since_for(&f.ch_a.to_string()).unwrap(), Some(102));
    assert_eq!(store.since_for(&f.ch_b.to_string()).unwrap(), Some(200));

    // 3. Second run is incremental and idempotent.
    let report2 = sync_once(&f.url, &f.me, None, &store).await.unwrap();
    assert_eq!(report2.inserted.values().sum::<usize>(), 0);
    assert_eq!(report2.total_items, 4);
    // `since` is inclusive per NIP-01, so exactly the watermark event is re-fetched.
    assert_eq!(report2.fetched[&f.ch_a.to_string()], 1);
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
        assert!(
            wait_for(&mut rx, &mut seen, Duration::from_secs(5), |e| matches!(
                e,
                LiveEvent::Profiles { .. }
            ))
            .await,
            "{seen:?}"
        );
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
