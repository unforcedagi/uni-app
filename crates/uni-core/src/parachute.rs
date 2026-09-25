//! Parachute vault access with the user's Nostr key (NIP-98).
//!
//! The hub's root `/mcp` door accepts `Authorization: Nostr <base64url(event)>`
//! where the event is a kind-27235 NIP-98 event bound to this exact request
//! (`u` = absolute URL, `method`, `payload` = SHA-256 of the body). The hub
//! maps the signing pubkey to a hub user (`parachute auth link-pubkey`) and
//! answers as that user: the same key that signs Buzz messages writes the
//! vault. No token is stored on the device.
//!
//! Journal entries use the Parachute app's capture shape so everything that
//! already reads captures (journal-router, search, Uni) sees them unchanged:
//! path `Notes/YYYY/MM-DD/HH-MM-SS`, tag `capture`, `metadata.source` =
//! `text` | `voice`. Voice notes carry the audio as an attachment uploaded
//! with `transcribe: true`; the vault transcribes it on the hub box and
//! replaces the `_Transcript pending._` placeholder.

use std::sync::Arc;
use std::time::Duration;

use nostr::base64::engine::general_purpose::URL_SAFE_NO_PAD;
use nostr::base64::Engine as _;
use nostr::{EventBuilder, JsonUtil as _, Keys, Kind, Tag};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::media::sha256_hex;
use crate::{Error, Result};

/// NIP-98 HTTP auth kind.
pub const NIP98_KIND: u16 = 27235;
/// Placeholder the vault's transcription worker replaces.
pub const TRANSCRIPT_PENDING: &str = "_Transcript pending._";
/// Largest voice note we upload (the vault's REST cap is 100 MiB).
pub const MAX_AUDIO_BYTES: usize = 50 * 1024 * 1024;

const TIMEOUT: Duration = Duration::from_secs(60);

/// `Authorization` header value for one request.
///
/// The hub burns every event id for ~2 minutes, and `created_at` has
/// one-second resolution, so two identical requests in the same second
/// (e.g. polling `get_entry`) would share an id and the second would be
/// rejected as `replayed`. A random `nonce` tag makes every id unique; the
/// hub ignores its value (parachute-hub `docs/contracts/nip98-http-auth.md`).
pub fn nip98_header(keys: &Keys, url: &str, method: &str, body: &[u8]) -> Result<String> {
    let tag = |parts: &[&str]| {
        Tag::parse(parts.iter().copied()).map_err(|e| Error::Invalid(e.to_string()))
    };
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let mut tags = vec![
        tag(&["u", url])?,
        tag(&["method", &method.to_uppercase()])?,
        tag(&["nonce", &nonce])?,
    ];
    if !body.is_empty() {
        tags.push(tag(&["payload", &sha256_hex(body)])?);
    }
    let event = EventBuilder::new(Kind::from(NIP98_KIND), "")
        .tags(tags)
        .sign_with_keys(keys)
        .map_err(|e| Error::Invalid(format!("signing failed: {e}")))?;
    Ok(format!(
        "Nostr {}",
        URL_SAFE_NO_PAD.encode(event.as_json().as_bytes())
    ))
}

/// Where the hub lives and which vault holds the journal.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VaultConfig {
    /// Hub origin, e.g. `https://uni-1.taildf9ce2.ts.net`.
    pub hub: String,
    /// Vault name, e.g. `unforced`.
    pub vault: String,
}

impl VaultConfig {
    fn origin(&self) -> Result<String> {
        let url = url::Url::parse(self.hub.trim())
            .map_err(|e| Error::Invalid(format!("hub URL: {e}")))?;
        let local = matches!(url.host_str(), Some("127.0.0.1" | "localhost"));
        if url.scheme() != "https" && !(url.scheme() == "http" && local) {
            return Err(Error::Invalid("hub URL must be https".into()));
        }
        Ok(url.origin().ascii_serialization())
    }
}

/// A journal entry as the app lists it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct JournalNote {
    pub id: String,
    pub path: String,
    pub created_at: String,
    pub content: String,
    /// `text`, `voice`, or whatever the writer recorded.
    pub source: Option<String>,
    /// Device-side id of the entry that wrote this note (`metadata.entry_id`).
    pub entry_id: Option<String>,
    pub tags: Vec<String>,
    /// Content is still the transcription placeholder.
    pub pending: bool,
}

