//! T-335 Taste Arcade: the arcade door (`taste-arcade` server) on the hub's host.
//!
//! The games keep their cards, reactions and the taste profile on the owner's own machine. The app holds no key for it:
//! each request is NIP-98 signed with the device key, as Mail's and the calendar's are, and the door answers on the
//! tailnet only. Only the paths below leave the device; every query value is checked before it goes into a URL.

use std::time::Duration;

use nostr::Keys;
use serde::Serialize;
use serde_json::Value;

/// Port the door listens on, on the hub's host (Tailscale Serve).
pub const ARCADE_PORT: u16 = 8543;
/// Override for the door origin (a scratch or fake door). Never set in a shipped install.
pub const ARCADE_URL_ENV: &str = "UNI_ARCADE_URL";
/// The games a round can be asked for (the Garden has no rounds).
pub const GAMES: &[&str] = &["this-or-that", "gallery", "fix-it", "who-said-it", "ripple"];

const TIMEOUT: Duration = Duration::from_secs(20);
const MAX_ANSWER: usize = 4 * 1024 * 1024;
/// A card's media (a short clip at most).
pub const MAX_MEDIA: usize = 30 * 1024 * 1024;

/// Why an arcade request failed, in the shape the view shows.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ArcadeError {
    /// The door could not be reached (it is down, or this device is off the tailnet).
    Unreachable { message: String },
    /// The door answered but does not take this device's key.
    NotAllowed { message: String },
    /// The door refused the request (bad input, too many requests).
    Refused { status: u16, message: String },
    /// The door failed (5xx).
    Server { message: String },
    /// Bad input, or an answer this client can't read.
    Invalid { message: String },
}

impl std::fmt::Display for ArcadeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ArcadeError::Unreachable { message } => write!(f, "arcade door unreachable: {message}"),
            ArcadeError::NotAllowed { message } => {
                write!(f, "arcade door does not allow this device: {message}")
            }
            ArcadeError::Refused { status, message } => {
                write!(f, "arcade door refused ({status}): {message}")
            }
            ArcadeError::Server { message } => write!(f, "arcade door: {message}"),
            ArcadeError::Invalid { message } => write!(f, "arcade: {message}"),
        }
    }
}

impl std::error::Error for ArcadeError {}

pub type ArcadeResult<T> = std::result::Result<T, ArcadeError>;

pub fn invalid(message: impl Into<String>) -> ArcadeError {
    ArcadeError::Invalid {
        message: message.into(),
    }
}

/// The door origin on the hub's host: same scheme and host, port [`ARCADE_PORT`], and only a tailnet host (the taste
/// log is the owner's, and goes to the owner's own box, whatever the hub is set to).
pub fn door_url(hub: &str) -> Option<String> {
    let origin = crate::hub::service_origin(hub, ARCADE_PORT)?;
    let host = origin.strip_prefix("https://")?.split(':').next()?;
    host.ends_with(".ts.net").then_some(origin)
}

/// The door to call for `hub`, and the door under the hub's other name (T-137) to try when the first can't be reached.
pub fn door_urls(hub: &str) -> Option<(String, Option<String>)> {
    let base = door_url(hub)?;
    let alias = crate::hub::alias_of(hub).and_then(|a| door_url(&a));
    let renamed = crate::hub::HUB_ALIASES
        .iter()
        .any(|(old, _)| door_url(old).as_deref() == Some(base.as_str()));
    Some(match alias {
        Some(new) if renamed => (new, Some(base)),
        alias => (base, alias),
    })
}

/// A card id as the door makes them (`web:12`, `pv-wsi-012`, `media:bellows-film`): safe in a query as it is.
pub fn check_card(id: &str) -> ArcadeResult<&str> {
    let ok = !id.is_empty()
        && id.len() <= 120
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'-' | b'_' | b'.'));
    if ok {
        Ok(id)
    } else {
        Err(invalid("not a card id"))
    }
}

pub fn check_game(game: &str) -> ArcadeResult<&str> {
    GAMES
        .iter()
        .find(|g| **g == game)
        .copied()
        .ok_or_else(|| invalid("not a game"))
}

/// A client for one door origin, signing as `keys`.
pub struct ArcadeDoor<'a> {
    base: String,
    alias: Option<String>,
    keys: &'a Keys,
}

/// Bytes and their type.
pub struct Media {
    pub bytes: Vec<u8>,
    pub mime: String,
}

impl<'a> ArcadeDoor<'a> {
    pub fn new(base: &str, keys: &'a Keys) -> ArcadeResult<Self> {
        let base = crate::hub::checked_origin(base).map_err(|e| invalid(e.to_string()))?;
        Ok(Self {
            base,
            alias: None,
            keys,
        })
    }

    pub fn with_alias(mut self, alias: Option<&str>) -> Self {
        self.alias = alias.and_then(|a| crate::hub::checked_origin(a).ok());
        self
    }

    pub async fn home(&self) -> ArcadeResult<Value> {
        self.json("GET", "/arcade/v1/home", None).await
    }

    pub async fn rounds(&self, game: &str, n: u32) -> ArcadeResult<Value> {
        let path = format!(
            "/arcade/v1/rounds?game={}&n={}",
            check_game(game)?,
            n.clamp(1, 60)
        );
        self.json("GET", &path, None).await
    }

