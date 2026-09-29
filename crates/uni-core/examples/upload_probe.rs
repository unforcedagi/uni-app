//! Live probe: upload each file to the relay's Blossom endpoint with the key in
//! UNI_NSEC, then fetch it back with auth and compare bytes. Posts no message.
//!
//! UNI_NSEC=<hex> cargo run -p uni-core --example upload_probe -- <relay-ws-url> <file>...
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
        let name = Path::new(path).file_name().unwrap().to_string_lossy().to_string();
        let media = uni_core::media::upload_media(relay, &keys, bytes.clone(), "", &name).await?;
        let back = uni_core::media::fetch_media(relay, &keys, &media.url, media.sha256.as_deref(), cache.path()).await?;
        println!(
            "{name}: url={} mime={:?} size={:?} dim={:?} roundtrip={}",
            media.url,
            media.mime,
            media.size,
            media.dim,
            if back == bytes { "ok" } else { "MISMATCH" }
        );
    }
    Ok(())
}
