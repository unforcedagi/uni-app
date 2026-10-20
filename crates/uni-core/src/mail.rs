//! Read-only mail (T-45) through the mail bridge on the hub's host.
//!
//! The bridge (`uni-mail-bridge`, tailnet port 8452) holds the mail
//! credentials; the app never does. Each request is NIP-98 signed by the
//! user's key, and the bridge answers only allowlisted pubkeys and only
//! read-only JMAP methods (`Mailbox/*`, `Email/get|query|changes`, …). Two
//! endpoints: `POST /mail/jmap {calls}` → JMAP `methodResponses`, and
//! `POST /mail/raw {blobId}` → the blob's bytes (a message or an attachment).
//!
//! Nothing here writes: no send, no flag change, no delete. Opening a message
//! does not mark it read.
//!
//! Message HTML is sanitized here ([`sanitize_html`]) so the webview never
//! sees the sender's markup: no scripts, no forms, no remote images (they are
//! counted and dropped), no CSS that can load a URL.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use nostr::Keys;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub mod attachment;
pub use attachment::{open_attachment, openable_extension};

/// Port the mail bridge listens on, on the hub's host (Tailscale Serve).
pub const MAIL_PORT: u16 = 8452;
/// Override for the bridge origin (a scratch or fake bridge). Never set in a shipped install.
pub const MAIL_URL_ENV: &str = "UNI_MAIL_URL";
/// Messages per page of a mailbox.
pub const PAGE_SIZE: u64 = 50;
/// The bridge's own cap on a blob (`MAX_RAW`).
pub const MAX_BLOB_BYTES: usize = 30 * 1024 * 1024;
/// Longest body part fetched; JMAP marks a longer one truncated.
const MAX_BODY_VALUE_BYTES: u64 = 1_000_000;
const JMAP_TIMEOUT: Duration = Duration::from_secs(45);
const RAW_TIMEOUT: Duration = Duration::from_secs(120);

/// Why a mail request failed, in the shape the UI shows.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MailError {
    /// The bridge could not be reached (it is down, or this device is off the tailnet).
    Unreachable { message: String },
    /// The bridge answered but does not allow this device's key.
    NotAllowed { message: String, pubkey: String },
    /// The bridge refused the request for another reason (bad signature, clock skew, bad input).
    Refused { status: u16, message: String },
    /// The mail server behind the bridge failed, or JMAP returned a method error.
    Server { message: String },
    /// Bad input, or an answer this client can't read.
    Invalid { message: String },
}

impl std::fmt::Display for MailError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MailError::Unreachable { message } => write!(f, "mail bridge unreachable: {message}"),
            MailError::NotAllowed { message, pubkey } => write!(f, "mail bridge does not allow key {pubkey}: {message}"),
            MailError::Refused { status, message } => write!(f, "mail bridge refused ({status}): {message}"),
            MailError::Server { message } => write!(f, "mail server: {message}"),
            MailError::Invalid { message } => write!(f, "mail: {message}"),
        }
    }
}

impl std::error::Error for MailError {}

pub type MailResult<T> = std::result::Result<T, MailError>;

fn invalid(message: impl Into<String>) -> MailError {
    MailError::Invalid { message: message.into() }
}

