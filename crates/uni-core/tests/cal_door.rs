//! T-229: the calendar door client over real HTTP, against a door double that checks NIP-98 the way the mail bridge's
//! `verify_nip98` does (the door copies it): kind 27235, id, signature, a 120 s window, `u` equal to its public URL plus
//! the path with its query, `method`, and `payload` equal to the body's sha256 on every request (a GET's is the empty
//! body's), the allowlist, no replays. Each case first gets a request that passes, so a check removed turns it red.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use nostr::base64::engine::general_purpose::URL_SAFE_NO_PAD;
use nostr::base64::Engine as _;
use nostr::{Event, JsonUtil as _, Keys};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use uni_core::cal::{CalDoor, CalError};

#[derive(Default)]
struct Door {
    allow: HashSet<String>,
    seen: HashSet<String>,
    /// (method, path with query, body) of every request that passed.
    passed: Vec<(String, String, Value)>,
    /// Every request, passed or not.
    requests: usize,
    /// The note's revision: a write with another `base_rev` is stale.
    rev: i64,
}

struct Running {
    url: String,
    door: Arc<Mutex<Door>>,
}

async fn start(allow: &[&Keys]) -> Running {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let door = Arc::new(Mutex::new(Door { allow: allow.iter().map(|k| k.public_key().to_hex()).collect(), rev: 3, ..Default::default() }));
    let (d, public) = (door.clone(), url.clone());
    tokio::spawn(async move {
        while let Ok((sock, _)) = listener.accept().await {
            let (d, public) = (d.clone(), public.clone());
            tokio::spawn(async move { let _ = serve(sock, &d, &public).await; });
        }
    });
    Running { url, door }
}

async fn serve(mut sock: tokio::net::TcpStream, d: &Mutex<Door>, public: &str) -> std::io::Result<()> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let (head, body) = loop {
        let n = sock.read(&mut chunk).await?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..end]).to_string();
            let len: usize = head.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap_or(0))).unwrap_or(0);
            while buf.len() < end + 4 + len {
                let n = sock.read(&mut chunk).await?;
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            break (head, buf[end + 4..(end + 4 + len).min(buf.len())].to_vec());
        }
    };
    let mut lines = head.lines();
    let first = lines.next().unwrap_or("").to_string();
    let mut parts = first.split_whitespace();
    let (method, path) = (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("/").to_string());
    let auth = lines.find_map(|l| l.split_once(':').filter(|(k, _)| k.trim().eq_ignore_ascii_case("authorization")).map(|(_, v)| v.trim().to_string())).unwrap_or_default();
    let (status, out) = handle(d, public, &method, &path, &auth, &body);
    let headers = format!("HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", out.len());
    sock.write_all(headers.as_bytes()).await?;
    sock.write_all(out.as_bytes()).await?;
    sock.shutdown().await
}

fn handle(d: &Mutex<Door>, public: &str, method: &str, path: &str, auth: &str, body: &[u8]) -> (u16, String) {
    d.lock().unwrap().requests += 1;
    if let Err(e) = verify(d, auth, &format!("{public}{path}"), method, body) {
        return (401, json!({ "error": e }).to_string());
    }
    let parsed: Value = if body.is_empty() { Value::Null } else { serde_json::from_slice(body).unwrap_or(Value::Null) };
    let mut s = d.lock().unwrap();
    s.passed.push((method.to_string(), path.to_string(), parsed.clone()));
    let route = path.split('?').next().unwrap_or("");
    match (method, route) {
        ("GET", "/cal/v1/session") => (200, json!({ "role": "owner", "ops": ["create", "move"], "calendar": "aaron", "tz": "America/Denver" }).to_string()),
        ("GET", "/cal/v1/events") => (200, json!({ "complete": true, "instances": [] }).to_string()),
        ("GET", r) if r.starts_with("/cal/v1/event/") => (200, json!({ "id": &r[14..], "rev": s.rev }).to_string()),
        ("POST", "/cal/v1/op") => {
            if parsed["base_rev"].as_i64().is_some_and(|b| b != s.rev) {
                return (409, json!({ "error": "the event changed since it was read", "current_rev": s.rev }).to_string());
            }
            s.rev += 1;
            (200, json!({ "ok": true, "opId": parsed["opId"], "id": parsed["id"], "rev": s.rev }).to_string())
        }
        _ => (404, json!({ "error": "not found" }).to_string()),
    }
}

