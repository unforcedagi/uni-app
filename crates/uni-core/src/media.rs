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
use serde::{Deserialize, Serialize};

use crate::{Error, Result};

/// Largest blob we download into memory: images and PDF previews (Buzz
/// desktop allows 50 MB; a phone needs less).
pub const MAX_MEDIA_BYTES: u64 = 25 * 1024 * 1024;
/// Largest video, audio or file we stream to the disk cache (T-172: Buzz
/// videos are routinely 30–50 MB). Played and opened from disk, never held whole.
pub const MAX_STREAM_MEDIA_BYTES: u64 = 500 * 1024 * 1024;
/// The media cache is trimmed, oldest first, to this after each streamed download.
pub const MEDIA_CACHE_BUDGET: u64 = 2 * 1024 * 1024 * 1024;
/// Most bytes one local playback response carries; players ask for the rest
/// with further `Range` requests (Tauri's asset protocol uses ~1 MB too).
pub const MAX_RANGE_CHUNK: u64 = 1024 * 1024;
/// Upload cap keeps the raw IPC payload and Rust/relay buffers practical on mobile.
pub const MAX_UPLOAD_BYTES: usize = 25 * 1024 * 1024;
/// Lifetime of a `t=get` token (Buzz: `MEDIA_GET_AUTH_EXPIRY_SECS`).
pub const MEDIA_GET_AUTH_EXPIRY_SECS: u64 = 600;
/// Most `imeta` entries kept per message.
pub const MAX_IMETA_PER_MESSAGE: usize = 20;
const FETCH_TIMEOUT: Duration = Duration::from_secs(60);
/// Whole-transfer limit for a streamed download; each read still has to
/// arrive within [`FETCH_TIMEOUT`].
const STREAM_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// One NIP-92 attachment on a message.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
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

/// Blossom BUD-02 upload authorization, scoped to this hash and relay.
pub fn sign_blossom_upload(keys: &Keys, relay_url: &str, sha: &str) -> Result<String> {
    if !is_sha256_hex(sha) {
        return Err(Error::Invalid("invalid upload hash".into()));
    }
    let server = buzz_core::tenant::relay_url_authority(relay_url);
    if server.is_empty() {
        return Err(Error::Invalid("cannot derive server authority".into()));
    }
    let exp = (Timestamp::now().as_secs() + MEDIA_GET_AUTH_EXPIRY_SECS).to_string();
    let tag = |parts: [&str; 2]| Tag::parse(parts).map_err(|e| Error::Invalid(e.to_string()));
    let event = EventBuilder::new(Kind::from(24242), "Upload file")
        .tags([
            tag(["t", "upload"])?,
            tag(["x", sha])?,
            tag(["expiration", &exp])?,
            tag(["server", &server])?,
        ])
        .sign_with_keys(keys)
        .map_err(|e| Error::Media(format!("signing failed: {e}")))?;
    Ok(format!(
        "Nostr {}",
        URL_SAFE_NO_PAD.encode(event.as_json().as_bytes())
    ))
}

/// Upload raw bytes from the file picker, paste, drag/drop or future voice input.
/// The relay sniffs the bytes and returns canonical MIME, size and dimensions;
/// never construct imeta from untrusted browser MIME hints. No redirects may
/// carry Blossom authorization off-origin. The legacy route only supports images.
pub async fn upload_media(
    relay_url: &str,
    keys: &Keys,
    bytes: Vec<u8>,
    mime: &str,
    filename: &str,
) -> Result<MediaRef> {
    if bytes.is_empty() || bytes.len() > MAX_UPLOAD_BYTES {
        return Err(Error::Media("file is empty or exceeds 25 MB".into()));
    }
    let filename: String = filename
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(filename)
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(255)
        .collect();
    let filename = if filename.is_empty() {
        "file".to_string()
    } else {
        filename
    };
    let bytes = sanitize_image_for_upload(bytes)?;
    let sha = sha256_hex(&bytes);
    crate::init_crypto();
    let auth = sign_blossom_upload(keys, relay_url, &sha)?;
    let origin = relay_http_origin(relay_url)?;
    let base = origin.as_str().trim_end_matches('/');
    // The relay treats Content-Type as advisory and validates the actual bytes.
    let hint = if mime.is_empty() || mime.contains(['\r', '\n']) {
        "application/octet-stream"
    } else {
        mime
    };
    let client = http_client()?;
    let mut response = client
        .put(format!("{base}/upload"))
        .header("Authorization", &auth)
        .header("Content-Type", hint)
        .header("X-SHA-256", &sha)
        .body(bytes.clone())
        .send()
        .await
        .map_err(|e| Error::Media(format!("upload failed: {e}")))?;
    if matches!(response.status().as_u16(), 404 | 405) {
        response = client
            .put(format!("{base}/media/upload"))
            .header("Authorization", &auth)
            .header("Content-Type", hint)
            .header("X-SHA-256", &sha)
            .body(bytes)
            .send()
            .await
            .map_err(|e| Error::Media(format!("upload failed: {e}")))?;
    }
    if !response.status().is_success() {
        let status = response.status();
        let reason = response.text().await.unwrap_or_default();
        let brief: String = reason.chars().take(400).collect();
        return Err(Error::Media(format!("upload rejected ({status}): {brief}")));
    }
    #[derive(serde::Deserialize)]
    struct BlobDescriptor {
        url: String,
        sha256: String,
        size: u64,
        #[serde(rename = "type")]
        mime: String,
        dim: Option<String>,
        blurhash: Option<String>,
    }
    let d: BlobDescriptor = response
        .json()
        .await
        .map_err(|e| Error::Media(format!("invalid upload response: {e}")))?;
    if d.sha256 != sha
        || d.size == 0
        || d.size > MAX_UPLOAD_BYTES as u64
        || media_sha_from_url(relay_url, &d.url).ok().as_deref() != Some(&sha)
        || !d.mime.contains('/')
        || d.mime.contains(['\r', '\n'])
    {
        return Err(Error::Media(
            "relay returned inconsistent upload metadata".into(),
        ));
    }
    Ok(MediaRef {
        url: d.url,
        mime: Some(d.mime),
        sha256: Some(sha),
        size: Some(d.size as i64),
        dim: d.dim.filter(|v| parse_dim(v).is_some()),
        blurhash: d.blurhash,
        alt: None,
        filename: Some(filename),
    })
}

