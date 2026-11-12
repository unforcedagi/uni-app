//! Makes media acceptable to the Buzz relay before it is uploaded, without re-encoding audio or video.
//!
//! The relay refuses anything it can't fully inspect rather than cleaning it (crates/buzz-media `validation.rs` and
//! `audio.rs`, `api/media.rs` for routing). Its rules, and who covers each:
//!
//! - Anything starting with `ftyp` is treated as video, and must be MP4-branded, `moov` before `mdat`, boxes from a short
//!   list only, exactly one H.264 track and at most one AAC track, up to 3840x2160, up to 500 MB: [`iso`].
//!   An audio-only MP4 is refused outright, so sound gets a one-frame H.264 track beside it, lasting as long as the
//!   sound. Stock Buzz measures that frame as video, up to 10 minutes, so that's the limit for sound (a long recording is
//!   cut into parts before it gets here: `media/voice`). More frames is video, up to 60 minutes. The longer track decides.
//! - JPEG, PNG, GIF and WebP with no metadata chunks, up to 25 MP, 50 MB (GIF 10 MB): [`image`].
//! - Other audio and video are refused, except single-track Opus in WebM or Ogg with no tags, up to 3 hours: [`opus`].
//!   Only our patched relay takes those; a device with codecs sends AAC instead, and this goes with the patches.
//! - Everything else is a download, up to 100 MB, unless it's a page or a program: [`classify`].
//!
//! What can't be made acceptable is a [`refuse`]: one plain line, ready to show as it is.
use std::io::Read as _;
use std::path::{Path, PathBuf};

use crate::{Error, Result};

mod image;
mod iso;
mod opus;

pub use image::sanitize_image_for_upload;
pub(crate) use opus::opus_head;

/// The relay's defaults (`BUZZ_MAX_*_BYTES`; the deployed relay sets none of them).
pub const MAX_VIDEO_BYTES: u64 = 500 * 1024 * 1024;
pub const MAX_IMAGE_BYTES: u64 = 50 * 1024 * 1024;
pub const MAX_GIF_BYTES: u64 = 10 * 1024 * 1024;
pub const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;
pub const MAX_PIXELS: u64 = 25_000_000;
/// Moving pictures (our relay's patch; stock Buzz takes 600 s; left until video is decided).
pub const MAX_VIDEO_SECONDS: f64 = 3_600.0;
/// Sound beside a still frame, as stock Buzz measures it: the frame's length, against its video limit
/// (validation.rs `validate_video_file`, 600 s).
pub const MAX_AUDIO_SECONDS: f64 = 600.0;
/// Opus in WebM or Ogg, which only our patched relay takes (its audio limit). Goes with the patches, target 2026-11-30.
pub const MAX_OPUS_SECONDS: f64 = 10_800.0;
pub const MAX_VIDEO_WIDTH: u32 = 3840;
pub const MAX_VIDEO_HEIGHT: u32 = 2160;

/// A file ready to upload.
#[derive(Debug)]
pub struct Normalized {
    /// The rewritten file, or the input itself when nothing needed changing.
    pub path: PathBuf,
    /// A new file in the work folder, for the caller to remove.
    pub rewritten: bool,
    /// The name to show: `.mov` becomes `.mp4`, sound with a still frame beside it is `.m4a`, which the app plays as audio.
    pub filename: String,
    /// The relay will treat it as video, with an hour to arrive. Anything else gets ten minutes.
    pub relay_video: bool,
}

/// A refusal to show as it is: one plain line that says why and, where there is one, what to do.
pub(crate) fn refuse(line: impl Into<String>) -> Error {
    Error::MediaRefused(line.into())
}

pub(crate) fn damaged() -> Error {
    refuse("This file is damaged or incomplete, so it can't be sent.")
}

/// An I/O failure while preparing a file. A full phone is the one worth naming.
pub(crate) fn io_failed(e: std::io::Error) -> Error {
    if e.kind() == std::io::ErrorKind::StorageFull {
        refuse("There isn't enough free space on this device to prepare the file.")
    } else {
        refuse("Couldn't read or prepare the file on this device. Attach it again.")
    }
}

/// "3 hours", "60 minutes", "10 minutes": a length limit in words, for messages.
pub(crate) fn limit_words(seconds: f64) -> String {
    let s = seconds.round() as u64;
    let unit = |n: u64, one: &str| format!("{n} {one}{}", if n == 1 { "" } else { "s" });
    if s >= 7200 && s.is_multiple_of(3600) {
        unit(s / 3600, "hour")
    } else if s >= 60 && s.is_multiple_of(60) {
        unit(s / 60, "minute")
    } else {
        unit(s, "second")
    }
}

