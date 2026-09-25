//! Live probe: write a text and a voice journal entry through the hub's
//! NIP-98 door with the key in UNI_NSEC. Dev tool; points at a test vault.
//!
//! UNI_NSEC=<hex> cargo run -p uni-core --example journal_probe -- <hub> <vault> <audio.webm>
use uni_core::parachute::{NewEntry, VaultClient, VaultConfig};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let (keys, _) = uni_core::load_keys(false)?;
    println!("probe pubkey: {}", keys.public_key().to_hex());
    if args.len() < 4 {
        return Ok(());
    }
    let client = VaultClient::new(
        VaultConfig {
            hub: args[1].clone(),
            vault: args[2].clone(),
        },
        keys,
    )?;
    let now = chrono_path();
    let text = client
        .create_entry(&NewEntry {
            path: format!("Notes/probe/{now}-text"),
            content: "Probe: a typed journal entry.".into(),
            source: "text".into(),
            created_at: None,
            entry_id: None,
        })
        .await?;
    println!("text entry: {} {}", text.id, text.path);
    let voice = client
        .create_entry(&NewEntry {
            path: format!("Notes/probe/{now}-voice"),
            content: uni_core::parachute::TRANSCRIPT_PENDING.into(),
            source: "voice".into(),
            created_at: None,
            entry_id: None,
        })
        .await?;
    println!("voice entry: {} pending={}", voice.id, voice.pending);
    let bytes = std::fs::read(&args[3])?;
    client
        .upload_audio(&voice.id, "voice.webm", "audio/webm;codecs=opus", bytes)
        .await?;
    println!("audio uploaded");
    for _ in 0..30 {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        let e = client.get_entry(&voice.id).await?;
        if !e.pending {
            println!("transcribed: {}", e.content.trim());
            break;
        }
    }
    let list = client.list_entries(5, 0).await?;
    println!(
        "listed {} newest entries; first = {}",
        list.len(),
        list.first().map(|e| e.path.as_str()).unwrap_or("-")
    );
    Ok(())
}

fn chrono_path() -> String {
    let s = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    format!("{s}")
}
