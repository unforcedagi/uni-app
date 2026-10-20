//! The fake mail bridge as a standalone server, for running the real app against test mail (T-45 walkthrough).
//! Never part of the app. Usage:
//!   cargo run -p uni-core --example fake_mail_bridge -- <port> <allowed pubkey hex>[,<hex>…] [down|shared]
//! Then start the app with `UNI_MAIL_URL=http://127.0.0.1:<port>`. `down` answers every call 502 (mail server down).
//! `shared` is the v2 bridge with two made-up accounts shared with each other (the owner's and Uni's), and Uni's
//! triage notes. Each forwarded JMAP method is printed with the account it named, so a walk shows it sent no write.

#[path = "../tests/support/fake_mail_bridge.rs"]
mod fake;

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let port: u16 = args.next().and_then(|p| p.parse().ok()).expect("usage: fake_mail_bridge <port> <pubkey hex,…> [down|shared]");
    let allow: Vec<String> = args.next().unwrap_or_default().split(',').filter(|k| !k.is_empty()).map(str::to_string).collect();
    let mode = args.next().unwrap_or_default();
    let bridge = if mode == "shared" {
        let (own, uni, triage) = fake::shared_mail();
        let b = fake::FakeBridge::start_shared(port, &allow, own, vec![uni]).await;
        b.state.lock().unwrap().triage = triage;
        b
    } else {
        fake::FakeBridge::start(port, &allow, fake::sample_mail()).await
    };
    bridge.state.lock().unwrap().server_down = mode == "down";
    println!("fake mail bridge on {} ({} allowed key(s){})", bridge.url, allow.len(), if mode.is_empty() { String::new() } else { format!(", {mode}") });
    let (mut shown, mut calls) = (0, 0);
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        let s = bridge.state.lock().unwrap();
        for (path, status) in &s.requests[shown..] {
            println!("{path} → {status}");
        }
        for (method, account) in &s.calls[calls..] {
            println!("  {method} {}", account.as_deref().unwrap_or("-"));
        }
        shown = s.requests.len();
        calls = s.calls.len();
    }
}
