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

pub mod normalize;
pub mod voice;

pub use normalize::sanitize_image_for_upload;

/// Largest blob we download into memory: images and PDF previews. The relay's own
/// image limit: anything smaller can be sent, so anything smaller has to show.
pub const MAX_MEDIA_BYTES: u64 = 50 * 1024 * 1024;
/// Largest video, audio or file we stream to the disk cache (T-172: Buzz
/// videos are routinely 30–50 MB). Played and opened from disk, never held whole.
pub const MAX_STREAM_MEDIA_BYTES: u64 = 500 * 1024 * 1024;
/// The media cache is trimmed, oldest first, to this after each streamed download.
pub const MEDIA_CACHE_BUDGET: u64 = 2 * 1024 * 1024 * 1024;
/// Most bytes one local playback response carries; players ask for the rest
/// with further `Range` requests (Tauri's asset protocol uses ~1 MB too).
pub const MAX_RANGE_CHUNK: u64 = 1024 * 1024;
/// How long an upload token stays good. The relay checks it when the body has arrived, and allows a video an hour.
const MEDIA_UPLOAD_AUTH_EXPIRY_SECS: u64 = 3600;
/// Whole-transfer limit for an MP4 (video, and M4A audio: the relay takes both on its streamed path), inside that hour.
const VIDEO_UPLOAD_TIMEOUT: Duration = Duration::from_secs(55 * 60);
/// The relay's buffered path (images, files, WebM and Ogg audio) checks the upload token ten minutes after it was signed, after the
/// last byte, however fast the start was. Opus may run 3 hours (11-06), but the length is not the size: 3 h of Opus at 32 kbit/s
/// is about 43 MB, inside ten minutes on any link faster than about 0.6 Mbit/s; a longer or larger M4A goes on the hour's path above.
/// A longer window for WebM/Ogg is the relay's to give (buzz-media upload.rs, the buffered path's 600 s).
const OTHER_UPLOAD_TIMEOUT: Duration = Duration::from_secs(590);
const UPLOAD_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const UPLOAD_ANSWER_BODY_LIMIT: Duration = Duration::from_secs(30);
/// Sent data the network hasn't acknowledged for this long means the connection is dead, however slow it was before.
/// The kernel's check, on the platforms that have it: a slow link and a relay still storing the file both pass, where
/// anything measured from here would have to guess. (A relay that stops reading altogether for this long is cut too, and
/// the relay streams uploads to disk, so it doesn't.)
#[cfg(any(target_os = "android", target_os = "linux"))]
const UPLOAD_UNACKED_LIMIT: Duration = Duration::from_secs(60);
/// The backstop everywhere: this long since the upload last took a piece of the file. A full socket buffer drains for a long
/// time on a slow link and the relay then checks and stores the file, so this has to allow for both. It stops two dead
/// uploads from holding every slot of [`UPLOAD_GATE`] for the whole-transfer limit.
const UPLOAD_QUIET_LIMIT: Duration = Duration::from_secs(10 * 60);
/// Connections lost partway that are worth another try before giving up.
const UPLOAD_RESETS_ALLOWED: u32 = 2;
/// Waits after the relay says "too many uploads" (429). It counts per minute, so together these outlast one window.
const UPLOAD_BUSY_WAITS: [Duration; 6] = [
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(10),
    Duration::from_secs(15),
    Duration::from_secs(20),
    Duration::from_secs(30),
];
/// The relay allows one sender two uploads at a time, and answers a third with 429 before reading it. The turn starts
/// before a file is rewritten, so this is also the limit on how many are: a large photo takes a couple of hundred MB to
/// decode, and a queued video would otherwise sit on disk in two copies.
static UPLOAD_GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
/// Large files take one turn at a time, leaving the other for what's quick: a voice note shouldn't wait behind two videos.
static LARGE_UPLOAD_GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
const LARGE_UPLOAD_BYTES: u64 = 25 * 1024 * 1024;
/// Past this much sent, a lost connection isn't retried by itself: the whole file would go again, on someone's phone data,
/// with nothing on screen. Below it is where a relay hanging up on a file it won't read shows up. Retry is one tap.
const UPLOAD_RESET_RETRY_BYTES: u64 = 16 * 1024 * 1024;
/// Lifetime of a `t=get` token (Buzz: `MEDIA_GET_AUTH_EXPIRY_SECS`).
pub const MEDIA_GET_AUTH_EXPIRY_SECS: u64 = 600;
/// Most `imeta` entries kept per message.
pub const MAX_IMETA_PER_MESSAGE: usize = 20;
const FETCH_TIMEOUT: Duration = Duration::from_secs(60);
/// Whole-transfer limit for a streamed download; each read still has to
/// arrive within [`FETCH_TIMEOUT`].
const STREAM_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// One NIP-92 attachment on a message.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
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
    /// `duration`: seconds, for video (NIP-71); the relay checks it against what it stored, to 0.1 s.
    #[serde(default)]
    pub duration: Option<f64>,
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
    let exp = (Timestamp::now().as_secs() + MEDIA_UPLOAD_AUTH_EXPIRY_SECS).to_string();
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

