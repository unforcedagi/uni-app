//! Calendar (T-229) through the calendar door (`uni-cal`) on the hub's host.
//!
//! Every event is a note in the vault, and the door is the only thing that writes them. The app holds no vault token
//! for it: each request is NIP-98 signed with the device key, as Mail's are, and the door maps the key to a role
//! (`owner`, `uni`, `sync`). Reads are `GET /cal/v1/session|events|event/<id>|conflicts`; every write is one named
//! operation, `POST /cal/v1/op {op, opId, …}`, idempotent on its opId and a compare-and-set on the note's `rev` (a stale
//! one answers 409 with `current_rev`, [`CalError::Stale`]). Answers pass through as JSON; the view reads them.
//!
//! Only the ops in [`OPS`] leave the device, whatever the door would take; the door decides who may run which.

use std::time::Duration;

use nostr::Keys;
use serde::Serialize;
use serde_json::Value;

/// Port the door listens on, on the hub's host (Tailscale Serve).
pub const CAL_PORT: u16 = 8490;
/// Override for the door origin (a scratch or fake door). Never set in a shipped install.
pub const CAL_URL_ENV: &str = "UNI_CAL_URL";
/// The named operations this client sends (CONTRACT.md, "Signed-in API" and "Invitations").
pub const OPS: &[&str] = &["create", "update", "move", "cancel", "delete", "rsvp", "send_invites", "resolve_conflict"];

const TIMEOUT: Duration = Duration::from_secs(30);
const MAX_ANSWER: usize = 16 * 1024 * 1024;

/// Why a calendar request failed, in the shape the view shows.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CalError {
    /// The door could not be reached (it is down, or this device is off the tailnet).
    Unreachable { message: String },
    /// The door answered but does not take this device's key, or not for this.
    NotAllowed { message: String, pubkey: String },
    /// The event changed since it was read: nothing was written. `current_rev` is the note's revision now.
    Stale { current_rev: Option<i64>, message: String },
    /// The door refused the request for another reason (bad input, an op it doesn't offer).
    Refused { status: u16, message: String },
    /// The door or the vault behind it failed.
    Server { message: String },
    /// Bad input, or an answer this client can't read.
    Invalid { message: String },
}

impl std::fmt::Display for CalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CalError::Unreachable { message } => write!(f, "calendar door unreachable: {message}"),
            CalError::NotAllowed { message, pubkey } => write!(f, "calendar door does not allow key {pubkey}: {message}"),
            CalError::Stale { current_rev, .. } => write!(f, "the event changed since it was read (now rev {current_rev:?})"),
            CalError::Refused { status, message } => write!(f, "calendar door refused ({status}): {message}"),
            CalError::Server { message } => write!(f, "calendar door: {message}"),
            CalError::Invalid { message } => write!(f, "calendar: {message}"),
        }
    }
}

impl std::error::Error for CalError {}

pub type CalResult<T> = std::result::Result<T, CalError>;

fn invalid(message: impl Into<String>) -> CalError {
    CalError::Invalid { message: message.into() }
}

/// The door origin on the hub's host: same scheme and host, port [`CAL_PORT`].
pub fn door_url(hub: &str) -> Option<String> {
    crate::hub::service_origin(hub, CAL_PORT)
}

/// The door to call for `hub`, and the door under the hub's other name (T-137) to try when the first can't be
/// reached, in the order [`crate::mail::bridge_urls`] uses.
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
pub struct CalDoor<'a> {
    base: String,
    alias: Option<String>,
    keys: &'a Keys,
}

impl<'a> CalDoor<'a> {
    /// `base` is the door origin; https, or http only on this device.
    pub fn new(base: &str, keys: &'a Keys) -> CalResult<Self> {
        let base = crate::hub::checked_origin(base).map_err(|e| invalid(e.to_string()))?;
        Ok(Self { base, alias: None, keys })
    }

    /// Also try `alias` when `base` can't be reached at all; an answer, even an error, is never retried.
    pub fn with_alias(mut self, alias: Option<&str>) -> Self {
        self.alias = alias.and_then(|a| crate::hub::checked_origin(a).ok());
        self
    }

    /// What this key may do here: `{role, ops, calendar, tz}`.
    pub async fn session(&self) -> CalResult<Value> {
        self.call("GET", "/cal/v1/session", None).await
    }

    /// Every instance overlapping `[from, to)`: `{complete, instances}`.
    pub async fn events(&self, from: &str, to: &str) -> CalResult<Value> {
        let path = format!("/cal/v1/events?from={}&to={}", instant(from)?, instant(to)?);
        self.call("GET", &path, None).await
    }

    /// One event note: its fields, description and ICS.
    pub async fn event(&self, id: &str) -> CalResult<Value> {
        self.call("GET", &format!("/cal/v1/event/{}", note_id(id)?), None).await
    }

    /// The conflict records (`event-conflict` notes) the door keeps.
    pub async fn conflicts(&self) -> CalResult<Value> {
        self.call("GET", "/cal/v1/conflicts", None).await
    }

    /// One named operation. Refused here, before anything is sent, unless it names an op in [`OPS`] and has an opId.
    pub async fn op(&self, op: &Value) -> CalResult<Value> {
        check_op(op)?;
        self.call("POST", "/cal/v1/op", Some(op)).await
    }

