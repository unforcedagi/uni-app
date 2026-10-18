//! T-172, Linux and Android. Neither webview can play a long video from the `unimedia` custom protocol:
//! - WebKitGTK hands media URLs to GStreamer, whose WebKit source element takes only http(s) and blob, so a
//!   `<video>` on a custom scheme fails with `FormatError` before any request (WebKitGTK 2.52).
//! - Android's WebView passes intercepted responses to the media stack without their `Content-Range`, so the first
//!   1 MiB partial answer reads as the whole file and playback stops after it (WebView 109: stuck at 1.7 s, while the
//!   same file in 1 MiB ranges from a real HTTP server played through). A full answer would need the whole range in
//!   memory, since Tauri protocol responses are not streamed.
//!
//! Both played the same file over plain http. So this serves the verified cache files over HTTP on 127.0.0.1, under
//! a random per-launch token, streaming the asked range from disk. macOS (and other platforms) keep the custom
//! protocol. Android allows cleartext to 127.0.0.1 and localhost only, in release builds too
//! (gen/android/app/src/main/res/xml/network_security_config.xml).

use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{sync_channel, TrySendError};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

static BASE: OnceLock<Result<String, String>> = OnceLock::new();

/// Codex review 1 (P1): any app on an Android device can reach 127.0.0.1 without the token. So the work one
/// connection can cause is bounded before the token is read: a fixed pool of handlers, a short queue (a connection
/// beyond it is closed at once), and one deadline for the whole request head, however slowly it trickles in.
#[derive(Clone, Copy)]
struct Limits {
    workers: usize,
    queue: usize,
    head_deadline: Duration,
    write_timeout: Duration,
}

const LIMITS: Limits = Limits {
    workers: 8,
    queue: 8,
    head_deadline: Duration::from_secs(3),
    // A paused player stops reading; give the handler back. It asks again with a Range on resume.
    write_timeout: Duration::from_secs(15),
};
const MAX_HEAD: usize = 16 * 1024;

/// `http://127.0.0.1:<port>/<token>`; the server starts on first use and lives as long as the app.
pub fn base(cache_dir: PathBuf) -> Result<String, String> {
    BASE.get_or_init(|| start(cache_dir, LIMITS)).clone()
}

fn start(cache_dir: PathBuf, limits: Limits) -> Result<String, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("media server: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    // 244 random bits: another local user, app or web page that reaches the port cannot guess a path.
    let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    let (tx, rx) = sync_channel::<TcpStream>(limits.queue);
    let rx = Arc::new(Mutex::new(rx));
    for i in 0..limits.workers {
        let (rx, dir, token) = (rx.clone(), cache_dir.clone(), token.clone());
        std::thread::Builder::new()
            .name(format!("unimedia-{i}"))
            .spawn(move || loop {
                let conn = match rx.lock().map(|r| r.recv()) {
                    Ok(Ok(conn)) => conn,
                    _ => return,
                };
                let _ = serve(conn, &dir, &token, limits);
            })
            .map_err(|e| e.to_string())?;
    }
    std::thread::Builder::new()
        .name("unimedia-accept".into())
        .spawn(move || {
            for conn in listener.incoming().flatten() {
                // Full: every handler is busy and the queue is too. Close now rather than pile up.
                if let Err(TrySendError::Full(conn)) = tx.try_send(conn) {
                    drop(conn);
                }
            }
        })
        .map_err(|e| e.to_string())?;
    tracing::info!(port, "media loopback server started");
    Ok(format!("http://127.0.0.1:{port}/{token}"))
}

/// The request head (up to the blank line), read within `deadline` in total; None when it isn't there in time.
fn read_head(conn: &mut TcpStream, deadline: Duration) -> Option<String> {
    let end = Instant::now() + deadline;
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        let left = end.checked_duration_since(Instant::now()).filter(|d| !d.is_zero())?;
        conn.set_read_timeout(Some(left)).ok()?;
        let n = conn.read(&mut chunk).ok().filter(|n| *n > 0)?;
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > MAX_HEAD {
            return None;
        }
    }
    Some(String::from_utf8_lossy(&buf).into_owned())
}

