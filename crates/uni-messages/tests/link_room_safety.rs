//! T-282 (Codex review lk82bn43, P1): what is typed into a login step (a phone number, a code, a password, cookies)
//! goes only into an end-to-end encrypted room whose joined and invited members are exactly the account and that
//! bridge's bot. A room marked as a DM with the bot but holding a third person, an unencrypted DM, or a room that was
//! safe and has since gained a member, is never used: a fresh encrypted DM with the bot alone is made instead.
//!
//! A real homeserver (continuwuity, see common/), skipped where it isn't installed. The bridge is outside this crate,
//! so `@signalbot` is an ordinary account that joins whatever it is invited to, over plain HTTP; the account under test
//! runs as the app runs it.

#![recursion_limit = "256"]

mod common;

use std::{collections::BTreeSet, sync::Arc, time::Duration};

use common::{binary, esc, http, register, until};
use serde_json::{json, Value};
use uni_messages::{FileSecrets, Messages};

const SERVER: &str = "safety.test.localhost";

fn uid(name: &str) -> String {
    format!("@{name}:{SERVER}")
}

/// The bot: joins every room it is invited to, as a running bridge does.
fn bot_joins_invites(port: u16, token: String) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut since = String::new();
        loop {
            let path = if since.is_empty() { "/_matrix/client/v3/sync?timeout=0".to_owned() } else { format!("/_matrix/client/v3/sync?timeout=0&since={since}") };
            if let Some((200, body)) = http(port, "GET", &path, None, Some(&token)).await {
                since = body["next_batch"].as_str().unwrap_or_default().to_owned();
                for room in body["rooms"]["invite"].as_object().into_iter().flat_map(|o| o.keys().cloned().collect::<Vec<_>>()) {
                    http(port, "POST", &format!("/_matrix/client/v3/join/{}", esc(&room)), Some(json!({})), Some(&token)).await;
                }
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    })
}

async fn create(port: u16, token: &str, body: Value) -> String {
    let (status, r) = http(port, "POST", "/_matrix/client/v3/createRoom", Some(body), Some(token)).await.unwrap();
    assert_eq!(status, 200, "{r}");
    r["room_id"].as_str().unwrap().to_owned()
}

async fn join(port: u16, token: &str, room: &str) {
    let (status, r) = http(port, "POST", &format!("/_matrix/client/v3/join/{}", esc(room)), Some(json!({})), Some(token)).await.unwrap();
    assert_eq!(status, 200, "{r}");
}

/// Message events (plain or encrypted) `sender` sent in `room`.
async fn sent_by(port: u16, token: &str, room: &str, sender: &str) -> usize {
    let (_, page) = http(port, "GET", &format!("/_matrix/client/v3/rooms/{}/messages?dir=b&limit=100", esc(room)), None, Some(token)).await.unwrap();
    page["chunk"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|e| e["sender"] == sender && (e["type"] == "m.room.message" || e["type"] == "m.room.encrypted"))
        .count()
}

/// Joined and invited members.
async fn members(port: u16, token: &str, room: &str) -> BTreeSet<String> {
    let (_, m) = http(port, "GET", &format!("/_matrix/client/v3/rooms/{}/members", esc(room)), None, Some(token)).await.unwrap();
    m["chunk"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|e| matches!(e["content"]["membership"].as_str(), Some("join" | "invite")))
        .filter_map(|e| e["state_key"].as_str().map(str::to_owned))
        .collect()
}

async fn encrypted(port: u16, token: &str, room: &str) -> bool {
    matches!(http(port, "GET", &format!("/_matrix/client/v3/rooms/{}/state/m.room.encryption/", esc(room)), None, Some(token)).await, Some((200, _)))
}

async fn joined_rooms(port: u16, token: &str) -> Vec<String> {
    let (_, r) = http(port, "GET", "/_matrix/client/v3/joined_rooms", None, Some(token)).await.unwrap();
    r["joined_rooms"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_owned)).collect()
}

/// The rooms that received something from wren since `before`, by id.
async fn rooms_with_new_sends(port: u16, token: &str, before: &[(String, usize)]) -> Vec<String> {
    let mut out = vec![];
    for room in joined_rooms(port, token).await {
        let had = before.iter().find(|(r, _)| *r == room).map_or(0, |(_, n)| *n);
        if sent_by(port, token, &room, &uid("wren")).await > had {
            out.push(room);
        }
    }
    out
}

