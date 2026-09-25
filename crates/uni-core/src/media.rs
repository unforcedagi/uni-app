//! Message attachments: NIP-92 `imeta` parsing and authenticated Blossom reads.
//!
//! Buzz attaches uploaded files to a kind-9 message as `imeta` tags
//! (`["imeta", "url <u>", "m <mime>", "x <sha256>", "size <n>", "dim WxH", …]`)
//! and also writes a `![image](url)` / `[name](url)` line into the body.
//! [`parse_imeta`] mirrors Buzz desktop's `shared/ui/markdown/parseImeta.ts`
//! (space-split `key value` parts, keyed by `url`).
//!
//! Relay media (`https://<relay>/media/<sha256>.<ext>`) requires Blossom
//! (BUD-01) read auth: a kind-24242 event with `t=get`, an `expiration` and a
//! `server` tag scoped to the relay authority, sent as
//! `Authorization: Nostr <base64url(event json)>`. [`sign_blossom_get`]
//! mirrors `buzz-cli/src/client.rs::sign_blossom_get` and
//! `desktop/src-tauri/src/commands/media.rs::sign_blossom_get_auth_header`.
//! Like Buzz, the token is only ever sent to the relay's own origin
//! ([`media_sha_from_url`] enforces it) and redirects are never followed, so a
//! 3xx cannot forward it elsewhere (`app_state.rs::build_media_fetch_client`).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use nostr::base64::engine::general_purpose::URL_SAFE_NO_PAD;
use nostr::base64::Engine as _;
use nostr::hashes::{sha256, Hash as _};
use nostr::{EventBuilder, JsonUtil as _, Keys, Kind, Tag, Timestamp};
use serde::Serialize;

use crate::{Error, Result};

/// Largest blob we download (Buzz desktop allows 50 MB; a phone needs less).
pub const MAX_MEDIA_BYTES: u64 = 25 * 1024 * 1024;
/// Lifetime of a `t=get` token (Buzz: `MEDIA_GET_AUTH_EXPIRY_SECS`).
pub const MEDIA_GET_AUTH_EXPIRY_SECS: u64 = 600;
/// Most `imeta` entries kept per message.
pub const MAX_IMETA_PER_MESSAGE: usize = 20;
const FETCH_TIMEOUT: Duration = Duration::from_secs(60);

/// One NIP-92 attachment on a message.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct MediaRef {
    pub url: String,
    /// `m`: MIME type.
    pub mime: Option<String>,
    /// `x`: lowercase hex SHA-256 of the blob (validated).
    pub sha256: Option<String>,
    pub size: Option<i64>,
    /// `dim`: `WIDTHxHEIGHT`.
    pub dim: Option<String>,
    pub blurhash: Option<String>,
    pub alt: Option<String>,
    pub filename: Option<String>,
}

