//! T-45: the bridge refuses every request it should, over real HTTP.
//!
//! One suite of forged, stale, replayed and altered authorizations runs
//! against the fake bridge (`support/fake_mail_bridge.rs`) and against a
//! scratch copy of the real bridge's `server.py` with
//! `docs/t45/mail-bridge-public-aliases.patch` applied
//! (`support/real_mail_bridge.rs`), under its main public URL and under each
//! alias. Each case first gets a request that passes, so a check that is
//! removed turns its case red.

#[path = "support/fake_mail_bridge.rs"]
mod fake;
#[path = "support/real_mail_bridge.rs"]
mod real;

use nostr::base64::engine::general_purpose::URL_SAFE_NO_PAD;
use nostr::base64::Engine as _;
use nostr::{EventBuilder, JsonUtil as _, Keys, Kind, Tag, Timestamp};
use real::{RealBridge, PASSED};
use serde_json::Value;
use uni_core::mail::{MailBridge, MailError};

const BODY: &[u8] = br#"{"calls":[["Mailbox/get",{},"0"]]}"#;

fn now() -> u64 {
    Timestamp::now().as_secs()
}

/// A NIP-98 header as the app builds it, with every part choosable.
fn auth(keys: &Keys, kind: u16, u: &str, method: &str, body: &[u8], at: u64) -> String {
    let tags = [
        Tag::parse(["u", u]).unwrap(),
        Tag::parse(["method", method]).unwrap(),
        Tag::parse(["nonce", &uuid::Uuid::new_v4().simple().to_string()]).unwrap(),
        Tag::parse(["payload", &uni_core::media::sha256_hex(body)]).unwrap(),
    ];
    let ev = EventBuilder::new(Kind::from(kind), "").tags(tags).custom_created_at(Timestamp::from(at)).sign_with_keys(keys).unwrap();
    format!("Nostr {}", URL_SAFE_NO_PAD.encode(ev.as_json()))
}

/// The header with its event changed after signing.
fn tamper(header: &str, f: impl FnOnce(&mut Value)) -> String {
    let mut ev: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(&header["Nostr ".len()..]).unwrap()).unwrap();
    f(&mut ev);
    format!("Nostr {}", URL_SAFE_NO_PAD.encode(ev.to_string()))
}

async fn post(connect: &str, path: &str, header: Option<&str>, body: &[u8]) -> (u16, String) {
    uni_core::init_crypto();
    let mut req = reqwest::Client::new().post(format!("{connect}{path}")).header("Content-Type", "application/json").body(body.to_vec());
    if let Some(h) = header {
        req = req.header("Authorization", h);
    }
    let res = req.send().await.unwrap();
    let status = res.status().as_u16();
    let text = res.text().await.unwrap();
    let error = serde_json::from_str::<Value>(&text).ok().and_then(|v| v["error"].as_str().map(str::to_string)).unwrap_or(text);
    (status, error)
}

/// Every refusal the bridge makes, against the bridge at `connect` whose public URL is `public`.
/// `passed` is the status a good request gets there.
async fn refusals(connect: &str, public: &str, keys: &Keys, passed: u16) {
    let u = format!("{public}/mail/jmap");
    let good = || auth(keys, 27235, &u, "POST", BODY, now());
    let refused = |what: &str, got: (u16, String), want: &str| {
        assert_eq!(got, (401, want.to_string()), "{what} must be refused");
    };

    // the baseline passes, and so does a request inside the 120 s window
    let first = good();
    assert_eq!(post(connect, "/mail/jmap", Some(&first), BODY).await.0, passed, "a good request");
    assert_eq!(post(connect, "/mail/jmap", Some(&auth(keys, 27235, &u, "POST", BODY, now() - 60)), BODY).await.0, passed, "60 s old");

    refused("a replay", post(connect, "/mail/jmap", Some(&first), BODY).await, "replayed authorization");
    refused("a stale event", post(connect, "/mail/jmap", Some(&auth(keys, 27235, &u, "POST", BODY, now() - 300)), BODY).await, "stale authorization");
    refused("a future event", post(connect, "/mail/jmap", Some(&auth(keys, 27235, &u, "POST", BODY, now() + 300)), BODY).await, "stale authorization");
    let other_body = br#"{"calls":[["Email/query",{},"0"]]}"#;
    refused("a changed payload", post(connect, "/mail/jmap", Some(&good()), other_body).await, "payload hash mismatch");
    let raw = auth(keys, 27235, &format!("{public}/mail/raw"), "POST", BODY, now());
    refused("another path", post(connect, "/mail/jmap", Some(&raw), BODY).await, "authorization is for a different request");
    let elsewhere = auth(keys, 27235, "https://evil.example:8452/mail/jmap", "POST", BODY, now());
    refused("another host", post(connect, "/mail/jmap", Some(&elsewhere), BODY).await, "authorization is for a different request");
    refused("another method", post(connect, "/mail/jmap", Some(&auth(keys, 27235, &u, "GET", BODY, now())), BODY).await, "authorization is for a different request");
    let bad_sig = tamper(&good(), |ev| {
        let s = ev["sig"].as_str().unwrap();
        let flipped = if s.ends_with('0') { '1' } else { '0' };
        ev["sig"] = Value::from(format!("{}{flipped}", &s[..s.len() - 1]));
    });
    refused("a bad signature", post(connect, "/mail/jmap", Some(&bad_sig), BODY).await, "bad signature");
    let bad_id = tamper(&good(), |ev| ev["content"] = Value::from("changed after signing"));
    refused("an event changed after signing", post(connect, "/mail/jmap", Some(&bad_id), BODY).await, "bad event id");
    refused("another kind", post(connect, "/mail/jmap", Some(&auth(keys, 1, &u, "POST", BODY, now())), BODY).await, "wrong kind");
    refused("no authorization", post(connect, "/mail/jmap", None, BODY).await, "missing Nostr authorization");
    let stranger = Keys::generate();
    refused("a key not on the list", post(connect, "/mail/jmap", Some(&auth(&stranger, 27235, &u, "POST", BODY, now())), BODY).await, "pubkey not allowed");
}