/// PNG ancillary chunks that affect only rendering and that the relay accepts.
/// Everything else ancillary (eXIf, iCCP, iTXt/tEXt/zTXt, pHYs, tIME, vendor
/// chunks such as Apple's iDOT) is a metadata channel the relay rejects.
const PNG_KEEP_ANCILLARY: [&[u8; 4]; 11] = [
    b"cHRM", b"gAMA", b"sBIT", b"sRGB", b"bKGD", b"hIST", b"tRNS", b"sPLT", b"acTL", b"fcTL",
    b"fdAT",
];

/// Remove metadata from PNG structurally: keep critical chunks and the
/// rendering/animation chunks above, drop the rest and anything after IEND.
/// Pixels (and APNG frames) are untouched, so this is lossless and cheap even
/// for large screenshots. Returns None when the bytes aren't a well-formed PNG.
fn strip_png_metadata(bytes: &[u8]) -> Option<Vec<u8>> {
    const SIG: &[u8] = b"\x89PNG\r\n\x1a\n";
    if !bytes.starts_with(SIG) {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len());
    out.extend_from_slice(SIG);
    let mut i = SIG.len();
    loop {
        let header = bytes.get(i..i + 8)?;
        let len = u32::from_be_bytes(header[..4].try_into().ok()?) as usize;
        let kind: &[u8; 4] = header[4..8].try_into().ok()?;
        let end = i.checked_add(12)?.checked_add(len)?;
        if end > bytes.len() {
            return None;
        }
        let ancillary = kind[0] & 0x20 != 0;
        if !ancillary || PNG_KEEP_ANCILLARY.contains(&kind) {
            out.extend_from_slice(&bytes[i..end]);
        }
        if kind == b"IEND" {
            return Some(out);
        }
        i = end;
    }
}

/// Make an image acceptable to Buzz's relay, which refuses any upload that
/// carries metadata (EXIF location, camera/device details, colour profiles,
/// XMP) rather than silently storing it. Mirrors Buzz desktop's
/// `sanitize_image_for_upload`:
/// - PNG (incl. macOS screenshots and APNG): lossless structural strip.
/// - JPEG / WebP: decode, bake in EXIF orientation, re-encode clean.
/// - Anything else (GIF, audio, video, files) passes through; the relay's
///   own validator stays the authority.
pub fn sanitize_image_for_upload(bytes: Vec<u8>) -> Result<Vec<u8>> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return strip_png_metadata(&bytes)
            .ok_or_else(|| Error::Media("image is not a valid PNG".into()));
    }
    let format = if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        image::ImageFormat::Jpeg
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        // Animated WebP would be flattened by a re-encode; leave it to the relay.
        if bytes.windows(4).any(|w| w == b"ANIM") {
            return Ok(bytes);
        }
        image::ImageFormat::WebP
    } else {
        return Ok(bytes);
    };
    use image::ImageDecoder as _;
    let bad = |what: &str| Error::Media(format!("could not {what} while removing image metadata"));
    let mut decoder = image::ImageReader::with_format(std::io::Cursor::new(&bytes), format)
        .into_decoder()
        .map_err(|_| bad("decode the image"))?;
    decoder
        .set_limits(image::Limits::default())
        .map_err(|_| bad("decode an image this large"))?;
    let orientation = decoder.orientation().map_err(|_| bad("read orientation"))?;
    let mut img =
        image::DynamicImage::from_decoder(decoder).map_err(|_| bad("decode the image"))?;
    img.apply_orientation(orientation);
    let mut out = std::io::Cursor::new(Vec::new());
    if format == image::ImageFormat::Jpeg {
        let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 92);
        img.to_rgb8()
            .write_with_encoder(enc)
            .map_err(|_| bad("re-encode the image"))?;
    } else {
        img.write_to(&mut out, format)
            .map_err(|_| bad("re-encode the image"))?;
    }
    Ok(out.into_inner())
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

