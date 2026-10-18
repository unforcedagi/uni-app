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
//! protocol. Android: the debug-built APK allows cleartext; a release build would need 127.0.0.1 in a network
//! security config.

use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

static BASE: OnceLock<Result<String, String>> = OnceLock::new();

/// `http://127.0.0.1:<port>/<token>`; the server starts on first use and lives as long as the app.
pub fn base(cache_dir: PathBuf) -> Result<String, String> {
    BASE.get_or_init(|| start(cache_dir)).clone()
}

fn start(cache_dir: PathBuf) -> Result<String, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("media server: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    // 244 random bits: another local user or a web page that reaches the port cannot guess a path.
    let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    let path_token = token.clone();
    std::thread::Builder::new()
        .name("unimedia-loopback".into())
        .spawn(move || {
            for conn in listener.incoming().flatten() {
                let (dir, token) = (cache_dir.clone(), path_token.clone());
                std::thread::spawn(move || {
                    let _ = serve(conn, &dir, &token);
                });
            }
        })
        .map_err(|e| e.to_string())?;
    tracing::info!(port, "media loopback server started");
    Ok(format!("http://127.0.0.1:{port}/{token}"))
}

fn serve(mut conn: TcpStream, dir: &Path, token: &str) -> std::io::Result<()> {
    conn.set_read_timeout(Some(Duration::from_secs(10)))?;
    // A paused player stops reading; give the thread and file back. It asks again with a Range on resume.
    conn.set_write_timeout(Some(Duration::from_secs(30)))?;
    let mut reader = BufReader::new(conn.try_clone()?);
    let mut line = String::new();
    (&mut reader).take(8192).read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let mut range = None;
    for _ in 0..100 {
        let mut h = String::new();
        if (&mut reader).take(8192).read_line(&mut h)? == 0 || h.trim().is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            if k.trim().eq_ignore_ascii_case("range") {
                range = Some(v.trim().to_string());
            }
        }
    }
    let sha = target
        .strip_prefix('/')
        .and_then(|p| p.strip_prefix(token))
        .and_then(|p| p.strip_prefix('/'))
        .unwrap_or("");
    let content_type = crate::MEDIA_STREAMS.lock().ok().and_then(|m| m.get(sha).cloned());
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
        let base = start(dir.clone()).unwrap();
        let token_path = base.splitn(4, '/').nth(3).unwrap().to_string();

        // Not allowed yet (not verified this session): 404.
        assert!(get(&base, &format!("/{token_path}/{sha}"), None).0.starts_with("HTTP/1.1 404"));
        crate::MEDIA_STREAMS.lock().unwrap().insert(sha.clone(), "video/mp4".into());

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
}
