//! UNI_NSEC=<key> cargo run -p uni-core --example surface_probe -- <hub> scope-test
//! Writes only to the explicitly selected vault; leaves its probe note for inspection.
use uni_core::parachute::{valid_vault_name, VaultClient, VaultConfig};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        return Err("usage: surface_probe <hub> <vault> (normally scope-test)".into());
    }
    let vault = &args[2];
    if !valid_vault_name(vault) || ["uni", "unforced"].contains(&vault.to_lowercase().as_str()) {
        return Err("refusing unsafe probe vault; use scope-test".into());
    }
    if std::env::var("UNI_NSEC")
        .map(|s| s.trim().is_empty())
        .unwrap_or(true)
    {
        return Err("UNI_NSEC is required".into());
    }
    uni_core::init_crypto();
    // Never print the key or a parsing error that might contain it.
    let (keys, _) = uni_core::load_keys(false).map_err(|_| "could not load UNI_NSEC")?;
    let client = VaultClient::new(
        VaultConfig {
            hub: args[1].clone(),
            vault: vault.clone(),
        },
        keys,
    )?;
    println!("{} paths in {vault}", client.list_paths(vault).await?.len());
    let unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs();
    let path = format!("Probe/{unix}-surface");
    let created = client
        .create_note(vault, &path, "# Surface probe\n\nInitial text.")
        .await?;
    let id = created["id"].as_str().ok_or("missing id")?;
    let stamp = created["updatedAt"].as_str().ok_or("missing updatedAt")?;
    // Avoid same-tick timestamp equality on servers with coarse clocks.
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    client
        .save_note(
            vault,
            id,
            "# Surface probe\n\nEdited text.",
            Some(stamp),
            false,
        )
        .await?;
    match client
        .save_note(vault, id, "This stale save must fail.", Some(stamp), false)
        .await
    {
        Err(e) if e.to_string().starts_with("conflict:") => {
            println!("conflict: stale revision rejected")
        }
        Err(e) => return Err(e.into()),
        Ok(_) => return Err("stale save unexpectedly succeeded".into()),
    }
    let fetched = client.get_note(vault, id).await?;
    let inbound = fetched["links"]
        .as_array()
        .map(|links| {
            links
                .iter()
                .filter(|l| l["targetId"].as_str() == Some(id))
                .count()
        })
        .unwrap_or(0);
    println!("Created and edited {vault}/{path}; fetched backlinks: {inbound}");
    Ok(())
}
