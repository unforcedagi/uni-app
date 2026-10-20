//! A fake `uni-mail-bridge` (T-45) over real HTTP, for tests and the walkthrough.
//!
//! It answers the way `~/.local/share/uni/mail-bridge/server.py` does: NIP-98
//! checked against its own public URL (kind 27235, signature, `u`, `method`,
//! `payload`, a 120 s window, the allowlist, no replays), 401 with the same
//! error strings, only read-only JMAP methods (400 for anything else), 502
//! when the mail server behind it is down. Behind that is a small in-memory
//! JMAP store: `Mailbox/get`, `Email/query` (inMailbox, receivedAt order,
//! position/limit/total) and `Email/get` (ids or a `#ids` back-reference,
//! body values on request), and `/mail/raw` for blobs.
#![allow(dead_code)]

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use nostr::base64::engine::general_purpose::URL_SAFE_NO_PAD;
use nostr::base64::Engine as _;
use nostr::{Event, JsonUtil as _};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const READ_METHODS: &[&str] = &[
    "Mailbox/get", "Mailbox/query", "Mailbox/changes", "Email/get", "Email/query", "Email/changes",
    "Email/queryChanges", "Thread/get", "Thread/changes", "SearchSnippet/get", "Identity/get",
];

pub struct Mail {
    pub account: String,
    pub mailboxes: Vec<Value>,
    /// Full JMAP Email objects (with `textBody`, `htmlBody`, `attachments`, `bodyValues`).
    pub emails: Vec<Value>,
    pub blobs: HashMap<String, Vec<u8>>,
}

pub struct State {
    pub mail: Mail,
    pub allow: HashSet<String>,
    /// The mail server behind the bridge is down: every call answers 502.
    pub server_down: bool,
    /// Every JMAP method name the bridge forwarded, in order.
    pub forwarded: Vec<String>,
    /// Every request path, with the status it got.
    pub requests: Vec<(String, u16)>,
    seen: HashSet<String>,
}

pub struct FakeBridge {
    /// Its public URL (the origin the `u` tag must name).
    pub url: String,
    pub state: Arc<Mutex<State>>,
}

impl FakeBridge {
    /// Start on `127.0.0.1:port` (0 = any free port).
    pub async fn start(port: u16, allow: &[String], mail: Mail) -> FakeBridge {
        let listener = TcpListener::bind(("127.0.0.1", port)).await.unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let state = Arc::new(Mutex::new(State {
            mail,
            allow: allow.iter().map(|k| k.to_lowercase()).collect(),
            server_down: false,
            forwarded: Vec::new(),
            requests: Vec::new(),
            seen: HashSet::new(),
        }));
        let (st, public) = (state.clone(), url.clone());
        tokio::spawn(async move {
            while let Ok((sock, _)) = listener.accept().await {
                let (st, public) = (st.clone(), public.clone());
                tokio::spawn(async move {
                    let _ = serve(sock, &st, &public).await;
                });
            }
        });
        FakeBridge { url, state }
    }
}

async fn serve(mut sock: tokio::net::TcpStream, st: &Mutex<State>, public: &str) -> std::io::Result<()> {
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
            let len: usize = head
                .lines()
                .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap_or(0)))
                .unwrap_or(0);
            while buf.len() < end + 4 + len {
                let n = sock.read(&mut chunk).await?;
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            let body = buf[end + 4..(end + 4 + len).min(buf.len())].to_vec();
            break (head, body);
        }
    };
    let mut lines = head.lines();
    let request = lines.next().unwrap_or("").to_string();
    let path = request.split_whitespace().nth(1).unwrap_or("/").to_string();
    let auth = lines
        .find_map(|l| l.split_once(':').filter(|(k, _)| k.trim().eq_ignore_ascii_case("authorization")).map(|(_, v)| v.trim().to_string()))
        .unwrap_or_default();
    let (status, ctype, out) = handle(st, public, &request, &path, &auth, &body);
    st.lock().unwrap().requests.push((path, status));
    let reason = match status { 200 => "OK", 400 => "Bad Request", 401 => "Unauthorized", 404 => "Not Found", 413 => "Payload Too Large", _ => "Bad Gateway" };
    let headers = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n", out.len());
    sock.write_all(headers.as_bytes()).await?;
    sock.write_all(&out).await?;
    sock.shutdown().await
}

fn err(status: u16, msg: &str) -> (u16, &'static str, Vec<u8>) {
    (status, "application/json", json!({ "error": msg }).to_string().into_bytes())
}

