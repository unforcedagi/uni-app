//! The app's mail commands over HTTP, for a Playwright run against a real mail bridge (T-335 live proof).
//! Never part of the app. Each `POST /` with `{"cmd": "mail_…", "args": {…}}` runs the same `uni_core::mail` call the
//! Tauri command runs, signed with the key in `<key file>` (64 hex characters), and answers `{"ok": value}` or
//! `{"err": MailError}` (the shape the webview gets from `invoke`). Opening a file hands it to a recorder instead of the
//! system opener: the answer is the opened file's name and SHA-256, so a test can compare it with what it sent.
//! `t335_fetch_back {"text": …}` lists every message matching `text` in every account, with each attachment's SHA-256
//! as fetched now: the proof that the sent copy carries the files byte for byte.
//! It answers only the page it serves (`origin`, the Vite preview of playwright.maillive.config.ts by default) and
//! callers with no Origin (curl, the spec's own Node side), and only JSON bodies, so another page in the same browser
//! can't drive it: a form post has no JSON type, and a fetch from elsewhere carries its own Origin.
//! Usage:
//!   cargo run -p uni-core --example mail_ipc_proxy -- <port> <bridge url> <key file> <cache dir> [origin]

use std::path::{Path, PathBuf};

use nostr::Keys;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use uni_core::mail::{HeldFile, MailBridge, MailError, Source, PAGE_SIZE};

struct Ctx {
    bridge: String,
    keys: Keys,
    cache: PathBuf,
}

fn arg<T: serde::de::DeserializeOwned>(a: &Value, k: &str) -> Result<T, MailError> {
    serde_json::from_value(a.get(k).cloned().unwrap_or(Value::Null)).map_err(|e| MailError::Invalid { message: format!("{k}: {e}") })
}

fn to_json<T: serde::Serialize>(v: T) -> Result<Value, MailError> {
    Ok(serde_json::to_value(v).unwrap_or(Value::Null))
}

/// What the opener got: its name and the SHA-256 of its bytes.
fn recorded(path: &Path) -> Value {
    let bytes = std::fs::read(path).unwrap_or_default();
    json!({ "opened": path.file_name().map(|n| n.to_string_lossy().to_string()), "sha256": uni_core::media::sha256_hex(&bytes), "size": bytes.len() })
}

async fn run(ctx: &Ctx, cmd: &str, a: &Value) -> Result<Value, MailError> {
    let mail = MailBridge::new(&ctx.bridge, &ctx.keys)?;
    match cmd {
        "mail_overview" => to_json(mail.overview().await?),
        "mail_threads" => {
            let sources: Vec<Source> = arg(a, "sources")?;
            let text: Option<String> = arg(a, "text")?;
            to_json(mail.threads(&sources, text.as_deref(), PAGE_SIZE).await?)
        }
        "mail_thread" => to_json(mail.thread(&arg::<String>(a, "accountId")?, &arg::<String>(a, "threadId")?).await?),
        "mail_triage" => to_json(mail.triage(&arg::<String>(a, "accountId")?, &arg::<Vec<String>>(a, "emailIds")?).await?),
        "mail_mark_seen" => to_json(mail.mark_seen(&arg::<String>(a, "accountId")?, &arg::<Vec<String>>(a, "emailIds")?, arg(a, "seen")?).await?),
        "mail_flag" => to_json(mail.flag(&arg::<String>(a, "accountId")?, &arg::<Vec<String>>(a, "emailIds")?, arg(a, "flagged")?).await?),
        "mail_parked" => to_json(mail.parked(&arg::<String>(a, "accountId")?).await?),
        "mail_send_approve" => to_json(mail.send_approve(&arg::<String>(a, "accountId")?, &arg::<String>(a, "opId")?, &arg::<String>(a, "fingerprint")?).await?),
        "mail_send_decline" => to_json(mail.send_decline(&arg::<String>(a, "accountId")?, &arg::<String>(a, "opId")?).await?),
        "mail_held_file_open" => {
            let file: HeldFile = arg(a, "file")?;
            let path = uni_core::mail::open_held_file_in(&mail, &ctx.cache, &arg::<String>(a, "accountId")?, &arg::<String>(a, "draftId")?, arg(a, "index")?, &file, |_| Ok(())).await?;
            Ok(recorded(&path))
        }
        "mail_attachment_open" => {
            let (account, name, mime): (Option<String>, Option<String>, Option<String>) = (arg(a, "accountId")?, arg(a, "name")?, arg(a, "mime")?);
            let path = uni_core::mail::open_attachment_in(&mail, &ctx.cache, account.as_deref(), &arg::<String>(a, "blobId")?, name.as_deref(), mime.as_deref(), |_| Ok(())).await?;
            Ok(recorded(&path))
        }
        "t335_fetch_back" => {
            let text: String = arg(a, "text")?;
            let o = mail.overview().await?;
            let mut out = Vec::new();
            for acct in &o.accounts {
                let source = Source { account_id: acct.id.clone(), mailbox_id: None, exclude: Vec::new(), position: 0 };
                let page = mail.threads(&[source], Some(&text), PAGE_SIZE).await?;
                for t in page.threads {
                    for m in mail.thread(&acct.id, &t.thread_id).await?.messages {
                        if !m.subject.contains(&text) {
                            continue;
                        }
                        let boxes: Vec<_> = m.mailbox_ids.iter().filter_map(|id| acct.mailboxes.iter().find(|b| &b.id == id)).map(|b| b.role.clone().unwrap_or_else(|| b.name.clone())).collect();
                        let mut files = Vec::new();
                        for f in &m.attachments {
                            let bytes = mail.blob_in(&acct.id, &f.blob_id).await?;
                            files.push(json!({ "name": f.name, "mime": f.mime, "size": bytes.len(), "sha256": uni_core::media::sha256_hex(&bytes) }));
                        }
                        out.push(json!({ "account": acct.name, "who": acct.who, "mailboxes": boxes, "draft": m.draft, "subject": m.subject,
                            "from": m.from, "to": m.to, "text": m.text, "files": files }));
                    }
                }
            }
            Ok(Value::Array(out))
        }
        _ => Err(MailError::Invalid { message: format!("this proxy doesn't run {cmd}") }),
    }
}