/// A rewritten file that goes away with the upload, however it ends.
struct RemoveOnDrop(Option<PathBuf>);
impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        if let Some(p) = &self.0 {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// The name for `imeta`: no folder part or control characters, not empty, at most the relay's 255 bytes.
fn upload_filename(filename: &str) -> String {
    let name: String = filename.rsplit(['/', '\\']).next().unwrap_or(filename).trim().chars().filter(|c| !c.is_control()).collect();
    let mut end = name.len().min(255);
    while !name.is_char_boundary(end) {
        end -= 1;
    }
    let name = name[..end].trim_end();
    if name.is_empty() { "file".to_string() } else { name.to_string() }
}

/// What a relay refusal means, in one line. The normalizer should have caught all of these first, so reaching one means
/// the relay's rules and ours have parted, or something changed between devices. Never the relay's raw body.
fn relay_refusal(status: u16, body: &str) -> String {
    let said = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
        .unwrap_or_default();
    let has = |needle: &str| said.contains(needle);
    if has("moov atom") || has("metadata") {
        "The relay still refused this file after it was cleaned up, so its rules may have changed.".into()
    } else if has("media codec") {
        "Buzz only takes H.264 video with AAC sound, and this file uses something else.".into()
    } else if has("too long") {
        // "audio too long: duration exceeds 10800 seconds": only our patched relay says audio, about Opus. Stock Buzz says video, at 600.
        let audio = has("audio too long");
        // Only a whole number of seconds is a limit; anything else gets ours.
        let limit = said
            .split("exceeds ")
            .nth(1)
            .and_then(|r| r.split(' ').next())
            .and_then(|n| n.parse::<u32>().ok())
            .filter(|n| *n > 0)
            .map_or(if audio { normalize::MAX_OPUS_SECONDS } else { normalize::MAX_VIDEO_SECONDS }, f64::from);
        let what = if audio { "audio" } else { "video" };
        format!("Buzz takes {what} up to {}, and this one is longer.", normalize::limit_words(limit))
    } else if has("resolution") {
        "Buzz takes videos up to 3840x2160, and this one is larger.".into()
    } else if has("unsupported container") {
        "Buzz only takes MP4 video, and this file is something else.".into()
    } else if has("invalid video") || has("invalid image") {
        "This file is damaged or incomplete, so it can't be sent.".into()
    } else if has("image dimensions") {
        "Buzz takes images up to 25 megapixels, and this one is larger.".into()
    } else if status == 413 || has("file too large") {
        "This file is larger than Buzz allows.".into()
    } else if let Some(kind) = said.strip_prefix("disallowed content type: ") {
        format!("Buzz doesn't take this kind of file ({kind}).")
    } else if has("unknown content type") {
        "Buzz can't tell what kind of file this is, so it won't take it.".into()
    } else if status == 401 {
        "The relay didn't accept this device's sign-in. Retry; if it keeps happening, check this device's time and pairing.".into()
    } else if status == 403 {
        "This account can't upload to this relay.".into()
    } else if status == 429 {
        "Too many uploads right now. Retry in a minute.".into()
    } else if status >= 500 {
        "The relay couldn't store this file just now. Retry in a moment.".into()
    } else {
        format!("The relay refused this file (error {status}).")
    }
}

/// A failed connection in one line. Voice retries itself when `netError.ts` finds these words, so they stay.
/// `out_of_time`: the attempt used its whole limit. A dead connection is a timeout too, and that's not the file's fault.
fn unreachable_line(e: &reqwest::Error, relay_video: bool, out_of_time: bool) -> String {
    if e.is_timeout() && out_of_time && !relay_video {
        "The upload timed out: Buzz allows ten minutes for a file that isn't an MP4 or M4A, and this connection is too slow for this file.".into()
    } else if e.is_timeout() {
        "Can't reach Buzz: the upload timed out. Is Tailscale on? Retry when you're back online.".into()
    } else {
        "Can't reach Buzz: error sending request. Is Tailscale on? Retry when you're back online.".into()
    }
}

fn stalled_line() -> String {
    "Can't reach Buzz: the upload timed out when the connection stopped moving. Is Tailscale on? Retry when you're back online.".into()
}

enum UploadFailure {
    /// Trying again here would only do the same.
    Final(Error),
    /// The connection broke partway; the line to show if it keeps happening.
    Reset(String),
}

/// When the upload last took a piece of the file.
struct UploadProgress {
    started: std::time::Instant,
    last_ms: std::sync::atomic::AtomicU64,
    taken_bytes: std::sync::atomic::AtomicU64,
}

impl UploadProgress {
    fn new() -> Self {
        Self { started: std::time::Instant::now(), last_ms: 0.into(), taken_bytes: 0.into() }
    }
    fn moved(&self) {
        let now = self.started.elapsed().as_millis() as u64;
        self.last_ms.store(now, std::sync::atomic::Ordering::Relaxed);
    }
    /// Finishes once the upload has been quiet for too long. The other half of a `select!` with the request.
    async fn stalled(&self, limit: Duration) {
        loop {
            tokio::time::sleep(Duration::from_millis(250)).await;
            let last = Duration::from_millis(self.last_ms.load(std::sync::atomic::Ordering::Relaxed));
            if self.started.elapsed().saturating_sub(last) > limit {
                return;
            }
        }
    }
}

/// The file as a request body that reports each piece taken: HTTP asks for the next when the socket has room.
fn watched_body(file: tokio::fs::File, progress: Arc<UploadProgress>) -> reqwest::Body {
    use tokio::io::AsyncReadExt as _;
    let pieces = futures_util::stream::unfold((file, progress), |(mut file, progress)| async move {
        let mut buf = vec![0u8; 256 * 1024];
        match file.read(&mut buf).await {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                progress.moved();
                progress.taken_bytes.fetch_add(n as u64, std::sync::atomic::Ordering::Relaxed);
                Some((Ok::<Vec<u8>, std::io::Error>(buf), (file, progress)))
            }
            Err(e) => Some((Err(e), (file, progress))),
        }
    });
    reqwest::Body::wrap_stream(pieces)
}

/// A recording in Opus (WebM), as the AAC parts stock Buzz takes, each named for the message: `(path, name)` in order.
/// `None`: not a WebM, or this device has no codecs for it, so it goes as it is. The parts are raw M4A for
/// [`upload_media_file`]'s normalizer; the caller removes them.
pub fn voice_parts(input: &Path, filename: &str, work_dir: &Path, codecs: Option<&dyn voice::Codecs>) -> Result<Option<Vec<(PathBuf, String)>>> {
    let Some(codecs) = codecs else { return Ok(None) };
    if !voice::is_webm(input) {
        return Ok(None);
    }
    let Some(converted) = voice::convert(input, work_dir, codecs, voice::MAX_PART_SECONDS)? else {
        return Ok(None);
    };
    let stem = filename.rsplit_once('.').map_or(filename, |(s, _)| s);
    let n = converted.parts.len();
    Ok(Some(
        converted
            .parts
            .into_iter()
            .enumerate()
            .map(|(k, p)| (p.path, if n == 1 { format!("{stem}.m4a") } else { format!("{stem} ({} of {n}).m4a", k + 1) }))
            .collect(),
    ))
}