    async fn call(&self, method: &str, path: &str, body: Option<&Value>) -> CalResult<Value> {
        crate::init_crypto();
        let body = match body {
            Some(b) => serde_json::to_vec(b).map_err(|e| invalid(e.to_string()))?,
            None => Vec::new(),
        };
        let client = crate::media::http_client_with_timeout(TIMEOUT).map_err(|e| invalid(e.to_string()))?;
        match self.call_to(&client, &self.base, method, path, &body).await {
            Err((true, e)) => match &self.alias {
                Some(alias) => self.call_to(&client, alias, method, path, &body).await.map_err(|(_, e2)| if matches!(e2, CalError::Unreachable { .. }) { e } else { e2 }),
                None => Err(e),
            },
            r => r.map_err(|(_, e)| e),
        }
    }

    /// One signed request to `base`; the error says whether the host was unreachable.
    async fn call_to(&self, client: &reqwest::Client, base: &str, method: &str, path: &str, body: &[u8]) -> std::result::Result<Value, (bool, CalError)> {
        let url = format!("{base}{path}");
        let auth = crate::parachute::nip98_header_with_payload(self.keys, &url, method, body).map_err(|e| (false, invalid(e.to_string())))?;
        let req = if method == "POST" {
            client.post(&url).header("Content-Type", "application/json").body(body.to_vec())
        } else {
            client.get(&url)
        };
        let response = req.header("Authorization", auth).send().await.map_err(|e| {
            let message = if e.is_timeout() { "the calendar door did not answer in time".into() } else { format!("{base} is not answering (tailnet only): {e}") };
            (crate::hub::is_connect_failure(&e), CalError::Unreachable { message })
        })?;
        let status = response.status();
        if response.content_length().is_some_and(|n| n as usize > MAX_ANSWER) {
            return Err((false, invalid("larger than this app reads")));
        }
        let bytes = response.bytes().await.map_err(|e| (false, CalError::Unreachable { message: format!("the answer was cut off: {e}") }))?;
        if bytes.len() > MAX_ANSWER {
            return Err((false, invalid("larger than this app reads")));
        }
        let json = serde_json::from_slice::<Value>(&bytes).ok();
        if status.is_success() {
            return match json {
                Some(v) if v.is_object() => Ok(v),
                _ => Err((false, invalid("the door's answer isn't a JSON object"))),
            };
        }
        let message = json
            .as_ref()
            .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_else(|| String::from_utf8_lossy(&bytes).chars().take(300).collect());
        Err((false, match status.as_u16() {
            401 | 403 => CalError::NotAllowed { message, pubkey: self.keys.public_key().to_hex() },
            409 => CalError::Stale { current_rev: json.as_ref().and_then(|v| v.get("current_rev")).and_then(Value::as_i64), message },
            502..=504 => CalError::Server { message },
            s => CalError::Refused { status: s, message },
        }))
    }
}

/// An op this client may send: a known name and an opId (8–128 characters).
pub fn check_op(op: &Value) -> CalResult<()> {
    let name = op.get("op").and_then(Value::as_str).unwrap_or("");
    if !OPS.contains(&name) {
        return Err(invalid(format!("this app doesn't send the calendar op {name:?}")));
    }
    let id = op.get("opId").and_then(Value::as_str).unwrap_or("");
    if !(8..=128).contains(&id.len()) || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(invalid("an op needs an opId (8–128 letters, digits, - or _)"));
    }
    Ok(())
}

/// A query bound: `YYYY-MM-DDTHH:MM:SSZ` or `YYYY-MM-DD`, nothing else (it goes into the URL unescaped).
fn instant(s: &str) -> CalResult<&str> {
    let ok = match s.len() {
        10 => s.chars().enumerate().all(|(i, c)| if i == 4 || i == 7 { c == '-' } else { c.is_ascii_digit() }),
        20 => s.ends_with('Z') && s.as_bytes()[10] == b'T' && s[..10].chars().enumerate().all(|(i, c)| if i == 4 || i == 7 { c == '-' } else { c.is_ascii_digit() })
            && s[11..19].chars().enumerate().all(|(i, c)| if i == 2 || i == 5 { c == ':' } else { c.is_ascii_digit() }),
        _ => false,
    };
    if ok { Ok(s) } else { Err(invalid(format!("not a calendar time: {s:?}"))) }
}

/// A note id as one path segment: letters, digits, `-` and `_` only.
fn note_id(s: &str) -> CalResult<&str> {
    if !s.is_empty() && s.len() <= 128 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        Ok(s)
    } else {
        Err(invalid(format!("not an event id: {s:?}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_known_ops_with_an_op_id_leave_the_device() {
        assert!(check_op(&json!({"op": "move", "opId": "op-12345678"})).is_ok());
        assert!(check_op(&json!({"op": "sync/upsert", "opId": "op-12345678"})).is_err());
        assert!(check_op(&json!({"op": "confirm_booking", "opId": "op-12345678"})).is_err());
        assert!(check_op(&json!({"op": "move"})).is_err());
        assert!(check_op(&json!({"op": "move", "opId": "short"})).is_err());
        assert!(check_op(&json!({"op": "move", "opId": "op 1234567&x=1"})).is_err());
    }

    #[test]
    fn query_bounds_and_ids_are_checked_before_they_go_into_a_url() {
        assert!(instant("2026-10-19T06:00:00Z").is_ok());
        assert!(instant("2026-10-19").is_ok());
        assert!(instant("2026-10-19T06:00:00Z&to=x").is_err());
        assert!(instant("2026-10-19T06:00:00+02:00").is_err());
        assert!(note_id("01JABCDEF").is_ok());
        assert!(note_id("../vault").is_err());
        assert!(note_id("").is_err());
    }

    #[test]
    fn the_door_is_on_the_hub_host_at_its_port() {
        assert_eq!(door_url("https://hub.example.ts.net").as_deref(), Some("https://hub.example.ts.net:8490"));
        assert_eq!(door_url("http://example.com"), None);
    }
}
