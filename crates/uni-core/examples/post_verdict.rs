//! T-335 end-to-end driver: Aaron's verdict on a `post` note through the same `VaultClient` methods the app's
//! `post_*` commands call. Key from UNI_NSEC (throwaway keys only; uni-ops post/e2e.py and the Playwright bridge).
//!
//! UNI_NSEC=<hex> cargo run -p uni-core --example post_verdict -- <hub> <vault> <note-id> <updatedAt> approve [<unix time>]
//! UNI_NSEC=<hex> cargo run -p uni-core --example post_verdict -- <hub> <vault> <note-id> <updatedAt> drop
//! UNI_NSEC=<hex> cargo run -p uni-core --example post_verdict -- <hub> <vault> <note-id> <updatedAt> edit <text>
//! UNI_NSEC=<hex> cargo run -p uni-core --example post_verdict -- <hub> <vault> <note-id> - get
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let a: Vec<String> = std::env::args().collect();
    uni_core::init_crypto();
    let (keys, _) = uni_core::load_keys(false)?;
    let cfg = uni_core::parachute::VaultConfig { hub: a[1].clone(), vault: a[2].clone() };
    let client = uni_core::parachute::VaultClient::new(cfg, keys.clone())?.with_alias(None)?;
    let now = nostr::Timestamp::now().as_secs();
    let out = match a.get(5).map(String::as_str) {
        Some("get") => client.get_note(&a[2], &a[3]).await,
        Some("approve") => {
            let at = a.get(6).and_then(|t| t.parse::<u64>().ok());
            client.post_approve(&keys, &a[2], &a[3], &a[4], at, now).await
        }
        Some("drop") => client.post_drop(&keys, &a[2], &a[3], &a[4], now).await,
        Some("edit") => client.post_edit(&keys, &a[2], &a[3], &a[4], a.get(6).map(String::as_str).unwrap_or_default(), now).await,
        other => Err(uni_core::Error::Invalid(format!("unknown mode {other:?}: get | approve | drop | edit"))),
    };
    match out {
        Ok(note) => println!("{}", serde_json::to_string(&note)?),
        Err(e) => {
            println!("{}", serde_json::json!({"error": e.to_string()}));
            std::process::exit(2);
        }
    }
    Ok(())
}