/// Removes every file it holds, however the upload ends.
struct RemoveAll(Vec<PathBuf>);
impl Drop for RemoveAll {
    fn drop(&mut self) {
        for p in &self.0 {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// Upload what the user attached or recorded, as one attachment or, for a long recording, several in order.
///
/// A recording in Opus is converted to AAC parts of at most 9:50, cut at pauses ([`voice`]), where this device has the
/// codecs; each part then goes as any file does ([`upload_media_file`]). Anything else is one [`upload_media_file`].
pub async fn upload_media(
    relay_url: &str,
    keys: &Keys,
    input: &Path,
    mime: &str,
    filename: &str,
    work_dir: &Path,
) -> Result<Vec<MediaRef>> {
    upload_media_with(relay_url, keys, input, mime, filename, work_dir, voice::platform_codecs()).await
}

async fn upload_media_with(
    relay_url: &str,
    keys: &Keys,
    input: &Path,
    mime: &str,
    filename: &str,
    work_dir: &Path,
    codecs: Option<&'static dyn voice::Codecs>,
) -> Result<Vec<MediaRef>> {
    let (from, name, dir) = (input.to_path_buf(), upload_filename(filename), work_dir.to_path_buf());
    let parts = tokio::task::spawn_blocking(move || voice_parts(&from, &name, &dir, codecs))
        .await
        .map_err(|_| normalize::refuse("Couldn't prepare the file on this device. Attach it again."))??;
    let Some(parts) = parts else {
        return Ok(vec![upload_media_file(relay_url, keys, input, mime, filename, work_dir).await?]);
    };
    let _cleanup = RemoveAll(parts.iter().map(|(p, _)| p.clone()).collect());
    let mut media = Vec::with_capacity(parts.len());
    for (path, name) in &parts {
        media.push(upload_media_file(relay_url, keys, path, "audio/mp4", name, work_dir).await?);
    }
    Ok(media)
}

/// Upload a picked, pasted, dropped, shared or recorded file: the one way media reaches the relay.
///
/// The file is normalized first ([`normalize`]), so the relay's rules are met or the reason is known before any bytes
/// move, and streamed from disk, so a large file is never held in memory. The relay sniffs the bytes and returns the
/// canonical MIME, size and dimensions; never construct imeta from untrusted browser MIME hints. No redirects may carry
/// Blossom authorization off-origin. The legacy route only supports images.
///
/// Every error is one plain line ([`Error::MediaRefused`]), ready to show.
pub async fn upload_media_file(
    relay_url: &str,
    keys: &Keys,
    input: &Path,
    mime: &str,
    filename: &str,
    work_dir: &Path,
) -> Result<MediaRef> {
    upload_with_quiet_limit(relay_url, keys, input, mime, filename, work_dir, UPLOAD_QUIET_LIMIT).await
}

async fn upload_with_quiet_limit(
    relay_url: &str,
    keys: &Keys,
    input: &Path,
    mime: &str,
    filename: &str,
    work_dir: &Path,
    quiet_limit: Duration,
) -> Result<MediaRef> {
    let name = upload_filename(filename);
    let large = std::fs::metadata(input).is_ok_and(|m| m.len() > LARGE_UPLOAD_BYTES);
    let (input, for_normalize, work_dir) = (input.to_path_buf(), name.clone(), work_dir.to_path_buf());
    let _large_turn = if large {
        Some(LARGE_UPLOAD_GATE.acquire().await.map_err(|_| normalize::refuse("Couldn't start the upload. Attach it again."))?)
    } else {
        None
    };
    let _turn = UPLOAD_GATE.acquire().await.map_err(|_| normalize::refuse("Couldn't start the upload. Attach it again."))?;
    let joined = tokio::task::spawn_blocking(move || {
        let n = normalize::normalize_file(&input, &for_normalize, &work_dir)?;
        let cleanup = RemoveOnDrop(n.rewritten.then(|| n.path.clone()));
        let sha = file_sha256(&n.path).map_err(normalize::io_failed)?;
        let size = std::fs::metadata(&n.path).map_err(normalize::io_failed)?.len();
        Ok::<_, Error>((n, cleanup, sha, size))
    })
    .await
    .map_err(|_| normalize::refuse("Couldn't prepare the file on this device. Attach it again."))?;
    let (normalized, _cleanup, sha, size) = joined?;
    crate::init_crypto();
    let origin = relay_http_origin(relay_url).map_err(|_| normalize::refuse("This device has no valid relay address."))?;
    let base = origin.as_str().trim_end_matches('/');
    // The relay treats Content-Type as advisory and validates the actual bytes.
    let hint = if mime.is_empty() || mime.contains(['\r', '\n']) { "application/octet-stream" } else { mime };
    // Long enough for a large file, but a phone with no route to the relay finds out in seconds, not an hour.
    let builder = client_builder(reqwest::redirect::Policy::none())?.connect_timeout(UPLOAD_CONNECT_TIMEOUT);
    #[cfg(any(target_os = "android", target_os = "linux"))]
    let builder = builder.tcp_user_timeout(UPLOAD_UNACKED_LIMIT);
    let client = builder.build().map_err(|_| normalize::refuse("Couldn't start the upload. Attach it again."))?;
    let limit = if normalized.relay_video { VIDEO_UPLOAD_TIMEOUT } else { OTHER_UPLOAD_TIMEOUT };

    let put = |route: &'static str| {
        let (client, path, sha, hint) = (client.clone(), normalized.path.clone(), sha.clone(), hint.to_string());
        let url = format!("{base}{route}");
        let relay_video = normalized.relay_video;
        async move {
            // Signed for each try: the relay wants a token minted within minutes of its arrival.
            let auth = sign_blossom_upload(keys, relay_url, &sha).map_err(|e| UploadFailure::Final(normalize::refuse(e.to_string())))?;
            let file = tokio::fs::File::open(&path).await.map_err(|e| UploadFailure::Final(normalize::io_failed(e)))?;
            let progress = Arc::new(UploadProgress::new());
            let started = std::time::Instant::now();
            let request = client
                .put(url)
                .timeout(limit)
                .header("Authorization", &auth)
                .header("Content-Type", &hint)
                .header("Content-Length", size)
                .header("X-SHA-256", &sha)
                .body(watched_body(file, progress.clone()))
                .send();
            tokio::select! {
                result = request => result.map_err(|e| {
                    let line = unreachable_line(&e, relay_video, started.elapsed() + Duration::from_secs(5) >= limit);
                    // Connecting failed, or time ran out: a retry here would only do the same. Otherwise the connection
                    // broke, as when a relay turns a file down without reading it all, and early on it's worth another go.
                    if e.is_connect() || e.is_timeout() || progress.taken_bytes.load(std::sync::atomic::Ordering::Relaxed) > UPLOAD_RESET_RETRY_BYTES {
                        UploadFailure::Final(normalize::refuse(line))
                    } else {
                        UploadFailure::Reset(line)
                    }
                }),
                () = progress.stalled(quiet_limit) => Err(UploadFailure::Final(normalize::refuse(stalled_line()))),
            }
        }
    };
    let mut waits = UPLOAD_BUSY_WAITS.iter();
    let mut resets = 0;
    let mut told_busy = false;
    let response = loop {
        let mut attempt = put("/upload").await;
        if matches!(&attempt, Ok(r) if matches!(r.status().as_u16(), 404 | 405)) {
            attempt = put("/media/upload").await;
        }
        match attempt {
            Ok(r) if r.status().as_u16() == 429 => {
                told_busy = true;
                match waits.next() {
                    Some(wait) => tokio::time::sleep(*wait).await,
                    None => break r,
                }
            }
            Ok(r) => break r,
            Err(UploadFailure::Final(e)) => return Err(e),
            Err(UploadFailure::Reset(line)) => {
                resets += 1;
                if resets > UPLOAD_RESETS_ALLOWED {
                    return Err(normalize::refuse(line));
                }
                // A relay turning down a large file hangs up without reading it, and which arrives first is a race: after
                // one "too busy", this may well be another, so it gets the same wait.
                let wait = if told_busy { waits.next().copied() } else { None };
                tokio::time::sleep(wait.unwrap_or(UPLOAD_BUSY_WAITS[0])).await;
            }
        }
    };
    if !response.status().is_success() {
        let status = response.status().as_u16();
        // The answer's status is known: its body gets a short wait, so a connection dying now can't hold a turn.
        let reason = tokio::time::timeout(UPLOAD_ANSWER_BODY_LIMIT, response.text()).await.ok().and_then(|r| r.ok()).unwrap_or_default();
        return Err(normalize::refuse(relay_refusal(status, &reason)));
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
        /// Seconds, for video (which includes sound with a still frame): what the relay stored and checks imeta against.
        duration: Option<f64>,
    }
    let inconsistent = || normalize::refuse("The relay answered with details that don't match the file, so it wasn't attached. Retry.");
    let d: BlobDescriptor = tokio::time::timeout(UPLOAD_ANSWER_BODY_LIMIT, response.json())
        .await
        .map_err(|_| inconsistent())?
        .map_err(|_| inconsistent())?;
    if d.sha256 != sha
        || d.size != size
        || media_sha_from_url(relay_url, &d.url).ok().as_deref() != Some(&sha)
        || !d.mime.contains('/')
        || d.mime.contains(['\r', '\n'])
    {
        return Err(inconsistent());
    }
    Ok(MediaRef {
        url: d.url,
        mime: Some(d.mime),
        sha256: Some(sha),
        size: Some(d.size as i64),
        dim: d.dim.filter(|v| parse_dim(v).is_some()),
        blurhash: d.blurhash,
        alt: None,
        filename: Some(normalized.filename),
        duration: d.duration.filter(|v| v.is_finite() && *v > 0.0),
    })
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
        touch(&path);
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
    let path = cache_path(cache_dir, sha).ok()?;
    if std::fs::metadata(&path).ok()?.len() > max {
        return None;
    }
    if file_sha256(&path).ok()? != sha {
        let _ = std::fs::remove_file(&path);
        return None;
    }
    touch(&path);
    Some(path)
}

/// Read `src` in 1 MB chunks, hashing; with `out`, write each chunk there as well. Returns the SHA-256 hex.
fn hash_through(src: &Path, mut out: Option<&mut std::fs::File>) -> std::io::Result<String> {
    use std::io::{Read as _, Write as _};
    let mut file = std::fs::File::open(src)?;
    let mut engine = sha256::Hash::engine();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        nostr::hashes::HashEngine::input(&mut engine, &buf[..n]);
        if let Some(out) = out.as_mut() {
            out.write_all(&buf[..n])?;
        }
    }
    Ok(sha256::Hash::from_engine(engine).to_string())
}

/// SHA-256 (hex) of a file, read in chunks, never whole.
pub fn file_sha256(path: &Path) -> std::io::Result<String> {
    hash_through(path, None)
}

/// Copy `src` to a new file `dst`, hashing as it goes, and sync it. Fails, removing `dst`, unless the bytes
/// written hash to `sha`. `dst` must not exist (it is created, never overwritten).
pub fn copy_verified(src: &Path, dst: &Path, sha: &str) -> std::io::Result<()> {
    let mut out = std::fs::File::options().write(true).create_new(true).open(dst)?;
    // From here on `dst` is ours: on any failure it goes.
    let result = hash_through(src, Some(&mut out)).and_then(|got| {
        if got != sha {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "file failed its integrity check"));
        }
        out.sync_all()
    });
    if result.is_err() {
        drop(out);
        let _ = std::fs::remove_file(dst);
    }
    result
}