/// Cached bytes for `sha`, re-verified (a corrupt file is removed). A file
/// over [`MAX_MEDIA_BYTES`] is a streamed video or file, not ours to load
/// into memory: it is left alone.
pub fn read_cached(cache_dir: &Path, sha: &str) -> Option<Vec<u8>> {
    let path = cache_path(cache_dir, sha).ok()?;
    if std::fs::metadata(&path).ok()?.len() > MAX_MEDIA_BYTES {
        return None;
    }
    let bytes = std::fs::read(&path).ok()?;
    if bytes.len() as u64 <= MAX_MEDIA_BYTES && sha256_hex(&bytes) == sha {
        Some(bytes)
    } else {
        let _ = std::fs::remove_file(&path);
        None
    }
}

/// The cached file for `sha` if it is at most `max` bytes and still hashes to
/// its name (read in chunks, never whole). A corrupt file is removed; a hit
/// is marked recently used for [`prune_cache`].
pub fn verified_cache_file(cache_dir: &Path, sha: &str, max: u64) -> Option<PathBuf> {
    use std::io::Read as _;
    let path = cache_path(cache_dir, sha).ok()?;
    let mut file = std::fs::File::open(&path).ok()?;
    if file.metadata().ok()?.len() > max {
        return None;
    }
    let mut engine = sha256::Hash::engine();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        match file.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => nostr::hashes::HashEngine::input(&mut engine, &buf[..n]),
            Err(_) => return None,
        }
    }
    if sha256::Hash::from_engine(engine).to_string() != sha {
        drop(file);
        let _ = std::fs::remove_file(&path);
        return None;
    }
    let _ = std::fs::File::options()
        .append(true)
        .open(&path)
        .and_then(|f| f.set_modified(std::time::SystemTime::now()));
    Some(path)
}

/// Trim the cache to `budget` bytes, least recently used first, never
/// touching `keep`. Stale `.part` files from interrupted downloads go too.
pub fn prune_cache(cache_dir: &Path, keep: &str, budget: u64) {
    let Ok(entries) = std::fs::read_dir(cache_dir) else {
        return;
    };
    let day = Duration::from_secs(24 * 3600);
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = Vec::new();
    for e in entries.flatten() {
        let Ok(meta) = e.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let modified = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        let name = e.file_name().to_string_lossy().into_owned();
        if name.ends_with(".part") {
            if modified.elapsed().is_ok_and(|age| age > day) {
                let _ = std::fs::remove_file(e.path());
            }
            continue;
        }
        if name != keep {
            files.push((modified, meta.len(), e.path()));
        }
    }
    let keep_len = std::fs::metadata(cache_dir.join(keep)).map_or(0, |m| m.len());
    let mut total = keep_len + files.iter().map(|f| f.1).sum::<u64>();
    files.sort();
    for (_, len, path) in files {
        if total <= budget {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total -= len;
        }
    }
}

pub(crate) fn http_client() -> Result<reqwest::Client> {
    http_client_with_timeout(FETCH_TIMEOUT)
}

/// Same TLS and no-redirect policy as [`http_client`], with a caller timeout.
pub(crate) fn http_client_with_timeout(timeout: Duration) -> Result<reqwest::Client> {
    client_with(timeout, reqwest::redirect::Policy::none())
}

/// HTTPS client with the bundled Mozilla roots that follows up to 5
/// redirects (GitHub release downloads redirect to a CDN). Use this instead of
/// a bare `reqwest::Client` on Android, where the platform verifier fails
/// without JNI setup.
pub fn https_client_following_redirects(timeout: Duration) -> Result<reqwest::Client> {
    client_with(timeout, reqwest::redirect::Policy::limited(5))
}

fn client_with(timeout: Duration, redirect: reqwest::redirect::Policy) -> Result<reqwest::Client> {
    client_builder(redirect)?
        .timeout(timeout)
        .build()
        .map_err(|e| Error::Media(format!("http client: {e}")))
}

