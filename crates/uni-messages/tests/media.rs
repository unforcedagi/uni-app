//! T-313: what a conversation carries besides words, read as the app reads it. A voice message, a picture, a file, a
//! reply and reactions arrive from another person; the account under test sees each in its rows, fetches the
//! attachment's bytes through the homeserver's authenticated media (the homeserver here refuses the old
//! unauthenticated download), and gets a voice message's words transcribed once: a second ask, two asks at once and an
//! ask after a restart all read the kept words without transcribing again. A failed transcription isn't kept.
//!
//! A real homeserver (continuwuity, see common/), skipped where it isn't installed. The other person is an ordinary
//! account over plain HTTP; the transcriber is outside this crate (uni-transcribe), so a stand-in counts its calls.
//! Every name, word and sound here is made up.

#![recursion_limit = "256"]

mod common;

use std::{
    sync::{
        atomic::{AtomicUsize, Ordering::SeqCst},
        Arc,
    },
    time::Duration,
};

use common::{binary, esc, http, register, until, upload};
use serde_json::{json, Value};
use uni_messages::{FileSecrets, MediaKind, MessageRow, Messages, MessagesError, Transcriber, Transcribing};

const SERVER: &str = "media.test.localhost";

/// Counts its calls; answers made-up words, or fails while `fail` is set.
#[derive(Default)]
struct Calls {
    calls: AtomicUsize,
    fail: std::sync::atomic::AtomicBool,
    /// What the last call was given.
    last: std::sync::Mutex<Option<(Vec<u8>, String)>>,
}

#[derive(Clone, Default)]
struct Stand(Arc<Calls>);

impl std::ops::Deref for Stand {
    type Target = Calls;
    fn deref(&self) -> &Calls {
        &self.0
    }
}

impl Transcriber for Stand {
    fn transcribe(&self, audio: Vec<u8>, mime: String) -> Transcribing {
        let me = self.clone();
        Box::pin(async move {
            me.calls.fetch_add(1, SeqCst);
            *me.last.lock().unwrap() = Some((audio, mime));
            // long enough that two asks at once overlap
            tokio::time::sleep(Duration::from_millis(400)).await;
            if me.fail.load(SeqCst) {
                Err("the transcriber is away".into())
            } else {
                Ok("  Bring the green umbrella, it might rain later.  ".into())
            }
        })
    }
}

/// A short WAV: 0.3 s of a tone, made here.
fn tone() -> Vec<u8> {
    let rate = 8000u32;
    let samples: Vec<i16> = (0..rate * 3 / 10).map(|i| ((i as f32 * 0.3).sin() * 8000.0) as i16).collect();
    let data = samples.len() as u32 * 2;
    let mut w = Vec::new();
    w.extend_from_slice(b"RIFF");
    w.extend_from_slice(&(36 + data).to_le_bytes());
    w.extend_from_slice(b"WAVEfmt ");
    w.extend_from_slice(&16u32.to_le_bytes());
    w.extend_from_slice(&1u16.to_le_bytes());
    w.extend_from_slice(&1u16.to_le_bytes());
    w.extend_from_slice(&rate.to_le_bytes());
    w.extend_from_slice(&(rate * 2).to_le_bytes());
    w.extend_from_slice(&2u16.to_le_bytes());
    w.extend_from_slice(&16u16.to_le_bytes());
    w.extend_from_slice(b"data");
    w.extend_from_slice(&data.to_le_bytes());
    for s in samples {
        w.extend_from_slice(&s.to_le_bytes());
    }
    w
}

async fn send(port: u16, token: &str, room: &str, kind: &str, content: Value, n: usize) -> String {
    let (status, r) = http(port, "PUT", &format!("/_matrix/client/v3/rooms/{}/send/{kind}/t{n}", esc(room)), Some(content), Some(token)).await.unwrap();
    assert_eq!(status, 200, "{r}");
    r["event_id"].as_str().unwrap().to_owned()
}

