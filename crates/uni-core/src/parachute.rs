//! Parachute vault access with the user's Nostr key (NIP-98).
//!
//! The hub's root `/mcp` door accepts `Authorization: Nostr <base64url(event)>`
//! where the event is a kind-27235 NIP-98 event bound to this exact request
//! (`u` = absolute URL, `method`, `payload` = SHA-256 of the body). The hub
//! maps the signing pubkey to a hub user (`parachute auth link-pubkey`) and
//! answers as that user: the same key that signs Buzz messages writes the
//! vault. No token is stored on the device.
//!
//! Journal entries (T-60): path `Journal/YYYY/MM-DD/HH-MM <first words>`
//! (local time; voice entries start untitled), tag `journal` (whose parent tag
//! on uni-1 is `capture`, so older readers still see them), `metadata.source` =
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
        self.rpc(tool, arguments).await?
    }

    /// Like [`call`](Self::call), but separates transport/HTTP failures
    /// (outer `Err`: hub unreachable, auth) from the tool's own error
    /// (inner `Err`), so callers can retry only the latter.
    async fn rpc(&self, tool: &str, arguments: Value) -> Result<Result<Value>> {
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
        Ok(tool_result(&rpc))
    }

    /// Create a journal entry (text now, or a voice placeholder).
    pub async fn create_entry(&self, entry: &NewEntry) -> Result<JournalNote> {
        let mut args = json!({
            "vault": self.cfg.vault,
            "content": entry.content,
            "path": entry.path,
            "tags": ["journal"],
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
                    "tag": "journal",
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

    /// Hub origin this client signs requests for.
    pub fn origin(&self) -> &str {
        &self.origin
    }

    /// One note (by id or path) from any vault this key can read, with its
    /// links, in the vault's own `Note` JSON shape — what surface-render's
    /// `<NoteRenderer>` takes. `vault` may differ from the journal vault.
    pub async fn get_note(&self, vault: &str, note_ref: &str) -> Result<Value> {
        if !valid_vault_name(vault) {
            return Err(Error::Invalid(format!("bad vault name: {vault}")));
        }
        let r = note_ref.trim();
        if r.is_empty() || r.len() > 1024 {
            return Err(Error::Invalid(
                "note reference must be 1..1024 bytes".into(),
            ));
        }
        let v = self
            .call(
                "query-notes",
                json!({ "vault": vault, "id": r, "include_links": true }),
            )
            .await?;
        note_from(&v, r)
    }

    /// Discover readable vaults through the same signed fan-out door.
    pub async fn list_vaults(&self) -> Result<Vec<String>> {
        let v = self
            .call(
                "query-notes",
                json!({"limit": 1, "include_content": false, "include_metadata": false}),
            )
            .await?;
        let mut names = vault_names(&v)?;
        if names.is_empty() && valid_vault_name(&self.cfg.vault) {
            names.push(self.cfg.vault.clone());
        }
        Ok(names)
    }

    /// Bounded, paginated path index; never downloads note bodies.
    pub async fn list_paths(&self, vault: &str) -> Result<Vec<NotePath>> {
        check_vault(vault)?;
        let mut paths = Vec::new();
        for offset in (0..20_000).step_by(500) {
            let v = self
                .call(
                    "query-notes",
                    json!({"vault": vault, "include_content": false,
                "include_metadata": false, "limit": 500, "offset": offset, "sort": "asc"}),
                )
                .await?;
            check_vault_errors(&v)?;
            let page = notes_in(&v);
            let count = page.len();
            for n in page.into_iter().take(20_000 - paths.len()) {
                if let Ok(row) = serde_json::from_value::<NotePath>(n) {
                    if !row.id.trim().is_empty() {
                        paths.push(row);
                    }
                }
            }
            if count < 500 {
                break;
            }
        }
        Ok(paths)
    }

    pub async fn create_note(&self, vault: &str, path: &str, content: &str) -> Result<Value> {
        check_vault(vault)?;
        validate_note_path(path)?;
        let v = self
            .call(
                "create-note",
                json!({"vault": vault, "path": path, "content": content, "if_exists": "error"}),
            )
            .await?;
        check_vault_errors(&v)?;
        note_from(&v, path)
    }

    pub async fn save_note(
        &self,
        vault: &str,
        id: &str,
        content: &str,
        if_updated_at: Option<&str>,
        force: bool,
    ) -> Result<Value> {
        check_vault(vault)?;
        if id.trim().is_empty() {
            return Err(Error::Invalid("missing note id".into()));
        }
        let args = save_args(vault, id, content, if_updated_at, force)?;
        let v = self.rpc("update-note", args).await?.map_err(save_error)?;
        check_vault_errors(&v)?;
        note_from(&v, id)
    }

    /// Search notes by meaning (semantic `near_text`) across every vault this
    /// key can read, or one `vault`. Falls back to keyword full-text search
    /// when the hub or vault has no embedding provider. Read-only.
    pub async fn search_notes(
        &self,
        vault: Option<&str>,
        query: &str,
        limit: usize,
        mode: Option<&str>,
        path_prefix: Option<&str>,
    ) -> Result<Vec<NoteHit>> {
        let q = query.trim();
        if q.is_empty() || q.len() > 500 {
            return Err(Error::Invalid("search must be 1..500 bytes".into()));
        }
        if let Some(v) = vault {
            if !valid_vault_name(v) {
                return Err(Error::Invalid(format!("bad vault name: {v}")));
            }
        }
        let limit = limit.clamp(1, 50);
        let args = search_args(vault, q, limit, mode, path_prefix)?;
        if mode == Some("keyword") {
            let v = self.call("query-notes", args).await?;
            let hits = hits_from(&v, vault, "keyword", limit);
            if hits.is_empty() {
                check_vault_errors(&v)?;
            }
            return Ok(hits);
        }
        let semantic = args.clone();
        let mut args = args;
        args.as_object_mut().unwrap().remove("semantic");
        args.as_object_mut().unwrap().remove("near_text");
        // Transport/auth failures surface at once (no second 60 s wait).
        // A tool-level error means meaning search isn't available at all:
        // keyword-search everything instead.
        let v = match self.rpc("query-notes", semantic).await? {
            Ok(v) => v,
            Err(_) => {
                let mut kw = args.clone();
                kw["search"] = json!(q);
                let v = self.call("query-notes", kw).await?;
                let hits = hits_from(&v, vault, "keyword", limit);
                return match vault_errors(&v).into_iter().next() {
                    Some((name, e)) if hits.is_empty() => Err(Error::Vault(format!("{name}: {e}"))),
                    _ => Ok(hits),
                };
            }
        };
        let mut hits = hits_from(&v, vault, "meaning", limit);
        // Vaults that couldn't do meaning search (e.g. no embeddings) are
        // keyword-searched one by one and listed after the meaning hits:
        // the two score scales aren't comparable.
        let mut last_err = None;
        for (name, e) in vault_errors(&v) {
            let mut kw = args.clone();
            kw["vault"] = json!(name);
            kw["search"] = json!(q);
            match self.call("query-notes", kw).await {
                Ok(r) => match vault_errors(&r).into_iter().next() {
                    None => hits.extend(hits_from(&r, Some(&name), "keyword", limit)),
                    Some(err) => last_err = Some(err),
                },
                Err(err) => last_err = Some((name, format!("{err} ({e})"))),
            }
        }
        if hits.is_empty() {
            if let Some((name, e)) = last_err {
                return Err(Error::Vault(format!("{name}: {e}")));
            }
        }
        hits.truncate(limit);
        Ok(hits)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NotePath {
    pub id: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub extension: Option<String>,
    #[serde(rename = "updatedAt", default)]
    pub updated_at: Option<String>,
}

fn check_vault(vault: &str) -> Result<()> {
    if valid_vault_name(vault) {
        Ok(())
    } else {
        Err(Error::Invalid("bad vault name".into()))
    }
}

// ECMAScript trim whitespace, shared with the frontend's String.trim().
fn path_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub fn validate_note_path(path: &str) -> Result<()> {
    if path.trim_matches(path_whitespace).is_empty()
        || path.len() > 512
        || path.starts_with('/')
        || path
            .split('/')
            .any(|s| s == ".." || s == "." || s.is_empty() || s.trim_matches(path_whitespace) != s)
        || path.contains('\\')
        || path.chars().any(|c| c.is_ascii_control())
    {
        return Err(Error::Invalid(
            "path must be 1..512 bytes, relative, with no empty, dot or whitespace-padded segments, backslashes or ASCII controls".into(),
        ));
    }
    Ok(())
}

fn check_vault_errors(v: &Value) -> Result<()> {
    if let Some((name, error)) = vault_errors(v).into_iter().next() {
        return Err(Error::Vault(format!("{name}: {error}")));
    }
    Ok(())
}

fn vault_names(v: &Value) -> Result<Vec<String>> {
    let mut names: Vec<String> = v["vaults_queried"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|s| valid_vault_name(s))
        .map(str::to_string)
        .collect();
    names.extend(
        v["results"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|r| r.get("error").is_none())
            .filter_map(|r| r["vault"].as_str())
            .filter(|s| valid_vault_name(s))
            .map(str::to_string),
    );
    // A named error is not a readable vault, even if included in queried names.
    let errors = vault_errors(v);
    names.retain(|n| !errors.iter().any(|(failed, _)| failed == n));
    names.sort();
    names.dedup();
    if names.is_empty() {
        check_vault_errors(v)?;
    }
    Ok(names)
}

fn save_error(e: Error) -> Error {
    match e {
        Error::VaultTool {
            message,
            error_type,
        } if error_type.as_deref() == Some("conflict") || conflict_message(&message) => {
            Error::Conflict(message)
        }
        Error::Vault(message) if conflict_message(&message) => Error::Conflict(message),
        other => other,
    }
}

fn conflict_message(mut message: &str) -> bool {
    while let Some(text) = message.strip_prefix("MCP error -").and_then(|rest| {
        let (code, text) = rest.split_once(": ")?;
        (!code.is_empty() && code.bytes().all(|b| b.is_ascii_digit())).then_some(text)
    }) {
        message = text;
    }
    let message = message.strip_prefix("[conflict] ").unwrap_or(message);
    message.starts_with("conflict: note")
}

fn save_args(
    vault: &str,
    id: &str,
    content: &str,
    stamp: Option<&str>,
    force: bool,
) -> Result<Value> {
    let mut args = json!({"vault": vault, "id": id, "content": content});
    if force {
        args["force"] = json!(true);
    } else {
        let stamp = stamp
            .filter(|s| !s.is_empty())
            .ok_or_else(|| Error::Invalid("missing update timestamp; reload the note".into()))?;
        args["if_updated_at"] = json!(stamp);
    }
    Ok(args)
}

fn search_args(
    vault: Option<&str>,
    query: &str,
    limit: usize,
    mode: Option<&str>,
    prefix: Option<&str>,
) -> Result<Value> {
    let mut args = json!({"include_content": true, "content_length": 600, "include_metadata": false, "limit": limit.clamp(1, 50)});
    if let Some(v) = vault {
        args["vault"] = json!(v);
    }
    if let Some(p) = prefix.filter(|p| !p.is_empty()) {
        args["path_prefix"] = json!(p);
    }
    match mode.unwrap_or("meaning") {
        "keyword" => args["search"] = json!(query),
        "meaning" => {
            args["semantic"] = json!(true);
            args["near_text"] = json!(query);
        }
        _ => {
            return Err(Error::Invalid(
                "search mode must be meaning or keyword".into(),
            ))
        }
    }
    Ok(args)
}

/// One search result for the app's Notes section.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteHit {
    pub vault: String,
    pub id: String,
    pub path: String,
    pub snippet: String,
    pub score: Option<f64>,
    /// `"meaning"` (semantic) or `"keyword"` (full-text fallback).
    pub mode: String,
}

/// `(vault, error)` for each fan-out row (or a single response) that failed.
fn vault_errors(v: &Value) -> Vec<(String, String)> {
    let row = |r: &Value| {
        r.get("error").map(|e| {
            let msg = e
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| e.to_string());
            (r["vault"].as_str().unwrap_or("vault").to_string(), msg)
        })
    };
    match v["results"].as_array() {
        Some(rows) => rows.iter().filter_map(row).collect(),
        None => row(v).into_iter().collect(),
    }
}

/// Hits from a single-vault or fan-out query-notes response, best first.
fn hits_from(v: &Value, vault: Option<&str>, mode: &str, limit: usize) -> Vec<NoteHit> {
    let mut groups: Vec<(String, Value)> = Vec::new();
    if let Some(results) = v["results"].as_array() {
        for r in results {
            let name = r["vault"].as_str().unwrap_or_default().to_string();
            groups.push((name, r["notes"].clone()));
        }
    } else {
        groups.push((vault.unwrap_or_default().to_string(), v.clone()));
    }
    let per_vault: Vec<Vec<NoteHit>> = groups
        .into_iter()
        .map(|(name, notes)| {
            notes_in(&notes)
                .into_iter()
                .filter(|n| n["id"].is_string() && n.get("error").is_none())
                .map(move |n| NoteHit {
                    vault: name.clone(),
                    id: n["id"].as_str().unwrap_or_default().to_string(),
                    path: n["path"].as_str().unwrap_or_default().to_string(),
                    snippet: snippet(n["content"].as_str().unwrap_or_default()),
                    score: n["score"].as_f64(),
                    mode: mode.to_string(),
                })
                .collect()
        })
        .collect();
    if mode != "meaning" {
        // Keyword (bm25) scores are relative to each vault's own result set:
        // keep each vault's order and interleave them.
        let mut hits = Vec::new();
        let longest = per_vault.iter().map(Vec::len).max().unwrap_or(0);
        for i in 0..longest {
            hits.extend(per_vault.iter().filter_map(|g| g.get(i).cloned()));
        }
        hits.truncate(limit);
        return hits;
    }
    // Cosine similarity: comparable across vaults sharing an embedding model.
    let mut hits: Vec<NoteHit> = per_vault.into_iter().flatten().collect();
    hits.sort_by(|a, b| {
        b.score
            .unwrap_or(f64::MIN)
            .partial_cmp(&a.score.unwrap_or(f64::MIN))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    hits.truncate(limit);
    hits
}

/// First ~200 chars of prose, skipping front matter and heading markers.
fn snippet(content: &str) -> String {
    let content = content.replace("\r\n", "\n");
    // Front matter: drop it, even when the 600-byte slice cut it off.
    let body = match content.strip_prefix("---\n") {
        Some(r) => r.split_once("\n---\n").map(|(_, b)| b).unwrap_or(""),
        None => &content,
    };
    let flat: String = body
        .lines()
        .map(|l| l.trim_start_matches('#').trim())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let mut out: String = flat.chars().take(200).collect();
    if flat.chars().count() > 200 {
        out.push('…');
    }
    out
}

/// Vault names are `[A-Za-z0-9_-]+` (the hub's own rule).
pub fn valid_vault_name(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 64
        && v.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The single note in a query-notes-by-id response, or the vault's error.
fn note_from(v: &Value, r: &str) -> Result<Value> {
    let note = notes_in(v)
        .into_iter()
        .next()
        .ok_or_else(|| Error::Vault(format!("note not found: {r}")))?;
    if let Some(e) = note.get("error").and_then(Value::as_str) {
        let kind = note["error_type"].as_str().unwrap_or_default();
        return Err(Error::Vault(if kind == "not_found" {
            format!("note not found: {r}")
        } else {
            format!("{e}: {r}")
        }));
    }
    if !note["id"].is_string() {
        return Err(Error::Vault(format!("note not found: {r}")));
    }
    Ok(note)
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
        return Err(Error::VaultTool {
            message: msg.to_string(),
            error_type: err["data"]["error_type"].as_str().map(str::to_string),
        });
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

    #[test]
    fn search_hits_from_fanout_are_ranked_and_labelled() {
        let v = json!({"results": [
            {"vault": "uni", "notes": [
                {"id": "a", "path": "Projects/Tabs", "content": "---\nx: 1\n---\n# Tabs\nPlan body", "score": 0.4}
            ]},
            {"vault": "unforced", "notes": [
                {"id": "b", "path": "Notes/B", "content": "Better match", "score": 0.8},
                {"error": "semantic_unavailable"}
            ]}
        ]});
        let hits = hits_from(&v, None, "meaning", 10);
        assert_eq!(hits.len(), 2);
        assert_eq!(
            (hits[0].vault.as_str(), hits[0].id.as_str()),
            ("unforced", "b")
        );
        assert_eq!(hits[1].snippet, "Tabs Plan body");
        assert_eq!(hits[1].mode, "meaning");
        assert!(vault_errors(&v).is_empty());
        assert_eq!(
            vault_errors(
                &json!({"results": [{"vault": "x", "error": "no"}, {"vault": "y", "notes": []}]})
            ),
            vec![("x".to_string(), "no".to_string())]
        );
    }

    #[test]
    fn search_single_vault_and_long_snippet() {
        let long = "word ".repeat(100);
        let v = json!([{"id": "n", "path": "P", "content": long}]);
        let hits = hits_from(&v, Some("uni"), "keyword", 5);
        assert_eq!(hits[0].vault, "uni");
        assert_eq!(snippet("---\r\ntitle: x\r\n---\r\nBody"), "Body");
        assert_eq!(snippet("---\ntitle: cut off mid front"), "");
        let kw = json!({"results": [
            {"vault": "a", "notes": [{"id": "a1", "path": "", "content": "", "score": 1.0}, {"id": "a2", "path": "", "content": "", "score": 9.0}]},
            {"vault": "b", "notes": [{"id": "b1", "path": "", "content": "", "score": 5.0}]}
        ]});
        let ids: Vec<_> = hits_from(&kw, None, "keyword", 10)
            .into_iter()
            .map(|h| h.id)
            .collect();
        assert_eq!(ids, ["a1", "b1", "a2"]);
        assert!(hits[0].snippet.ends_with('…'));
        assert_eq!(hits[0].snippet.chars().count(), 201);
    }
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
        let n = json!({"id": "a", "path": "Journal/2026/10-06/12-00 hi", "content": "hi", "tags": ["journal"], "metadata": {"source": "voice"}, "createdAt": "t"});
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
    fn note_lookup_shapes() {
        let n = json!({"id": "01M3", "path": "System/Now", "content": "hi", "links": []});
        let fanout =
            json!({"vaults_queried": ["uni"], "results": [{"vault": "uni", "notes": n.clone()}]});
        assert_eq!(note_from(&fanout, "System/Now").unwrap()["id"], "01M3");
        assert_eq!(note_from(&n, "01M3").unwrap()["path"], "System/Now");
        let missing = json!({"results": [{"vault": "uni", "notes": {"error": "Note not found", "error_type": "not_found", "id": "X"}}]});
        let err = note_from(&missing, "X").unwrap_err().to_string();
        assert!(err.contains("note not found: X"), "{err}");
        assert!(note_from(&json!([]), "X").is_err());
        assert!(valid_vault_name("uni") && valid_vault_name("my-vault_2"));
        assert!(!valid_vault_name("") && !valid_vault_name("../x") && !valid_vault_name("a b"));
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

#[cfg(test)]
mod surface_tests {
    use super::*;

    #[test]
    fn search_modes_and_scope_arguments() {
        let meaning =
            search_args(Some("scope-test"), "hello", 100, None, Some("Projects/")).unwrap();
        assert_eq!(meaning["semantic"], true);
        assert_eq!(meaning["near_text"], "hello");
        assert_eq!(meaning["path_prefix"], "Projects/");
        assert_eq!(meaning["vault"], "scope-test");
        assert_eq!(meaning["limit"], 50);
        assert!(meaning.get("search").is_none());
        let keyword = search_args(None, "hello", 0, Some("keyword"), None).unwrap();
        assert_eq!(keyword["search"], "hello");
        assert_eq!(keyword["limit"], 1);
        for key in ["vault", "path_prefix", "semantic", "near_text"] {
            assert!(keyword.get(key).is_none());
        }
        assert!(search_args(None, "q", 1, Some("bad"), None).is_err());
    }

    #[test]
    fn save_concurrency_and_force_arguments() {
        let normal = save_args("scope-test", "id", "mine", Some("t1"), false).unwrap();
        assert_eq!(normal["if_updated_at"], "t1");
        assert!(normal.get("force").is_none());
        let forced = save_args("scope-test", "id", "mine", Some("stale"), true).unwrap();
        assert_eq!(forced["force"], true);
        assert!(forced.get("if_updated_at").is_none());
        assert!(save_args("scope-test", "id", "mine", None, false).is_err());
        for error in [
            "conflict: note \"n\" has been modified",
            "MCP error -32600: conflict: note n has been modified",
        ] {
            assert!(save_error(Error::Vault(error.into()))
                .to_string()
                .starts_with("conflict:"));
        }
        assert!(!save_error(Error::Vault("permission denied".into()))
            .to_string()
            .starts_with("conflict:"));
    }

    #[test]
    fn discovery_shapes_and_path_validation() {
        assert_eq!(
            vault_names(&json!({"vaults_queried": ["z", "a", "z"]})).unwrap(),
            ["a", "z"]
        );
        assert_eq!(vault_names(&json!({"vaults_queried": 2, "results": [{"vault": "ok", "notes": []}, {"vault": "denied", "error": "forbidden"}]})).unwrap(), ["ok"]);
        assert!(vault_names(&json!({"results": [{"vault": "bad", "error": "offline"}]})).is_err());
        for path in [
            "",
            "   ",
            "/root",
            "a/../b",
            "a//b",
            "a/",
            "a\0b",
            "a/./b",
            " a/b",
            "a/b ",
            "a/ b",
            "a\\b",
            "a\tb",
            "a\nb",
            "a\x7fb",
            "a/\u{00a0}b",
            "a/\u{feff}b",
        ] {
            assert!(validate_note_path(path).is_err(), "{path}");
        }
        assert!(validate_note_path(&"é".repeat(257)).is_err());
        assert!(validate_note_path(&"é".repeat(256)).is_ok());
        assert!(validate_note_path("Probe/surface").is_ok());
    }

    // A local scripted MCP door verifies the public client, not just helpers.
    fn server(
        script: Vec<(&'static str, Value, Value)>,
    ) -> (VaultClient, std::thread::JoinHandle<()>) {
        use std::io::{BufRead, Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let hub = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            for (tool, expected, result) in script {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                let mut length = 0;
                let mut signed = false;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                    let lower = line.to_lowercase();
                    if let Some(n) = lower.strip_prefix("content-length:") {
                        length = n.trim().parse().unwrap();
                    }
                    if lower.starts_with("authorization: nostr ") {
                        signed = true;
                    }
                }
                assert!(signed);
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                let body: Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(body["params"]["name"], tool);
                assert_eq!(body["params"]["arguments"], expected);
                let status = result["http_status"].as_u64().unwrap_or(200);
                let body = if result.get("jsonrpc").is_some() || status != 200 {
                    result.to_string()
                } else {
                    json!({"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": result.to_string()}]}}).to_string()
                };
                write!(stream, "HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            }
        });
        let client = VaultClient::new(
            VaultConfig {
                hub,
                vault: "scope-test".into(),
            },
            Keys::generate(),
        )
        .unwrap();
        (client, handle)
    }

    #[tokio::test]
    async fn path_pagination_and_named_fanout() {
        crate::init_crypto();
        let page: Vec<Value> = (0..500)
            .map(|i| json!({"id": i.to_string(), "path": format!("P/{i}"), "updatedAt": "t1"}))
            .collect();
        let args = |offset| json!({"vault": "scope-test", "include_content": false, "include_metadata": false, "limit": 500, "offset": offset, "sort": "asc"});
        let (client, handle) = server(vec![
            (
                "query-notes",
                args(0),
                json!({"results": [{"vault": "scope-test", "notes": page}]}),
            ),
            (
                "query-notes",
                args(500),
                json!({"results": [{"vault": "scope-test", "notes": [{"id": "last", "path": "P/last", "updatedAt": "t2"}]}]}),
            ),
        ]);
        let paths = client.list_paths("scope-test").await.unwrap();
        assert_eq!(paths.len(), 501);
        assert_eq!(paths[500].updated_at.as_deref(), Some("t2"));
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn nullable_paths_and_empty_discovery() {
        crate::init_crypto();
        let (client, handle) = server(vec![
            (
                "query-notes",
                json!({"vault":"scope-test","include_content":false,"include_metadata":false,"limit":500,"offset":0,"sort":"asc"}),
                json!({"notes":[{"id":"x","path":null},{"id":"y"},{"path":"bad"},{"id":"z","path":"P/z","extension":"txt"}]}),
            ),
            (
                "query-notes",
                json!({"limit":1,"include_content":false,"include_metadata":false}),
                json!({"results":[]}),
            ),
        ]);
        let paths = client.list_paths("scope-test").await.unwrap();
        assert_eq!(paths.len(), 3);
        assert_eq!(paths[0].path, None);
        assert_eq!(paths[1].path, None);
        assert_eq!(paths[2].extension.as_deref(), Some("txt"));
        assert_eq!(client.list_vaults().await.unwrap(), ["scope-test"]);
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn save_errors_only_classify_actual_tool_conflicts() {
        crate::init_crypto();
        let args = save_args("scope-test", "n", "edit", Some("t1"), false).unwrap();
        let errors = vec![
            json!({"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"precondition_required: provide if_updated_at","data":{"error_type":"precondition_required"}}}),
            json!({"http_status":409,"error":"conflict: note n has been modified", "data":{"error_type":"conflict"}}),
            json!({"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"permission denied","data":{"error_type":"permission_denied"}}}),
            json!({"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"MCP error -32600: [transition_conflict] conflict: note …","data":{"error_type":"vault_error","vault":"scope-test","code":-32600}}}),
            json!({"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"MCP error -32602: [precondition_required] precondition required: …","data":{"error_type":"vault_error","vault":"scope-test","code":-32602}}}),
        ];
        let error_count = errors.len();
        for result in &errors {
            assert!(!matches!(
                save_error(tool_result(result).unwrap_err()),
                Error::Conflict(_)
            ));
        }
        let (client, handle) = server(
            errors
                .into_iter()
                .map(|e| ("update-note", args.clone(), e))
                .collect(),
        );
        for _ in 0..error_count {
            let error = client
                .save_note("scope-test", "n", "edit", Some("t1"), false)
                .await
                .unwrap_err();
            assert!(!matches!(error, Error::Conflict(_)), "{error}");
        }
        handle.join().unwrap();
        let live_error = json!({"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"MCP error -32600: [conflict] conflict: note \"01M…\" has been modified (current updated_at=…, expected=…)","data":{"error_type":"vault_error","vault":"scope-test","code":-32600}}});
        let error = tool_result(&live_error).unwrap_err();
        assert!(matches!(
            &error,
            Error::VaultTool { error_type: Some(kind), .. } if kind == "vault_error"
        ));
        assert!(matches!(save_error(error), Error::Conflict(_)));
        let (client, handle) = server(vec![("update-note", args, live_error)]);
        let error = client
            .save_note("scope-test", "n", "edit", Some("t1"), false)
            .await
            .unwrap_err();
        assert!(matches!(error, Error::Conflict(_)), "{error}");
        handle.join().unwrap();
        for message in [
            "conflict: note n has been modified",
            "MCP error -32600: conflict: note n has been modified",
            "[conflict] conflict: note n has been modified",
            "MCP error -32600: [conflict] conflict: note n has been modified",
            "MCP error -32602: MCP error -32600: [conflict] conflict: note n has been modified",
        ] {
            let result =
                json!({"result":{"isError":true,"content":[{"type":"text","text":message}]}});
            assert!(matches!(
                save_error(tool_result(&result).unwrap_err()),
                Error::Conflict(_)
            ));
        }
        for message in [
            "if_updated_at required",
            "permission denied",
            "unrelated conflict",
            "MCP error -oops: conflict: note n",
            "MCP error -: conflict: note n",
            "MCP error -32602: MCP error -oops: conflict: note n",
            "MCP error -32600: [transition_conflict] conflict: note …",
            "MCP error -32602: [precondition_required] precondition required: …",
            "[permission_denied] conflict: note n",
            "[conflict] permission denied",
        ] {
            assert!(!matches!(
                save_error(Error::Vault(message.into())),
                Error::Conflict(_)
            ));
        }
    }

    #[tokio::test]
    async fn path_cap_and_mutation_contract() {
        crate::init_crypto();
        let page: Vec<Value> = (0..500)
            .map(|i| json!({"id": i.to_string(), "path": format!("P/{i}")}))
            .collect();
        let script = (0..40).map(|i| (
            "query-notes",
            json!({"vault": "scope-test", "include_content": false, "include_metadata": false, "limit": 500, "offset": i * 500, "sort": "asc"}),
            json!({"notes": page}),
        )).collect();
        let (client, handle) = server(script);
        assert_eq!(client.list_paths("scope-test").await.unwrap().len(), 20_000);
        handle.join().unwrap();

        let note = json!({"id": "n", "path": "Probe/n", "content": "initial", "updatedAt": "t1"});
        let (client, handle) = server(vec![
            (
                "create-note",
                json!({"vault": "scope-test", "path": "Probe/n", "content": "initial", "if_exists": "error"}),
                note.clone(),
            ),
            (
                "update-note",
                save_args("scope-test", "n", "edit", Some("t1"), false).unwrap(),
                json!({"jsonrpc":"2.0", "id":1, "error":{"code":-32600,"message":"MCP error -32600: conflict: note n has been modified", "data":{"error_type":"conflict"}}}),
            ),
            (
                "update-note",
                save_args("scope-test", "n", "edit", None, true).unwrap(),
                json!({"id": "n", "path": "Probe/n", "content": "edit", "updatedAt": "t2"}),
            ),
        ]);
        assert_eq!(
            client
                .create_note("scope-test", "Probe/n", "initial")
                .await
                .unwrap(),
            note
        );
        assert!(client
            .save_note("scope-test", "n", "edit", Some("t1"), false)
            .await
            .unwrap_err()
            .to_string()
            .starts_with("conflict:"));
        assert_eq!(
            client
                .save_note("scope-test", "n", "edit", None, true)
                .await
                .unwrap()["updatedAt"],
            "t2"
        );
        // Invalid paths and vault names must fail before any network request.
        assert!(client
            .create_note("scope-test", "../bad", "")
            .await
            .is_err());
        assert!(client.list_paths("../bad").await.is_err());
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn keyword_skips_semantic_and_meaning_fallback_keeps_prefix() {
        crate::init_crypto();
        let kw = search_args(Some("scope-test"), "hi", 5, Some("keyword"), Some("P/")).unwrap();
        let meaning = search_args(Some("scope-test"), "hi", 5, None, Some("P/")).unwrap();
        let result = json!({"results": [{"vault": "scope-test", "notes": [{"id": "n", "path": "P/n", "content": "hello"}]}]});
        let (client, handle) = server(vec![
            ("query-notes", kw.clone(), result.clone()),
            (
                "query-notes",
                meaning,
                json!({"results": [{"vault": "scope-test", "error": "semantic_unavailable"}]}),
            ),
            ("query-notes", kw, result),
        ]);
        assert_eq!(
            client
                .search_notes(Some("scope-test"), "hi", 5, Some("keyword"), Some("P/"))
                .await
                .unwrap()[0]
                .mode,
            "keyword"
        );
        assert_eq!(
            client
                .search_notes(Some("scope-test"), "hi", 5, None, Some("P/"))
                .await
                .unwrap()[0]
                .mode,
            "keyword"
        );
        handle.join().unwrap();
    }
}
