//! Opening a mail attachment (T-45): what may reach the system's opener.
//!
//! Mail comes from anyone, and the OS picks the app for a file by its name
//! and, on Linux, by sniffing its bytes. So a file is opened only when all
//! three agree: its name ends in a type on [`TYPES`] (documents, images,
//! audio, video), the type the message declares fits that extension, and
//! the bytes are one whole, well-formed file of that type ([`shape`]). A
//! name is checked before anything is fetched, the bytes before anything is
//! written; nothing refused is written at all.
//!
//! Refused: SVG or HTML named `invoice.png`, a program named `notes.pdf`,
//! text with script or web-page markup, a truncated file or one with
//! something added after its end, an Office file with macros, an OLE
//! object, an ActiveX control, an embedded package, any Word field (DDE among them) or a link
//! that loads from outside (a remote template, a linked image), an
//! OpenDocument with macros, an OLE object or a script binding, RTF with an
//! embedded object or any field but a link to a web or mail address. Markdown is opened as plain text
//! (`notes.md.txt`), so no Markdown viewer renders HTML from mail.
//!
//! What is written: a new folder per open, with a random name, inside the
//! mail cache folder, which must be a real folder (not a symlink) owned by
//! this user and is kept private (0700). The file is created exclusively
//! and never through a symlink, readable only by this user (0600).
//!
//! Limits: a PDF, an image or a recording is checked for its structure, not
//! decoded; the viewer still parses it. Office parts that aren't XML
//! (pictures, fonts) are not read; an Excel cell formula that calls DDE is
//! left to Excel, which asks first.

mod shape;

use std::path::{Path, PathBuf};

use shape::Doc;

use super::{check_id, invalid, safe_file_name, MailBridge, MailError, MailResult};