/// Mark a cache file recently used for [`prune_cache`] (best effort).
fn touch(path: &Path) {
    let _ = std::fs::File::options()
        .append(true)
        .open(path)
        .and_then(|f| f.set_modified(std::time::SystemTime::now()));
}

/// Trim the cache to `budget` bytes, least recently used first, never
/// touching the files named in `keep` (the new download, media playing now).
/// Stale `.part` files from interrupted downloads go too.
pub fn prune_cache(cache_dir: &Path, keep: &[String], budget: u64) {
    let Ok(entries) = std::fs::read_dir(cache_dir) else {
        return;
    };
    let day = Duration::from_secs(24 * 3600);
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = Vec::new();
    let mut kept = 0u64;
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
        if keep.contains(&name) {
            kept += meta.len();
        } else {
            files.push((modified, meta.len(), e.path()));
        }
    }
    let mut total = kept + files.iter().map(|f| f.1).sum::<u64>();
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

/// The extension of a relay media URL (`…/<sha>.pdf` → `pdf`): at most 8
/// lowercase letters or digits, else none.
pub fn url_extension(url: &str) -> Option<&str> {
    let last = url.rsplit('/').next()?;
    let ext = last.rsplit_once('.')?.1;
    (!ext.is_empty()
        && ext.len() <= 8
        && ext.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()))
    .then_some(ext)
}

/// The longest saved name, in UTF-8 bytes. ext4 allows 255 bytes and eCryptfs
/// 143; a long CJK or emoji name cut by characters went over (T-185). 120 leaves
/// room for the " (12)" [`export_file`] adds to a name that is taken.
pub const DOWNLOAD_NAME_BYTES: usize = 120;

/// `s` cut to at most `max` UTF-8 bytes, never inside a character or after an emoji joiner.
fn cap_bytes(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let end = (0..=max).rev().find(|&i| s.is_char_boundary(i)).unwrap_or(0);
    s[..end].trim_end_matches(['\u{200d}', '\u{fe0e}', '\u{fe0f}'])
}