/// "1:02:05" or "35:05", for messages. Rounded up, so a length just over a limit never reads as the limit.
pub(crate) fn clock(seconds: f64) -> String {
    let s = seconds.ceil() as u64;
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
    } else {
        format!("{}:{:02}", s / 60, s % 60)
    }
}

/// Sound past the relay's limit for it, in one line.
pub(crate) fn audio_too_long(seconds: f64, limit: f64) -> Error {
    refuse(format!(
        "This audio is {} long; Buzz takes audio up to {}. Trim it, then attach it again.",
        clock(seconds),
        limit_words(limit)
    ))
}

/// Moving pictures past the relay's limit for video, in one line.
pub(crate) fn video_too_long(seconds: f64) -> Error {
    refuse(format!(
        "This video is {} long; Buzz takes video up to {}. Trim it, then attach it again.",
        clock(seconds),
        limit_words(MAX_VIDEO_SECONDS)
    ))
}

/// "612 MB", for messages.
pub(crate) fn megabytes(bytes: u64) -> String {
    format!("{} MB", bytes.div_ceil(1024 * 1024))
}

/// `name` with another extension, within the relay's 255 bytes for a name.
fn renamed(name: &str, extension: &str) -> String {
    let stem = name.rsplit_once('.').map_or(name, |(s, _)| s);
    let mut end = stem.len().min(255 - extension.len());
    while !stem.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{extension}", &stem[..end])
}

/// Rewrite `input` into `work_dir` as the relay needs it, or say in one line why it can't be.
/// Sniffs the bytes: the name and the browser's type are not evidence (the relay ignores them too).
pub fn normalize_file(input: &Path, filename: &str, work_dir: &Path) -> Result<Normalized> {
    let size = std::fs::metadata(input).map_err(io_failed)?.len();
    if size == 0 {
        return Err(refuse("This file is empty."));
    }
    let mut head = [0u8; 8192];
    let n = read_head(input, &mut head)?;
    let head = &head[..n];
    std::fs::create_dir_all(work_dir).map_err(io_failed)?;
    let out = work_dir.join(format!("normalized-{}", uuid::Uuid::new_v4().simple()));
    let result = normalize_into(input, filename, head, size, &out);
    if !matches!(&result, Ok(n) if n.rewritten) {
        let _ = std::fs::remove_file(&out);
    }
    result
}

fn read_head(input: &Path, head: &mut [u8]) -> Result<usize> {
    let mut f = std::fs::File::open(input).map_err(io_failed)?;
    let mut n = 0;
    while n < head.len() {
        match f.read(&mut head[n..]).map_err(io_failed)? {
            0 => break,
            k => n += k,
        }
    }
    Ok(n)
}

fn normalize_into(input: &Path, filename: &str, head: &[u8], size: u64, out: &Path) -> Result<Normalized> {
    let same = || Normalized { path: input.to_path_buf(), rewritten: false, filename: filename.to_string(), relay_video: false };
    let rewritten = |name: String, relay_video: bool| Normalized { path: out.to_path_buf(), rewritten: true, filename: name, relay_video };
    match classify(head) {
        Kind::Iso => match iso::rewrite(input, size, out)? {
            Some(result) => {
                Ok(rewritten(renamed(filename, if result.audio_only { ".m4a" } else { ".mp4" }), true))
            }
            // Bytes 4..8 only looked like a box name, and there's no ftyp for the relay to see: an ordinary file.
            None => generic(head, size).map(|()| same()),
        },
        Kind::Image => {
            // A photo this large can't get under the relay's limit by scaling on a phone.
            if size > 4 * MAX_IMAGE_BYTES {
                return Err(refuse(format!("This image is {}; the limit is {}.", megabytes(size), megabytes(MAX_IMAGE_BYTES))));
            }
            let bytes = std::fs::read(input).map_err(io_failed)?;
            let clean = image::sanitize_image_for_upload(bytes)?;
            std::fs::write(out, clean).map_err(io_failed)?;
            Ok(rewritten(filename.to_string(), false))
        }
        Kind::Webm => {
            let clean = opus::normalize_webm(&read_bounded(input, size)?)?;
            within_file_limit(clean.len() as u64)?;
            within_audio_limit(opus::webm_seconds(&clean))?;
            std::fs::write(out, clean).map_err(io_failed)?;
            Ok(rewritten(filename.to_string(), false))
        }
        Kind::Ogg => {
            let clean = opus::normalize_ogg(&read_bounded(input, size)?)?;
            within_file_limit(clean.len() as u64)?;
            within_audio_limit(opus::ogg_seconds(&clean))?;
            std::fs::write(out, clean).map_err(io_failed)?;
            Ok(rewritten(filename.to_string(), false))
        }
        Kind::Other => generic(head, size).map(|()| same()),
    }
}