/// The bridge origin on the hub's host: same scheme and host, port
/// [`MAIL_PORT`]. `None` for a hub that fails [`crate::hub::checked_origin`].
pub fn mail_url(hub: &str) -> Option<String> {
    crate::hub::service_origin(hub, MAIL_PORT)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Mailbox {
    pub id: String,
    pub name: String,
    /// JMAP role (`inbox`, `sent`, `junk`, …), if any.
    pub role: Option<String>,
    pub parent_id: Option<String>,
    pub total: u64,
    pub unread: u64,
}

/// What the account holds: which address the bridge reads, and its mailboxes (Inbox first).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MailAccount {
    pub account: String,
    pub mailboxes: Vec<Mailbox>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Address {
    pub name: Option<String>,
    pub email: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MessageSummary {
    pub id: String,
    pub thread_id: Option<String>,
    pub from: Vec<Address>,
    pub subject: String,
    pub preview: String,
    /// RFC 3339, as the server gives it.
    pub received_at: String,
    pub unread: bool,
    pub has_attachment: bool,
}

/// One page of a mailbox, newest first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MessagePage {
    pub account: String,
    pub mailbox: String,
    pub position: u64,
    pub total: Option<u64>,
    pub messages: Vec<MessageSummary>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Attachment {
    pub blob_id: String,
    pub name: Option<String>,
    pub mime: String,
    pub size: u64,
    /// Inline part (`Content-ID`), referenced from the HTML as `cid:`.
    pub cid: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Link {
    pub url: String,
    /// The link's own text, if it has any.
    pub text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub thread_id: Option<String>,
    pub from: Vec<Address>,
    pub to: Vec<Address>,
    pub cc: Vec<Address>,
    pub reply_to: Vec<Address>,
    pub subject: String,
    pub received_at: String,
    pub sent_at: Option<String>,
    pub unread: bool,
    /// The plain-text body, when the message has one.
    pub text: Option<String>,
    /// The HTML body, already sanitized ([`sanitize_html`]).
    pub html: Option<String>,
    /// Remote images dropped from the HTML.
    pub remote_images: usize,
    /// The HTML's web links (the reading frame runs no script, so they can't be clicked there).
    pub links: Vec<Link>,
    /// A body part was longer than this client fetches.
    pub truncated: bool,
    pub attachments: Vec<Attachment>,
}

/// A client for one bridge origin, signing as `keys`.
pub struct MailBridge<'a> {
    base: String,
    /// The origin the NIP-98 `u` tag names: the bridge's public URL (normally `base`).
    public: String,
    /// The bridge under the hub's other name (T-137), tried once when `base` can't be reached at all.
    alias: Option<String>,
    keys: &'a Keys,
}

impl<'a> MailBridge<'a> {
    /// `base` is the bridge origin (e.g. `https://uni-1.example.ts.net:8452`);
    /// https, or http only on this device.
    pub fn new(base: &str, keys: &'a Keys) -> MailResult<Self> {
        let base = crate::hub::checked_origin(base).map_err(|e| invalid(e.to_string()))?;
        Ok(Self { public: base.clone(), base, alias: None, keys })
    }

    /// Also try `alias` (the bridge under the hub's other name) when `base`
    /// can't be reached at all; an answer, even an error, is never retried.
    /// An alias that fails [`crate::hub::checked_origin`] is dropped.
    pub fn with_alias(mut self, alias: Option<&str>) -> Self {
        self.alias = alias.and_then(|a| crate::hub::checked_origin(a).ok());
        self
    }

    /// Sign for `public` while connecting to `base`: the bridge checks `u`
    /// against its public URL, so a call over loopback on the bridge's own
    /// host (ops, a check while the tailnet port is unmapped) signs as that.
    pub fn signing_as(mut self, public: &str) -> MailResult<Self> {
        self.public = url::Url::parse(public.trim()).map_err(|e| invalid(e.to_string()))?.origin().ascii_serialization();
        Ok(self)
    }

    /// One signed POST; the body on 200, a [`MailError`] otherwise. When the
    /// bridge's host can't be reached at all, the alias is tried once.
    async fn post(&self, path: &str, body: &Value, timeout: Duration, max: usize) -> MailResult<Vec<u8>> {
        crate::init_crypto();
        let body = serde_json::to_vec(body).map_err(|e| invalid(e.to_string()))?;
        let client = crate::media::http_client_with_timeout(timeout).map_err(|e| invalid(e.to_string()))?;
        match self.post_to(&client, &self.base, &self.public, path, &body, max).await {
            Err((true, e)) => match &self.alias {
                Some(alias) => self.post_to(&client, alias, alias, path, &body, max).await.map_err(|(_, e2)| if matches!(e2, MailError::Unreachable { .. }) { e } else { e2 }),
                None => Err(e),
            },
            r => r.map_err(|(_, e)| e),
        }
    }

    /// POST to `base`, signed for `public`; the error says whether the host was unreachable.
    async fn post_to(&self, client: &reqwest::Client, base: &str, public: &str, path: &str, body: &[u8], max: usize) -> std::result::Result<Vec<u8>, (bool, MailError)> {
        let url = format!("{base}{path}");
        let auth = crate::parachute::nip98_header(self.keys, &format!("{public}{path}"), "POST", body).map_err(|e| (false, invalid(e.to_string())))?;
        let response = client
            .post(&url)
            .header("Authorization", auth)
            .header("Content-Type", "application/json")
            .body(body.to_vec())
            .send()
            .await
            .map_err(|e| {
                let message = if e.is_timeout() { "the mail bridge did not answer in time".into() } else { format!("{base} is not answering (tailnet only): {e}") };
                (crate::hub::is_connect_failure(&e), MailError::Unreachable { message })
            })?;
        let status = response.status();
        if status.is_success() {
            if response.content_length().is_some_and(|n| n as usize > max) {
                return Err((false, invalid("larger than this app reads")));
            }
            let bytes = response.bytes().await.map_err(|e| (false, MailError::Unreachable { message: format!("the answer was cut off: {e}") }))?;
            if bytes.len() > max {
                return Err((false, invalid("larger than this app reads")));
            }
            return Ok(bytes.to_vec());
        }
        let text = response.text().await.unwrap_or_default();
        let message = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_else(|| text.chars().take(300).collect());
        Err((false, match status.as_u16() {
            401 if message.contains("not allowed") => MailError::NotAllowed { message, pubkey: self.keys.public_key().to_hex() },
            502..=504 => MailError::Server { message },
            s => MailError::Refused { status: s, message },
        }))
    }

    /// Run JMAP method calls; the account the bridge reads, and the responses by call id.
    async fn jmap(&self, calls: Value) -> MailResult<(String, HashMap<String, Value>)> {
        let raw = self.post("/mail/jmap", &json!({ "calls": calls }), JMAP_TIMEOUT, 64 * 1024 * 1024).await?;
        let v: Value = serde_json::from_slice(&raw).map_err(|e| invalid(format!("bad bridge answer: {e}")))?;
        let account = v.get("account").and_then(Value::as_str).unwrap_or_default().to_string();
        let mut out = HashMap::new();
        for r in v.get("methodResponses").and_then(Value::as_array).into_iter().flatten() {
            let (Some(name), Some(args), Some(id)) = (r.get(0).and_then(Value::as_str), r.get(1), r.get(2).and_then(Value::as_str)) else {
                continue;
            };
            if name == "error" {
                let kind = args.get("type").and_then(Value::as_str).unwrap_or("error");
                let detail = args.get("description").and_then(Value::as_str).unwrap_or("");
                return Err(MailError::Server { message: format!("{kind} {detail}").trim().to_string() });
            }
            out.insert(id.to_string(), args.clone());
        }
        Ok((account, out))
    }

    /// The account's address and its mailboxes, Inbox first.
    pub async fn mailboxes(&self) -> MailResult<MailAccount> {
        let calls = json!([["Mailbox/get", {
            "ids": null,
            "properties": ["id", "name", "parentId", "role", "sortOrder", "totalEmails", "unreadEmails"]
        }, "m"]]);
        let (account, r) = self.jmap(calls).await?;
        let list = r.get("m").and_then(|m| m.get("list")).and_then(Value::as_array).ok_or_else(|| invalid("no mailbox list in the answer"))?;
        let mut boxes: Vec<(u64, Mailbox)> = list
            .iter()
            .filter_map(|b| {
                Some((
                    b.get("sortOrder").and_then(Value::as_u64).unwrap_or(0),
                    Mailbox {
                        id: b.get("id")?.as_str()?.to_string(),
                        name: b.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                        role: b.get("role").and_then(Value::as_str).map(str::to_string),
                        parent_id: b.get("parentId").and_then(Value::as_str).map(str::to_string),
                        total: b.get("totalEmails").and_then(Value::as_u64).unwrap_or(0),
                        unread: b.get("unreadEmails").and_then(Value::as_u64).unwrap_or(0),
                    },
                ))
            })
            .collect();
        boxes.sort_by(|(sa, a), (sb, b)| role_rank(a).cmp(&role_rank(b)).then(sa.cmp(sb)).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(MailAccount { account, mailboxes: boxes.into_iter().map(|(_, b)| b).collect() })
    }

    /// One page of `mailbox`, newest first, starting at `position`.
    pub async fn messages(&self, mailbox: &str, position: u64, limit: u64) -> MailResult<MessagePage> {
        check_id(mailbox)?;
        let limit = limit.clamp(1, 100);
        let calls = json!([
            ["Email/query", {
                "filter": { "inMailbox": mailbox },
                "sort": [{ "property": "receivedAt", "isAscending": false }],
                "position": position,
                "limit": limit,
                "calculateTotal": true
            }, "q"],
            ["Email/get", {
                "#ids": { "resultOf": "q", "name": "Email/query", "path": "/ids" },
                "properties": ["id", "threadId", "keywords", "from", "subject", "preview", "receivedAt", "hasAttachment"]
            }, "g"]
        ]);
        let (account, r) = self.jmap(calls).await?;
        let q = r.get("q").ok_or_else(|| invalid("no query answer"))?;
        let ids: Vec<&str> = q.get("ids").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
        let got: HashMap<&str, &Value> = r
            .get("g")
            .and_then(|g| g.get("list"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|e| Some((e.get("id")?.as_str()?, e)))
            .collect();
        // Email/get may answer in any order; the query's order is newest first
        let messages = ids.iter().filter_map(|id| got.get(id)).map(|e| summary(e)).collect();
        Ok(MessagePage {
            account,
            mailbox: mailbox.to_string(),
            position: q.get("position").and_then(Value::as_u64).unwrap_or(position),
            total: q.get("total").and_then(Value::as_u64),
            messages,
        })
    }

    /// One message: headers, the plain-text body, the sanitized HTML body, attachments.
    pub async fn message(&self, id: &str) -> MailResult<Message> {
        check_id(id)?;
        let calls = json!([["Email/get", {
            "ids": [id],
            "properties": ["id", "threadId", "keywords", "from", "to", "cc", "replyTo", "subject", "receivedAt", "sentAt",
                           "textBody", "htmlBody", "attachments", "bodyValues"],
            "fetchTextBodyValues": true,
            "fetchHTMLBodyValues": true,
            "maxBodyValueBytes": MAX_BODY_VALUE_BYTES
        }, "g"]]);
        let (_, r) = self.jmap(calls).await?;
        let e = r
            .get("g")
            .and_then(|g| g.get("list"))
            .and_then(Value::as_array)
            .and_then(|l| l.first())
            .ok_or_else(|| invalid("that message is no longer in the mailbox"))?;
        Ok(message(e))
    }

    /// The bytes of a blob (an attachment, or a whole message).
    pub async fn blob(&self, blob_id: &str) -> MailResult<Vec<u8>> {
        check_id(blob_id)?;
        self.post("/mail/raw", &json!({ "blobId": blob_id }), RAW_TIMEOUT, MAX_BLOB_BYTES).await
    }
}

/// JMAP ids are `[A-Za-z0-9_-]`; anything else never leaves the device.
fn check_id(id: &str) -> MailResult<()> {
    if id.is_empty() || id.len() > 255 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return Err(invalid("bad mail id"));
    }
    Ok(())
}

fn role_rank(b: &Mailbox) -> u8 {
    match b.role.as_deref() {
        Some("inbox") => 0,
        Some("drafts") => 2,
        Some("sent") => 3,
        Some("archive") => 4,
        Some("junk") => 5,
        Some("trash") => 6,
        _ => 1,
    }
}

fn addresses(v: Option<&Value>) -> Vec<Address> {
    v.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|a| {
            Some(Address {
                name: a.get("name").and_then(Value::as_str).filter(|n| !n.trim().is_empty()).map(str::to_string),
                email: a.get("email")?.as_str()?.to_string(),
            })
        })
        .collect()
}

fn unread(e: &Value) -> bool {
    !e.get("keywords").and_then(|k| k.get("$seen")).and_then(Value::as_bool).unwrap_or(false)
}

fn text_of(e: &Value, key: &str) -> String {
    e.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

fn summary(e: &Value) -> MessageSummary {
    MessageSummary {
        id: text_of(e, "id"),
        thread_id: e.get("threadId").and_then(Value::as_str).map(str::to_string),
        from: addresses(e.get("from")),
        subject: text_of(e, "subject"),
        preview: text_of(e, "preview"),
        received_at: text_of(e, "receivedAt"),
        unread: unread(e),
        has_attachment: e.get("hasAttachment").and_then(Value::as_bool).unwrap_or(false),
    }
}

/// The body parts of `list` that are `mime`, joined; and whether any was truncated.
fn body(e: &Value, list: &str, mime: &str) -> (Option<String>, bool) {
    let values = e.get("bodyValues");
    let mut out: Vec<&str> = Vec::new();
    let mut truncated = false;
    for part in e.get(list).and_then(Value::as_array).into_iter().flatten() {
        if part.get("type").and_then(Value::as_str).map(|t| t.eq_ignore_ascii_case(mime)) != Some(true) {
            continue;
        }
        let Some(v) = part.get("partId").and_then(Value::as_str).and_then(|p| values?.get(p)) else { continue };
        truncated |= v.get("isTruncated").and_then(Value::as_bool).unwrap_or(false);
        if let Some(s) = v.get("value").and_then(Value::as_str) {
            out.push(s);
        }
    }
    let joined = out.join("\n\n");
    ((!joined.trim().is_empty()).then_some(joined), truncated)
}

fn message(e: &Value) -> Message {
    let (text, t1) = body(e, "textBody", "text/plain");
    let (html, t2) = body(e, "htmlBody", "text/html");
    let (html, remote_images) = match html {
        Some(h) => {
            let (clean, n) = sanitize_html(&h);
            (Some(clean), n)
        }
        None => (None, 0),
    };
    let links = html.as_deref().map(html_links).unwrap_or_default();
    let attachments = e
        .get("attachments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|a| {
            Some(Attachment {
                blob_id: a.get("blobId")?.as_str()?.to_string(),
                name: a.get("name").and_then(Value::as_str).filter(|n| !n.is_empty()).map(str::to_string),
                mime: a.get("type").and_then(Value::as_str).unwrap_or("application/octet-stream").to_string(),
                size: a.get("size").and_then(Value::as_u64).unwrap_or(0),
                cid: a.get("cid").and_then(Value::as_str).map(str::to_string),
            })
        })
        .collect();
    Message {
        id: text_of(e, "id"),
        thread_id: e.get("threadId").and_then(Value::as_str).map(str::to_string),
        from: addresses(e.get("from")),
        to: addresses(e.get("to")),
        cc: addresses(e.get("cc")),
        reply_to: addresses(e.get("replyTo")),
        subject: text_of(e, "subject"),
        received_at: text_of(e, "receivedAt"),
        sent_at: e.get("sentAt").and_then(Value::as_str).map(str::to_string),
        unread: unread(e),
        text,
        html,
        remote_images,
        links,
        truncated: t1 || t2,
        attachments,
    }
}

/// CSS properties kept in `style` attributes: layout and type only, none that take a URL.
const STYLE_PROPERTIES: &[&str] = &[
    "color", "background-color", "font", "font-family", "font-size", "font-style", "font-weight", "line-height",
    "text-align", "text-decoration", "text-transform", "letter-spacing", "white-space", "vertical-align",
    "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
    "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
    "border", "border-top", "border-right", "border-bottom", "border-left", "border-color", "border-style",
    "border-width", "border-radius", "border-collapse", "border-spacing",
    "width", "max-width", "min-width", "height", "max-height", "min-height", "display", "direction",
];

/// Sanitize a message's HTML for the reading pane; returns it with the
/// number of remote images dropped. Scripts, forms, frames, `<style>` and
/// event handlers go; links keep only http(s)/mailto; images keep only
/// inline raster `data:image/…` (remote, `cid:` and SVG sources are removed,
/// remote ones counted). The webview renders the result in a sandboxed, script-less
/// frame whose CSP also refuses remote loads, so this is the first of two walls.
pub fn sanitize_html(html: &str) -> (String, usize) {
    let remote = Arc::new(AtomicUsize::new(0));
    let seen = remote.clone();
    let style: HashSet<&str> = STYLE_PROPERTIES.iter().copied().collect();
    let clean = ammonia::Builder::default()
        .add_tags(["font", "tfoot"])
        .add_generic_attributes(["style", "align", "valign", "bgcolor", "width", "height", "dir"])
        .add_tag_attributes("font", ["color", "size", "face"])
        .add_tag_attributes("table", ["border", "cellpadding", "cellspacing"])
        .add_tag_attributes("td", ["nowrap"])
        .filter_style_properties(style)
        .url_schemes(["http", "https", "mailto", "data"].into_iter().collect())
        // relative URLs reach the filter (Deny would drop `//host/x` images before they are counted); every
        // image that isn't inline data is dropped there, and a relative link resolves inside the sealed frame
        .url_relative(ammonia::UrlRelative::PassThrough)
        .attribute_filter(move |element, attribute, value| match (element, attribute) {
            ("img", "src") => {
                let v = value.trim();
                let lower = v.get(..16).unwrap_or(v).to_ascii_lowercase();
                if lower.starts_with("data:image/") && !lower.starts_with("data:image/svg") {
                    Some(Cow::Borrowed(value))
                } else {
                    if lower.starts_with("http") || lower.starts_with("//") {
                        seen.fetch_add(1, Ordering::Relaxed);
                    }
                    None
                }
            }
            (_, "href") if value.trim().to_ascii_lowercase().starts_with("data:") => None,
            _ => Some(Cow::Borrowed(value)),
        })
        .clean(html)
        .to_string();
    (clean, remote.load(Ordering::Relaxed))
}

/// A file name safe to write in a cache folder: letters, digits, `.`, `-`,
/// `_` and spaces; no leading dot; at most 100 characters.
pub fn safe_file_name(name: Option<&str>) -> String {
    let cleaned: String = name
        .unwrap_or("")
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') { c } else { '_' })
        .collect();
    let trimmed = cleaned.trim().trim_start_matches('.').trim();
    let mut out: String = trimmed.chars().rev().take(100).collect::<Vec<_>>().into_iter().rev().collect();
    if out.is_empty() || out.chars().all(|c| c == '.' || c == '_') {
        out = "attachment".into();
    }
    out
}

/// Most links listed for one message.
const MAX_LINKS: usize = 40;

/// The web links of sanitized HTML ([`sanitize_html`]'s output: well-formed,
/// attributes double-quoted), with each link's text; http(s) only, first of
/// each URL kept, at most [`MAX_LINKS`].
pub fn html_links(html: &str) -> Vec<Link> {
    let mut out: Vec<Link> = Vec::new();
    let mut rest = html;
    while let Some(at) = rest.find("<a ") {
        rest = &rest[at + 3..];
        let Some(tag_end) = rest.find('>') else { break };
        let tag = &rest[..tag_end];
        let body_end = rest.find("</a>").unwrap_or(rest.len());
        let inner = if body_end > tag_end { &rest[tag_end + 1..body_end] } else { "" };
        let Some(href) = tag.split("href=\"").nth(1).and_then(|h| h.split('"').next()) else { continue };
        let url = unescape(href);
        let lower = url.to_ascii_lowercase();
        if !(lower.starts_with("https://") || lower.starts_with("http://")) || out.iter().any(|l| l.url == url) {
            continue;
        }
        let text = unescape(&strip_tags(inner)).split_whitespace().collect::<Vec<_>>().join(" ");
        let text: String = text.chars().take(80).collect();
        out.push(Link { url, text: (!text.is_empty()).then_some(text) });
        if out.len() >= MAX_LINKS {
            break;
        }
    }
    out
}

fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&nbsp;", " ").replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bridge_sits_on_the_hub_host() {
        assert_eq!(mail_url("https://uni-1.example.ts.net").as_deref(), Some("https://uni-1.example.ts.net:8452"));
        assert_eq!(mail_url("https://uni.example.ts.net/x?y").as_deref(), Some("https://uni.example.ts.net:8452"));
        assert_eq!(mail_url("http://uni-1.example.ts.net"), None, "never plain http to another machine");
        assert_eq!(mail_url("http://127.0.0.1:1939").as_deref(), Some("http://127.0.0.1:8452"));
    }

    #[test]
    fn sanitizing_drops_scripts_handlers_and_remote_images() {
        let (out, remote) = sanitize_html(concat!(
            r#"<p onclick="evil()" style="color:red;background:url(https://t.example/x.gif)">Hi</p>"#,
            r#"<script>alert(1)</script><style>body{background:url(https://t.example/b)}</style>"#,
            r#"<img src="https://t.example/pixel.gif" width=1><img src="//t.example/p2"><img src="cid:logo@x">"#,
            r#"<img src="data:image/png;base64,iVBORw0KGgo=" alt="ok"><img src="data:image/svg+xml,<svg/>">"#,
            r#"<a href="javascript:alert(1)">j</a><a href="data:text/html,x">d</a><a href="https://ok.example/">ok</a>"#,
            r#"<form action="https://x"><input name=a></form><iframe src="https://x"></iframe>"#,
        ));
        for bad in ["onclick", "script", "alert", "<style", "t.example", "cid:", "svg", "javascript", "data:text", "<form", "<input", "<iframe", "url("] {
            assert!(!out.contains(bad), "{bad} survived: {out}");
        }
        assert!(out.contains(r#"style="color:red""#), "{out}");
        assert!(out.contains("data:image/png;base64"), "{out}");
        assert!(out.contains(r#"href="https://ok.example/""#), "{out}");
        assert_eq!(remote, 2, "only the two remote images are counted");
    }

    #[test]
    fn file_names_cannot_escape_the_folder() {
        assert_eq!(safe_file_name(Some("../../etc/passwd")), "_.._etc_passwd");
        assert_eq!(safe_file_name(Some(".bashrc")), "bashrc");
        assert_eq!(safe_file_name(Some("Report Q3.pdf")), "Report Q3.pdf");
        assert_eq!(safe_file_name(None), "attachment");
        assert_eq!(safe_file_name(Some("///")), "attachment");
        assert!(safe_file_name(Some(&"a".repeat(300))).len() <= 100);
    }

    #[test]
    fn links_of_sanitized_html_are_listed_with_their_text() {
        let (html, _) = sanitize_html(concat!(
            r#"<p><a href="https://rsvp.example/e?a=1&amp;b=2">RSVP <b>here</b></a> or "#,
            r#"<a href="mailto:x@y">mail</a> <a href="javascript:x">j</a> <a href="https://rsvp.example/e?a=1&b=2">again</a> "#,
            r#"<a href="http://plain.example/"><img src="data:image/png;base64,AA=="></a></p>"#,
        ));
        assert_eq!(html_links(&html), vec![
            Link { url: "https://rsvp.example/e?a=1&b=2".into(), text: Some("RSVP here".into()) },
            Link { url: "http://plain.example/".into(), text: None },
        ]);
    }

    #[test]
    fn ids_are_checked_before_anything_is_sent() {
        assert!(check_id("Ma1b2-_").is_ok());
        for bad in ["", "a/b", "a b", "a?b", "../x", "{x}"] {
            assert!(check_id(bad).is_err(), "{bad}");
        }
    }
}
