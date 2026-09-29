//! Live probe: publish a typing indicator through the live loop's outbox and
//! confirm a second connection receives it from the relay. Posts no message.
//! UNI_NSEC=<hex> cargo run -p uni-core --example typing_probe -- <relay-url> <channel-uuid>
use std::time::Duration;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let (relay, channel): (String, uuid::Uuid) = (args[1].clone(), args[2].parse()?);
    uni_core::init_crypto();
    let (keys, _) = uni_core::load_keys(false)?;
    // Observer: a plain channel subscription on its own socket.
    let mut watcher = uni_core::BuzzClient::connect(&relay, &keys, None).await?;
    watcher.open_channel_sub(channel, Some(nostr::Timestamp::now().as_secs())).await?;
    // Live loop with an outbox, on a temp store.
    let dir = std::env::temp_dir().join(format!("typing-probe-{}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    let store = uni_core::Store::open(dir.join("uni.db"))?;
    let (out_tx, out_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut cfg = uni_core::LiveConfig::new(relay.clone());
    cfg.poll_timeout = Duration::from_secs(2);
    cfg.outbox = Some(std::sync::Arc::new(tokio::sync::Mutex::new(out_rx)));
    let (ev_tx, mut ev_rx) = tokio::sync::mpsc::unbounded_channel();
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    let sent = uni_core::typing::typing_event(&keys, channel, None, None)?;
    let sent_id = sent.id;
    let live = async {
        uni_core::run_live(cfg, &keys, None, &store, ev_tx, stop_rx).await
    };
    let drive = async {
        // Wait for the live loop to connect, then queue the typing event.
        while let Some(e) = ev_rx.recv().await {
            if matches!(e, uni_core::LiveEvent::Connected { .. }) { break; }
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
        out_tx.send(sent).unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        let mut seen = false;
        while tokio::time::Instant::now() < deadline {
            match watcher.next_message(Duration::from_secs(2)).await {
                Ok(buzz_msg) => {
                    let s = format!("{buzz_msg:?}");
                    if s.contains(&sent_id.to_hex()) { seen = true; break; }
                }
                Err(_) => continue,
            }
        }
        let _ = stop_tx.send(true);
        seen
    };
    let (res, seen) = tokio::join!(live, drive);
    println!("live loop: {:?}; typing event {} relayed to second socket: {}", res.map(|_| "stopped"), &sent_id.to_hex()[..12], seen);
    let _ = std::fs::remove_dir_all(dir);
    Ok(())
}