impl JournalNote {
    fn from_value(v: &Value) -> Option<Self> {
        let content = v["content"].as_str().unwrap_or_default().to_string();
        Some(Self {
            id: v["id"].as_str()?.to_string(),
            path: v["path"].as_str().unwrap_or_default().to_string(),
            created_at: v["createdAt"]
                .as_str()
                .or_else(|| v["created_at"].as_str())
                .unwrap_or_default()
                .to_string(),
            pending: content.contains(TRANSCRIPT_PENDING),
            source: v["metadata"]["source"].as_str().map(str::to_string),
            entry_id: v["metadata"]["entry_id"].as_str().map(str::to_string),
            tags: v["tags"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|t| t.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default(),
            content,
        })
    }
}

/// Signed client for the hub's account MCP.
pub struct VaultClient {
    cfg: VaultConfig,
    origin: String,
    keys: Keys,
    http: reqwest::Client,
}

impl VaultClient {
    pub fn new(cfg: VaultConfig, keys: Keys) -> Result<Self> {
        let origin = cfg.origin()?;
        Ok(Self {
            cfg,
            origin,
            keys,
            http: http_client()?,
        })
    }

    /// Call one MCP tool; returns the tool's JSON result (parsed from the
    /// first text block when it is JSON, else the text as a string).
    pub async fn call(&self, tool: &str, arguments: Value) -> Result<Value> {
        let url = format!("{}/mcp", self.origin);
        let body = serde_json::to_vec(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": { "name": tool, "arguments": arguments },
        }))
        .map_err(|e| Error::Vault(e.to_string()))?;
        let auth = nip98_header(&self.keys, &url, "POST", &body)?;
        let res = self
            .http
            .post(&url)
            .header("authorization", auth)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .body(body)
            .send()
            .await
            .map_err(|e| Error::Vault(format!("hub unreachable: {}", chain(&e))))?;
        let status = res.status();
        let text = res.text().await.map_err(|e| Error::Vault(e.to_string()))?;
        if !status.is_success() {
            return Err(Error::Vault(auth_hint(status.as_u16(), &text)));
        }
        let rpc: Value =
            serde_json::from_str(&text).map_err(|e| Error::Vault(format!("bad response: {e}")))?;
        tool_result(&rpc)
    }

    /// Create a journal entry (text now, or a voice placeholder).
    pub async fn create_entry(&self, entry: &NewEntry) -> Result<JournalNote> {
        let mut args = json!({
            "vault": self.cfg.vault,
            "content": entry.content,
            "path": entry.path,
            "tags": ["capture"],
            "metadata": { "source": entry.source, "client": "uni-app" },
            // A retried upload after a lost response finds the first write.
            "if_exists": "ignore",
        });
        if let Some(id) = &entry.entry_id {
            args["metadata"]["entry_id"] = json!(id);
        }
        if let Some(ts) = &entry.created_at {
            args["created_at"] = json!(ts);
        }
        let v = self.call("create-note", args).await?;
        JournalNote::from_value(&v)
            .ok_or_else(|| Error::Vault("create-note returned no note".into()))
    }

    /// Upload audio onto `note` and ask the vault to transcribe it.
    pub async fn upload_audio(
        &self,
        note: &str,
        filename: &str,
        mime: &str,
        bytes: Vec<u8>,
    ) -> Result<()> {
        if bytes.is_empty() || bytes.len() > MAX_AUDIO_BYTES {
            return Err(Error::Invalid(format!(
                "audio must be 1..{MAX_AUDIO_BYTES} bytes"
            )));
        }
        let ticket = self
            .call(
                "request-attachment-upload",
                json!({
                    "vault": self.cfg.vault,
                    "note": note,
                    "filename": filename,
                    "mime_type": mime,
                    "size_bytes": bytes.len(),
                    "transcribe": true,
                }),
            )
            .await?;
        let url = ticket_url(&self.origin, &self.cfg.vault, &ticket)?;
        let res = self
            .http
            .put(&url)
            .header("content-type", mime)
            .body(bytes)
            .send()
            .await
            .map_err(|e| Error::Vault(format!("upload failed: {}", chain(&e))))?;
        if !res.status().is_success() {
            let code = res.status().as_u16();
            let text = res.text().await.unwrap_or_default();
            return Err(Error::Vault(format!(
                "upload rejected ({code}): {}",
                text.chars().take(200).collect::<String>()
            )));
        }
        Ok(())
    }

    /// Newest journal entries first.
    pub async fn list_entries(&self, limit: usize, offset: usize) -> Result<Vec<JournalNote>> {
        let v = self
            .call(
                "query-notes",
                json!({
                    "vault": self.cfg.vault,
                    "tag": "capture",
                    "sort": "desc",
                    "limit": limit.clamp(1, 100),
                    "offset": offset,
                    "include_content": true,
                    "content_length": 2000,
                    "include_metadata": ["source", "entry_id"],
                }),
            )
            .await?;
        Ok(notes_in(&v)
            .iter()
            .filter_map(JournalNote::from_value)
            .collect())
    }

    /// One entry, full content.
    pub async fn get_entry(&self, id: &str) -> Result<JournalNote> {
        let v = self
            .call("query-notes", json!({ "vault": self.cfg.vault, "id": id }))
            .await?;
        notes_in(&v)
            .first()
            .and_then(JournalNote::from_value)
            .ok_or_else(|| Error::Vault(format!("entry not found: {id}")))
    }
}

