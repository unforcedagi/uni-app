//! Live probe: upload each file the way the app does (normalized, streamed from disk) to the relay's Blossom endpoint
//! with the key in UNI_NSEC, then fetch it back with auth, which checks its hash. Posts no message.
//!
//! UNI_NSEC=<hex> cargo run -p uni-core --example upload_probe -- <relay-ws-url> <file>...
//!
//! Voice is checked by uploading the real Chromium MediaRecorder clip
//! (examples/testdata/voice_chrome_mediarecorder.webm): that is the exact
//! byte shape the app sends, and the relay's generic upload path must accept
//! it as audio/webm. Transcription is a separate probe (transcribe_probe) and
//! passing it says nothing about the relay upload.
use std::path::Path;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    uni_core::init_crypto();
    let (keys, _) = uni_core::load_keys(false)?;
    let relay = &args[1];
    let cache = tempfile::tempdir()?;
    for path in &args[2..] {
        let name = Path::new(path)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        let media = uni_core::media::upload_media_file(relay, &keys, Path::new(path), "", &name, cache.path()).await?;
        let got = uni_core::media::fetch_media_to_file(relay, &keys, &media.url, media.sha256.as_deref(), cache.path(), uni_core::media::MAX_STREAM_MEDIA_BYTES).await;
        println!(
            "{name}: url={} mime={:?} size={:?} dim={:?} name={:?} read-back={}",
            media.url,
            media.mime,
            media.size,
            media.dim,
            media.filename,
            match got {
                Ok(_) => "ok".to_string(),
                Err(e) => format!("FAILED: {e}"),
            }
        );
    }
    Ok(())
}
