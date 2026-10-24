//! T-282: a message written while the homeserver restarts still goes, and so do the ones after it.
//!
//! matrix-sdk pauses a room's send queue when a send fails for a reason that passes (the network, the homeserver gone
//! for a moment) and leaves it paused until the app turns it back on; without that, every later message waits as
//! "sending" for good. Here the homeserver is a real one, continuwuity, run on a free loopback port with its own
//! database (the test is skipped where it isn't installed): the account signs in, the homeserver is stopped, a message
//! is sent, the homeserver starts again on the same database, and both that message and one sent after it must reach
//! the room.
//!
//! `UNI_TEST_CONTINUWUITY` names the binary; without it, the default install path is tried.

#![recursion_limit = "256"]

mod common;

use std::{sync::Arc, time::Duration};

use common::{binary, bootstrap_token, free_port, http, until, Homeserver};
use serde_json::json;
use uni_messages::{FileSecrets, Messages};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_message_sent_while_the_homeserver_restarts_still_goes_and_so_do_later_ones() {
    let Some(bin) = binary() else {
        eprintln!("skipped: no continuwuity binary (set UNI_TEST_CONTINUWUITY)");
        return;
    };
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_owned();
    let port = free_port();
    std::fs::write(
        dir.join("hs.toml"),
        format!(
            "[global]\nserver_name = \"outage.test.localhost\"\naddress = [\"127.0.0.1\"]\nport = {port}\ndatabase_path = \"{}\"\n\
             allow_federation = false\nallow_registration = true\nregistration_token = \"test-registration-token-0123456789\"\n\
             allow_announcements_check = false\ntrusted_servers = []\nlog = \"info\"\n",
            dir.join("db").display()
        ),
    )
    .unwrap();
    let mut hs = Homeserver { bin, dir: dir.clone(), port, child: None };
    hs.start();
    until(30, "the homeserver answers", || async { http(port, "GET", "/_matrix/client/versions", None, None).await.is_some_and(|r| r.0 == 200) }).await;

    // one account: the first takes the one-time token a fresh database prints
    let mut boot = None;
    until(10, "the bootstrap token", || {
        boot = bootstrap_token(&dir);
        let found = boot.is_some();
        async move { found }
    })
    .await;
    let (_, first) = http(port, "POST", "/_matrix/client/v3/register", Some(json!({ "username": "wren", "password": "pw-0123456789" })), None).await.unwrap();
    let (status, reg) = http(
        port,
        "POST",
        "/_matrix/client/v3/register",
        Some(json!({ "username": "wren", "password": "pw-0123456789", "auth": { "type": "m.login.registration_token", "token": boot.unwrap(), "session": first["session"] } })),
        None,
    )
    .await
    .unwrap();
    assert_eq!(status, 200, "{reg}");
    let token = reg["access_token"].as_str().unwrap().to_owned();
    let (_, room) = http(port, "POST", "/_matrix/client/v3/createRoom", Some(json!({ "name": "Outage test", "preset": "private_chat" })), Some(&token)).await.unwrap();
    let room_id = room["room_id"].as_str().unwrap().to_owned();

    // the account under test, as the app runs it
    let m = Messages::new(dir.join("app/data"), Arc::new(FileSecrets::new(dir.join("app/secrets"))));
    m.sign_in(&hs.url(), "wren", "pw-0123456789").await.unwrap();
    until(30, "the room is listed", || {
        let m = m.clone();
        let id = room_id.clone();
        async move { m.rooms().await.unwrap_or_default().iter().any(|r| r.id == id) }
    })
    .await;
    m.open(&room_id).await.unwrap();

    hs.stop();
    m.send(&room_id, "written while the homeserver was down").await.unwrap();
    tokio::time::sleep(Duration::from_secs(3)).await;
    hs.start();
    until(30, "the homeserver is back", || async { http(port, "GET", "/_matrix/client/versions", None, None).await.is_some_and(|r| r.0 == 200) }).await;
    m.send(&room_id, "written after it came back").await.unwrap();

    let path = format!("/_matrix/client/v3/rooms/{}/messages?dir=b&limit=20", room_id.replace('!', "%21").replace(':', "%3A"));
    until(60, "both messages reach the room", || {
        let (path, token) = (path.clone(), token.clone());
        async move {
            let Some((200, page)) = http(port, "GET", &path, None, Some(&token)).await else { return false };
            let bodies: Vec<String> = page["chunk"].as_array().into_iter().flatten().filter_map(|e| e["content"]["body"].as_str().map(str::to_owned)).collect();
            bodies.iter().any(|b| b == "written while the homeserver was down") && bodies.iter().any(|b| b == "written after it came back")
        }
    })
    .await;
    m.shut_down().await;
}