fn client_builder(redirect: reqwest::redirect::Policy) -> Result<reqwest::ClientBuilder> {
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
    Ok(reqwest::Client::builder()
        .tls_backend_preconfigured(tls)
        .redirect(redirect))
}

/// The hash a relay media URL names, checked against the `imeta` `x`.
fn checked_media_sha(relay_url: &str, url: &str, expected_sha: Option<&str>) -> Result<String> {
    let sha = media_sha_from_url(relay_url, url)?;
    if let Some(x) = expected_sha.filter(|x| !x.is_empty()) {
        if !x.eq_ignore_ascii_case(&sha) {
            return Err(Error::Media(
                "imeta hash does not match the media URL".into(),
            ));
        }
    }
    Ok(sha)
}

fn too_large(max: u64) -> Error {
    Error::Media(format!(
        "file is too large (over {} MB)",
        max / (1024 * 1024)
    ))
}

/// GET a relay media blob with Blossom `t=get` auth. Redirects and error
/// statuses are refused, and so is a declared length over `max`.
async fn get_relay_media(
    client: &reqwest::Client,
    relay_url: &str,
    keys: &Keys,
    url: &str,
    max: u64,
) -> Result<reqwest::Response> {
    crate::init_crypto();
    let auth = sign_blossom_get(keys, relay_url)?;
    let resp = client
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
    if resp.content_length().is_some_and(|n| n > max) {
        return Err(too_large(max));
    }
    Ok(resp)
}

/// Fetch a relay media blob with Blossom auth, verify its SHA-256 against the
/// URL (and `expected_sha`, the `imeta` `x`, when given), cache it under
/// `cache_dir/<sha256>` and return the bytes. A verified cache hit skips the
/// network entirely. For images and previews: capped at [`MAX_MEDIA_BYTES`];
/// videos and files go through [`fetch_media_to_file`].
pub async fn fetch_media(
    relay_url: &str,
    keys: &Keys,
    url: &str,
    expected_sha: Option<&str>,
    cache_dir: &Path,
) -> Result<Vec<u8>> {
    let sha = checked_media_sha(relay_url, url, expected_sha)?;
    if let Some(bytes) = read_cached(cache_dir, &sha) {
        return Ok(bytes);
    }
    let mut resp = get_relay_media(&http_client()?, relay_url, keys, url, MAX_MEDIA_BYTES).await?;
    let mut bytes = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| Error::Media(format!("download failed: {e}")))?
    {
        if (bytes.len() + chunk.len()) as u64 > MAX_MEDIA_BYTES {
            return Err(too_large(MAX_MEDIA_BYTES));
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
        if std::fs::write(&tmp, &bytes).is_ok() {
            if std::fs::rename(&tmp, &path).is_err() {
                let _ = std::fs::remove_file(&tmp);
            }
        } else {
            let _ = std::fs::remove_file(&tmp);
        }
    }
    Ok(bytes)
}

/// Like [`fetch_media`], but streams the blob (at most `max` bytes) straight
/// into `cache_dir/<sha256>`, hashing as it goes, and returns the path. Memory
/// use stays at one network chunk however large the file. Nothing is stored
/// under the hash name unless it verified; a verified cache hit skips the
/// network. Afterwards the cache is trimmed to [`MEDIA_CACHE_BUDGET`].
pub async fn fetch_media_to_file(
    relay_url: &str,
    keys: &Keys,
    url: &str,
    expected_sha: Option<&str>,
    cache_dir: &Path,
    max: u64,
) -> Result<PathBuf> {
    use std::io::Write as _;
    let sha = checked_media_sha(relay_url, url, expected_sha)?;
    if let Some(path) = verified_cache_file(cache_dir, &sha, max) {
        return Ok(path);
    }
    let client = client_builder(reqwest::redirect::Policy::none())?
        .timeout(STREAM_TIMEOUT)
        .read_timeout(FETCH_TIMEOUT)
        .build()
        .map_err(|e| Error::Media(format!("http client: {e}")))?;
    let mut resp = get_relay_media(&client, relay_url, keys, url, max).await?;
    let disk = |e: std::io::Error| Error::Media(format!("could not write the media cache: {e}"));
    std::fs::create_dir_all(cache_dir).map_err(disk)?;
    let path = cache_dir.join(&sha);
    let tmp = cache_dir.join(format!("{sha}.{}.part", uuid::Uuid::new_v4()));
    let result = async {
        let mut file = std::fs::File::create(&tmp).map_err(disk)?;
        let mut engine = sha256::Hash::engine();
        let mut len = 0u64;
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| Error::Media(format!("download failed: {e}")))?
        {
            len += chunk.len() as u64;
            if len > max {
                return Err(too_large(max));
            }
            nostr::hashes::HashEngine::input(&mut engine, &chunk);
            file.write_all(&chunk).map_err(disk)?;
        }
        if sha256::Hash::from_engine(engine).to_string() != sha {
            return Err(Error::Media(
                "downloaded file failed its integrity check".into(),
            ));
        }
        file.sync_all().map_err(disk)?;
        drop(file);
        std::fs::rename(&tmp, &path).map_err(disk)
    }
    .await;
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result?;
    prune_cache(cache_dir, &sha, MEDIA_CACHE_BUDGET);
    Ok(path)
}