/// How an extension's bytes are recognised.
#[derive(Clone, Copy)]
enum Shape {
    Pdf,
    Png,
    Jpeg,
    Gif,
    Webp,
    /// ISO-BMFF with an image brand (`heic`, `mif1`, …).
    Heif,
    Bmp,
    /// UTF-8-ish text with no NUL byte and no markup a sniffer reads as HTML/SVG/XML.
    Text,
    /// [`Shape::Text`] that starts with the first line and ends with the second (`BEGIN:VCALENDAR` … `END:VCALENDAR`).
    TextBetween(&'static str, &'static str),
    Rtf,
    /// Office Open XML with its parts in this folder (`word/`).
    Ooxml(&'static str),
    /// OpenDocument of this type.
    Odf(&'static str),
    /// Apple iWork: a zip with an `Index/` or `index.xml` document.
    IWork,
    /// MPEG audio frames, after any ID3 tag.
    Mp3,
    /// AAC in ADTS frames.
    Adts,
    /// ISO-BMFF / QuickTime (`ftyp`, `moov`, …).
    IsoMedia,
    Ogg,
    Wav,
    /// WebM (EBML).
    Ebml,
}

use Shape::*;

/// Each openable extension, the MIME types a sender may declare for it, and its bytes.
/// Anything that can run as a program or a web page (`.exe`, `.command`, scripts,
/// `.html`, `.svg`, archives, macro formats) is not here, so it is never opened.
/// Nor are TIFF and FLAC: neither marks its end, so a whole file can't be told
/// from a cut or extended one without decoding it.
const TYPES: &[(&str, &[&str], Shape)] = &[
    ("pdf", &["application/pdf", "application/x-pdf"], Pdf),
    ("png", &["image/png", "image/x-png"], Png),
    ("jpg", &["image/jpeg", "image/jpg", "image/pjpeg"], Jpeg),
    ("jpeg", &["image/jpeg", "image/jpg", "image/pjpeg"], Jpeg),
    ("gif", &["image/gif"], Gif),
    ("webp", &["image/webp"], Webp),
    ("heic", &["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"], Heif),
    ("heif", &["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"], Heif),
    ("bmp", &["image/bmp", "image/x-bmp", "image/x-ms-bmp"], Bmp),
    ("txt", &["text/plain"], Text),
    // opened as plain text: see OPENED_AS
    ("md", &["text/markdown", "text/x-markdown", "text/plain"], Text),
    // Outlook sends CSV as application/vnd.ms-excel
    ("csv", &["text/csv", "text/plain", "application/csv", "application/x-csv", "text/x-csv", "text/comma-separated-values", "text/x-comma-separated-values", "application/vnd.ms-excel"], Text),
    ("ics", &["text/calendar", "application/ics", "text/x-vcalendar"], TextBetween("BEGIN:VCALENDAR", "END:VCALENDAR")),
    ("vcf", &["text/vcard", "text/x-vcard", "text/directory"], TextBetween("BEGIN:VCARD", "END:VCARD")),
    ("rtf", &["application/rtf", "text/rtf"], Rtf),
    ("docx", &["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/msword", "application/zip", "application/x-zip-compressed"], Ooxml("word/")),
    ("xlsx", &["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel", "application/zip", "application/x-zip-compressed"], Ooxml("xl/")),
    ("pptx", &["application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/vnd.ms-powerpoint", "application/zip", "application/x-zip-compressed"], Ooxml("ppt/")),
    ("odt", &["application/vnd.oasis.opendocument.text", "application/zip"], Odf("application/vnd.oasis.opendocument.text")),
    ("ods", &["application/vnd.oasis.opendocument.spreadsheet", "application/zip"], Odf("application/vnd.oasis.opendocument.spreadsheet")),
    ("odp", &["application/vnd.oasis.opendocument.presentation", "application/zip"], Odf("application/vnd.oasis.opendocument.presentation")),
    ("pages", &["application/vnd.apple.pages", "application/zip", "application/x-iwork-pages-sffpages"], IWork),
    ("numbers", &["application/vnd.apple.numbers", "application/zip", "application/x-iwork-numbers-sffnumbers"], IWork),
    ("key", &["application/vnd.apple.keynote", "application/zip", "application/x-iwork-keynote-sffkey"], IWork),
    ("mp3", &["audio/mpeg", "audio/mp3", "audio/mpeg3", "audio/x-mpeg", "audio/x-mp3"], Mp3),
    ("aac", &["audio/aac", "audio/x-aac", "audio/aacp"], Adts),
    ("m4a", &["audio/mp4", "audio/x-m4a", "audio/m4a", "audio/aac"], IsoMedia),
    ("mp4", &["video/mp4", "audio/mp4", "application/mp4"], IsoMedia),
    ("m4v", &["video/x-m4v", "video/mp4"], IsoMedia),
    ("mov", &["video/quicktime"], IsoMedia),
    ("ogg", &["audio/ogg", "video/ogg", "application/ogg", "audio/vorbis"], Ogg),
    ("opus", &["audio/opus", "audio/ogg"], Ogg),
    ("wav", &["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"], Wav),
    ("webm", &["video/webm", "audio/webm"], Ebml),
];

/// Types opened under another extension, so the system picks a safer app: Markdown as plain text, since a
/// Markdown viewer renders any HTML in it.
const OPENED_AS: &[(&str, &str)] = &[("md", "txt")];

/// Types a mailer declares when it doesn't know; the bytes still decide.
const GENERIC: &[&str] = &["", "application/octet-stream", "binary/octet-stream", "application/x-download", "application/force-download", "application/unknown"];

fn entry(ext: &str) -> Option<&'static (&'static str, &'static [&'static str], Shape)> {
    TYPES.iter().find(|(e, _, _)| *e == ext)
}

/// The extension the attachment would be saved with, if the app may open that type.
pub fn openable_extension(name: Option<&str>) -> std::result::Result<String, String> {
    let file = safe_file_name(name);
    let ext = file.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    if entry(&ext).is_some() {
        Ok(ext)
    } else {
        Err(if ext.is_empty() { "a file with no type".to_string() } else { format!(".{ext} files") })
    }
}

