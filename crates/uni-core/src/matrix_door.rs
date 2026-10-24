//! The Matrix door on the hub's host (T-282, port [`MATRIX_PORT`], path `/uni-door`): it signs this device in to the
//! owner's Matrix account without a password reaching the device. Each request is NIP-98 signed with the device key,
//! as Mail's and Calendar's are; the door accepts only the owner's paired keys and answers a one-time login token
//! (`m.login.token`), which the Messages core spends at once. It also takes the owner's Telegram app keys, so the
//! Telegram bridge can start.
use std::time::Duration;

use nostr::Keys;
use serde::{Deserialize, Serialize};

/// The homeserver and its door share this port on the hub's host (tailscale serve: `/` and `/uni-door`).
pub const MATRIX_PORT: u16 = 8520;
const PREFIX: &str = "/uni-door";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DoorLogin {
    /// The homeserver to sign in at (the same origin, behind TLS on the tailnet).
    pub homeserver: String,
    pub user_id: String,
    /// One use, about two minutes.
    pub login_token: String,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum DoorError {
    /// Off the tailnet, or the door isn't running.
    #[error("{0}")]
    Unreachable(String),
    /// This device's key isn't one of the owner's.
    #[error("{0}")]
    Refused(String),
    #[error("{0}")]
    Failed(String),
}

/// The door's origin on `hub`'s host, and the same under the hub's other name, to try when the first can't be reached.
pub fn door_urls(hub: &str) -> Option<(String, Option<String>)> {
    let base = crate::hub::service_origin(hub, MATRIX_PORT)?;
    let alias = crate::hub::alias_of(hub).and_then(|a| crate::hub::service_origin(&a, MATRIX_PORT));
    let renamed = crate::hub::HUB_ALIASES.iter().any(|(old, _)| crate::hub::service_origin(old, MATRIX_PORT).as_deref() == Some(base.as_str()));
    Some(match alias {
        Some(new) if renamed => (new, Some(base)),
        alias => (base, alias),
    })
}

/// A one-time login token for the owner's account, for this device.
pub async fn login(base: &str, alias: Option<&str>, keys: &Keys) -> Result<DoorLogin, DoorError> {
    let body = post_either(base, alias, "/v1/login", keys, b"{}".to_vec()).await?;
    serde_json::from_str(&body).map_err(|e| DoorError::Failed(format!("the Matrix door answered something else: {e}")))
}

/// Hand the owner's Telegram app keys (my.telegram.org) to the box; the door starts the Telegram bridge with them.
pub async fn telegram_keys(base: &str, alias: Option<&str>, keys: &Keys, api_id: &str, api_hash: &str) -> Result<(), DoorError> {
    let api_id = api_id.trim();
    let api_hash = api_hash.trim().to_ascii_lowercase();
    if api_id.is_empty() || !api_id.bytes().all(|b| b.is_ascii_digit()) || api_hash.len() != 32 || !api_hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(DoorError::Failed("api_id is digits and api_hash is 32 letters and digits, both from my.telegram.org.".into()));
    }
    let body = serde_json::to_vec(&serde_json::json!({ "api_id": api_id, "api_hash": api_hash })).map_err(|e| DoorError::Failed(e.to_string()))?;
    post_either(base, alias, "/v1/telegram-keys", keys, body).await.map(|_| ())
}

async fn post_either(base: &str, alias: Option<&str>, path: &str, keys: &Keys, body: Vec<u8>) -> Result<String, DoorError> {
    match post(base, path, keys, body.clone()).await {
        Err((true, e)) => match alias {
            // only when the first name can't be reached at all; an answer, even an error, is never retried
            Some(a) => post(a, path, keys, body).await.map_err(|(_, e)| e),
            None => Err(e),
        },
        other => other.map_err(|(_, e)| e),
    }
}

/// One signed POST; the error says whether the host couldn't be reached at all.
async fn post(base: &str, path: &str, keys: &Keys, body: Vec<u8>) -> Result<String, (bool, DoorError)> {
    let plain = |e: DoorError| (false, e);
    let origin = crate::hub::checked_origin(base).map_err(|e| plain(DoorError::Failed(e.to_string())))?;
    let url = format!("{origin}{PREFIX}{path}");
    crate::init_crypto();
    let auth = crate::parachute::nip98_header(keys, &url, "POST", &body).map_err(|e| plain(DoorError::Failed(e.to_string())))?;
    let client = crate::media::http_client_with_timeout(Duration::from_secs(30)).map_err(|e| plain(DoorError::Failed(e.to_string())))?;
    let response = client
        .post(&url)
        .header("Authorization", auth)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| (crate::hub::is_connect_failure(&e), DoorError::Unreachable("The Matrix door on your box isn't answering (it is on the tailnet only).".into())))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if status.as_u16() == 401 {
        return Err(plain(DoorError::Refused("This device isn't one the Matrix door knows. Sign in with a password, or ask Uni to add this device.".into())));
    }
    if !status.is_success() {
        let said = serde_json::from_str::<serde_json::Value>(&text).ok().and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_owned));
        return Err(plain(DoorError::Failed(format!("The Matrix door said: {}", said.unwrap_or_else(|| status.to_string())))));
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_door_is_on_the_hubs_host_and_https_only() {
        let (base, _) = door_urls("https://hub.example.ts.net").unwrap();
        assert_eq!(base, "https://hub.example.ts.net:8520");
        assert!(door_urls("http://hub.example.ts.net").is_none(), "never in the clear off this machine");
    }
}

/// Against a running door, by hand (a test door with a throwaway key and account, never the owner's):
/// `UNI_TEST_MATRIX_DOOR=http://127.0.0.1:18599 UNI_TEST_MATRIX_DOOR_KEY=<hex> cargo test -p uni-core door_live -- --ignored`
#[cfg(test)]
mod live {
    use super::*;

    #[tokio::test]
    #[ignore = "needs a running test door (see above)"]
    async fn door_live() {
        let base = std::env::var("UNI_TEST_MATRIX_DOOR").unwrap();
        let keys = Keys::parse(&std::env::var("UNI_TEST_MATRIX_DOOR_KEY").unwrap()).unwrap();
        let got = login(&base, None, &keys).await.unwrap();
        assert!(got.user_id.starts_with('@') && !got.login_token.is_empty());
        println!("door answered for {} at {}", got.user_id, got.homeserver);
        // another key is refused
        let other = Keys::generate();
        assert!(matches!(login(&base, None, &other).await, Err(DoorError::Refused(_))));
        // the test door takes no Telegram keys: its answer is passed on, not retried or hidden
        assert!(telegram_keys(&base, None, &keys, "1234567", "0123456789abcdef0123456789abcdef").await.is_err());
    }
}