fn serve(mut conn: TcpStream, dir: &Path, token: &str, limits: Limits) -> std::io::Result<()> {
    conn.set_write_timeout(Some(limits.write_timeout))?;
    let Some(head) = read_head(&mut conn, limits.head_deadline) else {
        return Ok(()); // dropped: closes the connection
    };
    let mut lines = head.split("\r\n");
    let mut parts = lines.next().unwrap_or("").split_whitespace();
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let range = lines
        .filter_map(|h| h.split_once(':'))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case("range"))
        .map(|(_, v)| v.trim().to_string());
    let sha = target
        .strip_prefix('/')
        .and_then(|p| p.strip_prefix(token))
        .and_then(|p| p.strip_prefix('/'))
        .unwrap_or("");
    let content_type = crate::media_registry::lock(&crate::media_registry::MEDIA).content_type(sha);
    let file = content_type
        .as_ref()
        .and_then(|_| uni_core::media::cache_path(dir, sha).ok())
        .and_then(|p| std::fs::File::open(p).ok());
    let (Some(ct), Some(mut file), "GET" | "HEAD") = (content_type, file, method) else {
        return conn.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    };
    let len = file.metadata()?.len();
    let common = format!("Content-Type: {ct}\r\nAccept-Ranges: bytes\r\nCache-Control: no-store\r\nConnection: close\r\n");
    let (start, end) = match uni_core::media::parse_range(range.as_deref(), len) {
        Err(()) => {
            let head = format!("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{len}\r\nContent-Length: 0\r\n{common}\r\n");
            return conn.write_all(head.as_bytes());
        }
        Ok(None) => {
            conn.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {len}\r\n{common}\r\n").as_bytes())?;
            (0, len)
        }
        Ok(Some((s, e))) => {
            let head = format!("HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {s}-{e}/{len}\r\nContent-Length: {}\r\n{common}\r\n", e + 1 - s);
            conn.write_all(head.as_bytes())?;
            (s, e + 1)
        }
    };
    tracing::debug!(sha, range = ?range, "unimedia loopback");
    if method == "GET" {
        file.seek(SeekFrom::Start(start))?;
        std::io::copy(&mut file.take(end - start), &mut conn)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get(base: &str, path: &str, range: Option<&str>) -> (String, Vec<u8>) {
        let addr = base.trim_start_matches("http://").split('/').next().unwrap().to_string();
        let mut c = TcpStream::connect(addr).unwrap();
        let range = range.map(|r| format!("Range: {r}\r\n")).unwrap_or_default();
        write!(c, "GET {path} HTTP/1.1\r\nHost: x\r\n{range}\r\n").unwrap();
        let mut raw = Vec::new();
        c.read_to_end(&mut raw).unwrap();
        let split = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        (String::from_utf8_lossy(&raw[..split]).into_owned(), raw[split + 4..].to_vec())
    }

    #[test]
    fn serves_verified_hashes_by_range_under_the_token_only() {
        let dir = std::env::temp_dir().join(format!("unimedia-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let data: Vec<u8> = (0..3_000_000u32).map(|i| (i % 249) as u8).collect();
        let sha = uni_core::media::sha256_hex(&data);
        std::fs::write(dir.join(&sha), &data).unwrap();
        let base = start(dir.clone(), LIMITS).unwrap();
        let token_path = base.splitn(4, '/').nth(3).unwrap().to_string();

        // Not allowed yet (not verified this session): 404.
        assert!(get(&base, &format!("/{token_path}/{sha}"), None).0.starts_with("HTTP/1.1 404"));
        crate::media_registry::lock(&crate::media_registry::MEDIA).allow_for_test(&sha, "video/mp4");

        let (head, body) = get(&base, &format!("/{token_path}/{sha}"), Some("bytes=1000-"));
        assert!(head.starts_with("HTTP/1.1 206"), "{head}");
        assert!(head.contains(&format!("Content-Range: bytes 1000-2999999/{}", data.len())), "{head}");
        assert!(head.contains("Content-Type: video/mp4"), "{head}");
        assert!(body == data[1000..], "the whole rest of the file, streamed, not a capped chunk");
        let (head, body) = get(&base, &format!("/{token_path}/{sha}"), None);
        assert!(head.starts_with("HTTP/1.1 200"), "{head}");
        assert_eq!(body.len(), data.len());
        assert!(get(&base, &format!("/{token_path}/{sha}"), Some("bytes=9999999-")).0.starts_with("HTTP/1.1 416"));

        // Wrong or missing token, or a path outside the cache: 404.
        assert!(get(&base, &format!("/{}/{sha}", "0".repeat(64)), None).0.starts_with("HTTP/1.1 404"));
        assert!(get(&base, &format!("/{sha}"), None).0.starts_with("HTTP/1.1 404"));
        assert!(get(&base, &format!("/{token_path}/../{sha}"), None).0.starts_with("HTTP/1.1 404"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn threads() -> usize {
        std::fs::read_dir("/proc/self/task").unwrap().count()
    }

    /// Codex review 1 (P1): connections that never send a full request head, slowly or at all.
    #[test]
    fn silent_or_trickling_clients_hold_no_more_than_the_pool() {
        let dir = std::env::temp_dir().join(format!("unimedia-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let data = vec![7u8; 4096];
        let sha = uni_core::media::sha256_hex(&data);
        std::fs::write(dir.join(&sha), &data).unwrap();
        crate::media_registry::lock(&crate::media_registry::MEDIA).allow_for_test(&sha, "audio/mp4");
        let limits = Limits { workers: 2, queue: 2, head_deadline: Duration::from_millis(600), write_timeout: Duration::from_secs(1) };
        let base = start(dir.clone(), limits).unwrap();
        let addr = base.trim_start_matches("http://").split('/').next().unwrap().to_string();
        let token_path = base.splitn(4, '/').nth(3).unwrap().to_string();

        // A head that trickles in a byte every 150 ms is cut off at the deadline, not kept alive per read.
        let mut c = TcpStream::connect(&addr).unwrap();
        c.set_read_timeout(Some(Duration::from_millis(150))).unwrap();
        let t = Instant::now();
        let mut closed = false;
        while t.elapsed() < Duration::from_secs(4) {
            if c.write_all(b"G").is_err() {
                closed = true;
                break;
            }
            match c.read(&mut [0u8; 1]) {
                Ok(0) => {
                    closed = true;
                    break;
                }
                Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
                _ => {
                    closed = true;
                    break;
                }
            }
        }
        assert!(closed, "a trickling client kept its handler for {:?}", t.elapsed());
        assert!(t.elapsed() < Duration::from_millis(1500), "closed only after {:?}", t.elapsed());

        // 60 silent connections: no thread per connection.
        let before = threads();
        let idle: Vec<TcpStream> = (0..60).map(|_| TcpStream::connect(&addr).unwrap()).collect();
        std::thread::sleep(Duration::from_millis(300));
        let grown = threads().saturating_sub(before);
        assert!(grown <= 10, "{grown} threads for 60 idle connections");

        // When they time out, the handlers serve a real request again.
        std::thread::sleep(Duration::from_millis(800));
        drop(idle);
        let (head, body) = get(&base, &format!("/{token_path}/{sha}"), None);
        assert!(head.starts_with("HTTP/1.1 200"), "{head}");
        assert_eq!(body, data);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