/// Why the declared MIME type (parameters ignored) doesn't fit `ext`, if it doesn't; a generic type always fits.
fn declared_mismatch(ext: &str, mime: Option<&str>) -> Option<String> {
    let m = mime.unwrap_or("").split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    let fits = GENERIC.contains(&m.as_str()) || entry(ext).is_some_and(|(_, mimes, _)| mimes.contains(&m.as_str()));
    (!fits).then(|| format!("it is sent as {}, not a .{ext} file", mime.unwrap_or("").trim()))
}

/// Whether the declared MIME type fits `ext`.
pub fn declared_type_fits(ext: &str, mime: Option<&str>) -> bool {
    declared_mismatch(ext, mime).is_none()
}

fn has(hay: &[u8], needle: &[u8]) -> bool {
    memchr::memmem::find(hay, needle).is_some()
}

/// Text as lowercase UTF-8, if `bytes` are text: UTF-8 (or a single-byte charset) with no NUL,
/// or UTF-16 with a byte-order mark. BOM and leading whitespace removed.
fn text_of(bytes: &[u8]) -> Option<Vec<u8>> {
    let utf16 = |be: bool| {
        let units: Vec<u16> = bytes[2..].chunks(2).map(|c| if c.len() == 2 { if be { u16::from_be_bytes([c[0], c[1]]) } else { u16::from_le_bytes([c[0], c[1]]) } } else { 0xFFFD }).collect();
        String::from_utf16(&units).ok().map(String::into_bytes)
    };
    let text = if bytes.starts_with(b"\xFF\xFE") {
        utf16(false)?
    } else if bytes.starts_with(b"\xFE\xFF") {
        utf16(true)?
    } else if bytes.contains(&0) {
        return None;
    } else {
        bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes).to_vec()
    };
    if text.contains(&0) {
        return None;
    }
    let at = text.iter().position(|c| !c.is_ascii_whitespace()).unwrap_or(text.len());
    Some(text[at..].to_ascii_lowercase())
}

/// Markup that a content sniffer (shared-mime-info, a browser) reads as a web page, SVG or XML, or
/// that a Markdown viewer would run or load: refused anywhere in a text file.
const MARKUP: &[&[u8]] = &[b"<html", b"<svg", b"<script", b"<!doctype", b"<?xml", b"<iframe", b"<frame", b"<body", b"<head", b"<object", b"<embed", b"<meta", b"<link", b"<form", b"<base", b"javascript:"];

/// Plain text: no markup, and not a script. A file that *starts* with `<` sniffs as HTML, so it is refused too.
fn plain_text(text: &[u8]) -> bool {
    !text.starts_with(b"<") && !text.starts_with(b"#!") && !MARKUP.iter().any(|m| has(text, m))
}

/// What a file's first bytes claim it is, whether or not the rest holds up.
fn claims(shape: Shape, b: &[u8]) -> bool {
    let iso_box = || b.get(4..8);
    match shape {
        Pdf => b.starts_with(b"%PDF-"),
        Png => b.starts_with(b"\x89PNG\r\n\x1a\n"),
        Jpeg => b.starts_with(b"\xFF\xD8\xFF"),
        Gif => b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a"),
        Webp => b.starts_with(b"RIFF") && b.get(8..12) == Some(b"WEBP"),
        Heif => iso_box() == Some(b"ftyp"),
        IsoMedia => iso_box().is_some_and(|t| shape::ISO_MEDIA_FIRST.iter().any(|x| t == *x)),
        Bmp => b.starts_with(b"BM"),
        Text => false,
        TextBetween(first, _) => text_of(b).is_some_and(|t| plain_text(&t) && t.starts_with(first.to_ascii_lowercase().as_bytes())),
        Rtf => b.starts_with(b"{\\rtf"),
        Ooxml(_) | Odf(_) | IWork => b.starts_with(b"PK\x03\x04"),
        Mp3 => b.starts_with(b"ID3") || (b.len() > 1 && b[0] == 0xFF && b[1] & 0xE0 == 0xE0),
        Adts => b.starts_with(b"ID3") || (b.len() > 1 && b[0] == 0xFF && b[1] & 0xF6 == 0xF0),
        Ogg => b.starts_with(b"OggS"),
        Wav => b.starts_with(b"RIFF") && b.get(8..12) == Some(b"WAVE"),
        Ebml => b.starts_with(b"\x1A\x45\xDF\xA3"),
    }
}

