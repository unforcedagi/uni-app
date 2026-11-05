//! T-335 All v2: the route door (`services/route`) on the hub's host: a small model's suggestion for where an unaddressed message goes.
//!
//! The app holds no key for it: each request is NIP-98 signed with the device key, as Mail's and the calendar's are. The door answers on the tailnet
//! only. The words go there and nowhere else. A failure of any kind is the caller's cue to stay on the word match, so errors stay plain strings.

use std::time::Duration;

use nostr::Keys;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Port the door listens on, on the hub's host (Tailscale Serve).
pub const ROUTE_PORT: u16 = 8521;
/// Override for the door origin (a scratch or fake door). Never set in a shipped install.
pub const ROUTE_URL_ENV: &str = "UNI_ROUTE_URL";

/// The app stops waiting at 1.5 s; a late answer can still add suggestions, so the request itself may run this long.
const TIMEOUT: Duration = Duration::from_secs(6);
const MAX_ANSWER: usize = 64 * 1024;

/// A room as the door hears of it: the place's name and its one line. Private areas are never in the list (the caller leaves them out).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DoorRoom {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub about: String,
}

/// The door origin on the hub's host: same scheme and host, port [`ROUTE_PORT`].
pub fn door_url(hub: &str) -> Option<String> {
    crate::hub::service_origin(hub, ROUTE_PORT)
}

/// The door to call for `hub`, and the door under the hub's other name (T-137) to try when the first can't be reached.
pub fn door_urls(hub: &str) -> Option<(String, Option<String>)> {
    let base = door_url(hub)?;
    let alias = crate::hub::alias_of(hub).and_then(|a| door_url(&a));
    let renamed = crate::hub::HUB_ALIASES.iter().any(|(old, _)| door_url(old).as_deref() == Some(base.as_str()));
    Some(match alias {
        Some(new) if renamed => (new, Some(base)),
        alias => (base, alias),
    })
}

/// A client for one door origin, signing as `keys`.
pub struct RouteDoor<'a> {
    base: String,
    alias: Option<String>,
    keys: &'a Keys,
}

impl<'a> RouteDoor<'a> {
    pub fn new(base: &str, alias: Option<&str>, keys: &'a Keys) -> Result<Self, String> {
        let base = crate::hub::checked_origin(base).map_err(|e| e.to_string())?;
        Ok(Self { base, alias: alias.and_then(|a| crate::hub::checked_origin(a).ok()), keys })
    }

    /// Suggested rooms for `text`: `{id, picks: [{id, why, sure}], ms}`.
    pub async fn suggest(&self, text: &str, rooms: &[DoorRoom]) -> Result<Value, String> {
        self.post("/route/v1/suggest", &serde_json::json!({ "text": text, "rooms": rooms })).await
    }

    /// What was suggested against what was sent: room ids, never words.
    pub async fn outcome(&self, outcome: &Value) -> Result<Value, String> {
        self.post("/route/v1/outcome", outcome).await
    }

    async fn post(&self, path: &str, body: &Value) -> Result<Value, String> {
        crate::init_crypto();
        let body = serde_json::to_vec(body).map_err(|e| e.to_string())?;
        let client = crate::media::http_client_with_timeout(TIMEOUT).map_err(|e| e.to_string())?;
        match self.post_to(&client, &self.base, path, &body).await {
            Err((true, e)) => match &self.alias {
                Some(alias) => self.post_to(&client, alias, path, &body).await.map_err(|(_, e2)| e2),
                None => Err(e),
            },
            r => r.map_err(|(_, e)| e),
        }
    }

    /// One signed request to `base`; the error says whether the host was unreachable. Errors never hold the request's words.
    async fn post_to(&self, client: &reqwest::Client, base: &str, path: &str, body: &[u8]) -> Result<Value, (bool, String)> {
        let url = format!("{base}{path}");
        let auth = crate::parachute::nip98_header_with_payload(self.keys, &url, "POST", body).map_err(|e| (false, e.to_string()))?;
        let response = client.post(&url).header("Content-Type", "application/json").header("Authorization", auth).body(body.to_vec()).send().await
            .map_err(|e| (crate::hub::is_connect_failure(&e), if e.is_timeout() { "the route door did not answer in time".to_string() } else { "the route door isn't answering (tailnet only)".to_string() }))?;
        let status = response.status();
        if response.content_length().is_some_and(|n| n as usize > MAX_ANSWER) {
            return Err((false, "larger than this app reads".into()));
        }
        let bytes = response.bytes().await.map_err(|_| (false, "the answer was cut off".to_string()))?;
        if bytes.len() > MAX_ANSWER {
            return Err((false, "larger than this app reads".into()));
        }
        let json = serde_json::from_slice::<Value>(&bytes).ok();
        if status.is_success() {
            return match json {
                Some(v) if v.is_object() => Ok(v),
                _ => Err((false, "the door's answer isn't a JSON object".into())),
            };
        }
        let why = json.as_ref().and_then(|v| v.get("error")).and_then(Value::as_str).unwrap_or("no reason given");
        Err((false, format!("route door ({status}): {why}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_door_is_on_the_hub_host_at_its_port() {
        assert_eq!(door_url("https://hub.example.ts.net").as_deref(), Some("https://hub.example.ts.net:8521"));
        assert_eq!(door_url("http://example.com"), None);
    }
}