fn handle(st: &Mutex<State>, public: &str, request: &str, path: &str, auth: &str, body: &[u8]) -> (u16, &'static str, Vec<u8>) {
    if !request.starts_with("POST ") {
        return err(404, "not found");
    }
    if body.is_empty() || body.len() > 64 * 1024 {
        return err(413, "bad body size");
    }
    if let Err(e) = verify_nip98(st, auth, &format!("{public}{path}"), body) {
        return err(401, &e);
    }
    let req: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(_) => return err(400, "bad json"),
    };
    let mut s = st.lock().unwrap();
    if s.server_down {
        return err(502, "mail server: URLError");
    }
    match path {
        "/mail/jmap" => {
            let calls = req.get("calls").and_then(Value::as_array).cloned().unwrap_or_default();
            for c in &calls {
                let ok = c.as_array().is_some_and(|a| a.len() == 3 && a[1].is_object());
                if !ok {
                    return err(400, "malformed method call");
                }
                let name = c[0].as_str().unwrap_or("");
                if !READ_METHODS.contains(&name) {
                    return err(400, &format!("method not allowed (read-only bridge): {name}"));
                }
            }
            let mut responses: Vec<Value> = Vec::new();
            for c in &calls {
                let (name, args, id) = (c[0].as_str().unwrap().to_string(), &c[1], c[2].as_str().unwrap_or("").to_string());
                s.forwarded.push(name.clone());
                let answer = jmap(&s.mail, &name, args, &responses);
                responses.push(match answer {
                    Ok(v) => json!([name, v, id]),
                    Err(t) => json!(["error", { "type": t }, id]),
                });
            }
            (200, "application/json", json!({ "account": s.mail.account, "methodResponses": responses }).to_string().into_bytes())
        }
        "/mail/raw" => {
            let blob = req.get("blobId").and_then(Value::as_str).unwrap_or("");
            if blob.is_empty() || blob.chars().any(|c| "/?#{} ".contains(c)) {
                return err(400, "bad blobId");
            }
            match s.mail.blobs.get(blob) {
                Some(b) => (200, "text/plain; charset=utf-8", b.clone()),
                // Stalwart 404s an unknown blob; the bridge reports that as an upstream failure
                None => err(502, "mail server: HTTPError"),
            }
        }
        _ => err(404, "not found"),
    }
}

