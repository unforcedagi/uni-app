//! Live probe: upload each file to the relay's Blossom endpoint with the key in
//! UNI_NSEC, then fetch it back with auth and compare bytes. Posts no message.
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
        let bytes = std::fs::read(path)?;
        let name = Path::new(path)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        let media = uni_core::media::upload_media(relay, &keys, bytes.clone(), "", &name).await?;
        let back = uni_core::media::fetch_media(
            relay,
            &keys,
            &media.url,
            media.sha256.as_deref(),
            cache.path(),
        )
        .await?;
        // Images are metadata-stripped before upload, so compare against the
        // sanitized bytes (identical to the input for audio/files).
        let expected = uni_core::media::sanitize_image_for_upload(bytes.clone())?;
        println!(
            "{name}: url={} mime={:?} size={:?} dim={:?} stripped={}B roundtrip={}",
            media.url,
            media.mime,
            media.size,
            media.dim,
            bytes.len() as i64 - expected.len() as i64,
            if back == expected { "ok" } else { "MISMATCH" }
        );
    }
    Ok(())
}