/// Whether `b` is one whole file of `shape`, holding nothing that runs or loads.
fn verdict(shape: Shape, b: &[u8]) -> Doc {
    let whole = match shape {
        Ooxml(folder) => return shape::ooxml(b, folder),
        Odf(mime) => return shape::odf(b, mime),
        Rtf => return shape::rtf(b).0,
        Pdf => shape::pdf(b),
        Png => shape::png(b),
        Jpeg => shape::jpeg(b),
        Gif => shape::gif(b),
        Webp => shape::webp(b),
        Heif => shape::heif(b),
        Bmp => shape::bmp(b),
        Text => text_of(b).is_some_and(|t| plain_text(&t)),
        TextBetween(first, last) => text_of(b).is_some_and(|t| {
            let t = t.trim_ascii_end();
            plain_text(t) && t.starts_with(first.to_ascii_lowercase().as_bytes()) && t.ends_with(last.to_ascii_lowercase().as_bytes())
        }),
        IWork => shape::iwork(b),
        Mp3 => shape::mp3(b),
        Adts => shape::adts(b),
        IsoMedia => shape::iso_media(b),
        Ogg => shape::ogg(b),
        Wav => shape::wav(b),
        Ebml => shape::webm(b),
    };
    if whole { Doc::Fine } else { Doc::Broken }
}

/// A plain description of what `bytes` look like, for the refusal message.
pub fn looks_like(bytes: &[u8]) -> &'static str {
    let text = text_of(bytes);
    if bytes.starts_with(b"MZ") {
        "a Windows program"
    } else if bytes.starts_with(b"\x7FELF") {
        "a Linux program"
    } else if [b"\xCF\xFA\xED\xFE", b"\xCE\xFA\xED\xFE", b"\xCA\xFE\xBA\xBE"].iter().any(|m| bytes.starts_with(*m)) {
        "a Mac program"
    } else if let Some(t) = text.as_deref().filter(|t| !plain_text(t)) {
        if t.starts_with(b"#!") {
            "a script"
        } else if has(t, b"<svg") {
            "an SVG image (which can run script)"
        } else {
            "a web page"
        }
    } else if bytes.starts_with(b"PK\x03\x04") {
        "a zip archive"
    } else if bytes.is_empty() {
        "an empty file"
    } else {
        "something else"
    }
}

fn bytes_mismatch(ext: &str, bytes: &[u8]) -> Option<String> {
    let (_, _, shape) = entry(ext)?;
    let why = match verdict(*shape, bytes) {
        Doc::Fine => return None,
        Doc::Active => match shape {
            Ooxml(_) => "it is an Office file with macros, an embedded object, unsupported fields, or a link that loads from outside".to_string(),
            Rtf => "its contents are a document with an embedded object or unsupported fields".to_string(),
            _ => "it is a document with macros, an embedded object or a script binding".to_string(),
        },
        Doc::Broken if claims(*shape, bytes) => format!("it isn't a whole .{ext} file: it is cut short, damaged, or has something added"),
        Doc::Broken => format!("its contents are {}", looks_like(bytes)),
    };
    Some(format!("it is named .{ext} but {why}"))
}

