//! T-282 (Codex confirm review 2r8bmvox, P1): a login value whose send is held up must not reach someone who joins
//! the room meanwhile.
//!
//! The scenario the review names: the room is checked, the value is handed on, its transmission fails for a while,
//! and in that time a third person is invited and joins. matrix-sdk's send queue encrypts again on every retry, for
//! whoever is in the room then, so a queued value would be readable by the newcomer once the retry goes through.
//!
//! A real homeserver (continuwuity, see common/), skipped where it isn't installed, with a small HTTP gate between it
//! and the account under test that can refuse that account's sends into one room. `@signalbot` is an ordinary account
//! that joins whatever it is invited to; `@mallory` is a second, real Messages device (so a room key can reach her).
//! The value must never be readable on mallory's device, and nothing may be sent again by itself afterwards.

#![recursion_limit = "256"]

mod common;

use std::{
    collections::BTreeSet,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use axum::{
    body::Body,
    extract::{Request, State},
    http::{header, Method, StatusCode},
    response::{IntoResponse, Response},
    Router,
};
use common::{binary, esc, http, register, until};
use serde_json::json;
use uni_messages::{FileSecrets, Messages};

const SERVER: &str = "delayed.test.localhost";
const SECRET: &str = "+15550199";

fn uid(name: &str) -> String {
    format!("@{name}:{SERVER}")
}

/// Between the account under test and the homeserver: passes everything through, except that while a room is
/// blocked, the account's sends into it are refused (502), as a failing network would.
#[derive(Clone)]
struct Gate {
    upstream: String,
    client: matrix_sdk::reqwest::Client,
    blocked: Arc<Mutex<Option<String>>>,
    refused: Arc<AtomicUsize>,
}

async fn pass(State(g): State<Gate>, req: Request) -> Response {
    let method = req.method().clone();
    let path = req.uri().path_and_query().map(|p| p.to_string()).unwrap_or_default();
    let headers = req.headers().clone();
    let body = axum::body::to_bytes(req.into_body(), usize::MAX).await.unwrap_or_default();
    let blocked = g.blocked.lock().unwrap().clone();
    if let Some(room) = blocked {
        let id = room.trim_start_matches('!').split(':').next().unwrap_or_default().to_owned();
        if method == Method::PUT && path.contains("/send/") && path.contains(&id) {
            g.refused.fetch_add(1, Ordering::SeqCst);
            return (StatusCode::BAD_GATEWAY, "{\"errcode\":\"M_UNKNOWN\",\"error\":\"held by the test\"}").into_response();
        }
    }
    let mut out = g.client.request(method, format!("{}{}", g.upstream, path));
    for (k, v) in headers.iter() {
        if k != header::HOST && k != header::CONTENT_LENGTH {
            out = out.header(k, v);
        }
    }
    let Ok(answer) = out.body(body).send().await else { return StatusCode::BAD_GATEWAY.into_response() };
    let status = answer.status();
    let mut r = Response::builder().status(status);
    for (k, v) in answer.headers().iter() {
        if k != header::CONTENT_LENGTH && k != header::TRANSFER_ENCODING && k != header::CONNECTION {
            r = r.header(k, v);
        }
    }
    let bytes = answer.bytes().await.unwrap_or_default();
    r.body(Body::from(bytes)).unwrap()
}

async fn start_gate(upstream: String) -> (Gate, String) {
    let gate = Gate {
        upstream,
        client: matrix_sdk::reqwest::Client::builder().build().unwrap(),
        blocked: Arc::new(Mutex::new(None)),
        refused: Arc::new(AtomicUsize::new(0)),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new().fallback(pass).with_state(gate.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (gate, url)
}

/// The bot: joins every room it is invited to, as a running bridge does.
fn bot_joins_invites(port: u16, token: String) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut since = String::new();
        loop {
            let path = if since.is_empty() { "/_matrix/client/v3/sync?timeout=0".to_owned() } else { format!("/_matrix/client/v3/sync?timeout=0&since={since}") };
            if let Some((200, body)) = http(port, "GET", &path, None, Some(&token)).await {
                since = body["next_batch"].as_str().unwrap_or_default().to_owned();
                for room in body["rooms"]["invite"].as_object().into_iter().flat_map(|o| o.keys().cloned().collect::<Vec<_>>()) {
                    http(port, "POST", &format!("/_matrix/client/v3/join/{}", esc(&room)), Some(json!({})), Some(&token)).await;
                }
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    })
}

async fn joined_members(port: u16, token: &str, room: &str) -> BTreeSet<String> {
    let (_, m) = http(port, "GET", &format!("/_matrix/client/v3/rooms/{}/joined_members", esc(room)), None, Some(token)).await.unwrap();
    m["joined"].as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default()
}

async fn joined_rooms(port: u16, token: &str) -> Vec<String> {
    let (_, r) = http(port, "GET", "/_matrix/client/v3/joined_rooms", None, Some(token)).await.unwrap();
    r["joined_rooms"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_owned)).collect()
}

/// Message events (plain or encrypted) wren sent in `room`.
async fn sent_by_wren(port: u16, token: &str, room: &str) -> usize {
    let (_, page) = http(port, "GET", &format!("/_matrix/client/v3/rooms/{}/messages?dir=b&limit=100", esc(room)), None, Some(token)).await.unwrap();
    page["chunk"].as_array().into_iter().flatten().filter(|e| e["sender"] == uid("wren").as_str() && (e["type"] == "m.room.message" || e["type"] == "m.room.encrypted")).count()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_held_up_login_value_never_reaches_someone_who_joins_meanwhile() {
    let Some(bin) = binary() else {
        eprintln!("skipped: no continuwuity binary (set UNI_TEST_CONTINUWUITY)");
        return;
    };
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_owned();
    let hs = common::start(bin, &dir, SERVER).await;
    let port = hs.port;
    let wren = register(&hs, "wren", true).await;
    let bot = register(&hs, "signalbot", false).await;
    let mallory = register(&hs, "mallory", false).await;
    http(port, "PUT", &format!("/_matrix/client/v3/profile/{}/displayname", esc(&uid("signalbot"))), Some(json!({ "displayname": "Signal bridge" })), Some(&bot)).await;
    let bot_task = bot_joins_invites(port, bot.clone());
    let (gate, gate_url) = start_gate(hs.url()).await;

    // wren, as the app runs it, behind the gate; mallory, a real device of her own
    let m = Messages::new(dir.join("wren/data"), Arc::new(FileSecrets::new(dir.join("wren/secrets"))));
    m.sign_in(&gate_url, "wren", "pw-0123456789").await.unwrap();
    let mm = Messages::new(dir.join("mallory/data"), Arc::new(FileSecrets::new(dir.join("mallory/secrets"))));
    mm.sign_in(&hs.url(), "mallory", "pw-0123456789").await.unwrap();
    until(30, "both syncs are live", || {
        let (m, mm) = (m.clone(), mm.clone());
        async move { m.status().state == "live" && mm.status().state == "live" }
    })
    .await;

    // the Signal card's first step makes the room with the bot
    m.link_start("signal", None, None).await.unwrap();
    let mut room = String::new();
    for _ in 0..60 {
        for r in joined_rooms(port, &wren).await {
            if joined_members(port, &wren, &r).await == BTreeSet::from([uid("wren"), uid("signalbot")]) {
                room = r;
            }
        }
        if !room.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert!(!room.is_empty(), "no room with just wren and the bot");
    tokio::time::sleep(Duration::from_secs(2)).await;

    // the value's transmission fails for a while
    *gate.blocked.lock().unwrap() = Some(room.clone());
    let sent = m.link_send("signal", SECRET).await;
    until(30, "the send was tried and held", || {
        let refused = gate.refused.clone();
        async move { refused.load(Ordering::SeqCst) > 0 }
    })
    .await;
    let before = sent_by_wren(port, &wren, &room).await;

    // meanwhile a third person is invited and joins
    let (status, r) = http(port, "POST", &format!("/_matrix/client/v3/rooms/{}/invite", esc(&room)), Some(json!({ "user_id": uid("mallory") })), Some(&wren)).await.unwrap();
    assert_eq!(status, 200, "{r}");
    let (status, r) = http(port, "POST", &format!("/_matrix/client/v3/join/{}", esc(&room)), Some(json!({})), Some(&mallory)).await.unwrap();
    assert_eq!(status, 200, "{r}");
    tokio::time::sleep(Duration::from_secs(8)).await;

    // the network comes back
    *gate.blocked.lock().unwrap() = None;
    let mut read = false;
    for _ in 0..60 {
        if let Ok(rows) = mm.open(&room).await {
            if rows.iter().any(|r| r.body.contains(SECRET)) {
                read = true;
                break;
            }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    if let Ok(rows) = mm.open(&room).await {
        for r in &rows {
            eprintln!("on mallory's device: {} {:?} {:?} {}", r.sender, r.kind, r.state, if r.body.contains(SECRET) { "THE VALUE" } else { "other" });
        }
    }
    assert!(!read, "the login value reached the person who joined while it was held up");

    // and nothing was sent again by itself: the value is dropped and the card asks for it again
    assert_eq!(sent_by_wren(port, &wren, &room).await, before, "something was sent again after the network came back");
    assert!(sent.is_err(), "a send that didn't go must say so, so the value is typed again: {sent:?}");

    bot_task.abort();
    m.shut_down().await;
    mm.shut_down().await;
}
