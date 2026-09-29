//! Voice-message transcription on uni-1 (faster-whisper behind Tailscale Serve).
//!
//! The app POSTs the recorded audio with a NIP-98 header signed by the user's
//! key; the server only accepts allowlisted pubkeys, so no token lives on the
//! device. Tailnet-only: off the tailnet a voice message still sends, just
//! without a transcript.
use std::time::Duration;

use nostr::Keys;
use serde::{Deserialize, Serialize};

use crate::{Error, Result};

/// Public endpoint; the NIP-98 `u` tag must match it exactly.
pub const TRANSCRIBE_URL: &str = "https://uni-1.taildf9ce2.ts.net:8445/transcribe";
/// Largest recording sent for transcription.
pub const MAX_TRANSCRIBE_BYTES: usize = 25 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Transcript {
    pub text: String,
    pub language: Option<String>,
    /// Audio length in seconds.
    pub duration: Option<f64>,
}

/// Transcribe `audio` at `url` (normally [`TRANSCRIBE_URL`]).
pub async fn transcribe(url: &str, keys: &Keys, audio: Vec<u8>, mime: &str) -> Result<Transcript> {
    if audio.is_empty() || audio.len() > MAX_TRANSCRIBE_BYTES {
        return Err(Error::Media("recording is empty or larger than 25 MB".into()));
    }
    crate::init_crypto();
    let auth = crate::parachute::nip98_header(keys, url, "POST", &audio)?;
    // Whisper on a laptop CPU runs near real time; allow for long messages.
    let client = crate::media::http_client_with_timeout(Duration::from_secs(300))?;
    let hint = if mime.starts_with("audio/") && !mime.contains(['\r', '\n']) { mime } else { "application/octet-stream" };
    let response = client
        .post(url)
        .header("Authorization", auth)
        .header("Content-Type", hint)
        .body(audio)
        .send()
        .await
        .map_err(|e| Error::Media(format!("transcription unreachable (tailnet only): {e}")))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let brief: String = body.chars().take(300).collect();
        return Err(Error::Media(format!("transcription failed ({status}): {brief}")));
    }
    serde_json::from_str(&body).map_err(|e| Error::Media(format!("bad transcription response: {e}")))
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
}