/// What the app writes for one entry.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NewEntry {
    pub path: String,
    pub content: String,
    pub source: String,
    /// ISO time the entry was made on the device (offline entries keep it).
    pub created_at: Option<String>,
    /// Device-side UUID; lets a retry recognise its own earlier write.
    pub entry_id: Option<String>,
}

/// Unwrap an MCP `tools/call` JSON-RPC response.
fn tool_result(rpc: &Value) -> Result<Value> {
    if let Some(err) = rpc.get("error") {
        let msg = err["message"].as_str().unwrap_or("tool error");
        return Err(Error::Vault(msg.to_string()));
    }
    let result = &rpc["result"];
    let text = result["content"]
        .as_array()
        .and_then(|c| c.iter().find_map(|b| b["text"].as_str()))
        .unwrap_or_default();
    if result["isError"].as_bool() == Some(true) {
        return Err(Error::Vault(text.chars().take(300).collect()));
    }
    let parsed: Value = serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.into()));
    // The account door proxies vault tools, whose own text may be wrapped
    // once more as `{"result": "<json>"}`.
    if let Some(inner) = parsed.get("result").and_then(Value::as_str) {
        if let Ok(v) = serde_json::from_str::<Value>(inner) {
            return Ok(v);
        }
    }
    Ok(parsed)
}

/// Notes from any query-notes shape: a bare array, `{notes}`, a single note,
/// or the account fan-out `{results: [{vault, notes}]}`.
fn notes_in(v: &Value) -> Vec<Value> {
    if let Some(a) = v.as_array() {
        return a.clone();
    }
    if let Some(results) = v["results"].as_array() {
        return results.iter().flat_map(|r| notes_in(&r["notes"])).collect();
    }
    if let Some(a) = v["notes"].as_array() {
        return a.clone();
    }
    if v["notes"].is_object() {
        return vec![v["notes"].clone()];
    }
    if v["id"].is_string() {
        return vec![v.clone()];
    }
    Vec::new()
}

/// The ticket URL, re-rooted on the hub origin we reached: the vault builds
/// it from the (proxied, possibly loopback) request it saw.
fn ticket_url(origin: &str, vault: &str, ticket: &Value) -> Result<String> {
    let raw = ticket["url"]
        .as_str()
        .ok_or_else(|| Error::Vault("upload ticket has no url".into()))?;
    let parsed = url::Url::parse(raw).map_err(|e| Error::Vault(format!("ticket url: {e}")))?;
    let prefix = format!("/vault/{vault}/tickets/");
    let id = parsed
        .path()
        .strip_prefix(&prefix)
        .filter(|id| !id.is_empty() && !id.contains('/'))
        .ok_or_else(|| Error::Vault("unexpected ticket url".into()))?;
    Ok(format!("{origin}{prefix}{id}"))
}

/// An error with its causes (reqwest's Display hides DNS/TLS/connect detail).
fn chain(e: &dyn std::error::Error) -> String {
    let mut out = e.to_string();
    let mut src = e.source();
    while let Some(s) = src {
        out.push_str(": ");
        out.push_str(&s.to_string());
        src = s.source();
    }
    out
}

fn auth_hint(status: u16, body: &str) -> String {
    let detail: String = body.chars().take(200).collect();
    match status {
        401 if body.contains("not linked") => {
            "this key isn't linked to a Parachute account yet (parachute auth link-pubkey)".into()
        }
        401 | 403 => format!("vault refused this key ({status}): {detail}"),
        _ => format!("hub error {status}: {detail}"),
    }
}