/// Wait until what was just typed has reached some room (up to 30 s), then a moment more for any second copy; the
/// rooms that got it.
async fn landed(port: u16, token: &str, before: &[(String, usize)]) -> Vec<String> {
    let end = std::time::Instant::now() + Duration::from_secs(30);
    while std::time::Instant::now() < end && rooms_with_new_sends(port, token, before).await.is_empty() {
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    tokio::time::sleep(Duration::from_secs(2)).await;
    rooms_with_new_sends(port, token, before).await
}

async fn counts(port: u16, token: &str) -> Vec<(String, usize)> {
    let mut out = vec![];
    for room in joined_rooms(port, token).await {
        let n = sent_by(port, token, &room, &uid("wren")).await;
        out.push((room, n));
    }
    out
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn login_values_go_only_into_an_encrypted_room_with_just_the_bot() {
    let Some(bin) = binary() else {
        eprintln!("skipped: no continuwuity binary (set UNI_TEST_CONTINUWUITY)");
        return;
    };
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_owned();
    let hs = common::start(bin, &dir, SERVER).await;
    let port = hs.port;
    let wren = register(&hs, "wren", true).await;
    let bot = register(&hs, "signalbot", false).await;
    let mallory = register(&hs, "mallory", false).await;
    // as a bridge does when it starts: its bot has a profile (the app takes a bot without one as a bridge never started)
    http(port, "PUT", &format!("/_matrix/client/v3/profile/{}/displayname", esc(&uid("signalbot"))), Some(json!({ "displayname": "Signal bridge" })), Some(&bot)).await;
    let bot_task = bot_joins_invites(port, bot.clone());

    // A: encrypted and marked as the DM with the bot, but a third person is in it
    let a = create(port, &wren, json!({ "is_direct": true, "preset": "trusted_private_chat", "invite": [uid("signalbot"), uid("mallory")],
        "initial_state": [{ "type": "m.room.encryption", "state_key": "", "content": { "algorithm": "m.megolm.v1.aes-sha2" } }] })).await;
    join(port, &mallory, &a).await;
    // B: just wren and the bot, marked as their DM, but not encrypted
    let b = create(port, &wren, json!({ "is_direct": true, "preset": "trusted_private_chat", "invite": [uid("signalbot")] })).await;
    // D (review 2r8bmvox): encrypted, just wren and the bot, but made the ordinary way: anyone with the bot's power
    // (trusted_private_chat gives it the creator's) could bring a third person in, and history is shared
    let d = create(port, &wren, json!({ "is_direct": true, "preset": "trusted_private_chat", "invite": [uid("signalbot")],
        "initial_state": [{ "type": "m.room.encryption", "state_key": "", "content": { "algorithm": "m.megolm.v1.aes-sha2" } }] })).await;
    let direct = json!({ uid("signalbot"): [a.clone(), b.clone(), d.clone()] });
    http(port, "PUT", &format!("/_matrix/client/v3/user/{}/account_data/m.direct", esc(&uid("wren"))), Some(direct), Some(&wren)).await;
    until(20, "the bot is in A and B", || {
        let (bot, a, b) = (bot.clone(), a.clone(), b.clone());
        let d = d.clone();
        async move { let r = joined_rooms(port, &bot).await; r.contains(&a) && r.contains(&b) && r.contains(&d) }
    })
    .await;
    assert!(!encrypted(port, &wren, &b).await && encrypted(port, &wren, &a).await);

    // the account under test, as the app runs it, synced
    let m = Messages::new(dir.join("app/data"), Arc::new(FileSecrets::new(dir.join("app/secrets"))));
    m.sign_in(&hs.url(), "wren", "pw-0123456789").await.unwrap();
    until(30, "the sync is live", || {
        let m = m.clone();
        async move { m.status().state == "live" }
    })
    .await;
    tokio::time::sleep(Duration::from_secs(2)).await;

    // a phone number typed into the Signal card
    let before = counts(port, &wren).await;
    if let Err(e) = m.link_send("signal", "+15550100").await {
        for r in joined_rooms(port, &wren).await {
            eprintln!("on failure: wren room {r}: members {:?} encrypted {}", members(port, &wren, &r).await, encrypted(port, &wren, &r).await);
        }
        eprintln!("on failure: bot rooms {:?}", joined_rooms(port, &bot).await);
        panic!("{e:?}");
    }
    let got = landed(port, &wren, &before).await;
    assert!(!got.contains(&a), "sent into a room with a third member");
    assert!(!got.contains(&b), "sent into an unencrypted room");
    assert!(!got.contains(&d), "sent into a room where the bot could invite someone");
    assert_eq!(got.len(), 1, "one fresh room gets it: {got:?}");
    let c = got[0].clone();
    assert!(encrypted(port, &wren, &c).await, "the fresh room is encrypted");
    assert_eq!(members(port, &wren, &c).await, BTreeSet::from([uid("wren"), uid("signalbot")]), "only wren and the bot");
    // and no one else can come in: invite-only, history from joining, only wren may invite
    let state = |kind: &'static str| {
        let c = c.clone();
        let wren = wren.clone();
        async move { http(port, "GET", &format!("/_matrix/client/v3/rooms/{}/state/{kind}/", esc(&c)), None, Some(&wren)).await.unwrap().1 }
    };
    assert_eq!(state("m.room.join_rules").await["join_rule"], "invite");
    assert_eq!(state("m.room.history_visibility").await["history_visibility"], "joined");
    let p = state("m.room.power_levels").await;
    let invite = p["invite"].as_i64().unwrap_or(0);
    assert!(p["users"][uid("signalbot")].as_i64().unwrap_or(0) < invite && p["users_default"].as_i64().unwrap_or(0) < invite, "{p}");
    // wren made the room: a creator (room version 12) or listed with power to invite
    let create = state("m.room.create").await;
    let wren_creator = create["creator"] == uid("wren").as_str() || create["room_version"].as_str().is_some_and(|v| v == "12");
    assert!(wren_creator || p["users"][uid("wren")].as_i64().unwrap_or(0) >= invite, "{p}");

    // the safe room is now the one this device uses; someone else is invited into it: the next value doesn't go there
    let (status, r) = http(port, "POST", &format!("/_matrix/client/v3/rooms/{}/invite", esc(&c)), Some(json!({ "user_id": uid("mallory") })), Some(&wren)).await.unwrap();
    assert_eq!(status, 200, "{r}");
    let before = counts(port, &wren).await;
    m.link_send("signal", "123456").await.unwrap();
    let got = landed(port, &wren, &before).await;
    assert!(!got.contains(&c), "sent into the cached room after a third person was invited");
    assert!(!got.contains(&a) && !got.contains(&b) && !got.contains(&d));
    assert_eq!(got.len(), 1, "another fresh room gets it: {got:?}");
    assert!(encrypted(port, &wren, &got[0]).await);
    assert_eq!(members(port, &wren, &got[0]).await, BTreeSet::from([uid("wren"), uid("signalbot")]));

    bot_task.abort();
    m.shut_down().await;
}
