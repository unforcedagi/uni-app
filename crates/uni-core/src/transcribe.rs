//! Voice-message transcription on the hub's host (faster-whisper behind
//! Tailscale Serve, port 8445). The URL derives from the hub setting
//! ([`crate::hub::transcribe_url`]), so it follows the tailnet rename.
//!
//! The app POSTs the recorded audio with a NIP-98 header signed by the user's
//! key; the server only accepts allowlisted pubkeys, so no token lives on the
//! device. Tailnet-only: off the tailnet a voice message still sends, just
//! without a transcript.
use std::time::Duration;

use nostr::Keys;
use serde::{Deserialize, Serialize};

use crate::{Error, Result};

/// Largest recording sent for transcription.
pub const MAX_TRANSCRIBE_BYTES: usize = 25 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Transcript {
    pub text: String,
    pub language: Option<String>,
    /// Audio length in seconds.
    pub duration: Option<f64>,
}

/// Transcribe `audio` at `url` (the NIP-98 `u` tag must match it exactly).
pub async fn transcribe(url: &str, keys: &Keys, audio: Vec<u8>, mime: &str) -> Result<Transcript> {
    post(url, keys, audio, mime).await.map_err(|(_, e)| e)
}

/// Transcribe on the hub's host ([`crate::hub::transcribe_url`]). When that
/// host can't be reached at all (DNS, connection) and the hub has another
/// name ([`crate::hub`]), try that once; `on_switch` hears the hub origin
/// that answered so the app can remember it. The hub and its other name
/// both pass [`crate::hub::checked_origin`] before any audio is sent; an
/// alias that fails it is never tried.
pub async fn transcribe_on_hub(
    hub: &str,
    keys: &Keys,
    audio: Vec<u8>,
    mime: &str,
    on_switch: Option<crate::parachute::OnHubSwitch>,
) -> Result<Transcript> {
    let hub = crate::hub::checked_origin(hub)?;
    let url = crate::hub::transcribe_url(&hub).ok_or_else(|| Error::Media(format!("no transcription URL for hub {hub}")))?;
    let alias = crate::hub::alias_of(&hub).and_then(|a| Some((crate::hub::transcribe_url(&a)?, a)));
    transcribe_or_alias(&url, alias, keys, audio, mime, on_switch).await
}

/// `url`, then once `alias` (its URL, and the hub origin to report) if `url`'s host is unreachable.
async fn transcribe_or_alias(
    url: &str,
    alias: Option<(String, String)>,
    keys: &Keys,
    audio: Vec<u8>,
    mime: &str,
    on_switch: Option<crate::parachute::OnHubSwitch>,
) -> Result<Transcript> {
    // both endpoints are checked before any audio leaves: a bad hub fails here,
    // a bad alias is dropped
    crate::hub::checked_origin(url)?;
    let alias = alias.filter(|(u, a)| crate::hub::checked_origin(u).is_ok() && crate::hub::checked_origin(a).is_ok());
    let err = match post(url, keys, audio.clone(), mime).await {
        Ok(t) => return Ok(t),
        Err((true, e)) => e,
        Err((false, e)) => return Err(e),
    };
    let Some((alias_url, alias)) = alias else {
        return Err(err);
    };
    match post(&alias_url, keys, audio, mime).await {
        Ok(t) => {
            if let Some(f) = on_switch {
                f(&alias);
            }
            Ok(t)
        }
        // the alias answered with an error: that's its answer
        Err((false, e)) => Err(e),
        Err((true, _)) => Err(err),
    }
}

