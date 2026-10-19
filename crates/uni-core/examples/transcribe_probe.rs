//! Live probe: send an audio file to the hub host's transcription service,
//! signed with the key in UNI_NSEC, and print the transcript.
//!
//! UNI_NSEC=<hex> cargo run -p uni-core --example transcribe_probe -- <audio> <mime> [hub]
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    uni_core::init_crypto();
    let (keys, _) = uni_core::load_keys(false)?;
    let audio = std::fs::read(&args[1])?;
    let hub = args.get(3).map(String::as_str).unwrap_or(uni_core::hub::HUB_ALIASES[0].0);
    let url = uni_core::hub::transcribe_url(hub).ok_or("bad hub URL")?;
    let started = std::time::Instant::now();
    let t = uni_core::transcribe::transcribe(&url, &keys, audio, &args[2]).await?;
    println!("{:?} lang={:?} audio={:?}s wall={:.1}s", t.text, t.language, t.duration, started.elapsed().as_secs_f64());
    // An unlisted key must be refused.
    let stranger = nostr::Keys::generate();
    let denied = uni_core::transcribe::transcribe(&url, &stranger, std::fs::read(&args[1])?, &args[2]).await;
    println!("stranger: {}", match denied { Ok(_) => "ACCEPTED (bad)".to_string(), Err(e) => e.to_string() });
    Ok(())
}
