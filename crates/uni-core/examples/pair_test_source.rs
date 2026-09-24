//! Dev tool: act as Buzz desktop's pairing *source* with a freshly generated
//! THROWAWAY key, to exercise a device's pairing flow without a real account.
//!
//! ```sh
//! cargo run -p uni-core --example pair_test_source -- [wss://pairing.buzz.xyz]
//! ```
//! Prints a `nostrpair://` link, waits for the device's offer, prints the
//! 6-digit code, auto-confirms on this side (the device still has to confirm),
//! sends a Buzz-desktop-shaped payload `{relayUrl, pubkey, nsec}` and waits
//! for `complete`. Only the throwaway *pubkey* is printed.

use std::time::Duration;

use buzz_core::kind::KIND_PAIRING;
use buzz_core::pairing::{qr::encode_qr, PairingSession, PayloadType};
use buzz_ws_client::{NostrWsConnection, RelayMessage};
use nostr::nips::nip19::ToBech32;
use nostr::{EventBuilder, Keys, RelayUrl};
use serde_json::json;
use zeroize::Zeroizing;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    uni_core::init_crypto();
    let relay = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "wss://pairing.buzz.xyz".into());
    let throwaway = Keys::generate();
    let (mut session, qr) = PairingSession::new_source(relay.clone());
    println!("THROWAWAY pubkey: {}", throwaway.public_key().to_hex());
    println!("LINK: {}", encode_qr(&qr));

    let mut conn = NostrWsConnection::connect(&relay).await?;
    // Optional NIP-42 with the ephemeral session key.
    if let Ok(RelayMessage::Auth { challenge }) = conn.next_event(Duration::from_secs(3)).await {
        let auth = session.sign_event(EventBuilder::auth(challenge, RelayUrl::parse(&relay)?))?;
        conn.send_raw(&json!(["AUTH", auth])).await?;
    }
    let filter = json!({"kinds":[KIND_PAIRING], "#p":[session.pubkey().to_hex()]});
    conn.send_raw(&json!(["REQ", "pair", filter])).await?;

    let sas = loop {
        let ev = next(&mut conn).await?;
        if let Ok(sas) = session.handle_offer(&ev) {
            break sas;
        }
    };
    println!("SAS: {sas}");
    let confirm = session.confirm_sas()?;
    conn.send_raw(&json!(["EVENT", confirm])).await?;
    let payload = Zeroizing::new(
        json!({
            "relayUrl": "https://buzz.unforced.org",
            "pubkey": throwaway.public_key().to_hex(),
            "nsec": throwaway.secret_key().to_bech32()?,
        })
        .to_string(),
    );
    let ev = session.send_payload(PayloadType::Custom, payload)?;
    conn.send_raw(&json!(["EVENT", ev])).await?;
    println!("payload sent; waiting for complete…");
    loop {
        let ev = next(&mut conn).await?;
        if let Ok(reason) = session.handle_abort(&ev) {
            println!("ABORTED by device: {reason:?}");
            return Ok(());
        }
        if session.handle_complete(&ev).is_ok() {
            println!("COMPLETE ✓");
            return Ok(());
        }
    }
}

async fn next(conn: &mut NostrWsConnection) -> Result<nostr::Event, Box<dyn std::error::Error>> {
    loop {
        match conn.next_event(Duration::from_secs(120)).await? {
            RelayMessage::Event { event, .. } => return Ok(*event),
            RelayMessage::Ok(ok) if !ok.accepted => eprintln!("relay rejected: {}", ok.message),
            _ => {}
        }
    }
}