/// The mail bridge's `verify_nip98`, with the method check widened to the request's own (GET or POST).
fn verify(d: &Mutex<Door>, header: &str, url: &str, method: &str, body: &[u8]) -> Result<(), String> {
    let b64 = header.strip_prefix("Nostr ").ok_or("missing Nostr authorization")?;
    let raw = URL_SAFE_NO_PAD.decode(b64.trim_end_matches('=')).map_err(|_| "bad authorization encoding")?;
    let ev = Event::from_json(&raw).map_err(|_| "bad event id")?;
    if ev.kind.as_u16() != 27235 {
        return Err("wrong kind".into());
    }
    if !ev.verify_id() || !ev.verify_signature() {
        return Err("bad signature".into());
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    if (now - ev.created_at.as_secs() as i64).abs() > 120 {
        return Err("stale authorization".into());
    }
    let tag = |name: &str| ev.tags.iter().find_map(|t| (t.as_slice().first().map(String::as_str) == Some(name)).then(|| t.as_slice().get(1).cloned()).flatten());
    if tag("u").as_deref() != Some(url) || tag("method").map(|m| m.to_uppercase()).as_deref() != Some(method) {
        return Err("authorization is for a different request".into());
    }
    if tag("payload").as_deref() != Some(uni_core::media::sha256_hex(body).as_str()) {
        return Err("payload hash mismatch".into());
    }
    let mut s = d.lock().unwrap();
    if !s.allow.contains(&ev.pubkey.to_hex()) {
        return Err("pubkey not allowed".into());
    }
    if !s.seen.insert(ev.id.to_hex()) {
        return Err("replayed authorization".into());
    }
    Ok(())
}

#[tokio::test]
async fn reads_and_ops_are_signed_for_the_exact_request_and_pass_the_doors_checks() {
    let keys = Keys::generate();
    let door = start(&[&keys]).await;
    let client = CalDoor::new(&door.url, &keys).unwrap();
    assert_eq!(client.session().await.unwrap()["role"], "owner");
    // the query string is part of what is signed
    assert_eq!(client.events("2026-10-19T06:00:00Z", "2026-10-26T06:00:00Z").await.unwrap()["complete"], true);
    assert_eq!(client.event("fx-lunch").await.unwrap()["rev"], 3);
    let op = json!({ "op": "move", "opId": "app-0123456789abcdef01234567", "id": "fx-lunch", "base_rev": 3, "start": "2026-10-22T19:00:00Z", "end": "2026-10-22T20:00:00Z", "scope": "all" });
    assert_eq!(client.op(&op).await.unwrap()["rev"], 4);
    // two identical reads in one second are two requests, neither a replay
    client.session().await.unwrap();
    let s = door.door.lock().unwrap();
    assert_eq!(s.passed.iter().map(|(m, p, _)| format!("{m} {p}")).collect::<Vec<_>>(), [
        "GET /cal/v1/session",
        "GET /cal/v1/events?from=2026-10-19T06:00:00Z&to=2026-10-26T06:00:00Z",
        "GET /cal/v1/event/fx-lunch",
        "POST /cal/v1/op",
        "GET /cal/v1/session",
    ]);
    assert_eq!(s.passed[3].2, op);
}

#[tokio::test]
async fn a_key_the_door_does_not_take_is_not_allowed_and_names_the_key() {
    let (keys, other) = (Keys::generate(), Keys::generate());
    let door = start(&[&other]).await;
    match CalDoor::new(&door.url, &keys).unwrap().session().await {
        Err(CalError::NotAllowed { message, pubkey }) => {
            assert_eq!(message, "pubkey not allowed");
            assert_eq!(pubkey, keys.public_key().to_hex());
        }
        r => panic!("expected not_allowed, got {r:?}"),
    }
    // the allowed key passes the same door
    CalDoor::new(&door.url, &other).unwrap().session().await.unwrap();
}

#[tokio::test]
async fn a_write_on_an_old_revision_is_stale_with_the_revision_now() {
    let keys = Keys::generate();
    let door = start(&[&keys]).await;
    let client = CalDoor::new(&door.url, &keys).unwrap();
    let op = |rev: i64, id: &str| json!({ "op": "cancel", "opId": id, "id": "fx-lunch", "base_rev": rev, "scope": "all" });
    client.op(&op(3, "app-aaaaaaaaaaaaaaaa")).await.unwrap();
    match client.op(&op(3, "app-bbbbbbbbbbbbbbbb")).await {
        Err(CalError::Stale { current_rev, .. }) => assert_eq!(current_rev, Some(4)),
        r => panic!("expected stale, got {r:?}"),
    }
}

#[tokio::test]
async fn an_op_this_app_does_not_send_and_a_bad_bound_never_leave_the_device() {
    let keys = Keys::generate();
    let door = start(&[&keys]).await;
    let client = CalDoor::new(&door.url, &keys).unwrap();
    for bad in [json!({ "op": "sync/upsert", "opId": "app-aaaaaaaaaaaaaaaa" }), json!({ "op": "confirm_booking", "opId": "app-aaaaaaaaaaaaaaaa" }), json!({ "op": "move" })] {
        assert!(matches!(client.op(&bad).await, Err(CalError::Invalid { .. })), "{bad}");
    }
    assert!(matches!(client.events("2026-10-19T06:00:00Z&role=owner", "2026-10-26T06:00:00Z").await, Err(CalError::Invalid { .. })));
    assert!(matches!(client.event("../session").await, Err(CalError::Invalid { .. })));
    assert_eq!(door.door.lock().unwrap().requests, 0);
}

#[tokio::test]
async fn a_door_that_cannot_be_reached_is_unreachable() {
    let keys = Keys::generate();
    let port = TcpListener::bind(("127.0.0.1", 0)).await.unwrap().local_addr().unwrap().port(); // bound, then closed
    match CalDoor::new(&format!("http://127.0.0.1:{port}"), &keys).unwrap().session().await {
        Err(CalError::Unreachable { .. }) => {}
        r => panic!("expected unreachable, got {r:?}"),
    }
}
