//! T-176 end-to-end driver for the app side of the secret handoff (scripts/t176/e2e.py runs it).
//! It does what the `send_secret` / `forget_secret` Tauri commands do, minus the webview: fetch the room,
//! ingest it into a store (dropping anything whose signature fails), re-verify the request from its kept signed
//! event, check the requester is pinned, seal, publish. The value comes on stdin (as from the masked field), never argv; only event ids are printed.
//!
//! UNI_NSEC=<hex> UNI_SECRET_REQUESTERS=<hex> cargo run -p uni-core --example secret_send -- \
//!     <relay-url> <channel-uuid> [send|forget] < value
use std::io::Read;

use nostr::{Filter, Kind, PublicKey};
use zeroize::Zeroizing;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let (relay, channel): (String, uuid::Uuid) = (args[1].clone(), args[2].parse()?);
    let mode = args.get(3).map(String::as_str).unwrap_or("send");
    uni_core::init_crypto();
    let (keys, _) = uni_core::load_keys(false)?;
    let pinned: Vec<PublicKey> = std::env::var("UNI_SECRET_REQUESTERS")
        .unwrap_or_default()
        .split(',')
        .filter_map(|s| PublicKey::from_hex(s.trim()).ok())
        .collect();

    // The room's messages, into a throwaway store (the app's live loop does this).
    let mut client = uni_core::BuzzClient::connect(&relay, &keys, None).await?;
    let filter = Filter::new()
        .kind(Kind::Custom(9))
        .custom_tag(nostr::SingleLetterTag::lowercase(nostr::Alphabet::H), channel.to_string());
    let events = client.req_until_eose("t176", &[filter]).await?;
    let _ = client.disconnect().await;
    let dir = std::env::temp_dir().join(format!("t176-app-{}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    let store = uni_core::Store::open(dir.join("uni.db"))?;
    for ev in &events {
        uni_core::ingest_channel_event(&store, ev, &keys.public_key(), channel)?;
    }
    // The newest request in the room, read back from the store as the Tauri command does.
    let newest = events
        .iter()
        .filter(|e| uni_core::secret::parse_request(&e.content).is_some())
        .max_by_key(|e| e.created_at)
        .ok_or("no secret request in the room")?;
    let asked = uni_core::secret::stored_request(&store, &channel.to_string(), &newest.id.to_hex())?;
    let now = nostr::Timestamp::now().as_secs();
    let wrap = if mode == "forget" {
        if !pinned.contains(&asked.requester) {
            return Err("this requester is not trusted for secrets".into());
        }
        uni_core::secret::seal_forget(&keys, &asked, now)?
    } else {
        uni_core::secret::check_answerable(&asked, &pinned, now)?;
        let mut value = Zeroizing::new(String::new());
        std::io::stdin().read_to_string(&mut value)?;
        let value = Zeroizing::new(value.trim_end_matches(['\r', '\n']).to_string());
        uni_core::secret::seal_delivery(&keys, &asked, &value, now)?
    };
    let id = uni_core::secret::publish_wrap(&relay, &keys, None, wrap).await?;
    println!("{mode}: request {} answered with gift wrap {}", asked.event_id.to_hex(), id.to_hex());
    std::fs::remove_dir_all(&dir)?;
    Ok(())
}