fn http_client() -> Result<reqwest::Client> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let provider = rustls::crypto::CryptoProvider::get_default()
        .cloned()
        .unwrap_or_else(|| Arc::new(rustls::crypto::ring::default_provider()));
    let tls = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| Error::Vault(format!("tls: {e}")))?
        .with_root_certificates(roots)
        .with_no_client_auth();
    reqwest::Client::builder()
        .tls_backend_preconfigured(tls)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| Error::Vault(format!("http client: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::Event;

    fn decode(header: &str) -> Event {
        let b64 = header.strip_prefix("Nostr ").unwrap();
        let json = URL_SAFE_NO_PAD.decode(b64).unwrap();
        Event::from_json(json).unwrap()
    }

    #[test]
    fn nip98_binds_url_method_and_body() {
        let keys = Keys::generate();
        let h = nip98_header(&keys, "https://hub.example/mcp", "post", b"{}").unwrap();
        let ev = decode(&h);
        ev.verify().unwrap();
        assert_eq!(ev.kind, Kind::from(27235));
        assert_eq!(ev.pubkey, keys.public_key());
        let tags: Vec<Vec<String>> = ev.tags.iter().map(|t| t.clone().to_vec()).collect();
        assert!(tags.contains(&vec!["u".into(), "https://hub.example/mcp".into()]));
        assert!(tags.contains(&vec!["method".into(), "POST".into()]));
        assert!(tags.contains(&vec!["payload".into(), sha256_hex(b"{}")]));
        // Identical requests in the same second still get distinct ids.
        let again = decode(&nip98_header(&keys, "https://hub.example/mcp", "post", b"{}").unwrap());
        assert!(tags.iter().any(|t| t[0] == "nonce"));
        assert_ne!(ev.id, again.id);
        // No payload tag for an empty body (the hub rejects one).
        let ev = decode(&nip98_header(&keys, "https://hub.example/x", "GET", b"").unwrap());
        assert!(ev.tags.iter().all(|t| t.clone().to_vec()[0] != "payload"));
    }

    #[test]
    fn hub_must_be_https() {
        let k = Keys::generate();
        let cfg = |hub: &str| VaultConfig {
            hub: hub.into(),
            vault: "v".into(),
        };
        assert!(VaultClient::new(cfg("http://uni-1.example"), k.clone()).is_err());
        assert!(VaultClient::new(cfg("http://127.0.0.1:1939"), k.clone()).is_ok());
        let c = VaultClient::new(cfg("https://uni-1.example/some/path"), k).unwrap();
        assert_eq!(c.origin, "https://uni-1.example");
    }

    #[test]
    fn tool_results_unwrap() {
        let rpc = json!({"result": {"content": [{"type": "text", "text": "{\"id\":\"n1\"}"}]}});
        assert_eq!(tool_result(&rpc).unwrap()["id"], "n1");
        let wrapped = json!({"result": {"content": [{"type": "text", "text": "{\"result\": \"{\\\"id\\\":\\\"n2\\\"}\"}"}]}});
        assert_eq!(tool_result(&wrapped).unwrap()["id"], "n2");
        let err = json!({"result": {"content": [{"type": "text", "text": "Error: nope"}], "isError": true}});
        assert!(tool_result(&err).is_err());
        assert!(tool_result(&json!({"error": {"message": "bad"}})).is_err());
    }

    #[test]
    fn notes_from_every_shape() {
        let n = json!({"id": "a", "path": "Notes/x", "content": "hi", "tags": ["capture"], "metadata": {"source": "voice"}, "createdAt": "t"});
        assert_eq!(notes_in(&json!([n.clone()])).len(), 1);
        assert_eq!(notes_in(&json!({"notes": [n.clone(), n.clone()]})).len(), 2);
        assert_eq!(
            notes_in(&json!({"results": [{"vault": "v", "notes": [n.clone()]}]})).len(),
            1
        );
        assert_eq!(
            notes_in(&json!({"results": [{"vault": "v", "notes": n.clone()}]})).len(),
            1
        );
        let j = JournalNote::from_value(&n).unwrap();
        assert_eq!((j.source.as_deref(), j.pending), (Some("voice"), false));
        let p =
            JournalNote::from_value(&json!({"id": "b", "content": TRANSCRIPT_PENDING})).unwrap();
        assert!(p.pending);
    }

    #[test]
    fn ticket_url_is_rerooted_and_checked() {
        let t = json!({"url": "http://127.0.0.1:1939/vault/unforced/tickets/abc123"});
        assert_eq!(
            ticket_url("https://hub.example", "unforced", &t).unwrap(),
            "https://hub.example/vault/unforced/tickets/abc123"
        );
        let other = json!({"url": "https://evil.example/vault/other/tickets/abc"});
        assert!(ticket_url("https://hub.example", "unforced", &other).is_err());
        let nested = json!({"url": "https://hub.example/vault/unforced/tickets/a/b"});
        assert!(ticket_url("https://hub.example", "unforced", &nested).is_err());
    }
}