    /// `{reactions: [...]}`, 1..100 of them; the door checks each one.
    pub async fn react(&self, reactions: &Value) -> ArcadeResult<Value> {
        let n = reactions.as_array().map(|a| a.len()).unwrap_or(0);
        if !(1..=100).contains(&n) {
            return Err(invalid("1 to 100 reactions at a time"));
        }
        self.json(
            "POST",
            "/arcade/v1/react",
            Some(&serde_json::json!({ "reactions": reactions })),
        )
        .await
    }

    pub async fn profile(&self) -> ArcadeResult<Value> {
        self.json("GET", "/arcade/v1/profile", None).await
    }

    pub async fn distill(&self, deep: bool) -> ArcadeResult<Value> {
        self.json(
            "POST",
            "/arcade/v1/distill",
            Some(&serde_json::json!({ "deep": deep })),
        )
        .await
    }

    pub async fn media(&self, card: &str, which: &str) -> ArcadeResult<Media> {
        if which != "src" && which != "poster" {
            return Err(invalid("media is src or poster"));
        }
        let path = format!("/arcade/v1/media?card={}&which={which}", check_card(card)?);
        let (bytes, mime) = self.call("GET", &path, &[], MAX_MEDIA).await?;
        Ok(Media { bytes, mime })
    }

    async fn json(&self, method: &str, path: &str, body: Option<&Value>) -> ArcadeResult<Value> {
        let body = match body {
            Some(b) => serde_json::to_vec(b).map_err(|e| invalid(e.to_string()))?,
            None => Vec::new(),
        };
        let (bytes, _) = self.call(method, path, &body, MAX_ANSWER).await?;
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(v) if v.is_object() => Ok(v),
            _ => Err(invalid("the door's answer isn't a JSON object")),
        }
    }

    async fn call(
        &self,
        method: &str,
        path: &str,
        body: &[u8],
        max: usize,
    ) -> ArcadeResult<(Vec<u8>, String)> {
        crate::init_crypto();
        let client =
            crate::media::http_client_with_timeout(TIMEOUT).map_err(|e| invalid(e.to_string()))?;
        match self
            .call_to(&client, &self.base, method, path, body, max)
            .await
        {
            Err((true, e)) => match &self.alias {
                Some(alias) => self
                    .call_to(&client, alias, method, path, body, max)
                    .await
                    .map_err(|(_, e2)| {
                        if matches!(e2, ArcadeError::Unreachable { .. }) {
                            e
                        } else {
                            e2
                        }
                    }),
                None => Err(e),
            },
            r => r.map_err(|(_, e)| e),
        }
    }

    /// One signed request to `base`; the error says whether the host was unreachable.
    async fn call_to(
        &self,
        client: &reqwest::Client,
        base: &str,
        method: &str,
        path: &str,
        body: &[u8],
        max: usize,
    ) -> std::result::Result<(Vec<u8>, String), (bool, ArcadeError)> {
        let url = format!("{base}{path}");
        let auth = crate::parachute::nip98_header_with_payload(self.keys, &url, method, body)
            .map_err(|e| (false, invalid(e.to_string())))?;
        let req = if method == "POST" {
            client
                .post(&url)
                .header("Content-Type", "application/json")
                .body(body.to_vec())
        } else {
            client.get(&url)
        };
        let response = req
            .header("Authorization", auth)
            .send()
            .await
            .map_err(|e| {
                let message = if e.is_timeout() {
                    "the arcade door did not answer in time".into()
                } else {
                    format!("{base} is not answering (tailnet only): {e}")
                };
                (
                    crate::hub::is_connect_failure(&e),
                    ArcadeError::Unreachable { message },
                )
            })?;
        let status = response.status();
        let mime = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_string();
        if response.content_length().is_some_and(|n| n as usize > max) {
            return Err((false, invalid("larger than this app reads")));
        }
        let bytes = response.bytes().await.map_err(|e| {
            (
                false,
                ArcadeError::Unreachable {
                    message: format!("the answer was cut off: {e}"),
                },
            )
        })?;
        if bytes.len() > max {
            return Err((false, invalid("larger than this app reads")));
        }
        if status.is_success() {
            return Ok((bytes.to_vec(), mime));
        }
        let message = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_else(|| String::from_utf8_lossy(&bytes).chars().take(300).collect());
        Err((
            false,
            match status.as_u16() {
                401 | 403 => ArcadeError::NotAllowed { message },
                500..=599 => ArcadeError::Server { message },
                s => ArcadeError::Refused { status: s, message },
            },
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_tailnet_hubs_get_a_door() {
        assert_eq!(
            door_url("https://box.example.ts.net").as_deref(),
            Some("https://box.example.ts.net:8543")
        );
        assert_eq!(door_url("https://notes.example.com"), None);
        assert_eq!(door_url("http://box.example.ts.net"), None);
    }

    #[test]
    fn query_values_are_checked_before_they_go_into_a_url() {
        assert!(
            check_card("web:12").is_ok()
                && check_card("pv-wsi-012").is_ok()
                && check_card("media:a_b.c").is_ok()
        );
        for bad in ["", "a&which=x", "../x", "a b", "a/b", "a?b", "ü"] {
            assert!(check_card(bad).is_err(), "{bad}");
        }
        assert!(check_game("gallery").is_ok());
        assert!(check_game("garden").is_err() && check_game("gallery&n=9").is_err());
    }
}
