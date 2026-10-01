//! Headless real-relay interop driver. Secrets travel only through env / private IPC.
//! UNI_PAIR_KEY: throwaway hex or nsec, UNI_PAIR_URI: target link,
//! UNI_PAIR_URI_PIPE: source FIFO (never stdout), UNI_PAIR_RELAY: pairing relay.
use nostr::Keys;
use std::io::{self, Write};
use zeroize::Zeroizing;

fn approve() -> Result<(), Box<dyn std::error::Error>> {
    let mut answer = String::new();
    io::stdin().read_line(&mut answer)?;
    if answer.trim() != "yes" {
        return Err("SAS confirmation required".into());
    }
    Ok(())
}

#[tokio::main]
async fn main() {
    uni_core::init_crypto();
    if run().await.is_err() {
        // Do not render external errors: a malformed input may contain a secret.
        eprintln!("interop failed (key, protocol, transport, or confirmation error)");
        std::process::exit(1);
    }
}
async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let key = Zeroizing::new(std::env::var("UNI_PAIR_KEY")?);
    let keys = Keys::parse(key.as_str())?;
    let mode = std::env::args().nth(1).ok_or("source or target required")?;
    if mode == "pubkey" {
        println!("PUBKEY {}", keys.public_key().to_hex());
        return Ok(());
    }
    if mode == "probe" {
        let relay = std::env::var("UNI_PAIR_RELAY")?;
        let pending = tokio::time::timeout(
            std::time::Duration::from_secs(12),
            uni_core::pairing_source::start_source(&relay),
        )
        .await??;
        pending.cancel(false).await?;
        println!("REACHABLE");
        return Ok(());
    }
    if mode == "source" {
        let relay = std::env::var("UNI_PAIR_RELAY")?;
        let mut pending = uni_core::pairing_source::start_source(&relay).await?;
        // The harness owns a mode-0600 FIFO inside a private directory; never a log file.
        let mut pipe = std::fs::OpenOptions::new()
            .write(true)
            .open(std::env::var("UNI_PAIR_URI_PIPE")?)?;
        pipe.write_all(pending.uri().as_bytes())?;
        drop(pipe);
        let sas = pending.wait_offer().await?;
        println!("SAS {sas}");
        io::stdout().flush()?;
        if approve().is_err() {
            pending.cancel(true).await?;
            return Err("codes differ".into());
        }
        pending.send(&keys, "https://buzz.unforced.org").await?;
    } else if mode == "target" {
        let uri = Zeroizing::new(std::env::var("UNI_PAIR_URI")?);
        let pending = uni_core::pairing::start(&uri).await?;
        println!("SAS {}", pending.sas());
        io::stdout().flush()?;
        if approve().is_err() {
            pending.cancel(true).await?;
            return Err("codes differ".into());
        }
        let identity = pending.confirm().await?;
        if identity.pubkey != keys.public_key() {
            return Err("received public key mismatch".into());
        }
        println!("PUBKEY {}", identity.pubkey.to_hex());
    } else {
        return Err("unknown mode".into());
    }
    println!("SUCCESS");
    Ok(())
}