async fn answer(ctx: &Ctx, mut sock: tokio::net::TcpStream, origin: &str) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 65536];
    let (head_end, len) = loop {
        let Ok(n) = sock.read(&mut chunk).await else { return };
        if n == 0 {
            return;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..i]).to_ascii_lowercase();
            let len = head.lines().find_map(|l| l.strip_prefix("content-length:").and_then(|v| v.trim().parse::<usize>().ok())).unwrap_or(0);
            break (i + 4, len);
        }
    };
    while buf.len() < head_end + len {
        let Ok(n) = sock.read(&mut chunk).await else { return };
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let preflight = buf.starts_with(b"OPTIONS");
    let head = String::from_utf8_lossy(&buf[..head_end]).to_ascii_lowercase();
    let header = |name: &str| head.lines().find_map(|l| l.strip_prefix(name).map(|v| v.trim().to_string()));
    let foreign = header("origin:").is_some_and(|o| o != origin.to_ascii_lowercase());
    let json_body = header("content-type:").is_some_and(|t| t.starts_with("application/json"));
    if foreign || (!preflight && !json_body) {
        eprintln!("refused a request from {:?} ({:?})", header("origin:"), header("content-type:"));
        let _ = sock.write_all(b"HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").await;
        return;
    }
    let body = if preflight {
        String::new()
    } else {
        let req: Value = serde_json::from_slice(&buf[head_end..(head_end + len).min(buf.len())]).unwrap_or(Value::Null);
        let cmd = req["cmd"].as_str().unwrap_or("").to_string();
        let out = match run(ctx, &cmd, &req["args"]).await {
            Ok(v) => json!({ "ok": v }),
            Err(e) => json!({ "err": e }),
        };
        eprintln!("{cmd} -> {}", if out.get("ok").is_some() { "ok".to_string() } else { out["err"].to_string() });
        out.to_string()
    };
    let resp = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\naccess-control-allow-origin: {origin}\r\naccess-control-allow-methods: POST, OPTIONS\r\naccess-control-allow-headers: content-type\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = sock.write_all(resp.as_bytes()).await;
}

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let usage = "usage: mail_ipc_proxy <port> <bridge url> <key file> <cache dir> [allowed origin]";
    let port: u16 = args.next().and_then(|p| p.parse().ok()).expect(usage);
    let bridge = args.next().expect(usage);
    let key = std::fs::read_to_string(args.next().expect(usage)).expect("key file");
    let keys = Keys::parse(key.trim()).expect("a 64-hex secret key");
    let cache = PathBuf::from(args.next().expect(usage));
    let origin = args.next().unwrap_or_else(|| "http://127.0.0.1:1436".into());
    eprintln!("mail_ipc_proxy on 127.0.0.1:{port} -> {bridge} as {}", keys.public_key().to_hex());
    let ctx = std::sync::Arc::new(Ctx { bridge, keys, cache });
    let listener = TcpListener::bind(("127.0.0.1", port)).await.expect("bind");
    loop {
        let Ok((sock, _)) = listener.accept().await else { continue };
        let (ctx, origin) = (ctx.clone(), origin.clone());
        tokio::spawn(async move { answer(&ctx, sock, &origin).await });
    }
}