/// One answer of the local playback protocol to a `Range` request.
#[derive(Debug, PartialEq, Eq)]
pub struct RangeReply {
    /// 200, 206 or 416.
    pub status: u16,
    /// `Content-Range` header value, when there is one.
    pub content_range: Option<String>,
    pub body: Vec<u8>,
}

/// The inclusive byte span a `Range` header asks of a `len`-byte file:
/// `bytes=a-b`, `bytes=a-` and `bytes=-n` (only the first of several
/// ranges; an end past the file is clamped). `Ok(None)`: no `Range`, the
/// whole file. `Err(())`: not satisfiable (answer 416).
#[allow(clippy::result_unit_err)]
pub fn parse_range(range: Option<&str>, len: u64) -> std::result::Result<Option<(u64, u64)>, ()> {
    let Some(r) = range.map(str::trim) else {
        return Ok(None);
    };
    let spec = r.strip_prefix("bytes=").ok_or(())?;
    let first = spec.split(',').next().unwrap_or("").trim();
    let (a, b) = first.split_once('-').ok_or(())?;
    let (a, b) = (a.trim(), b.trim());
    let last = len.checked_sub(1).ok_or(())?;
    let span = match (a.is_empty(), b.is_empty()) {
        // bytes=-n: the last n bytes.
        (true, false) => b
            .parse::<u64>()
            .ok()
            .filter(|n| *n > 0)
            .map(|n| (len.saturating_sub(n), last)),
        (false, true) => a.parse::<u64>().ok().map(|s| (s, last)),
        (false, false) => a
            .parse::<u64>()
            .ok()
            .zip(b.parse::<u64>().ok())
            .filter(|(s, e)| s <= e)
            .map(|(s, e)| (s, e.min(last))),
        (true, true) => None,
    };
    match span {
        Some((s, e)) if s < len => Ok(Some((s, e))),
        _ => Err(()),
    }
}