/// Known sizes make a rewritten WebM a little larger than a recorder's, so a file near the limit is measured again.
fn within_file_limit(size: u64) -> Result<()> {
    if size > MAX_FILE_BYTES {
        return Err(refuse(format!("This recording is {} once cleaned up; Buzz takes WebM or Ogg audio up to {}.", megabytes(size), megabytes(MAX_FILE_BYTES))));
    }
    Ok(())
}

/// The relay measures Opus by where its last block or page ends, and so does this.
fn within_audio_limit(seconds: f64) -> Result<()> {
    if seconds > MAX_OPUS_SECONDS {
        return Err(audio_too_long(seconds, MAX_OPUS_SECONDS));
    }
    Ok(())
}

fn read_bounded(input: &Path, size: u64) -> Result<Vec<u8>> {
    if size > MAX_FILE_BYTES {
        return Err(refuse(format!("This recording is {}; Buzz takes WebM or Ogg audio up to {}, and video only as MP4 with H.264.", megabytes(size), megabytes(MAX_FILE_BYTES))));
    }
    std::fs::read(input).map_err(io_failed)
}

enum Kind {
    Iso,
    Image,
    Webm,
    Ogg,
    Other,
}

fn classify(head: &[u8]) -> Kind {
    if iso::looks_like(head) {
        Kind::Iso
    } else if head.starts_with(b"\x89PNG\r\n\x1a\n")
        || head.starts_with(&[0xff, 0xd8, 0xff])
        || head.starts_with(b"GIF87a")
        || head.starts_with(b"GIF89a")
        || (head.len() >= 12 && head.starts_with(b"RIFF") && &head[8..12] == b"WEBP")
    {
        Kind::Image
    } else if head.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        Kind::Webm
    } else if head.starts_with(b"OggS") {
        Kind::Ogg
    } else {
        Kind::Other
    }
}

/// Types the relay recognises and blocks on its generic path (validation.rs `BLOCKED_FILE_MIME_TYPES`).
const PROGRAMS: &[&str] = &[
    "application/x-msdownload",
    "application/x-executable",
    "application/vnd.microsoft.portable-executable",
    "application/x-mach-binary",
    "application/x-sharedlib",
    "application/x-elf",
    "application/x-msi",
    "application/vnd.android.package-archive",
    "application/x-apple-diskimage",
];
const PAGES: &[&str] = &["text/html", "application/xhtml+xml", "image/svg+xml", "application/javascript", "text/javascript"];

/// The relay's generic path: anything it can name as media is refused, so say so here, before the upload.
fn generic(head: &[u8], size: u64) -> Result<()> {
    if let Some(kind) = infer::get(head) {
        let mime = kind.mime_type();
        if mime.starts_with("audio/") {
            let name = match mime {
                "audio/mpeg" => "MP3",
                "audio/x-wav" | "audio/wav" => "WAV",
                "audio/x-flac" | "audio/flac" => "FLAC",
                "audio/aac" => "raw AAC",
                _ => "in a format Buzz doesn't take",
            };
            return Err(refuse(format!("This audio is {name}; Buzz only takes M4A (AAC), or Opus in WebM or Ogg. Convert it, then attach it again.")));
        }
        if mime.starts_with("video/") {
            return Err(refuse(format!("This video is .{}; Buzz only takes MP4 with H.264. Convert it, then attach it again.", kind.extension())));
        }
        if mime.starts_with("image/") {
            return Err(refuse(format!("This image is .{}; Buzz only takes JPEG, PNG, GIF or WebP. Convert it, then attach it again.", kind.extension())));
        }
        if PROGRAMS.contains(&mime) {
            return Err(refuse("This is a program or installer, and Buzz doesn't take those."));
        }
        if PAGES.contains(&mime) {
            return Err(refuse("This is a web page or script, and Buzz doesn't take those."));
        }
    }
    if size > MAX_FILE_BYTES {
        return Err(refuse(format!("This file is {}; Buzz takes files up to {}.", megabytes(size), megabytes(MAX_FILE_BYTES))));
    }
    Ok(())
}