fn is_sha256_hex(v: &str) -> bool {
    v.len() == 64 && v.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

/// Parse every `imeta` tag of an event (tag slices), in tag order.
///
/// Same rules as Buzz's `parseImetaTags`: each part is `key value` split at
/// the first space; parts without a space are skipped; entries without a
/// `url` are dropped; a repeated url keeps its first position and the later
/// entry's fields. Additionally (defensive, this is untrusted data): only
/// http(s) urls, `x` must be 64 lowercase hex, at most
/// [`MAX_IMETA_PER_MESSAGE`] entries.
pub fn parse_imeta<'a, I>(tags: I) -> Vec<MediaRef>
where
    I: IntoIterator<Item = &'a [String]>,
{
    let mut out: Vec<MediaRef> = Vec::new();
    for parts in tags {
        if parts.first().map(String::as_str) != Some("imeta") {
            continue;
        }
        let mut m = MediaRef::default();
        for part in &parts[1..] {
            let Some((key, val)) = part.split_once(' ') else {
                continue;
            };
            let v = || Some(val.to_string()).filter(|s| !s.is_empty());
            match key {
                "url" => m.url = val.trim().to_string(),
                "m" => m.mime = v().map(|s| s.to_ascii_lowercase()),
                "x" => {
                    m.sha256 = Some(val.trim().to_ascii_lowercase()).filter(|s| is_sha256_hex(s))
                }
                "size" => m.size = val.trim().parse::<i64>().ok().filter(|n| *n >= 0),
                "dim" => m.dim = v().filter(|d| parse_dim(d).is_some()),
                "blurhash" => m.blurhash = v(),
                "alt" => m.alt = v(),
                "filename" => m.filename = v(),
                _ => {}
            }
        }
        let lower = m.url.to_ascii_lowercase();
        if !(lower.starts_with("https://") || lower.starts_with("http://")) {
            continue;
        }
        if let Some(existing) = out.iter_mut().find(|e| e.url == m.url) {
            *existing = m;
        } else if out.len() < MAX_IMETA_PER_MESSAGE {
            out.push(m);
        }
    }
    out
}

/// `"1024x768"` → `(1024, 768)`.
pub fn parse_dim(dim: &str) -> Option<(u32, u32)> {
    let (w, h) = dim.trim().split_once('x')?;
    let (w, h) = (w.parse().ok()?, h.parse().ok()?);
    (w > 0 && h > 0).then_some((w, h))
}

/// The relay's HTTP origin for a `ws(s)://` relay URL.
fn relay_http_origin(relay_url: &str) -> Result<url::Url> {
    let mut u =
        url::Url::parse(relay_url).map_err(|e| Error::Invalid(format!("relay URL: {e}")))?;
    let scheme = match u.scheme() {
        "wss" | "https" => "https",
        "ws" | "http" => "http",
        s => return Err(Error::Invalid(format!("relay URL scheme {s}"))),
    };
    u.set_scheme(scheme)
        .map_err(|_| Error::Invalid("relay URL scheme".into()))?;
    Ok(u)
}

/// True for `https://<relay>/media/<sha256>[.<ext>]` on *our* relay.
pub fn is_relay_media_url(relay_url: &str, url: &str) -> bool {
    media_sha_from_url(relay_url, url).is_ok()
}

/// Validate that `url` is a media blob on the relay's own origin and return
/// its hash. Mirrors `validate_download_url` (desktop) and
/// `media_url_from_input` (CLI): same origin as the relay, `/media/` path,
/// `sha256` or `sha256.ext` segment; https, or http only for localhost.
/// Thumbnails (`sha.thumb.jpg`) are refused: their bytes don't hash to the name.
pub fn media_sha_from_url(relay_url: &str, url: &str) -> Result<String> {
    let parsed = url::Url::parse(url.trim()).map_err(|_| Error::Invalid("media URL".into()))?;
    let relay = relay_http_origin(relay_url)?;
    match parsed.scheme() {
        "https" => {}
        "http" if matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")) => {}
        _ => return Err(Error::Invalid("media URL must use https".into())),
    }
    if parsed.scheme() != relay.scheme()
        || !parsed
            .host_str()
            .zip(relay.host_str())
            .is_some_and(|(a, b)| a.eq_ignore_ascii_case(b))
        || parsed.port_or_known_default() != relay.port_or_known_default()
    {
        return Err(Error::Invalid("media URL is not on this relay".into()));
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(Error::Invalid("media URL must not carry a query".into()));
    }
    let seg = parsed
        .path()
        .strip_prefix("/media/")
        .ok_or_else(|| Error::Invalid("media URL must be a /media/ path".into()))?;
    let (hash, ext) = match seg.split_once('.') {
        Some((h, e)) => (h, Some(e)),
        None => (seg, None),
    };
    let ext_ok = ext.is_none_or(|e| {
        !e.is_empty()
            && e.len() <= 8
            && e.bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    });
    if !is_sha256_hex(hash) || !ext_ok {
        return Err(Error::Invalid(
            "media path must be sha256 or sha256.ext".into(),
        ));
    }
    Ok(hash.to_string())
}

/// Sign a Blossom `t=get` token scoped to the relay's authority and return
/// the full `Authorization` header value (`Nostr <base64url>`).
pub fn sign_blossom_get(keys: &Keys, relay_url: &str) -> Result<String> {
    let server = buzz_core::tenant::relay_url_authority(relay_url);
    if server.is_empty() {
        return Err(Error::Invalid(
            "cannot derive server authority from relay URL".into(),
        ));
    }
    let exp = (Timestamp::now().as_secs() + MEDIA_GET_AUTH_EXPIRY_SECS).to_string();
    let tag = |parts: [&str; 2]| Tag::parse(parts).map_err(|e| Error::Invalid(e.to_string()));
    let event = EventBuilder::new(Kind::from(24242), "Get media")
        .tags([
            tag(["t", "get"])?,
            tag(["expiration", &exp])?,
            tag(["server", &server])?,
        ])
        .sign_with_keys(keys)
        .map_err(|e| Error::Invalid(format!("signing failed: {e}")))?;
    Ok(format!(
        "Nostr {}",
        URL_SAFE_NO_PAD.encode(event.as_json().as_bytes())
    ))
}

/// Lowercase hex SHA-256.
pub fn sha256_hex(bytes: &[u8]) -> String {
    sha256::Hash::hash(bytes).to_string()
}

/// Where a blob with this hash is cached.
pub fn cache_path(cache_dir: &Path, sha: &str) -> Result<PathBuf> {
    if !is_sha256_hex(sha) {
        return Err(Error::Invalid("bad sha256".into()));
    }
    Ok(cache_dir.join(sha))
}

/// Cached bytes for `sha`, re-verified (a corrupt file is removed).
pub fn read_cached(cache_dir: &Path, sha: &str) -> Option<Vec<u8>> {
    let path = cache_path(cache_dir, sha).ok()?;
    let bytes = std::fs::read(&path).ok()?;
    if sha256_hex(&bytes) == sha {
        Some(bytes)
    } else {
        let _ = std::fs::remove_file(&path);
        None
    }
}

fn http_client() -> Result<reqwest::Client> {
    // Mozilla roots (the same set tokio-tungstenite uses for the relay socket),
    // not the platform verifier: that one needs JNI setup on Android.
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let provider = rustls::crypto::CryptoProvider::get_default()
        .cloned()
        .unwrap_or_else(|| Arc::new(rustls::crypto::ring::default_provider()));
    let tls = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| Error::Media(format!("tls: {e}")))?
        .with_root_certificates(roots)
        .with_no_client_auth();
    reqwest::Client::builder()
        .tls_backend_preconfigured(tls)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(FETCH_TIMEOUT)
        .build()
        .map_err(|e| Error::Media(format!("http client: {e}")))
}