/// The bridge's `verify_nip98`, check for check.
fn verify_nip98(st: &Mutex<State>, header: &str, url: &str, body: &[u8]) -> Result<(), String> {
    let b64 = header.strip_prefix("Nostr ").ok_or("missing Nostr authorization")?;
    let raw = URL_SAFE_NO_PAD.decode(b64.trim_end_matches('=')).map_err(|_| "bad authorization encoding")?;
    let ev = Event::from_json(&raw).map_err(|_| "bad event id")?;
    if ev.kind.as_u16() != 27235 {
        return Err("wrong kind".into());
    }
    if !ev.verify_id() {
        return Err("bad event id".into());
    }
    if !ev.verify_signature() {
        return Err("bad signature".into());
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    if (now - ev.created_at.as_secs() as i64).abs() > 120 {
        return Err("stale authorization".into());
    }
    let tag = |name: &str| ev.tags.iter().find_map(|t| (t.as_slice().first().map(String::as_str) == Some(name)).then(|| t.as_slice().get(1).cloned()).flatten());
    if tag("u").as_deref() != Some(url) || tag("method").map(|m| m.to_uppercase()).as_deref() != Some("POST") {
        return Err("authorization is for a different request".into());
    }
    if tag("payload").as_deref() != Some(uni_core::media::sha256_hex(body).as_str()) {
        return Err("payload hash mismatch".into());
    }
    let mut s = st.lock().unwrap();
    if !s.allow.contains(&ev.pubkey.to_hex()) {
        return Err("pubkey not allowed".into());
    }
    if !s.seen.insert(ev.id.to_hex()) {
        return Err("replayed authorization".into());
    }
    Ok(())
}

/// Resolve a JMAP `#name` back-reference (`/ids` only, which is all the app uses).
fn back_ref(args: &Value, key: &str, earlier: &[Value]) -> Option<Value> {
    if let Some(v) = args.get(key) {
        return Some(v.clone());
    }
    let r = args.get(format!("#{key}"))?;
    let (of, path) = (r.get("resultOf")?.as_str()?, r.get("path")?.as_str()?);
    let prev = earlier.iter().find(|p| p.get(2).and_then(Value::as_str) == Some(of))?;
    prev.get(1)?.pointer(path).cloned()
}

fn jmap(mail: &Mail, name: &str, args: &Value, earlier: &[Value]) -> Result<Value, &'static str> {
    match name {
        "Mailbox/get" => {
            let list: Vec<Value> = mail
                .mailboxes
                .iter()
                .map(|b| {
                    let id = b["id"].as_str().unwrap_or("");
                    let inside: Vec<&Value> = mail.emails.iter().filter(|e| e["mailboxIds"].get(id).is_some()).collect();
                    let unread = inside.iter().filter(|e| e["keywords"].get("$seen").is_none()).count();
                    let mut b = b.clone();
                    b["totalEmails"] = json!(inside.len());
                    b["unreadEmails"] = json!(unread);
                    b
                })
                .collect();
            Ok(json!({ "accountId": "a", "state": "1", "list": list, "notFound": [] }))
        }
        "Email/query" => {
            let inbox = args.pointer("/filter/inMailbox").and_then(Value::as_str);
            if inbox.is_some_and(|m| !mail.mailboxes.iter().any(|b| b["id"] == m)) {
                return Err("invalidArguments");
            }
            let mut found: Vec<&Value> = mail.emails.iter().filter(|e| inbox.is_none_or(|m| e["mailboxIds"].get(m).is_some())).collect();
            found.sort_by(|a, b| b["receivedAt"].as_str().cmp(&a["receivedAt"].as_str()));
            let position = args.get("position").and_then(Value::as_u64).unwrap_or(0) as usize;
            let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(256) as usize;
            let ids: Vec<&Value> = found.iter().skip(position).take(limit).map(|e| &e["id"]).collect();
            let mut out = json!({ "accountId": "a", "queryState": "1", "canCalculateChanges": false, "position": position, "ids": ids });
            if args.get("calculateTotal").and_then(Value::as_bool) == Some(true) {
                out["total"] = json!(found.len());
            }
            Ok(out)
        }
        "Email/get" => {
            let ids = back_ref(args, "ids", earlier).ok_or("invalidResultReference")?;
            let ids: Vec<&str> = ids.as_array().into_iter().flatten().filter_map(Value::as_str).collect();
            let text = args.get("fetchTextBodyValues").and_then(Value::as_bool) == Some(true);
            let html = args.get("fetchHTMLBodyValues").and_then(Value::as_bool) == Some(true);
            let mut list = Vec::new();
            let mut not_found = Vec::new();
            // answer in reverse, as a real server may: the client must restore the query's order
            for id in ids.iter().rev() {
                let Some(e) = mail.emails.iter().find(|e| e["id"] == *id) else {
                    not_found.push(*id);
                    continue;
                };
                let mut e = e.clone();
                let mut values = serde_json::Map::new();
                for (list_key, want) in [("textBody", text), ("htmlBody", html)] {
                    if !want {
                        continue;
                    }
                    for part in e[list_key].as_array().cloned().unwrap_or_default() {
                        if let Some(p) = part["partId"].as_str() {
                            if let Some(v) = e["bodyValues"].get(p) {
                                values.insert(p.to_string(), v.clone());
                            }
                        }
                    }
                }
                e["bodyValues"] = Value::Object(values);
                list.push(e);
            }
            Ok(json!({ "accountId": "a", "state": "1", "list": list, "notFound": not_found }))
        }
        _ => Ok(json!({ "accountId": "a", "list": [] })),
    }
}

fn part(id: &str, mime: &str) -> Value {
    json!({ "partId": id, "blobId": format!("B{id}"), "type": mime })
}

/// A message in `mailbox`. `html` adds an HTML alternative (or is the only body when `text` is empty).
#[allow(clippy::too_many_arguments)]
pub fn email(id: &str, mailbox: &str, from: (&str, &str), subject: &str, at: &str, seen: bool, text: &str, html: Option<&str>) -> Value {
    let mut text_body = Vec::new();
    let mut html_body = Vec::new();
    let mut values = serde_json::Map::new();
    if !text.is_empty() {
        text_body.push(part("1", "text/plain"));
        values.insert("1".into(), json!({ "value": text, "isTruncated": false }));
    }
    if let Some(h) = html {
        html_body.push(part("2", "text/html"));
        values.insert("2".into(), json!({ "value": h, "isTruncated": false }));
        if text.is_empty() {
            // JMAP: with no plain alternative, textBody holds the HTML part
            text_body.push(part("2", "text/html"));
        }
    } else {
        html_body.push(part("1", "text/plain"));
    }
    let preview: String = if text.is_empty() { subject.to_string() } else { text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(120).collect() };
    json!({
        "id": id, "threadId": format!("T{id}"), "mailboxIds": { mailbox: true },
        "keywords": if seen { json!({ "$seen": true }) } else { json!({}) },
        "from": [{ "name": from.0, "email": from.1 }], "to": [{ "name": "Uni", "email": "owner@example.com" }], "cc": null, "replyTo": null,
        "subject": subject, "preview": preview, "receivedAt": at, "sentAt": at, "hasAttachment": false,
        "textBody": text_body, "htmlBody": html_body, "attachments": [], "bodyValues": values,
    })
}

