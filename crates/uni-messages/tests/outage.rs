//! T-282: a message written while the homeserver restarts still goes, and so do the ones after it.
//!
//! matrix-sdk pauses a room's send queue when a send fails for a reason that passes (the network, the homeserver gone
//! for a moment) and leaves it paused until the app turns it back on; without that, every later message waits as
//! "sending" for good. Here the homeserver is a real one, continuwuity, run on a free loopback port with its own
//! database (the test is skipped where it isn't installed): the account signs in, the homeserver is stopped, a message
//! is sent, the homeserver starts again on the same database, and both that message and one sent after it must reach
//! the room.
//!
//! `UNI_TEST_CONTINUWUITY` names the binary; without it, the default install path is tried.

#![recursion_limit = "256"]

use std::{
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uni_messages::{FileSecrets, Messages};

fn binary() -> Option<PathBuf> {
    let p = std::env::var_os("UNI_TEST_CONTINUWUITY")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share/uni-matrix/bin/continuwuity")))?;
    p.is_file().then_some(p)
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

struct Homeserver {
    bin: PathBuf,
    dir: PathBuf,
    port: u16,
    child: Option<Child>,
}

impl Homeserver {
    fn start(&mut self) {
        let log = std::fs::OpenOptions::new().create(true).append(true).open(self.dir.join("hs.log")).unwrap();
        let child = Command::new(&self.bin)
            .arg("-c")
            .arg(self.dir.join("hs.toml"))
            .stdout(Stdio::from(log.try_clone().unwrap()))
            .stderr(Stdio::from(log))
            .spawn()
            .unwrap();
        self.child = Some(child);
    }

    fn stop(&mut self) {
        if let Some(mut c) = self.child.take() {
            // a clean stop, as `systemctl restart` gives it
            let _ = Command::new("kill").arg("-TERM").arg(c.id().to_string()).status();
            let _ = c.wait();
        }
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

impl Drop for Homeserver {
    fn drop(&mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

/// One plain HTTP/1.1 request to the homeserver: (status, JSON body). Setup and checks only; the account under test
/// talks through matrix-sdk.
async fn http(port: u16, method: &str, path: &str, body: Option<Value>, token: Option<&str>) -> Option<(u16, Value)> {
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.ok()?;
    let body = body.map(|b| b.to_string()).unwrap_or_default();
    let auth = token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Type: application/json\r\n{auth}Content-Length: {}\r\n\r\n{body}",
        body.len()
    );
    s.write_all(req.as_bytes()).await.ok()?;
    let mut out = Vec::new();
    s.read_to_end(&mut out).await.ok()?;
    let text = String::from_utf8_lossy(&out);
    let status = text.split_whitespace().nth(1)?.parse().ok()?;
    let (head, rest) = text.split_once("\r\n\r\n")?;
    let rest = if head.to_ascii_lowercase().contains("transfer-encoding: chunked") { dechunk(rest) } else { rest.to_owned() };
    Some((status, serde_json::from_str(&rest).unwrap_or(Value::Null)))
}

fn dechunk(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some((size, after)) = rest.split_once("\r\n") {
        let n = usize::from_str_radix(size.trim(), 16).unwrap_or(0);
        if n == 0 || after.len() < n {
            break;
        }
        out.push_str(&after[..n]);
        rest = after[n..].trim_start_matches("\r\n");
    }
    out
}

async fn until<F: std::future::Future<Output = bool>>(secs: u64, what: &str, mut f: impl FnMut() -> F) {
    let end = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < end {
        if f().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    panic!("timed out: {what}");
}

fn bootstrap_token(dir: &Path) -> Option<String> {
    let log = std::fs::read_to_string(dir.join("hs.log")).ok()?;
    let plain: String = log.split('\x1b').map(|p| p.split_once('m').map_or(p, |(_, r)| r)).collect();
    let at = plain.find("registration token ")? + "registration token ".len();
    plain[at..].split_whitespace().next().map(str::to_owned)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_message_sent_while_the_homeserver_restarts_still_goes_and_so_do_later_ones() {
    let Some(bin) = binary() else {
        eprintln!("skipped: no continuwuity binary (set UNI_TEST_CONTINUWUITY)");
        return;
    };
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_owned();
    let port = free_port();
    std::fs::write(
        dir.join("hs.toml"),
        format!(
            "[global]\nserver_name = \"outage.test.localhost\"\naddress = [\"127.0.0.1\"]\nport = {port}\ndatabase_path = \"{}\"\n\
             allow_federation = false\nallow_registration = true\nregistration_token = \"test-registration-token-0123456789\"\n\
             allow_announcements_check = false\ntrusted_servers = []\nlog = \"info\"\n",
            dir.join("db").display()
        ),
    )
    .unwrap();
    let mut hs = Homeserver { bin, dir: dir.clone(), port, child: None };
    hs.start();
    until(30, "the homeserver answers", || async { http(port, "GET", "/_matrix/client/versions", None, None).await.is_some_and(|r| r.0 == 200) }).await;

    // one account: the first takes the one-time token a fresh database prints
    let mut boot = None;
    until(10, "the bootstrap token", || {
        boot = bootstrap_token(&dir);
        let found = boot.is_some();
        async move { found }
    })
    .await;
    let (_, first) = http(port, "POST", "/_matrix/client/v3/register", Some(json!({ "username": "wren", "password": "pw-0123456789" })), None).await.unwrap();
    let (status, reg) = http(
        port,
        "POST",
        "/_matrix/client/v3/register",
        Some(json!({ "username": "wren", "password": "pw-0123456789", "auth": { "type": "m.login.registration_token", "token": boot.unwrap(), "session": first["session"] } })),
        None,
    )
    .await
    .unwrap();
    assert_eq!(status, 200, "{reg}");
    let token = reg["access_token"].as_str().unwrap().to_owned();
    let (_, room) = http(port, "POST", "/_matrix/client/v3/createRoom", Some(json!({ "name": "Outage test", "preset": "private_chat" })), Some(&token)).await.unwrap();
    let room_id = room["room_id"].as_str().unwrap().to_owned();

    // the account under test, as the app runs it
    let m = Messages::new(dir.join("app/data"), Arc::new(FileSecrets::new(dir.join("app/secrets"))));
    m.sign_in(&hs.url(), "wren", "pw-0123456789").await.unwrap();
    until(30, "the room is listed", || {
        let m = m.clone();
        let id = room_id.clone();
        async move { m.rooms().await.unwrap_or_default().iter().any(|r| r.id == id) }
    })
    .await;
    m.open(&room_id).await.unwrap();

    hs.stop();
    m.send(&room_id, "written while the homeserver was down").await.unwrap();
    tokio::time::sleep(Duration::from_secs(3)).await;
    hs.start();
    until(30, "the homeserver is back", || async { http(port, "GET", "/_matrix/client/versions", None, None).await.is_some_and(|r| r.0 == 200) }).await;
    m.send(&room_id, "written after it came back").await.unwrap();

    let path = format!("/_matrix/client/v3/rooms/{}/messages?dir=b&limit=20", room_id.replace('!', "%21").replace(':', "%3A"));
    until(60, "both messages reach the room", || {
        let (path, token) = (path.clone(), token.clone());
        async move {
            let Some((200, page)) = http(port, "GET", &path, None, Some(&token)).await else { return false };
            let bodies: Vec<String> = page["chunk"].as_array().into_iter().flatten().filter_map(|e| e["content"]["body"].as_str().map(str::to_owned)).collect();
            bodies.iter().any(|b| b == "written while the homeserver was down") && bodies.iter().any(|b| b == "written after it came back")
        }
    })
    .await;
    m.shut_down().await;
}