/// Whether `bytes`, declared as `mime`, may be opened as a `.ext` file; why not, if not.
pub fn check_content(ext: &str, mime: Option<&str>, bytes: &[u8]) -> std::result::Result<(), String> {
    if entry(ext).is_none() {
        return Err(format!(".{ext} files"));
    }
    match declared_mismatch(ext, mime).or_else(|| bytes_mismatch(ext, bytes)) {
        Some(why) => Err(why),
        None => Ok(()),
    }
}

/// The name the file is saved under: its safe name, with `.txt` added for a type opened as text.
pub fn saved_name(name: Option<&str>, ext: &str) -> String {
    let file = safe_file_name(name);
    match OPENED_AS.iter().find(|(from, _)| *from == ext) {
        Some((_, to)) => format!("{file}.{to}"),
        None => file,
    }
}

fn refused(why: &str) -> MailError {
    invalid(format!("Uni didn't open this attachment: {why}. Open it in your mail client if you trust the sender."))
}

/// The checks made before anything is fetched (name, then declared type); the extension to save with.
fn checked_before_fetch(name: Option<&str>, mime: Option<&str>) -> MailResult<String> {
    let ext = openable_extension(name).map_err(|what| invalid(format!("Uni doesn't open {what} from mail: they could run as a program. Open it in your mail client if you trust the sender.")))?;
    if let Some(why) = declared_mismatch(&ext, mime) {
        return Err(refused(&why));
    }
    Ok(ext)
}

/// Why opening this attachment would be refused without fetching it (its name or declared type), in the words
/// [`open_attachment`] would use; `None` when only its bytes can decide. The list shows it at once (T-45 v2).
pub fn refused_before_fetch(name: Option<&str>, mime: Option<&str>) -> Option<String> {
    match checked_before_fetch(name, mime) {
        Ok(_) => None,
        Err(MailError::Invalid { message }) => Some(message),
        Err(e) => Some(e.to_string()),
    }
}

/// How long an opened attachment is kept: long enough for its viewer to be done with it.
const KEEP_OPENED: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

fn not_safe(what: &str) -> std::io::Error {
    std::io::Error::other(what.to_string())
}

/// Write `bytes` as `name` in a new folder of its own inside `cache`; its path.
///
/// `cache` is opened without following a symlink and must be a folder owned by this user; it is made
/// private (0700) if it isn't. The new folder (a random name) and the file are created exclusively,
/// relative to the folder already opened, never through a symlink; the file is readable only by this user.
#[cfg(unix)]
fn write_private(cache: &Path, name: &str, bytes: &[u8]) -> std::io::Result<PathBuf> {
    use rustix::fs::{fchmod, fstat, mkdirat, openat, FileType, Mode, OFlags, CWD};
    use std::io::Write;
    if let Some(parent) = cache.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match mkdirat(CWD, cache, Mode::RWXU) {
        Ok(()) | Err(rustix::io::Errno::EXIST) => {}
        Err(e) => return Err(e.into()),
    }
    let folder_flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let dir = openat(CWD, cache, folder_flags, Mode::empty()).map_err(|e| if e == rustix::io::Errno::LOOP || e == rustix::io::Errno::NOTDIR { not_safe("the mail cache folder is a link or not a folder") } else { e.into() })?;
    let st = fstat(&dir)?;
    if FileType::from_raw_mode(st.st_mode) != FileType::Directory || st.st_uid != rustix::process::geteuid().as_raw() {
        return Err(not_safe("the mail cache folder isn't this user's"));
    }
    if (st.st_mode as u32) & 0o077 != 0 {
        fchmod(&dir, Mode::RWXU)?;
    }
    let folder = uuid::Uuid::new_v4().simple().to_string();
    mkdirat(&dir, folder.as_str(), Mode::RWXU)?;
    let sub = openat(&dir, folder.as_str(), folder_flags, Mode::empty())?;
    let fd = openat(&sub, name, OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC, Mode::RUSR | Mode::WUSR)?;
    std::fs::File::from(fd).write_all(bytes)?;
    prune_at(&dir);
    Ok(cache.join(folder).join(name))
}