/// T-174: the name an attachment is saved under where the user will find it
/// (Downloads). The `imeta` filename without any folder part, characters file
/// systems refuse, or leading/trailing dots and spaces, at most
/// [`DOWNLOAD_NAME_BYTES`]; when it has no extension (`notes`, `Meeting 10.18`),
/// the URL's is added. Without a usable name: `<first 12 of the hash>.<ext>`.
pub fn download_name(filename: Option<&str>, url: &str, sha: &str) -> String {
    let ext = url_extension(url);
    let base = filename
        .and_then(|f| f.rsplit(['/', '\\']).next())
        .unwrap_or("");
    let clean: String = base
        .chars()
        .map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c })
        .collect();
    let clean = clean.trim_matches(|c: char| c == '.' || c.is_whitespace());
    let mut name = if clean.is_empty() {
        sha.chars().take(12).collect::<String>()
    } else {
        clean.to_string()
    };
    // An extension: up to 8 letters or digits, at least one a letter (`10.18` is not one).
    let has_ext = name.rsplit_once('.').is_some_and(|(stem, e)| {
        !stem.is_empty() && e.len() <= 8 && e.bytes().all(|b| b.is_ascii_alphanumeric()) && e.bytes().any(|b| b.is_ascii_alphabetic())
    });
    if let Some(ext) = ext.filter(|_| !has_ext) {
        name = format!("{name}.{ext}");
    }
    if name.len() > DOWNLOAD_NAME_BYTES {
        // Keep the extension; shorten the stem.
        let (stem, ext) = name.rsplit_once('.').filter(|(_, e)| e.chars().count() <= 8).unwrap_or((&name, ""));
        let keep = if ext.is_empty() { DOWNLOAD_NAME_BYTES } else { DOWNLOAD_NAME_BYTES - ext.len() - 1 };
        // A cut can leave a trailing dot or space, which Windows and some share targets drop.
        let stem = cap_bytes(stem, keep).trim_end_matches(|c: char| c == '.' || c.is_whitespace());
        name = if ext.is_empty() { stem.to_string() } else { format!("{stem}.{ext}") };
    }
    name
}

/// `report.pdf`, then `report (1).pdf`, `report (2).pdf`, …
fn numbered(name: &str, n: u32) -> String {
    if n == 0 {
        return name.to_string();
    }
    match name.rsplit_once('.').filter(|(stem, _)| !stem.is_empty()) {
        Some((stem, ext)) => format!("{stem} ({n}).{ext}"),
        None => format!("{name} ({n})"),
    }
}

