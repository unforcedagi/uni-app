//! End-to-end test against an in-process mock Buzz relay.
//!
//! The mock speaks the subset of NIP-01/NIP-42 the relay uses (spec §2):
//! proactive `AUTH` challenge, `NOTICE auth-required` before auth, `OK` on
//! the kind-22242 AUTH event (rejecting pubkeys not in its member set with
//! `restricted: not a relay member`, exactly what `wss://buzz.unforced.org`
//! answers), then `EVENT`/`EOSE` for kind 39002/39000/9 REQs, and
//! `CLOSED restricted` for `#h` REQs on channels the pubkey is not a member of.

use std::collections::HashSet;

use futures_util::{SinkExt, StreamExt};
use nostr::{Keys, Kind, Tag};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

use uni_core::{sync_once, Store};

struct MockRelay {
    members: HashSet<String>,
    events: Vec<Value>,
    /// Channel uuids the members may read.
    member_channels: HashSet<String>,
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

async fn serve(listener: TcpListener, relay: std::sync::Arc<MockRelay>) {
    loop {
        let (stream, _) = listener.accept().await.unwrap();
        let relay = relay.clone();
        tokio::spawn(async move {
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            let challenge = Uuid::new_v4().to_string();
            ws.send(Message::Text(json!(["AUTH", challenge]).to_string().into()))
                .await
                .unwrap();
            let mut authed: Option<String> = None;
            while let Some(Ok(msg)) = ws.next().await {
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
                            (true, "")
                        };
                        ws.send(Message::Text(
                            json!(["OK", id, ok, reason]).to_string().into(),
                        ))
                        .await
                        .unwrap();
                    }
                    "REQ" => {
                        let sub = frame[1].as_str().unwrap();
                        if authed.is_none() {
                            ws.send(Message::Text(
                                json!(["NOTICE", "auth-required: authenticate before subscribing"])
                                    .to_string()
                                    .into(),
                            ))
                            .await
                            .unwrap();
                            continue;
                        }
                        let filters = &frame[2..];
                        // Channel-scoped REQ: enforce membership like the real relay.
                        for f in filters {
                            if let Some(hs) = f["#h"].as_array() {
                                for h in hs {
                                    if !relay.member_channels.contains(h.as_str().unwrap()) {
                                        ws.send(Message::Text(
                                            json!([
                                                "CLOSED",
                                                sub,
                                                "restricted: not a channel member"
                                            ])
                                            .to_string()
                                            .into(),
                                        ))
                                        .await
                                        .unwrap();
                                        continue;
                                    }
                                }
                            }
                        }
                        for ev in &relay.events {
                            if filters.iter().any(|f| matches(f, ev)) {
                                ws.send(Message::Text(
                                    json!(["EVENT", sub, ev]).to_string().into(),
                                ))
                                .await
                                .unwrap();
                            }
                        }
                        ws.send(Message::Text(json!(["EOSE", sub]).to_string().into()))
                            .await
                            .unwrap();
                    }
                    "CLOSE" => {}
                    _ => {}
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

#[tokio::test]
async fn sync_against_mock_relay() {
    let relay_keys = Keys::generate();
    let me = Keys::generate();
    let other = Keys::generate();
    let ch_a = Uuid::new_v4();
    let ch_b = Uuid::new_v4();
    let ch_archived = Uuid::new_v4();
    let ch_not_mine = Uuid::new_v4();

    let d = |u: Uuid| vec!["d".to_string(), u.to_string()];
    let h = |u: Uuid| vec!["h".to_string(), u.to_string()];
    let p = |k: &Keys| vec!["p".to_string(), k.public_key().to_hex()];
    let me_hex = me.public_key().to_hex();

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
            vec![
                d(ch_a),
                vec!["name".into(), "Uni".into()],
                vec!["about".into(), "core".into()],
            ],
            "",
            1,
        ),
        signed(
            &relay_keys,
            39000,
            vec![d(ch_b), vec!["name".into(), "heartbeat".into()]],
            "",
            1,
        ),
        signed(
            &relay_keys,
            39000,
            vec![
                d(ch_archived),
                vec!["name".into(), "old".into()],
                vec!["archived".into(), "true".into()],
            ],
            "",
            1,
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

    let relay = std::sync::Arc::new(MockRelay {
        members: [me_hex.clone()].into_iter().collect(),
        member_channels: [ch_a, ch_b, ch_archived]
            .iter()
            .map(|u| u.to_string())
            .collect(),
        events,
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    tokio::spawn(serve(listener, relay));

    // 1. Unknown pubkey is rejected at AUTH (matches the real relay's answer).
    let stranger = Keys::generate();
    let store = Store::open_in_memory().unwrap();
    let err = sync_once(&url, &stranger, None, &store).await.unwrap_err();
    assert!(
        err.to_string().contains("restricted: not a relay member"),
        "got: {err}"
    );

    // 2. Member: discovery + history + store.
    let store = Store::open_in_memory().unwrap();
    let report = sync_once(&url, &me, None, &store).await.unwrap();
    assert_eq!(report.pubkey, me_hex);
    assert_eq!(
        report.channels.len(),
        2,
        "archived channel dropped: {:?}",
        report.channels
    );
    assert_eq!(report.channels[&ch_a.to_string()].as_deref(), Some("Uni"));
    assert_eq!(
        report.channels[&ch_b.to_string()].as_deref(),
        Some("heartbeat")
    );
    assert!(
        report.channel_errors.is_empty(),
        "{:?}",
        report.channel_errors
    );
    assert_eq!(report.fetched[&ch_a.to_string()], 3);
    assert_eq!(report.inserted[&ch_a.to_string()], 3);
    assert_eq!(report.fetched[&ch_b.to_string()], 1);
    assert_eq!(report.total_items, 4);

    let counts = store.count_by_channel("buzz").unwrap();
    let mut expected = vec![(ch_a.to_string(), 3), (ch_b.to_string(), 1)];
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
    assert_eq!(store.since_for(&ch_a.to_string()).unwrap(), Some(102));
    assert_eq!(store.since_for(&ch_b.to_string()).unwrap(), Some(200));

    // 3. Second run is incremental and idempotent.
    let report2 = sync_once(&url, &me, None, &store).await.unwrap();
    assert_eq!(report2.inserted.values().sum::<usize>(), 0);
    assert_eq!(report2.total_items, 4);
    // `since` is inclusive per NIP-01, so exactly the watermark event is re-fetched.
    assert_eq!(report2.fetched[&ch_a.to_string()], 1);
}