fn row<'a>(rows: &'a [MessageRow], event: &str) -> Option<&'a MessageRow> {
    rows.iter().find(|r| r.event_id.as_deref() == Some(event))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn voice_pictures_files_replies_and_reactions_arrive_and_a_voice_message_is_transcribed_once() {
    let Some(bin) = binary() else {
        eprintln!("skipped: no continuwuity binary (set UNI_TEST_CONTINUWUITY)");
        return;
    };
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_owned();
    // no unauthenticated media: a download must carry the account's token (`/_matrix/client/v1/media`)
    let hs = common::start_with(bin, &dir, SERVER, "allow_legacy_media = false\n").await;
    let port = hs.port;
    let pat = register(&hs, "pat", true).await;
    let sam = register(&hs, "sam", false).await;
    let (status, r) = http(port, "PUT", &format!("/_matrix/client/v3/profile/{}/displayname", esc(&format!("@sam:{SERVER}"))), Some(json!({ "displayname": "Sam Rowan" })), Some(&sam)).await.unwrap();
    assert_eq!(status, 200, "{r}");
    let (_, room) = http(port, "POST", "/_matrix/client/v3/createRoom", Some(json!({ "name": "Garden plans", "preset": "private_chat", "invite": [format!("@pat:{SERVER}")] })), Some(&sam)).await.unwrap();
    let room = room["room_id"].as_str().unwrap().to_owned();
    let (status, r) = http(port, "POST", &format!("/_matrix/client/v3/join/{}", esc(&room)), Some(json!({})), Some(&pat)).await.unwrap();
    assert_eq!(status, 200, "{r}");

    // what Sam sends: a voice message as the bridges mark one, a picture declared as SVG, a file, a message and a reply
    let audio = tone();
    let audio_mxc = upload(port, &sam, &audio, "audio/ogg").await;
    let voice = send(port, &sam, &room, "m.room.message", json!({
        "msgtype": "m.audio", "body": "Voice message.ogg", "url": audio_mxc,
        "info": { "mimetype": "audio/ogg", "size": audio.len(), "duration": 2500 },
        "org.matrix.msc1767.audio": { "duration": 2500 }, "org.matrix.msc3245.voice": {}
    }), 1).await;
    let svg = b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>".to_vec();
    let svg_mxc = upload(port, &sam, &svg, "image/svg+xml").await;
    let picture = send(port, &sam, &room, "m.room.message", json!({
        "msgtype": "m.image", "body": "Seedlings by the window", "filename": "seedlings.svg", "url": svg_mxc,
        "info": { "mimetype": "image/svg+xml", "w": 640, "h": 480, "size": svg.len() }
    }), 2).await;
    let pdf = b"%PDF-1.4 made-up planting plan".to_vec();
    let pdf_mxc = upload(port, &sam, &pdf, "application/pdf").await;
    let file = send(port, &sam, &room, "m.room.message", json!({
        "msgtype": "m.file", "body": "planting-plan.pdf", "url": pdf_mxc, "info": { "mimetype": "application/pdf", "size": pdf.len() }
    }), 3).await;
    // Codex review 9b8p17d9: files larger than their events say (one understates its size, one gives none)
    let big = vec![9u8; 64 * 1024];
    let big_mxc = upload(port, &sam, &big, "application/pdf").await;
    let understated = send(port, &sam, &room, "m.room.message", json!({
        "msgtype": "m.file", "body": "small.pdf", "url": big_mxc, "info": { "mimetype": "application/pdf", "size": 100 }
    }), 20).await;
    let sizeless = send(port, &sam, &room, "m.room.message", json!({ "msgtype": "m.file", "body": "unsized.pdf", "url": big_mxc }), 21).await;
    let first = send(port, &sam, &room, "m.room.message", json!({ "msgtype": "m.text", "body": "Are the beans in yet?" }), 4).await;
    let reply = send(port, &pat, &room, "m.room.message", json!({
        "msgtype": "m.text", "body": "Not yet, Saturday.", "m.relates_to": { "m.in_reply_to": { "event_id": first } }
    }), 5).await;
    for (who, n) in [(&sam, 6), (&pat, 7)] {
        send(port, who, &room, "m.reaction", json!({ "m.relates_to": { "rel_type": "m.annotation", "event_id": first, "key": "🌱" } }), n).await;
    }
    // the old unauthenticated download is refused here, so whatever the account fetches came the authenticated way
    let legacy = http(port, "GET", &format!("/_matrix/media/v3/download/{}", audio_mxc.trim_start_matches("mxc://")), None, None).await.unwrap();
    assert_ne!(legacy.0, 200, "the homeserver still serves unauthenticated media");

    // Pat, as the app runs the account
    let stand = Stand::default();
    let app = dir.join("app");
    let m = Messages::new(app.join("data"), Arc::new(FileSecrets::new(app.join("secrets"))));
    m.set_transcriber(Arc::new(stand.clone()));
    // where the app keeps the attachments it opens (src-tauri: the media cache): a directory per launch
    let cache = dir.join("cache");
    let first_launch = m.set_copies_dir(&cache);
    m.sign_in(&hs.url(), "pat", "pw-0123456789").await.unwrap();
    until(30, "the room is listed", || {
        let (m, id) = (m.clone(), room.clone());
        async move { m.rooms().await.unwrap_or_default().iter().any(|r| r.id == id) }
    })
    .await;
    let ready = |rows: &[MessageRow]| {
        let quoted = row(rows, &reply).and_then(|r| r.reply.as_ref()).is_some_and(|q| q.text.is_some());
        let reacted = row(rows, &first).is_some_and(|r| r.reactions.first().is_some_and(|x| x.count == 2));
        quoted && reacted && row(rows, &voice).is_some() && row(rows, &sizeless).is_some()
    };
    let mut rows = Vec::new();
    for _ in 0..60 {
        rows = m.open(&room).await.unwrap_or_default();
        if ready(&rows) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert!(ready(&rows), "every message, with the reply's quote and both reactions: {rows:#?}");

    // the voice message: marked as one, its length and type as sent
    let v = row(&rows, &voice).unwrap().media.clone().unwrap();
    assert_eq!((v.kind, v.mime.as_str(), v.duration_ms, v.size), (MediaKind::Voice, "audio/ogg", Some(2500), Some(audio.len() as u64)));
    // and the room list's preview and the row's words say so, with its length
    assert_eq!(row(&rows, &voice).unwrap().body, "Voice message (0:02)");
    // a picture declared as SVG is never handed over as one (it can carry script): plain bytes
    let p = row(&rows, &picture).unwrap().media.clone().unwrap();
    assert_eq!((p.kind, p.mime.as_str(), p.width, p.height), (MediaKind::Image, "application/octet-stream", Some(640), Some(480)));
    assert_eq!(p.name, "seedlings.svg");
    assert_eq!(p.caption.as_deref(), Some("Seedlings by the window"));
    let f = row(&rows, &file).unwrap().media.clone().unwrap();
    assert_eq!((f.kind, f.name.as_str(), f.mime.as_str(), f.caption.as_deref()), (MediaKind::File, "planting-plan.pdf", "application/octet-stream", None));
    // the reply quotes who it answers and what they said; the reactions count both people, one of them Pat
    let q = row(&rows, &reply).unwrap().reply.clone().unwrap();
    assert_eq!((q.event_id.as_str(), q.sender_name.as_deref(), q.text.as_deref()), (first.as_str(), Some("Sam Rowan"), Some("Are the beans in yet?")));
    let x = &row(&rows, &first).unwrap().reactions;
    assert_eq!((x.len(), x[0].key.as_str(), x[0].count, x[0].own), (1, "🌱", 2, true));
    assert!(row(&rows, &first).unwrap().media.is_none());

    // the bytes, as sent, through the account's own client
    let got = m.media(&room, &voice).await.unwrap();
    assert_eq!(got.bytes, audio);
    assert_eq!(got.mime, "audio/ogg");
    assert_eq!(m.media(&room, &file).await.unwrap().bytes, pdf);
    // a message without an attachment, an event that isn't there, a room the account isn't in: refused
    assert!(matches!(m.media(&room, &first).await, Err(MessagesError::Invalid { .. })));
    assert!(matches!(m.media(&room, "$not-here:media.test.localhost").await, Err(MessagesError::Invalid { .. })));
    assert!(m.media("!elsewhere:media.test.localhost", &voice).await.is_err());
    // past this device's limit, whatever the event says: refused (download.rs stops reading at the limit)
    m.set_media_limit(16 * 1024);
    for (event, what) in [(&understated, "understated"), (&sizeless, "no size")] {
        let got = m.media(&room, event).await;
        assert!(matches!(got, Err(MessagesError::Invalid { ref message }) if message.contains("too large")), "{what}: {:?}", got.map(|f| f.bytes.len()));
    }
    assert_eq!(m.media(&room, &voice).await.unwrap().bytes, audio);
    m.set_media_limit(uni_messages::MAX_MEDIA);
    assert_eq!(m.media(&room, &sizeless).await.unwrap().bytes, big);

    // a copy for the system's viewer: written, decrypted; gone when the app quits (below)
    let (quit_copy, mime) = m.write_copy(&room, &voice).await.unwrap();
    assert_eq!(mime, "audio/ogg");
    assert!(quit_copy.starts_with(&first_launch) && quit_copy.to_string_lossy().ends_with("-Voice message.ogg"), "{}", quit_copy.display());
    assert_eq!(std::fs::read(&quit_copy).unwrap(), audio);
    // files in this launch's directory only
    let files_in = |d: &std::path::Path| std::fs::read_dir(d).map(|r| r.count()).unwrap_or(0);

    // only sound is transcribed
    assert!(matches!(m.transcript(&room, &file).await, Err(MessagesError::Invalid { .. })));
    assert_eq!(stand.calls.load(SeqCst), 0);

    // a failed transcription says so and isn't kept
    stand.fail.store(true, SeqCst);
    assert!(matches!(m.transcript(&room, &voice).await, Err(MessagesError::Unreachable { .. })));
    assert_eq!(stand.calls.load(SeqCst), 1);
    stand.fail.store(false, SeqCst);
    // two asks at once: one transcription, the same words for both, trimmed
    let (a, b) = tokio::join!(m.transcript(&room, &voice), m.transcript(&room, &voice));
    let words = "Bring the green umbrella, it might rain later.";
    assert_eq!((a.unwrap().text.as_str(), b.unwrap().text.as_str()), (words, words));
    assert_eq!(stand.calls.load(SeqCst), 2);
    // the transcriber was given the voice message itself, with its type
    assert_eq!(stand.last.lock().unwrap().clone(), Some((audio.clone(), "audio/ogg".to_owned())));
    // asked again: read back
    assert_eq!(m.transcript(&room, &voice).await.unwrap().text, words);
    assert_eq!(stand.calls.load(SeqCst), 2);

    // after a restart (the app quit, a new one over the same store): still kept, not transcribed again
    m.shut_down().await;
    assert!(!quit_copy.exists(), "a copy outlived the app's account");
    drop(m);
    let m = Messages::new(app.join("data"), Arc::new(FileSecrets::new(app.join("secrets"))));
    m.set_transcriber(Arc::new(stand.clone()));
    // the next start: an earlier launch's copies directory goes before Messages opens, whatever it holds
    std::fs::create_dir_all(&first_launch).unwrap();
    std::fs::write(first_launch.join("left-behind.pdf"), &pdf).unwrap();
    let copies = m.set_copies_dir(&cache);
    assert!(!first_launch.exists(), "an earlier launch's copies survived the next start");
    assert_ne!(copies, first_launch);
    m.resume().await.unwrap();
    until(30, "the room is listed again", || {
        let (m, id) = (m.clone(), room.clone());
        async move { m.rooms().await.unwrap_or_default().iter().any(|r| r.id == id) }
    })
    .await;
    m.open(&room).await.unwrap();
    assert_eq!(m.transcript(&room, &voice).await.unwrap().text, words);
    assert_eq!(stand.calls.load(SeqCst), 2, "transcribed again after a restart");

    // signed out, the copies go with the account (and the copy was this account's, written after a restart)
    let (out_copy, _) = m.write_copy(&room, &file).await.unwrap();
    assert_eq!(std::fs::read(&out_copy).unwrap(), pdf);
    // and the kept words go with the account's store; signed in again, it is a new device and a new store
    m.sign_out().await.unwrap();
    assert!(!out_copy.exists(), "a decrypted copy outlived sign-out");
    m.sign_in(&hs.url(), "pat", "pw-0123456789").await.unwrap();
    until(30, "the room is listed after signing in again", || {
        let (m, id) = (m.clone(), room.clone());
        async move { m.rooms().await.unwrap_or_default().iter().any(|r| r.id == id) }
    })
    .await;
    until(30, "the voice message is loaded again", || {
        let (m, id, voice) = (m.clone(), room.clone(), voice.clone());
        async move { m.open(&id).await.is_ok_and(|rows| row(&rows, &voice).is_some()) }
    })
    .await;
    assert_eq!(m.transcript(&room, &voice).await.unwrap().text, words);
    assert_eq!(stand.calls.load(SeqCst), 3, "a new sign-in kept the old account's words");

    // a copy being written as the account signs out: however the two fall, no copy is left once both are done
    for round in 0..3 {
        let (wrote, out) = tokio::join!(m.write_copy(&room, &file), m.sign_out());
        out.unwrap();
        assert_eq!(files_in(&copies), 0, "round {round}: a copy outlived sign-out (written: {})", wrote.is_ok());
        m.sign_in(&hs.url(), "pat", "pw-0123456789").await.unwrap();
        until(30, "the file is loaded after signing in again", || {
            let (m, id, file) = (m.clone(), room.clone(), file.clone());
            async move { m.open(&id).await.is_ok_and(|rows| row(&rows, &file).is_some()) }
        })
        .await;
    }

    // the app quits with an open under way: whichever way they fall, nothing is left, the directory included, and
    // nothing opens after
    let (_, ()) = tokio::join!(m.write_copy(&room, &file), async { m.drop_copies() });
    assert!(!copies.exists(), "the copies directory outlived quit");
    assert!(matches!(m.write_copy(&room, &file).await, Err(MessagesError::Invalid { .. })));
    assert!(!copies.exists(), "an open after quit made the copies directory again");
    m.shut_down().await;
}