/// Remove what earlier opens left in the cache folder once it is a day old, working through the folder already
/// opened (never its path again): links and files are unlinked, an open's folder is emptied and removed. Nothing
/// is followed, and nothing deeper than an open's folder is touched.
#[cfg(unix)]
#[allow(clippy::useless_conversion)] // st_mtime is 32-bit on armv7 Android
fn prune_at(dir: &rustix::fd::OwnedFd) {
    use rustix::fs::{openat, statat, unlinkat, AtFlags, Dir, FileType, Mode, OFlags};
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
    let entries = |fd: &rustix::fd::OwnedFd| -> Vec<std::ffi::CString> {
        Dir::read_from(fd).map(|d| d.flatten().map(|e| e.file_name().to_owned()).filter(|n| n.as_bytes() != b"." && n.as_bytes() != b"..").collect()).unwrap_or_default()
    };
    for name in entries(dir) {
        let Ok(st) = statat(dir, name.as_c_str(), AtFlags::SYMLINK_NOFOLLOW) else { continue };
        if now - i64::from(st.st_mtime) < KEEP_OPENED.as_secs() as i64 {
            continue;
        }
        if FileType::from_raw_mode(st.st_mode) == FileType::Directory {
            let Ok(sub) = openat(dir, name.as_c_str(), OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC, Mode::empty()) else { continue };
            for inner in entries(&sub) {
                let _ = unlinkat(&sub, inner.as_c_str(), AtFlags::empty()); // fails on a folder, which is left alone
            }
            let _ = unlinkat(dir, name.as_c_str(), AtFlags::REMOVEDIR);
        } else {
            let _ = unlinkat(dir, name.as_c_str(), AtFlags::empty());
        }
    }
}

#[cfg(not(unix))]
fn write_private(cache: &Path, name: &str, bytes: &[u8]) -> std::io::Result<PathBuf> {
    use std::io::Write;
    std::fs::create_dir_all(cache)?;
    let meta = std::fs::symlink_metadata(cache)?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(not_safe("the mail cache folder is a link or not a folder"));
    }
    let folder = cache.join(uuid::Uuid::new_v4().simple().to_string());
    std::fs::create_dir(&folder)?;
    let path = folder.join(name);
    std::fs::OpenOptions::new().write(true).create_new(true).open(&path)?.write_all(bytes)?;
    prune(cache);
    Ok(path)
}

/// Remove what earlier opens left in `cache` once it is a day old. Links are removed, never followed.
#[cfg(not(unix))]
fn prune(cache: &Path) {
    let Ok(entries) = std::fs::read_dir(cache) else { return };
    for e in entries.flatten() {
        let Ok(meta) = std::fs::symlink_metadata(e.path()) else { continue };
        if meta.modified().ok().and_then(|m| m.elapsed().ok()).is_some_and(|age| age > KEEP_OPENED) {
            let _ = if meta.is_dir() { std::fs::remove_dir_all(e.path()) } else { std::fs::remove_file(e.path()) };
        }
    }
}