/// Read the part of `path` a `Range` header asks for ([`parse_range`]), at
/// most [`MAX_RANGE_CHUNK`] bytes, as media elements expect. A file that
/// needs more than one chunk is answered with a partial 206 even without a
/// `Range` header, so its bytes are never loaded whole.
pub fn read_range(path: &Path, range: Option<&str>) -> std::io::Result<RangeReply> {
    use std::io::{Read as _, Seek as _};
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let (start, end) = match parse_range(range, len) {
        Err(()) => {
            return Ok(RangeReply {
                status: 416,
                content_range: Some(format!("bytes */{len}")),
                body: Vec::new(),
            })
        }
        Ok(None) if len <= MAX_RANGE_CHUNK => {
            let mut body = Vec::with_capacity(len as usize);
            file.read_to_end(&mut body)?;
            return Ok(RangeReply {
                status: 200,
                content_range: None,
                body,
            });
        }
        Ok(None) => (0, len - 1),
        Ok(Some(span)) => span,
    };
    let end = end.min(start + MAX_RANGE_CHUNK - 1);
    let mut body = Vec::with_capacity((end + 1 - start) as usize);
    file.seek(std::io::SeekFrom::Start(start))?;
    file.take(end + 1 - start).read_to_end(&mut body)?;
    Ok(RangeReply {
        status: 206,
        content_range: Some(format!("bytes {start}-{end}/{len}")),
        body,
    })
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

    fn png_chunk(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut c = (payload.len() as u32).to_be_bytes().to_vec();
        c.extend_from_slice(kind);
        c.extend_from_slice(payload);
        c.extend_from_slice(&[0; 4]); // CRC unchecked by the stripper
        c
    }

    fn chunk_kinds(png: &[u8]) -> Vec<[u8; 4]> {
        let mut out = vec![];
        let mut i = 8;
        while i + 12 <= png.len() {
            let len = u32::from_be_bytes(png[i..i + 4].try_into().unwrap()) as usize;
            out.push(png[i + 4..i + 8].try_into().unwrap());
            i += 12 + len;
        }
        out
    }

    #[test]
    fn mac_screenshot_png_metadata_is_stripped_losslessly() {
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.extend(png_chunk(b"IHDR", &[0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]));
        png.extend(png_chunk(b"sRGB", &[0]));
        png.extend(png_chunk(b"iCCP", b"Display P3\0\0xx"));
        png.extend(png_chunk(b"eXIf", b"MM\0*"));
        png.extend(png_chunk(b"pHYs", &[0; 9]));
        png.extend(png_chunk(b"iTXt", b"XML:com.adobe.xmp\0\0\0\0\0<x/>"));
        png.extend(png_chunk(b"iDOT", &[0; 28]));
        png.extend(png_chunk(b"IDAT", b"pixels"));
        png.extend(png_chunk(b"tIME", &[0; 7]));
        png.extend(png_chunk(b"IEND", b""));
        png.extend_from_slice(b"trailing junk");
        let out = sanitize_image_for_upload(png).unwrap();
        assert_eq!(
            chunk_kinds(&out),
            vec![*b"IHDR", *b"sRGB", *b"IDAT", *b"IEND"]
        );
        assert!(
            out.windows(6).any(|w| w == b"pixels"),
            "pixel data preserved"
        );
        assert!(
            out.ends_with(&png_chunk(b"IEND", b"")),
            "nothing after IEND"
        );
    }

    #[test]
    fn malformed_png_is_refused_and_non_images_pass_through() {
        let mut truncated = b"\x89PNG\r\n\x1a\n".to_vec();
        truncated.extend(png_chunk(b"IHDR", &[0; 13]));
        truncated.truncate(truncated.len() - 3);
        assert!(sanitize_image_for_upload(truncated).is_err());
        let webm = vec![0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3];
        assert_eq!(sanitize_image_for_upload(webm.clone()).unwrap(), webm);
        let pdf = b"%PDF-1.7 hello".to_vec();
        assert_eq!(sanitize_image_for_upload(pdf.clone()).unwrap(), pdf);
    }

    #[test]
    fn jpeg_is_reencoded_without_exif() {
        let img = image::RgbImage::from_pixel(3, 2, image::Rgb([200, 10, 10]));
        let mut clean = std::io::Cursor::new(Vec::new());
        img.write_to(&mut clean, image::ImageFormat::Jpeg).unwrap();
        let clean = clean.into_inner();
        // Splice an APP1/Exif segment (with a fake GPS marker) after SOI.
        let exif = b"Exif\0\0MM\0*GPSLatitude";
        let mut dirty = clean[..2].to_vec();
        dirty.extend_from_slice(&[0xff, 0xe1]);
        dirty.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
        dirty.extend_from_slice(exif);
        dirty.extend_from_slice(&clean[2..]);
        let out = sanitize_image_for_upload(dirty).unwrap();
        assert!(out.starts_with(&[0xff, 0xd8, 0xff]));
        assert!(!out.windows(4).any(|w| w == b"Exif"));
        assert!(!out.windows(11).any(|w| w == b"GPSLatitude"));
        let decoded = image::load_from_memory(&out).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (3, 2));
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

    #[test]
    fn blossom_upload_token_is_hash_and_server_scoped() {
        let keys = Keys::generate();
        assert!(sign_blossom_upload(&keys, "wss://relay.example", "bad").is_err());
        let ev = decode_auth(&sign_blossom_upload(&keys, "wss://relay.example:443", H).unwrap());
        assert_eq!(ev.kind, Kind::from(24242));
        assert_eq!(ev.pubkey, keys.public_key());
        let tags: Vec<Vec<String>> = ev.tags.iter().map(|t| t.as_slice().to_vec()).collect();
        assert!(tags.iter().any(|t| t == &["t", "upload"]));
        assert!(tags.iter().any(|t| t == &["x", H]));
        assert!(tags.iter().any(|t| t == &["server", "relay.example"]));
        let exp: u64 = tags.iter().find(|t| t[0] == "expiration").unwrap()[1]
            .parse()
            .unwrap();
        let now = Timestamp::now().as_secs();
        assert!(exp > now && exp <= now + MEDIA_GET_AUTH_EXPIRY_SECS);
        ev.verify().unwrap();
    }

    #[tokio::test]
    async fn upload_put_sends_bud02_headers_and_uses_relay_descriptor() {
        let data = b"%PDF-1.4\nmock".to_vec();
        let sha = sha256_hex(&data);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let url = format!("http://127.0.0.1:{port}/media/{sha}.pdf");
        let response = serde_json::json!({"url":url,"sha256":sha,"size":data.len(),"type":"application/pdf","uploaded":1}).to_string();
        let (tx, rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 1024];
            while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = sock.read(&mut chunk).await.unwrap();
                buf.extend_from_slice(&chunk[..n]);
            }
            let end = buf.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
            let header = String::from_utf8(buf[..end].to_vec()).unwrap();
            let len: usize = header
                .lines()
                .find(|l| l.to_ascii_lowercase().starts_with("content-length:"))
                .unwrap()
                .split_once(':')
                .unwrap()
                .1
                .trim()
                .parse()
                .unwrap();
            while buf.len() - end < len {
                let n = sock.read(&mut chunk).await.unwrap();
                buf.extend_from_slice(&chunk[..n]);
            }
            tx.send((header, buf[end..end + len].to_vec())).unwrap();
            sock.write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                    response.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        });
        let keys = Keys::generate();
        let media = upload_media(
            &format!("ws://127.0.0.1:{port}"),
            &keys,
            data.clone(),
            "application/pdf",
            "../a].pdf",
        )
        .await
        .unwrap();
        assert_eq!(media.url, url);
        assert_eq!(media.filename.as_deref(), Some("a].pdf"));
        assert_eq!(media.mime.as_deref(), Some("application/pdf"));
        let (head, body) = rx.await.unwrap();
        assert_eq!(body, data);
        assert!(head.starts_with("PUT /upload HTTP/1.1"));
        assert!(head
            .to_ascii_lowercase()
            .contains(&format!("x-sha-256: {sha}")));
        let auth = head
            .lines()
            .find(|l| l.to_ascii_lowercase().starts_with("authorization:"))
            .unwrap()
            .split_once(':')
            .unwrap()
            .1
            .trim();
        let ev = decode_auth(auth);
        assert_eq!(ev.pubkey, keys.public_key());
        assert!(ev.tags.iter().any(|t| t.as_slice() == ["x", &sha]));
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

    /// T-172: Aaron's teaching videos are 30–46 MB. They stream to the hash
    /// file with the same Blossom auth and SHA-256 check as images.
    #[tokio::test]
    async fn relay_video_over_25mb_streams_to_the_cache() {
        let body: Vec<u8> = (0..30 * 1024 * 1024u32).map(|i| (i % 251) as u8).collect();
        let sha = sha256_hex(&body);
        let (port, mut seen) = serve("200 OK", body.clone()).await;
        let relay = format!("ws://127.0.0.1:{port}");
        let url = format!("http://127.0.0.1:{port}/media/{sha}.mp4");
        let dir = tempfile::tempdir().unwrap();
        let keys = Keys::generate();
        let fetch = |max| fetch_media_to_file(&relay, &keys, &url, Some(&sha), dir.path(), max);

        let path = fetch(MAX_STREAM_MEDIA_BYTES).await.unwrap();
        assert_eq!(path, dir.path().join(&sha));
        assert!(std::fs::read(&path).unwrap() == body);
        let ev = decode_auth(&seen.recv().await.unwrap().expect("Authorization header"));
        assert_eq!(ev.kind, Kind::from(24242));
        assert_eq!(ev.pubkey, keys.public_key());
        // No .part file left behind.
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);

        // Verified cache hit: no second request.
        assert_eq!(fetch(MAX_STREAM_MEDIA_BYTES).await.unwrap(), path);
        assert!(seen.try_recv().is_err());

        // The in-memory image path still refuses it, and leaves the file alone.
        let err = fetch_media(&relay, &keys, &url, None, dir.path())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("too large (over 25 MB)"), "{err}");
        assert!(path.exists());

        // A cached file that no longer hashes to its name is fetched again.
        std::fs::write(&path, b"corrupt").unwrap();
        assert_eq!(fetch(MAX_STREAM_MEDIA_BYTES).await.unwrap(), path);
        assert!(std::fs::read(&path).unwrap() == body);
        assert!(seen.recv().await.unwrap().is_some());
    }

    #[tokio::test]
    async fn streamed_fetch_enforces_the_cap_and_the_hash() {
        let body = vec![7u8; 3 * 1024 * 1024];
        let sha = sha256_hex(&body);
        let (port, _seen) = serve("200 OK", body).await;
        let relay = format!("ws://127.0.0.1:{port}");
        let dir = tempfile::tempdir().unwrap();
        let keys = Keys::generate();
        let url = format!("http://127.0.0.1:{port}/media/{sha}.mp4");
        let err = fetch_media_to_file(&relay, &keys, &url, None, dir.path(), 2 * 1024 * 1024)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("too large (over 2 MB)"), "{err}");

        // Bytes that don't match the name never land under it.
        let url = format!("http://127.0.0.1:{port}/media/{H}.mp4");
        let err = fetch_media_to_file(
            &relay,
            &keys,
            &url,
            None,
            dir.path(),
            MAX_STREAM_MEDIA_BYTES,
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("integrity"), "{err}");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);

        // Same origin and imeta rules as fetch_media.
        let off = format!("http://localhost:{port}/media/{sha}.mp4");
        assert!(fetch_media_to_file(
            &relay,
            &keys,
            &off,
            None,
            dir.path(),
            MAX_STREAM_MEDIA_BYTES
        )
        .await
        .is_err());
        let url = format!("http://127.0.0.1:{port}/media/{sha}.mp4");
        assert!(fetch_media_to_file(
            &relay,
            &keys,
            &url,
            Some(H),
            dir.path(),
            MAX_STREAM_MEDIA_BYTES
        )
        .await
        .is_err());
    }

    #[test]
    fn read_range_answers_media_element_requests() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("v");
        let len = 3 * MAX_RANGE_CHUNK + 10;
        let data: Vec<u8> = (0..len).map(|i| (i % 253) as u8).collect();
        std::fs::write(&path, &data).unwrap();
        let r = |h: Option<&str>| read_range(&path, h).unwrap();

        // AVFoundation's probe.
        let a = r(Some("bytes=0-1"));
        assert_eq!(
            (a.status, a.content_range.as_deref(), &a.body[..]),
            (206, Some(&*format!("bytes 0-1/{len}")), &data[..2])
        );
        // Chromium / GStreamer open-ended: capped at one chunk.
        let a = r(Some("bytes=0-"));
        assert_eq!(a.status, 206);
        assert_eq!(
            a.content_range,
            Some(format!("bytes 0-{}/{len}", MAX_RANGE_CHUNK - 1))
        );
        assert!(a.body == data[..MAX_RANGE_CHUNK as usize]);
        // Seek near the end: the tail.
        let a = r(Some(&format!("bytes={}-", len - 4)));
        assert_eq!(
            (a.content_range, a.body),
            (
                Some(format!("bytes {}-{}/{len}", len - 4, len - 1)),
                data[len as usize - 4..].to_vec()
            )
        );
        let a = r(Some("bytes=-3"));
        assert_eq!(a.body, data[len as usize - 3..].to_vec());
        // End past the file is clamped; several ranges: the first.
        let a = r(Some(&format!("bytes={}-{}, 0-1", len - 2, len + 100)));
        assert_eq!(a.body, data[len as usize - 2..].to_vec());
        // Unsatisfiable or malformed.
        for h in [
            format!("bytes={len}-"),
            "bytes=5-2".into(),
            "items=0-1".into(),
            "bytes=-0".into(),
            "bytes=x-".into(),
        ] {
            let a = r(Some(&h));
            assert_eq!(
                (a.status, a.content_range),
                (416, Some(format!("bytes */{len}"))),
                "{h}"
            );
        }
        // No Range on a large file: a first chunk, never the whole file.
        let a = r(None);
        assert_eq!((a.status, a.body.len() as u64), (206, MAX_RANGE_CHUNK));
        // No Range on a small file: all of it.
        std::fs::write(&path, b"tiny").unwrap();
        assert_eq!(
            r(None),
            RangeReply {
                status: 200,
                content_range: None,
                body: b"tiny".to_vec()
            }
        );
    }

    #[test]
    fn parse_range_spans() {
        assert_eq!(parse_range(None, 10), Ok(None));
        assert_eq!(parse_range(Some("bytes=2-4"), 10), Ok(Some((2, 4))));
        assert_eq!(parse_range(Some("bytes=2-"), 10), Ok(Some((2, 9))));
        assert_eq!(parse_range(Some("bytes=-3"), 10), Ok(Some((7, 9))));
        assert_eq!(parse_range(Some("bytes=-30"), 10), Ok(Some((0, 9))));
        assert_eq!(parse_range(Some("bytes=8-99"), 10), Ok(Some((8, 9))));
        for bad in ["bytes=10-", "bytes=4-2", "bytes=-0", "bytes=-", "lines=1-2", "bytes=a-"] {
            assert_eq!(parse_range(Some(bad), 10), Err(()), "{bad}");
        }
        assert_eq!(parse_range(Some("bytes=0-"), 0), Err(()));
    }

    #[test]
    fn prune_cache_drops_least_recently_used_but_keeps_the_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let t = |secs| std::time::UNIX_EPOCH + Duration::from_secs(secs);
        for (name, age) in [("old", 100), ("mid", 200), ("new", 300), ("keep", 50)] {
            let p = dir.path().join(name);
            std::fs::write(&p, [0u8; 10]).unwrap();
            std::fs::File::options()
                .append(true)
                .open(&p)
                .unwrap()
                .set_modified(t(age))
                .unwrap();
        }
        let part = dir.path().join("x.part");
        std::fs::write(&part, [0u8; 1]).unwrap();
        std::fs::File::options()
            .append(true)
            .open(&part)
            .unwrap()
            .set_modified(t(1))
            .unwrap();
        prune_cache(dir.path(), "keep", 25);
        let mut left: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        left.sort();
        assert_eq!(left, ["keep", "new"]);
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