/// Test mail for `owner@example.com`: an Inbox with plain, HTML-only (remote images, a script) and
/// attachment messages, read and unread; an empty Archive; a Junk folder with one message.
pub fn sample_mail() -> Mail {
    let mailboxes = vec![
        json!({ "id": "mb-junk", "name": "Junk Mail", "role": "junk", "parentId": null, "sortOrder": 0 }),
        json!({ "id": "mb-inbox", "name": "Inbox", "role": "inbox", "parentId": null, "sortOrder": 0 }),
        json!({ "id": "mb-archive", "name": "Archive", "role": "archive", "parentId": null, "sortOrder": 0 }),
    ];
    let mut emails = vec![
        email("m1", "mb-inbox", ("Stalwart test", "test@mail.example.com"), "Mail is live on mail.example.com", "2026-10-18T07:12:00Z", false,
            "Hi Uni,\n\nThis is a test message for the new mailbox. If you can read this in the Uni app, the read-only bridge works.\n\nIt has no attachments and no HTML part.\n\n— the mail setup", None),
        email("m2", "mb-inbox", ("Hilltop Tech Night", "events@example.org"), "This week: three demos and a pizza", "2026-10-17T16:30:00Z", false, "",
            Some(r#"<h1 style="color:#2b5d8a;font-family:Georgia">This week at Hilltop Tech Night</h1><p>Three demos, one pizza order, and a talk on local-first apps.</p><p><img src="https://tracker.example/open.gif?u=agi" width="1" height="1"><img src="https://cdn.example/banner.png" alt="Banner"></p><script>document.title='pwned'</script><p onclick="steal()"><a href="https://bouldernewtech.example/rsvp">RSVP here</a></p>"#)),
        email("m4", "mb-inbox", ("Ada (test)", "ada@example.org"), "Notes from Thursday", "2026-10-16T21:05:00Z", true,
            "Notes attached as a PDF.\n\nThe short version: we keep mail read-only in the app for now, and sending stays in the mail client.", Some("<p>Notes attached as a PDF.</p><p>The short version: we keep mail <b>read-only</b> in the app for now, and sending stays in the mail client.</p>")),
        email("m5", "mb-inbox", ("Resend", "no-reply@example.org"), "Delivery report for mail.example.com", "2026-10-15T09:00:00Z", true,
            "All 4 test messages were delivered. Nothing bounced.", None),
        email("m6", "mb-junk", ("Prize Desk", "winner@spam.example"), "You have won", "2026-10-14T03:00:00Z", false, "Claim now.", None),
    ];
    emails[2]["hasAttachment"] = json!(true);
    // the second is disguised: SVG (which can carry script) named and declared as a PNG; the third is a
    // real Word file carrying an OLE object (Codex round 2's arrangement: embeddings/payload.bin behind a
    // compressed oleObject relationship)
    emails[2]["attachments"] = json!([
        { "partId": "3", "blobId": "Bnotes-pdf", "type": "application/pdf", "name": "thursday-notes.pdf", "size": 13401, "cid": null, "disposition": "attachment" },
        { "partId": "4", "blobId": "Binvoice-svg", "type": "image/png", "name": "invoice.png", "size": 160, "cid": null, "disposition": "attachment" },
        { "partId": "5", "blobId": "Bbudget-docx", "type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "name": "budget.docx", "size": 5113, "cid": null, "disposition": "attachment" },
    ]);
    let mut blobs = HashMap::new();
    blobs.insert("Bnotes-pdf".to_string(), include_bytes!("../fixtures/attachments/notes.pdf").to_vec());
    blobs.insert("Bbudget-docx".to_string(), include_bytes!("../fixtures/attachments/budget-ole.docx").to_vec());
    blobs.insert("Binvoice-svg".to_string(), br#"<svg xmlns="http://www.w3.org/2000/svg" onload="alert(document.domain)"><text y="20">Invoice</text></svg>"#.to_vec());
    Mail { account: "owner@example.com".into(), mailboxes, emails, blobs }
}