/// Fetch an attachment into a new folder of its own in `cache` and hand it
/// to `open` (the system opener in the app; a recorder in tests). The name
/// and declared type are checked before anything is fetched, the bytes
/// before anything is written; a refused file is never written.
pub async fn open_attachment<O>(bridge: &MailBridge<'_>, cache: &Path, blob_id: &str, name: Option<&str>, mime: Option<&str>, open: O) -> MailResult<PathBuf>
where
    O: FnOnce(&Path) -> std::result::Result<(), String>,
{
    open_attachment_in(bridge, cache, None, blob_id, name, mime, open).await
}

/// [`open_attachment`] for a blob in `account` (T-45 v2: the shared mailbox is a second JMAP account);
/// `None` is the bridge's own account.
pub async fn open_attachment_in<O>(bridge: &MailBridge<'_>, cache: &Path, account: Option<&str>, blob_id: &str, name: Option<&str>, mime: Option<&str>, open: O) -> MailResult<PathBuf>
where
    O: FnOnce(&Path) -> std::result::Result<(), String>,
{
    let ext = checked_before_fetch(name, mime)?;
    check_id(blob_id)?;
    let bytes = match account {
        Some(a) => bridge.blob_in(a, blob_id).await?,
        None => bridge.blob(blob_id).await?,
    };
    if let Some(why) = bytes_mismatch(&ext, &bytes) {
        return Err(refused(&why));
    }
    let path = write_private(cache, &saved_name(name, &ext), &bytes).map_err(|e| invalid(format!("Uni couldn't save this attachment safely: {e}")))?;
    open(&path).map_err(invalid)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_documents_and_media_are_opened_from_mail() {
        for ok in ["notes.pdf", "Photo.JPG", "slides.pptx", "voice.m4a", "cal.ics"] {
            assert!(openable_extension(Some(ok)).is_ok(), "{ok}");
        }
        for bad in ["invoice.exe", "run.command", "x.sh", "page.html", "logo.svg", "a.zip", "macro.docm", "doc.pdf.exe", "README", "x.lnk", "x.app"] {
            assert!(openable_extension(Some(bad)).is_err(), "{bad}");
        }
        assert_eq!(openable_extension(Some("invoice.exe")).unwrap_err(), ".exe files");
    }

    #[test]
    fn the_declared_type_must_fit_the_extension() {
        assert!(declared_type_fits("png", Some("image/png")));
        assert!(declared_type_fits("png", Some("IMAGE/PNG; name=x.png")));
        assert!(declared_type_fits("pdf", Some("application/octet-stream")), "generic: the bytes decide");
        assert!(declared_type_fits("pdf", None));
        assert!(!declared_type_fits("png", Some("image/svg+xml")));
        assert!(!declared_type_fits("txt", Some("text/html")));
        assert!(!declared_type_fits("pdf", Some("application/x-msdownload")));
    }

    /// Codex round 3: every literal `fldinst` started a new scan of the rest of its group, so `{\rtf1 ` and
    /// `fldinst ` repeated to 800 KB took tens of billions of steps. One pass visits each byte about once.
    #[test]
    fn rtf_is_decided_in_one_bounded_pass() {
        let payloads: Vec<(&str, Vec<u8>, Doc)> = vec![
            ("codex: unclosed", [&b"{\\rtf1 "[..], &b"fldinst ".repeat(100_000)].concat(), Doc::Broken),
            ("closed", [&b"{\\rtf1 "[..], &b"fldinst ".repeat(100_000), b"}"].concat(), Doc::Fine),
            ("as control words", [&b"{\\rtf1{\\field{\\*\\fldinst "[..], &b"\\rtlch ".repeat(110_000), b"HYPERLINK https://a.org/}}}"].concat(), Doc::Fine),
            ("nested instruction groups", [&b"{\\rtf1{\\field{\\*\\fldinst "[..], &b"{\\b ".repeat(200_000), &b"}".repeat(200_000), b"}}}"].concat(), Doc::Fine),
            ("fields nested in results", [&b"{\\rtf1"[..], &b"{\\field{\\fldrslt ".repeat(50_000), &b"}}".repeat(50_000), b"}"].concat(), Doc::Fine),
            ("dde at the end", [&b"{\\rtf1{\\field{\\*\\fldinst "[..], &b"{x}".repeat(250_000), b"DDE}}}"].concat(), Doc::Active),
        ];
        for (what, rtf, expected) in payloads {
            assert!(rtf.len() >= 750_000, "{what}: {} bytes", rtf.len());
            let (doc, work) = shape::rtf(&rtf);
            assert_eq!(doc, expected, "{what}");
            assert!(work <= 2 * rtf.len(), "{what}: {work} steps for {} bytes", rtf.len());
        }
    }
}