#[tokio::test]
async fn the_fake_bridge_refuses_forged_stale_and_replayed_requests() {
    let keys = Keys::generate();
    let fake = fake::FakeBridge::start(0, &[keys.public_key().to_hex()], fake::sample_mail()).await;
    refusals(&fake.url, &fake.url, &keys, 200).await;
}

const PUBLIC: &str = "https://uni-1.example.ts.net:8452";
const ALIASES: &[&str] = &["https://uni.example.ts.net:8452", "https://mail.example.ts.net:8452"];

#[tokio::test]
async fn the_patched_bridge_refuses_forged_stale_and_replayed_requests_under_every_name() {
    let keys = Keys::generate();
    let bridge = RealBridge::start(true, PUBLIC, Some(ALIASES), &[keys.public_key().to_hex()]);
    for public in [PUBLIC, ALIASES[0], ALIASES[1]] {
        refusals(&bridge.url, public, &keys, PASSED).await;
    }
}

#[tokio::test]
async fn the_unpatched_bridge_refuses_forged_stale_and_replayed_requests() {
    let keys = Keys::generate();
    let bridge = RealBridge::start(false, PUBLIC, None, &[keys.public_key().to_hex()]);
    refusals(&bridge.url, PUBLIC, &keys, PASSED).await;
}

/// What the app gets signing for `public` while talking to the bridge over loopback.
async fn app_signing_as(bridge: &RealBridge, keys: &Keys, public: &str) -> MailError {
    MailBridge::new(&bridge.url, keys).unwrap().signing_as(public).unwrap().mailboxes().await.unwrap_err()
}

fn passed(e: &MailError) -> bool {
    *e == MailError::Server { message: "mail server: URLError".into() }
}

fn different_request(e: &MailError) -> bool {
    *e == MailError::Refused { status: 401, message: "authorization is for a different request".into() }
}

#[tokio::test]
async fn the_patched_bridge_accepts_the_app_under_each_listed_name_and_no_other() {
    let keys = Keys::generate();
    let bridge = RealBridge::start(true, PUBLIC, Some(ALIASES), &[keys.public_key().to_hex()]);
    for name in [PUBLIC, ALIASES[0], ALIASES[1]] {
        let e = app_signing_as(&bridge, &keys, name).await;
        assert!(passed(&e), "{name}: {e:?}");
    }
    for name in ["https://evil.example.ts.net:8452", "https://uni.example.ts.net:8453", "http://uni.example.ts.net:8452", "https://uni.example.ts.net"] {
        let e = app_signing_as(&bridge, &keys, name).await;
        assert!(different_request(&e), "{name}: {e:?}");
    }
    // membership is exact: a listed name with more after it is another URL
    let lookalike = auth(&keys, 27235, &format!("{}/mail/jmap?x", ALIASES[0]), "POST", BODY, now());
    assert_eq!(post(&bridge.url, "/mail/jmap", Some(&lookalike), BODY).await, (401, "authorization is for a different request".into()));
}

#[tokio::test]
async fn without_the_patch_or_its_config_only_the_main_name_is_accepted() {
    let keys = Keys::generate();
    let allow = [keys.public_key().to_hex()];
    let unpatched = RealBridge::start(false, PUBLIC, None, &allow);
    assert!(passed(&app_signing_as(&unpatched, &keys, PUBLIC).await));
    assert!(different_request(&app_signing_as(&unpatched, &keys, ALIASES[0]).await), "today's bridge refuses the hub's second name");
    // patched, but the config doesn't list aliases yet: same as before
    let no_aliases = RealBridge::start(true, PUBLIC, None, &allow);
    assert!(passed(&app_signing_as(&no_aliases, &keys, PUBLIC).await));
    assert!(different_request(&app_signing_as(&no_aliases, &keys, ALIASES[0]).await));
}