/// Fetch a relay media blob with Blossom auth, verify its SHA-256 against the
/// URL (and `expected_sha`, the `imeta` `x`, when given), cache it under
/// `cache_dir/<sha256>` and return the bytes. A verified cache hit skips the
/// network entirely.
pub async fn fetch_media(
    relay_url: &str,
    keys: &Keys,
    url: &str,
    expected_sha: Option<&str>,
    cache_dir: &Path,
) -> Result<Vec<u8>> {
    let sha = media_sha_from_url(relay_url, url)?;
    if let Some(x) = expected_sha.filter(|x| !x.is_empty()) {
        if !x.eq_ignore_ascii_case(&sha) {
            return Err(Error::Media(
                "imeta hash does not match the media URL".into(),
            ));
        }
    }
    if let Some(bytes) = read_cached(cache_dir, &sha) {
        return Ok(bytes);
    }
    crate::init_crypto();
    let auth = sign_blossom_get(keys, relay_url)?;
    let mut resp = http_client()?
        .get(url.trim())
        .header("Authorization", auth)
        .send()
        .await
        .map_err(|e| Error::Media(format!("request failed: {e}")))?;
    let status = resp.status();
    if status.is_redirection() {
        return Err(Error::Media(format!(
            "relay redirected media request ({status}); refused"
        )));
    }
    if !status.is_success() {
        return Err(Error::Media(format!("relay answered {status}")));
    }
    if resp.content_length().is_some_and(|n| n > MAX_MEDIA_BYTES) {
        return Err(Error::Media("file is too large".into()));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| Error::Media(format!("download failed: {e}")))?
    {
        if (bytes.len() + chunk.len()) as u64 > MAX_MEDIA_BYTES {
            return Err(Error::Media("file is too large".into()));
        }
        bytes.extend_from_slice(&chunk);
    }
    if sha256_hex(&bytes) != sha {
        return Err(Error::Media(
            "downloaded file failed its integrity check".into(),
        ));
    }
    // Best effort: a cache write failure still returns the verified bytes.
    if std::fs::create_dir_all(cache_dir).is_ok() {
        let path = cache_dir.join(&sha);
        let tmp = cache_dir.join(format!("{sha}.{}.part", uuid::Uuid::new_v4()));
        if std::fs::write(&tmp, &bytes).is_ok() && std::fs::rename(&tmp, &path).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::JsonUtil;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn tags(v: &[&[&str]]) -> Vec<Vec<String>> {
        v.iter()
            .map(|t| t.iter().map(|s| s.to_string()).collect())
            .collect()
    }
    fn parse(v: &[&[&str]]) -> Vec<MediaRef> {
        let t = tags(v);
        parse_imeta(t.iter().map(Vec::as_slice))
    }
    const H: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn imeta_parses_buzz_fields() {
        let url = format!("https://buzz.example/media/{H}.png");
        let m = parse(&[
            &["h", "x"],
            &[
                "imeta",
                &format!("url {url}"),
                "m image/png",
                &format!("x {H}"),
                "size 1234",
                "dim 640x480",
                "blurhash LEHV6nWB2y",
                "alt a cat on a mat",
                "filename cat.png",
                "junk",
            ],
        ]);
        assert_eq!(
            m,
            vec![MediaRef {
                url,
                mime: Some("image/png".into()),
                sha256: Some(H.into()),
                size: Some(1234),
                dim: Some("640x480".into()),
                blurhash: Some("LEHV6nWB2y".into()),
                alt: Some("a cat on a mat".into()),
                filename: Some("cat.png".into()),
            }]
        );
    }

    #[test]
    fn imeta_rejects_bad_values_and_dedupes_by_url() {
        let m = parse(&[
            &["imeta", "m image/png"], // no url
            &["imeta", "url javascript:alert(1)"],
            &["imeta", "url https://a/1", "x nothex", "size -3", "dim big"],
            &["imeta", "url https://a/2"],
            &["imeta", "url https://a/1", "m IMAGE/JPEG"],
        ]);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].url, "https://a/1");
        assert_eq!(m[0].mime.as_deref(), Some("image/jpeg"));
        assert_eq!(m[0].sha256, None);
        assert_eq!(m[1].url, "https://a/2");
        let first = parse(&[&["imeta", "url https://a/3", "x nothex", "size -3", "dim big"]]);
        assert_eq!(
            (
                first[0].sha256.as_ref(),
                first[0].size,
                first[0].dim.as_ref()
            ),
            (None, None, None)
        );
        let many: Vec<Vec<String>> = (0..30)
            .map(|i| vec!["imeta".into(), format!("url https://a/{i}")])
            .collect();
        assert_eq!(
            parse_imeta(many.iter().map(Vec::as_slice)).len(),
            MAX_IMETA_PER_MESSAGE
        );
    }

    #[test]
    fn media_urls_must_be_on_the_relay_origin() {
        let relay = "wss://buzz.example";
        assert_eq!(
            media_sha_from_url(relay, &format!("https://buzz.example/media/{H}.jpg")).unwrap(),
            H
        );
        assert_eq!(
            media_sha_from_url(relay, &format!("https://Buzz.Example:443/media/{H}")).unwrap(),
            H
        );
        for bad in [
            format!("https://evil.example/media/{H}.jpg"),
            format!("http://buzz.example/media/{H}.jpg"),
            format!("https://buzz.example:8443/media/{H}.jpg"),
            format!("https://buzz.example/files/{H}.jpg"),
            format!("https://buzz.example/media/{H}.thumb.jpg"),
            format!("https://buzz.example/media/{H}.jpg?x=1"),
            "https://buzz.example/media/abc.jpg".to_string(),
            format!("https://buzz.example/media/{}.jpg", H.to_uppercase()),
        ] {
            assert!(media_sha_from_url(relay, &bad).is_err(), "{bad}");
        }
        assert!(
            media_sha_from_url("ws://127.0.0.1:9", &format!("http://127.0.0.1:9/media/{H}"))
                .is_ok()
        );
    }

    fn decode_auth(header: &str) -> nostr::Event {
        let b64 = header.strip_prefix("Nostr ").unwrap();
        let json = URL_SAFE_NO_PAD.decode(b64).unwrap();
        let ev = nostr::Event::from_json(std::str::from_utf8(&json).unwrap()).unwrap();
        ev.verify().unwrap();
        ev
    }

    /// Same assertions as buzz-cli's `media_get_auth_header_is_server_scoped`.
    #[test]
    fn blossom_get_token_matches_buzz_shape() {
        let keys = Keys::generate();
        let ev = decode_auth(&sign_blossom_get(&keys, "wss://relay.example:443").unwrap());
        assert_eq!(ev.kind, Kind::from(24242));
        assert_eq!(ev.pubkey, keys.public_key());
        let t: Vec<Vec<String>> = ev.tags.iter().map(|t| t.as_slice().to_vec()).collect();
        assert!(t.iter().any(|t| t == &["t", "get"]));
        assert!(t.iter().any(|t| t == &["server", "relay.example"]));
        assert!(!t.iter().any(|t| t[0] == "x"));
        let exp: u64 = t.iter().find(|t| t[0] == "expiration").unwrap()[1]
            .parse()
            .unwrap();
        let now = Timestamp::now().as_secs();
        assert!(exp > now && exp <= now + MEDIA_GET_AUTH_EXPIRY_SECS);
    }

    /// Tiny HTTP/1.1 server: serves `status` + `body` for every request and
    /// reports each request's `Authorization` header.
    async fn serve(
        status: &'static str,
        body: Vec<u8>,
    ) -> (u16, tokio::sync::mpsc::UnboundedReceiver<Option<String>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 1024];
                while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    let n = sock.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                let req = String::from_utf8_lossy(&buf).to_string();
                let auth = req.lines().find_map(|l| {
                    let (k, v) = l.split_once(':')?;
                    k.eq_ignore_ascii_case("authorization")
                        .then(|| v.trim().to_string())
                });
                let _ = tx.send(auth);
                let head = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = sock.write_all(head.as_bytes()).await;
                let _ = sock.write_all(&body).await;
                let _ = sock.shutdown().await;
            }
        });
        (port, rx)
    }

    #[tokio::test]
    async fn fetch_sends_blossom_auth_verifies_and_caches() {
        let body = b"\x89PNG fake image bytes".to_vec();
        let sha = sha256_hex(&body);
        let (port, mut seen) = serve("200 OK", body.clone()).await;
        let relay = format!("ws://127.0.0.1:{port}");
        let url = format!("http://127.0.0.1:{port}/media/{sha}.png");
        let dir = tempfile::tempdir().unwrap();
        let keys = Keys::generate();

        let got = fetch_media(&relay, &keys, &url, Some(&sha), dir.path())
            .await
            .unwrap();
        assert_eq!(got, body);
        let ev = decode_auth(&seen.recv().await.unwrap().expect("Authorization header"));
        assert_eq!(ev.kind, Kind::from(24242));
        assert_eq!(ev.pubkey, keys.public_key());
        let t: Vec<Vec<String>> = ev.tags.iter().map(|t| t.as_slice().to_vec()).collect();
        assert!(t
            .iter()
            .any(|t| t == &["server", format!("127.0.0.1:{port}").as_str()]));
        assert_eq!(std::fs::read(dir.path().join(&sha)).unwrap(), body);

        // Cache hit: no second request.
        let again = fetch_media(&relay, &keys, &url, None, dir.path())
            .await
            .unwrap();
        assert_eq!(again, body);
        assert!(seen.try_recv().is_err());

        // `x` that disagrees with the URL is refused before any request.
        let other = "f".repeat(64);
        assert!(fetch_media(&relay, &keys, &url, Some(&other), dir.path())
            .await
            .is_err());
        // Auth is never sent off-relay.
        let off = format!("http://localhost:{port}/media/{sha}.png");
        assert!(fetch_media(&relay, &keys, &off, None, dir.path())
            .await
            .is_err());
        assert!(seen.try_recv().is_err());
    }

    #[tokio::test]
    async fn fetch_rejects_tampered_bytes_and_errors() {
        let (port, _seen) = serve("200 OK", b"not what was promised".to_vec()).await;
        let relay = format!("ws://127.0.0.1:{port}");
        let dir = tempfile::tempdir().unwrap();
        let keys = Keys::generate();
        let err = fetch_media(
            &relay,
            &keys,
            &format!("http://127.0.0.1:{port}/media/{H}.jpg"),
            None,
            dir.path(),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("integrity"), "{err}");
        assert!(!dir.path().join(H).exists());

        let (port, _seen) = serve("401 Unauthorized", b"authentication failed".to_vec()).await;
        let err = fetch_media(
            &format!("ws://127.0.0.1:{port}"),
            &keys,
            &format!("http://127.0.0.1:{port}/media/{H}.jpg"),
            None,
            dir.path(),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("401"), "{err}");

        let (port, _seen) = serve("302 Found", Vec::new()).await;
        let err = fetch_media(
            &format!("ws://127.0.0.1:{port}"),
            &keys,
            &format!("http://127.0.0.1:{port}/media/{H}.jpg"),
            None,
            dir.path(),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("redirect"), "{err}");
    }
}
