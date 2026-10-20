//! The fake mail bridge as a standalone server, for running the real app against test mail (T-45 walkthrough).
//! Never part of the app. Usage:
//!   cargo run -p uni-core --example fake_mail_bridge -- <port> <allowed pubkey hex>[,<hex>…] [down]
//! Then start the app with `UNI_MAIL_URL=http://127.0.0.1:<port>`. `down` answers every call 502 (mail server down).

#[path = "../tests/support/fake_mail_bridge.rs"]
mod fake;

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let port: u16 = args.next().and_then(|p| p.parse().ok()).expect("usage: fake_mail_bridge <port> <pubkey hex,…> [down]");
    let allow: Vec<String> = args.next().unwrap_or_default().split(',').filter(|k| !k.is_empty()).map(str::to_string).collect();
    let down = args.next().as_deref() == Some("down");
    let bridge = fake::FakeBridge::start(port, &allow, fake::sample_mail()).await;
    bridge.state.lock().unwrap().server_down = down;
    println!("fake mail bridge on {} ({} allowed key(s){})", bridge.url, allow.len(), if down { ", mail server down" } else { "" });
    let mut shown = 0;
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        let s = bridge.state.lock().unwrap();
        for (path, status) in &s.requests[shown..] {
            println!("{path} → {status}");
        }
        shown = s.requests.len();
    }
}
