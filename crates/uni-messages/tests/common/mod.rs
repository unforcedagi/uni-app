//! A real homeserver for the integration tests: continuwuity (the pinned binary uni-matrix runs) on a free loopback
//! port with its own database, and plain HTTP for the tests' own setup and checks. The account under test talks
//! through matrix-sdk. `UNI_TEST_CONTINUWUITY` names the binary; without it, the default install path is tried.
#![allow(dead_code)]

use std::{
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const REGISTRATION_TOKEN: &str = "test-registration-token-0123456789";

pub fn binary() -> Option<PathBuf> {
    let p = std::env::var_os("UNI_TEST_CONTINUWUITY")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share/uni-matrix/bin/continuwuity")))?;
    p.is_file().then_some(p)
}

pub fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

pub struct Homeserver {
    pub bin: PathBuf,
    pub dir: PathBuf,
    pub port: u16,
    pub child: Option<Child>,
}

impl Homeserver {
    pub fn start(&mut self) {
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

    pub fn stop(&mut self) {
        if let Some(mut c) = self.child.take() {
            // a clean stop, as `systemctl restart` gives it
            let _ = Command::new("kill").arg("-TERM").arg(c.id().to_string()).status();
            let _ = c.wait();
        }
    }

    pub fn url(&self) -> String {
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
pub async fn http(port: u16, method: &str, path: &str, body: Option<Value>, token: Option<&str>) -> Option<(u16, Value)> {
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

pub fn dechunk(s: &str) -> String {
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

pub async fn until<F: std::future::Future<Output = bool>>(secs: u64, what: &str, mut f: impl FnMut() -> F) {
    let end = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < end {
        if f().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    panic!("timed out: {what}");
}

pub fn bootstrap_token(dir: &Path) -> Option<String> {
    let log = std::fs::read_to_string(dir.join("hs.log")).ok()?;
    let plain: String = log.split('\x1b').map(|p| p.split_once('m').map_or(p, |(_, r)| r)).collect();
    let at = plain.find("registration token ")? + "registration token ".len();
    plain[at..].split_whitespace().next().map(str::to_owned)
}

/// A fresh homeserver in `dir`, answering, named `server_name`.
pub async fn start(bin: PathBuf, dir: &Path, server_name: &str) -> Homeserver {
    let port = free_port();
    std::fs::write(
        dir.join("hs.toml"),
        format!(
            "[global]\nserver_name = \"{server_name}\"\naddress = [\"127.0.0.1\"]\nport = {port}\ndatabase_path = \"{}\"\n\
             allow_federation = false\nallow_registration = true\nregistration_token = \"{REGISTRATION_TOKEN}\"\n\
             allow_announcements_check = false\ntrusted_servers = []\nlog = \"info\"\n",
            dir.join("db").display()
        ),
    )
    .unwrap();
    let mut hs = Homeserver { bin, dir: dir.to_owned(), port, child: None };
    hs.start();
    until(30, "the homeserver answers", || async { http(port, "GET", "/_matrix/client/versions", None, None).await.is_some_and(|r| r.0 == 200) }).await;
    hs
}

/// Register `user` (password "pw-0123456789"): the first account on a fresh database takes the one-time token it
/// prints, the others the configured one. Its access token.
pub async fn register(hs: &Homeserver, user: &str, first: bool) -> String {
    let token = if first {
        let mut boot = None;
        until(10, "the bootstrap token", || {
            boot = bootstrap_token(&hs.dir);
            let found = boot.is_some();
            async move { found }
        })
        .await;
        boot.unwrap()
    } else {
        REGISTRATION_TOKEN.to_owned()
    };
    let (_, step) = http(hs.port, "POST", "/_matrix/client/v3/register", Some(json!({ "username": user, "password": "pw-0123456789" })), None).await.unwrap();
    let (status, reg) = http(
        hs.port,
        "POST",
        "/_matrix/client/v3/register",
        Some(json!({ "username": user, "password": "pw-0123456789", "auth": { "type": "m.login.registration_token", "token": token, "session": step["session"] } })),
        None,
    )
    .await
    .unwrap();
    assert_eq!(status, 200, "register {user}: {reg}");
    reg["access_token"].as_str().unwrap().to_owned()
}

/// A room id, escaped for a URL path.
pub fn esc(id: &str) -> String {
    id.replace('!', "%21").replace(':', "%3A").replace('@', "%40")
}