/// T-174: copy a (verified) cache file into `dir` as `name`, never over a file
/// that is already there (`report (1).pdf` instead). The copy is written
/// under a hidden temporary name and only then given its own, so a
/// half-written file never shows up in the folder. Returns where it went.
pub fn export_file(src: &Path, dir: &Path, name: &str) -> std::io::Result<PathBuf> {
    use std::io::ErrorKind;
    if name.is_empty() || name.contains(['/', '\\']) || name.starts_with('.') {
        return Err(std::io::Error::new(ErrorKind::InvalidInput, "bad file name"));
    }
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(".{}.uni-part", uuid::Uuid::new_v4()));
    let placed = (|| {
        let mut out = std::fs::File::create(&tmp)?;
        std::io::copy(&mut std::fs::File::open(src)?, &mut out)?;
        out.sync_all()?;
        drop(out);
        for n in 0..1000 {
            let target = dir.join(numbered(name, n));
            // A hard link fails if the name is taken, so nothing is overwritten.
            match std::fs::hard_link(&tmp, &target) {
                Ok(()) => return Ok(target),
                Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
                // File systems without hard links (FAT, some network shares): claim the
                // name with an empty file first, then move the copy over our own claim.
                Err(_) => match std::fs::OpenOptions::new().write(true).create_new(true).open(&target) {
                    Ok(_) => {
                        std::fs::rename(&tmp, &target)?;
                        return Ok(target);
                    }
                    Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
                    Err(e) => return Err(e),
                },
            }
        }
        Err(std::io::Error::new(ErrorKind::AlreadyExists, "too many files with this name"))
    })();
    let _ = std::fs::remove_file(&tmp);
    placed
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
/// network. Callers trim the cache afterwards ([`prune_cache`]), knowing
/// which files are in use.
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
                duration: None,
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
        assert!(exp > now && exp <= now + MEDIA_UPLOAD_AUTH_EXPIRY_SECS);
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
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.pdf");
        std::fs::write(&file, &data).unwrap();
        let media = upload_media_file(
            &format!("ws://127.0.0.1:{port}"),
            &keys,
            &file,
            "application/pdf",
            "../a].pdf",
            dir.path(),
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

    /// T-172: Buzz videos run past what we hold in memory. They stream to the hash
    /// file with the same Blossom auth and SHA-256 check as images.
    #[tokio::test]
    async fn relay_video_over_the_image_limit_streams_to_the_cache() {
        let body: Vec<u8> = (0..51 * 1024 * 1024u32).map(|i| (i % 251) as u8).collect();
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
        assert!(err.to_string().contains("too large (over 50 MB)"), "{err}");
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
    fn prune_cache_drops_least_recently_used_but_keeps_files_in_use() {
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
        prune_cache(dir.path(), &["keep".into(), "gone".into()], 25);
        let mut left: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        left.sort();
        assert_eq!(left, ["keep", "new"]);
    }

    /// T-174: "Save" must put the file where the user finds it. The real save
    /// path: Blossom-authenticated, hash-checked download to the cache, then a
    /// copy into the Downloads folder under the attachment's own name, with
    /// nothing overwritten and no temporary file left behind.
    #[tokio::test]
    async fn saved_attachment_lands_in_downloads_under_its_name() {
        let body: Vec<u8> = (0..2 * 1024 * 1024u32).map(|i| (i % 249) as u8).collect();
        let sha = sha256_hex(&body);
        let (port, mut seen) = serve("200 OK", body.clone()).await;
        let relay = format!("ws://127.0.0.1:{port}");
        let url = format!("http://127.0.0.1:{port}/media/{sha}.pdf");
        let cache = tempfile::tempdir().unwrap();
        let downloads = tempfile::tempdir().unwrap();
        let keys = Keys::generate();

        let cached = fetch_media_to_file(&relay, &keys, &url, Some(&sha), cache.path(), MAX_STREAM_MEDIA_BYTES)
            .await
            .unwrap();
        assert!(seen.recv().await.unwrap().is_some(), "sent with Blossom auth");
        let name = download_name(Some("Q3 report.pdf"), &url, &sha);
        let saved = export_file(&cached, downloads.path(), &name).unwrap();
        assert_eq!(saved, downloads.path().join("Q3 report.pdf"));
        assert!(std::fs::read(&saved).unwrap() == body);

        // Saving again keeps the first copy and numbers the second.
        std::fs::write(&saved, b"the user's edits").unwrap();
        let again = export_file(&cached, downloads.path(), &name).unwrap();
        assert_eq!(again, downloads.path().join("Q3 report (1).pdf"));
        assert_eq!(std::fs::read(&saved).unwrap(), b"the user's edits");
        assert!(std::fs::read(&again).unwrap() == body);

        // Only the two saved files: no hidden temporary copy left behind.
        let mut names: Vec<String> = std::fs::read_dir(downloads.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, ["Q3 report (1).pdf", "Q3 report.pdf"]);

        // A missing Downloads folder is created; a hostile name stays inside it.
        let nested = downloads.path().join("new");
        let hostile = download_name(Some("../../.bashrc"), &url, &sha);
        let placed = export_file(&cached, &nested, &hostile).unwrap();
        assert_eq!(placed, nested.join("bashrc.pdf"));
        assert!(export_file(&cached, &nested, "../x").is_err());
    }

    #[test]
    fn copy_verified_publishes_only_matching_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        std::fs::write(&src, b"attachment bytes").unwrap();
        let sha = sha256_hex(b"attachment bytes");
        assert_eq!(file_sha256(&src).unwrap(), sha);
        let dst = dir.path().join("dst");
        copy_verified(&src, &dst, &sha).unwrap();
        assert_eq!(std::fs::read(&dst).unwrap(), b"attachment bytes");
        // Never over an existing file.
        assert!(copy_verified(&src, &dst, &sha).is_err());
        assert_eq!(std::fs::read(&dst).unwrap(), b"attachment bytes");
        // Wrong bytes: an error and no file left.
        let bad = dir.path().join("bad");
        let err = copy_verified(&src, &bad, H).unwrap_err();
        assert!(err.to_string().contains("integrity"), "{err}");
        assert!(!bad.exists());
    }

    #[test]
    fn download_names_are_safe_and_keep_their_type() {
        let sha = H;
        let url = format!("https://relay.example/media/{sha}.mp4");
        assert_eq!(download_name(Some("class.mp4"), &url, sha), "class.mp4");
        assert_eq!(download_name(Some("class"), &url, sha), "class.mp4");
        assert_eq!(download_name(Some("Meeting 10.18"), &url, sha), "Meeting 10.18.mp4");
        assert_eq!(download_name(Some("v1.2 notes"), &url, sha), "v1.2 notes.mp4");
        assert_eq!(download_name(Some("clip.MOV"), &url, sha), "clip.MOV");
        assert_eq!(download_name(Some("C:\\Users\\a\\notes.txt"), &url, sha), "notes.txt");
        assert_eq!(download_name(Some("a<b>:c?.mp4"), &url, sha), "a_b__c_.mp4");
        assert_eq!(download_name(Some(" .. "), &url, sha), format!("{}.mp4", &sha[..12]));
        assert_eq!(download_name(None, &url, sha), format!("{}.mp4", &sha[..12]));
        assert_eq!(download_name(None, "https://relay.example/media/x", sha), sha[..12].to_string());
        let long = format!("{}.pdf", "x".repeat(300));
        let short = download_name(Some(&long), &url, sha);
        assert_eq!(short.chars().count(), 120);
        assert!(short.ends_with(".pdf"));
        // T-185: the cap is in UTF-8 bytes, so a long CJK or emoji name still saves (ext4 allows 255 bytes).
        for (title, unit) in [("長", 3), ("🌱", 4)] {
            let long = format!("{}.pdf", title.repeat(200));
            let short = download_name(Some(&long), &url, sha);
            let (src, downloads) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
            std::fs::write(src.path().join("f"), b"x").unwrap();
            let saved = export_file(&src.path().join("f"), downloads.path(), &short).unwrap();
            assert_eq!(saved.file_name().unwrap().to_str(), Some(short.as_str()));
            assert!(short.len() <= DOWNLOAD_NAME_BYTES, "{} bytes", short.len());
            assert_eq!(short, format!("{}.pdf", title.repeat((DOWNLOAD_NAME_BYTES - 4) / unit)));
        }
        // No extension: the whole name is cut, never inside a character.
        let bare = download_name(Some(&"é".repeat(200)), "https://relay.example/media/x", sha);
        assert_eq!(bare, "é".repeat(DOWNLOAD_NAME_BYTES / 2));
        // A cut never leaves a trailing dot or space.
        let dotted = format!("{}. 長長長.pdf", "a".repeat(DOWNLOAD_NAME_BYTES - 4 - 2));
        assert_eq!(download_name(Some(&dotted), &url, sha), format!("{}.pdf", "a".repeat(DOWNLOAD_NAME_BYTES - 4 - 2)));
        // A cut that falls just after an emoji joiner drops the joiner too.
        let family = format!("{}👩\u{200d}👩\u{200d}👧.pdf", "a".repeat(DOWNLOAD_NAME_BYTES - 4 - 7));
        assert_eq!(download_name(Some(&family), &url, sha), format!("{}👩.pdf", "a".repeat(DOWNLOAD_NAME_BYTES - 4 - 7)));
        assert_eq!(url_extension(&url), Some("mp4"));
        assert_eq!(url_extension("https://relay.example/media/x.EXE"), None);
        assert_eq!(numbered("a.tar.gz", 2), "a.tar (2).gz");
        assert_eq!(numbered(".env", 1), ".env (1)");
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

    // ── Uploads: the relay's answers, and what the user reads ─────────────
    /// A relay answering each upload in turn: `Some` as given, `None` with a true descriptor of the bytes it received.
    /// Reports each body it was sent.
    async fn relay_answering(answers: Vec<(u16, Option<String>)>) -> (u16, tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            for (status, answer) in answers {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut buf = Vec::new();
                let mut chunk = vec![0u8; 1024 * 1024];
                let end = loop {
                    if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break p + 4;
                    }
                    let n = sock.read(&mut chunk).await.unwrap();
                    buf.extend_from_slice(&chunk[..n]);
                };
                let head = String::from_utf8_lossy(&buf[..end]).to_ascii_lowercase();
                let len: usize = head.lines().find_map(|l| l.strip_prefix("content-length:")).unwrap().trim().parse().unwrap();
                while buf.len() - end < len {
                    let n = sock.read(&mut chunk).await.unwrap();
                    buf.extend_from_slice(&chunk[..n]);
                }
                let got = buf[end..].to_vec();
                let body = answer.unwrap_or_else(|| {
                    let sha = sha256_hex(&got);
                    serde_json::json!({"url":format!("http://127.0.0.1:{port}/media/{sha}.bin"),"sha256":sha,"size":got.len(),"type":"application/octet-stream"}).to_string()
                });
                let _ = tx.send(got);
                let reply = format!("HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                sock.write_all(reply.as_bytes()).await.unwrap();
                let _ = sock.shutdown().await;
            }
        });
        (port, rx)
    }

    /// A long recording goes up as its parts, in order, each normalized, and each carries the length the relay stored, which
    /// the message's imeta must repeat (to 0.1 s) for stock Buzz to take it. The relay here answers as stock Buzz does: the
    /// still frame's length, from its own MP4 parser.
    #[tokio::test]
    async fn a_long_recording_uploads_as_parts_with_the_relays_lengths_for_imeta() {
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("work");
        let input = dir.path().join("voice 09-12.webm");
        let runs = [(500.0, true), (1.0, false), (549.0, true), (1.0, false), (209.0, true)];
        std::fs::write(&input, voice::testing::webm(&voice::testing::speech(&runs))).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(String, f64)>();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                let mut buf = Vec::new();
                let mut chunk = vec![0u8; 1024 * 1024];
                let end = loop {
                    if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break p + 4;
                    }
                    let n = sock.read(&mut chunk).await.unwrap();
                    buf.extend_from_slice(&chunk[..n]);
                };
                let head = String::from_utf8_lossy(&buf[..end]).to_ascii_lowercase();
                let len: usize = head.lines().find_map(|l| l.strip_prefix("content-length:")).unwrap().trim().parse().unwrap();
                while buf.len() - end < len {
                    let n = sock.read(&mut chunk).await.unwrap();
                    buf.extend_from_slice(&chunk[..n]);
                }
                let got = buf[end..].to_vec();
                let mp4 = mp4::Mp4Reader::read_header(std::io::Cursor::new(&got), got.len() as u64).unwrap();
                let video = mp4.tracks().values().find(|t| t.track_type().unwrap() == mp4::TrackType::Video).unwrap();
                let duration = video.duration().as_millis() as f64 / 1000.0;
                assert!(duration <= 600.0);
                let sha = sha256_hex(&got);
                let _ = tx.send((sha.clone(), duration));
                let body = serde_json::json!({"url":format!("http://127.0.0.1:{port}/media/{sha}.mp4"),"sha256":sha,"size":got.len(),
                    "type":"video/mp4","dim":"640x360","duration":duration}).to_string();
                let reply = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                sock.write_all(reply.as_bytes()).await.unwrap();
                let _ = sock.shutdown().await;
            }
        });
        let relay = format!("ws://127.0.0.1:{port}");
        let media = upload_media_with(&relay, &Keys::generate(), &input, "audio/webm", "voice 09-12.webm", &work, Some(&voice::testing::FAKE))
            .await
            .unwrap();
        let names: Vec<_> = media.iter().map(|m| m.filename.clone().unwrap()).collect();
        assert_eq!(names, ["voice 09-12 (1 of 3).m4a", "voice 09-12 (2 of 3).m4a", "voice 09-12 (3 of 3).m4a"]);
        let stored: Vec<_> = (0..3).map(|_| rx.try_recv().unwrap()).collect();
        for (m, (sha, duration)) in media.iter().zip(&stored) {
            assert_eq!(m.sha256.as_deref(), Some(sha.as_str()), "uploaded in order");
            assert_eq!(m.duration, Some(*duration));
        }
        // The message carries each length, as the relay checks it.
        let (_, tags) = crate::compose::outgoing_media(&relay, "", &media).unwrap();
        for (tag, (_, duration)) in tags.iter().zip(&stored) {
            assert!(tag.contains(&format!("duration {duration}")), "{tag:?}");
        }
        // The parts and their normalized copies are gone; the recording itself is the caller's.
        assert_eq!(std::fs::read_dir(&work).unwrap().count(), 0);
        assert!(input.exists());
    }

    #[tokio::test]
    async fn a_relay_refusal_is_one_plain_line_never_its_json() {
        let cases = [
            (422, r#"{"error":"moov atom not at front of file (not fast-start)"}"#, "after it was cleaned up"),
            (422, r#"{"error":"media contains metadata or a non-canonical metadata channel"}"#, "after it was cleaned up"),
            (415, r#"{"error":"unsupported media codec: only H.264 video and AAC audio are accepted"}"#, "H.264"),
            (415, r#"{"error":"disallowed content type: audio/mpeg"}"#, "audio/mpeg"),
            (422, r#"{"error":"audio too long: duration exceeds 10800 seconds"}"#, "Buzz takes audio up to 3 hours, and this one is longer."),
            (422, r#"{"error":"video too long: duration exceeds 3600 seconds"}"#, "Buzz takes video up to 60 minutes, and this one is longer."),
            // A relay still on the old rule says its own limit, not ours.
            (422, r#"{"error":"video too long: duration exceeds 600 seconds"}"#, "Buzz takes video up to 10 minutes, and this one is longer."),
            (422, r#"{"error":"audio too long: duration exceeds NaN seconds"}"#, "Buzz takes audio up to 3 hours, and this one is longer."),
            (401, r#"{"error":"authentication failed"}"#, "sign-in"),
            (500, r#"{"error":"internal error"}"#, "Retry"),
            (502, "<html>bad gateway</html>", "Retry"),
        ];
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("notes.txt");
        std::fs::write(&file, "made up").unwrap();
        for (status, body, expect) in cases {
            let (port, _seen) = relay_answering(vec![(status, Some(body.to_string()))]).await;
            let err = upload_media_file(&format!("ws://127.0.0.1:{port}"), &Keys::generate(), &file, "", "notes.txt", dir.path())
                .await
                .unwrap_err()
                .to_string();
            assert!(err.contains(expect), "{err}");
            assert!(!err.contains('{') && !err.contains('<') && !err.contains("media:") && !err.contains('\n'), "{err}");
        }
    }

    #[tokio::test]
    async fn too_many_uploads_waits_its_turn_instead_of_failing() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("notes.txt");
        std::fs::write(&file, "made up").unwrap();
        let busy = Some(r#"{"error":"upload concurrency limit reached"}"#.to_string());
        let (port, mut seen) = relay_answering(vec![(429, busy), (200, None)]).await;
        let media = upload_media_file(&format!("ws://127.0.0.1:{port}"), &Keys::generate(), &file, "", "notes.txt", dir.path())
            .await
            .unwrap();
        assert_eq!(media.filename.as_deref(), Some("notes.txt"));
        assert_eq!(seen.recv().await.unwrap(), b"made up");
        assert_eq!(seen.recv().await.unwrap(), b"made up", "the whole file again on the second try");
    }

    #[tokio::test]
    async fn no_relay_is_a_line_the_voice_retry_still_recognises() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("notes.txt");
        std::fs::write(&file, "made up").unwrap();
        let err = upload_media_file(&format!("ws://127.0.0.1:{port}"), &Keys::generate(), &file, "", "notes.txt", dir.path())
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("error sending request"), "netError.ts looks for these words: {err}");
        assert!(!err.contains("127.0.0.1") && !err.contains("media:"), "{err}");
    }

    #[tokio::test]
    async fn a_relay_that_goes_quiet_lets_go_of_the_upload() {
        let dir = tempfile::tempdir().unwrap();
        // Takes the headers and the file, then never answers.
        let quiet = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = quiet.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = quiet.accept().await.unwrap();
            let mut buf = vec![0u8; 1024 * 1024];
            while sock.read(&mut buf).await.unwrap_or(0) > 0 {}
        });
        let small = dir.path().join("notes.txt");
        std::fs::write(&small, "made up").unwrap();
        let err = tokio::time::timeout(
            Duration::from_secs(20),
            upload_with_quiet_limit(&format!("ws://127.0.0.1:{port}"), &Keys::generate(), &small, "", "notes.txt", dir.path(), Duration::from_secs(1)),
        )
        .await
        .expect("gave up by itself")
        .unwrap_err()
        .to_string();
        assert!(err.contains("timed out"), "voice retries on these words: {err}");

        // Takes the headers, then stops reading: the file stops moving partway.
        let stuck = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = stuck.local_addr().unwrap().port();
        let holder = tokio::spawn(async move {
            let (sock, _) = stuck.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(30)).await;
            drop(sock);
        });
        let big = dir.path().join("big.txt");
        std::fs::write(&big, vec![b'x'; 40 * 1024 * 1024]).unwrap();
        let err = tokio::time::timeout(
            Duration::from_secs(20),
            upload_with_quiet_limit(&format!("ws://127.0.0.1:{port}"), &Keys::generate(), &big, "", "big.txt", dir.path(), Duration::from_secs(1)),
        )
        .await
        .expect("gave up by itself")
        .unwrap_err()
        .to_string();
        assert!(err.contains("timed out"), "{err}");
        holder.abort();
    }

    /// A slow relay isn't a dead one: it has taken the whole file and is still storing it.
    #[tokio::test]
    async fn a_relay_that_answers_late_within_the_limit_is_waited_for() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("notes.txt");
        std::fs::write(&file, "made up").unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let sha = sha256_hex(b"made up");
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 64 * 1024];
            let mut got = Vec::new();
            while !got.ends_with(b"made up") {
                let n = sock.read(&mut buf).await.unwrap();
                got.extend_from_slice(&buf[..n]);
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
            let body = serde_json::json!({"url":format!("http://127.0.0.1:{port}/media/{sha}.bin"),"sha256":sha,"size":7,"type":"application/octet-stream"}).to_string();
            let reply = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            sock.write_all(reply.as_bytes()).await.unwrap();
        });
        let media = upload_with_quiet_limit(&format!("ws://127.0.0.1:{port}"), &Keys::generate(), &file, "", "notes.txt", dir.path(), Duration::from_secs(30)).await.unwrap();
        assert_eq!(media.size, Some(7));
    }

    #[tokio::test]
    async fn a_connection_lost_partway_is_tried_again() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("notes.txt");
        std::fs::write(&file, "made up").unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let sha = sha256_hex(b"made up");
        tokio::spawn(async move {
            // The first connection closes without an answer, like a relay refusing a file it won't read.
            let (first, _) = listener.accept().await.unwrap();
            drop(first);
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 64 * 1024];
            let mut got = Vec::new();
            while !got.ends_with(b"made up") {
                let n = sock.read(&mut buf).await.unwrap();
                got.extend_from_slice(&buf[..n]);
            }
            let body = serde_json::json!({"url":format!("http://127.0.0.1:{port}/media/{sha}.bin"),"sha256":sha,"size":7,"type":"application/octet-stream"}).to_string();
            let reply = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            sock.write_all(reply.as_bytes()).await.unwrap();
        });
        let media = upload_media_file(&format!("ws://127.0.0.1:{port}"), &Keys::generate(), &file, "", "notes.txt", dir.path()).await.unwrap();
        assert_eq!(media.size, Some(7));
    }

    /// Over the old 25 MB limit, by far: the file goes up whole from disk.
    #[tokio::test]
    async fn a_large_file_goes_up_whole() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("big.txt");
        let data: Vec<u8> = (0..60 * 1024 * 1024u32).map(|i| b"abcdefg\n"[(i % 8) as usize]).collect();
        std::fs::write(&file, &data).unwrap();
        let (port, mut seen) = relay_answering(vec![(200, None)]).await;
        let media = upload_media_file(&format!("ws://127.0.0.1:{port}"), &Keys::generate(), &file, "", "big.txt", dir.path()).await.unwrap();
        assert_eq!(media.size, Some(data.len() as i64));
        assert!(seen.recv().await.unwrap() == data);
    }

    /// The cleaned copy is what's sent, what the descriptor is checked against, and it's gone afterwards.
    #[tokio::test]
    async fn the_rewritten_copy_is_what_goes_up_and_it_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("work");
        let file = dir.path().join("p.png");
        let mut png = std::io::Cursor::new(Vec::new());
        image::RgbImage::new(2, 2).write_to(&mut png, image::ImageFormat::Png).unwrap();
        let mut png = png.into_inner();
        png.splice(33..33, png_chunk(b"tEXt", b"Comment\0made up"));
        std::fs::write(&file, &png).unwrap();
        for answers in [vec![(200, None)], vec![(422, Some(r#"{"error":"invalid image data"}"#.to_string()))]] {
            let ok = answers[0].0 == 200;
            let (port, mut seen) = relay_answering(answers).await;
            let result = upload_media_file(&format!("ws://127.0.0.1:{port}"), &Keys::generate(), &file, "", "p.png", &work).await;
            assert_eq!(result.is_ok(), ok);
            assert!(!seen.recv().await.unwrap().windows(7).any(|w| w == b"made up"));
            assert_eq!(std::fs::read_dir(&work).unwrap().count(), 0, "nothing left in the work folder");
        }
        assert_eq!(std::fs::read(&file).unwrap(), png, "the original is left alone");
    }

    #[test]
    fn upload_names_fit_the_relays_limit_in_bytes() {
        assert_eq!(upload_filename("/a/b\\c.mp4"), "c.mp4");
        assert_eq!(upload_filename("  \n "), "file");
        let long = "é".repeat(200);
        let cut = upload_filename(&long);
        assert!(cut.len() <= 255 && cut.chars().all(|c| c == 'é'));
    }
}
