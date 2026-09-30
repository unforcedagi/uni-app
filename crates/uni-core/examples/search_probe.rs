//! Live probe: search the Parachute vault through the hub's NIP-98 door
//! with the key in UNI_NSEC (never printed). Read-only.
//!
//! UNI_NSEC=<hex> cargo run -p uni-core --example search_probe -- <hub> <query> [vault]
use uni_core::parachute::{VaultClient, VaultConfig};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    uni_core::init_crypto();
    let (keys, _) = uni_core::load_keys(false)?;
    println!("probe pubkey: {}", keys.public_key().to_hex());
    let hub = args.get(1).cloned().unwrap_or_default();
    let query = args.get(2).cloned().unwrap_or_default();
    let vault = args.get(3).cloned();
    let client = VaultClient::new(
        VaultConfig {
            hub,
            vault: vault.clone().unwrap_or_else(|| "unforced".into()),
        },
        keys,
    )?;
    let hits = client.search_notes(vault.as_deref(), &query, 10).await?;
    println!("{} hits", hits.len());
    for h in hits {
        println!(
            "{} [{}] {} — {}",
            h.mode,
            h.vault,
            h.path,
            h.snippet.chars().take(80).collect::<String>()
        );
    }
    Ok(())
}