/// One POST; the error says whether the host was unreachable (DNS/connect).
async fn post(url: &str, keys: &Keys, audio: Vec<u8>, mime: &str) -> std::result::Result<Transcript, (bool, Error)> {
    let plain = |e: Error| (false, e);
    crate::hub::checked_origin(url).map_err(plain)?;
    if audio.is_empty() || audio.len() > MAX_TRANSCRIBE_BYTES {
        return Err(plain(Error::Media("recording is empty or larger than 25 MB".into())));
    }
    crate::init_crypto();
    let auth = crate::parachute::nip98_header(keys, url, "POST", &audio).map_err(plain)?;
    // Whisper on a laptop CPU runs near real time; allow for long messages.
    let client = crate::media::http_client_with_timeout(Duration::from_secs(300)).map_err(plain)?;
    let hint = if mime.starts_with("audio/") && !mime.contains(['\r', '\n']) { mime } else { "application/octet-stream" };
    let response = client
        .post(url)
        .header("Authorization", auth)
        .header("Content-Type", hint)
        .body(audio)
        .send()
        .await
        .map_err(|e| (crate::hub::is_connect_failure(&e), Error::Media(format!("transcription unreachable (tailnet only): {e}"))))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let brief: String = body.chars().take(300).collect();
        return Err(plain(Error::Media(format!("transcription failed ({status}): {brief}"))));
    }
    serde_json::from_str(&body).map_err(|e| plain(Error::Media(format!("bad transcription response: {e}"))))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn posts_signed_audio_and_parses_reply() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://127.0.0.1:{}/transcribe", listener.local_addr().unwrap().port());
        let (tx, rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let n = sock.read(&mut chunk).await.unwrap();
                buf.extend_from_slice(&chunk[..n]);
                if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&buf[..end]).to_string();
                    let len: usize = head.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap())).unwrap();
                    if buf.len() >= end + 4 + len { tx.send((head, buf[end + 4..end + 4 + len].to_vec())).unwrap(); break; }
                }
            }
            let reply = r#"{"text":"hello there","language":"en","duration":1.5,"seconds":0.4}"#;
            sock.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len()).as_bytes()).await.unwrap();
        });
        let keys = Keys::generate();
        let t = transcribe(&url, &keys, b"OggS fake".to_vec(), "audio/ogg").await.unwrap();
        assert_eq!(t.text, "hello there");
        assert_eq!(t.language.as_deref(), Some("en"));
        let (head, body) = rx.await.unwrap();
        assert!(head.starts_with("POST /transcribe"));
        assert_eq!(body, b"OggS fake");
        assert!(head.to_ascii_lowercase().contains("authorization: nostr "));
        assert!(transcribe(&url, &keys, vec![], "audio/ogg").await.is_err());
    }

    /// Answers one POST with `status` and a transcript body.
    async fn answer_once(status: u16) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://127.0.0.1:{}/transcribe", listener.local_addr().unwrap().port());
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 65536];
            let _ = sock.read(&mut buf).await;
            let reply = r#"{"text":"from the alias","language":"en","duration":1.0}"#;
            let _ = sock.write_all(format!("HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len()).as_bytes()).await;
        });
        url
    }

    #[test]
    fn t137_the_url_derives_from_the_hub_host() {
        assert_eq!(crate::hub::transcribe_url("https://uni-1.example.ts.net").as_deref(), Some("https://uni-1.example.ts.net:8445/transcribe"));
        assert_eq!(crate::hub::transcribe_url("https://uni.example.ts.net").as_deref(), Some("https://uni.example.ts.net:8445/transcribe"));
    }

    #[tokio::test]
    async fn t137_an_unresolvable_host_falls_back_to_the_alias_once_and_reports_it() {
        let alias_url = answer_once(200).await;
        let heard = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let h2 = heard.clone();
        let t = transcribe_or_alias(
            "https://uni-t137-gone.invalid:8445/transcribe",
            Some((alias_url, "https://uni.example".into())),
            &Keys::generate(),
            b"OggS fake".to_vec(),
            "audio/ogg",
            Some(std::sync::Arc::new(move |o: &str| h2.lock().unwrap().push(o.into()))),
        )
        .await
        .unwrap();
        assert_eq!(t.text, "from the alias");
        assert_eq!(*heard.lock().unwrap(), vec!["https://uni.example".to_string()]);
    }

    /// A listener on 127.0.0.2 (loopback, but not a name `checked_origin`
    /// allows over http): counts any connection, so a refusal is provably
    /// made before audio leaves.
    async fn counting_remote() -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.2:0").await.unwrap();
        let origin = format!("http://127.0.0.2:{}", listener.local_addr().unwrap().port());
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let h = hits.clone();
        tokio::spawn(async move {
            while listener.accept().await.is_ok() {
                h.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
        });
        (origin, hits)
    }

    #[tokio::test]
    async fn an_http_remote_hub_is_refused_for_transcription() {
        let (remote, hits) = counting_remote().await;
        let keys = Keys::generate();
        // the hub setting itself
        let e = transcribe_on_hub(&remote, &keys, b"OggS fake".to_vec(), "audio/ogg", None).await.unwrap_err();
        assert!(e.to_string().contains("must be https"), "{e}");
        let e = transcribe_on_hub("http://uni-1.example.ts.net", &keys, b"OggS fake".to_vec(), "audio/ogg", None).await.unwrap_err();
        assert!(e.to_string().contains("must be https"), "{e}");
        // a URL handed straight to the client
        let e = transcribe(&format!("{remote}/transcribe"), &keys, b"OggS fake".to_vec(), "audio/ogg").await.unwrap_err();
        assert!(e.to_string().contains("must be https"), "{e}");
        // an alias over http to another machine is never tried: the hub's own failure stands
        let heard = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let h2 = heard.clone();
        let e = transcribe_or_alias(
            "https://uni-t137-gone.invalid:8445/transcribe",
            Some((format!("{remote}/transcribe"), remote.clone())),
            &keys,
            b"OggS fake".to_vec(),
            "audio/ogg",
            Some(std::sync::Arc::new(move |_: &str| h2.store(true, std::sync::atomic::Ordering::SeqCst))),
        )
        .await
        .unwrap_err();
        assert!(e.to_string().contains("unreachable"), "{e}");
        assert!(!heard.load(std::sync::atomic::Ordering::SeqCst));
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 0, "no audio reached the http remote");
    }

    #[tokio::test]
    async fn t137_an_http_error_is_an_answer_never_a_fallback() {
        for status in [401u16, 500] {
            let hub_url = answer_once(status).await;
            let heard = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let h2 = heard.clone();
            // an answer, even an error, is never retried on the alias (the report hook stays silent)
            let e = transcribe_or_alias(
                &hub_url,
                Some(("https://uni-t137-never.invalid:8445/transcribe".into(), "https://uni.example".into())),
                &Keys::generate(),
                b"OggS fake".to_vec(),
                "audio/ogg",
                Some(std::sync::Arc::new(move |_: &str| h2.store(true, std::sync::atomic::Ordering::SeqCst))),
            )
            .await
            .unwrap_err()
            .to_string();
            assert!(e.contains(&format!("({status}")), "{e}");
            assert!(!heard.load(std::sync::atomic::Ordering::SeqCst));
        }
    }
}
