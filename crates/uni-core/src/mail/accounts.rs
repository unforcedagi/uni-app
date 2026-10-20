//! T-45 v2: both mailboxes, read-only.
//!
//! The bridge maps each key to one mail principal. Stalwart shares the other
//! mailbox with it (an ACL), and JMAP shows a shared mailbox as a second
//! account in the same session: the owner's key sees its own account (YOU)
//! and Uni's (UNI); every call names the account it reads (`accountId`).
//!
//! The bridge answers `POST /mail/session` with the session's accounts and a
//! `roles` map saying whose each one is ([`parse_session`]). Whose mail it is
//! is never guessed: the key's own account is the session's primary one, Uni's
//! is the one the bridge names `uni`, and any other account is left out. A
//! bridge without the endpoint (v1, which reads one account whatever is asked)
//! answers 404; then the session is that one account and nothing is shared.
//!
//! Every answer is checked against the account it was asked about
//! ([`answered_for`]): a bridge that lists two accounts but reads only one
//! fails closed instead of showing one mailbox's mail as the other's.
//!
//! JMAP can't query across accounts, so the combined view is one request with
//! one query per account, merged here by `receivedAt`, each account keeping its
//! own position for the next page ([`merge`]).
//!
//! Reads only: `Mailbox/get`, `Email/query`, `Email/get`, `Thread/get`
//! ([`super::check_read_only`] refuses anything else before it is sent).
//! Nothing here sets `$seen`.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{addresses, check_id, invalid, keyword, message, parse_mailboxes, text_of, unread, Address, MailBridge, MailError, MailResult, Mailbox, Message, MAX_BODY_VALUE_BYTES};

/// Whose mail: the key's own account, or the shared one (Uni's, for the owner's key).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Who {
    Owner,
    Uni,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionAccount {
    /// The JMAP `accountId`.
    pub id: String,
    /// The account's name in the session (its address).
    pub name: String,
    pub who: Who,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MailSession {
    /// The address this key reads as (the bridge's principal).
    pub login: String,
    /// The key's own account first, then the shared one.
    pub accounts: Vec<SessionAccount>,
    /// The bridge reads by `accountId`. False: a v1 bridge, one account.
    pub multi: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AccountBoxes {
    pub id: String,
    pub name: String,
    pub who: Who,
    /// Inbox first.
    pub mailboxes: Vec<Mailbox>,
}

/// Every account in the session with its mailboxes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Overview {
    pub login: String,
    pub multi: bool,
    pub accounts: Vec<AccountBoxes>,
}

/// One account's part of a list: a mailbox (or, for a search, the whole account less `exclude`), and where its next
/// page starts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Source {
    pub account_id: String,
    #[serde(default)]
    pub mailbox_id: Option<String>,
    /// Mailboxes left out (a search skips Junk and Trash).
    #[serde(default)]
    pub exclude: Vec<String>,
    #[serde(default)]
    pub position: u64,
}

/// A thread as a list shows it: its newest message in the list's mailbox, and the thread's size and state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThreadSummary {
    pub account_id: String,
    pub thread_id: String,
    /// The message the row shows (the newest in the list's mailbox).
    pub email_id: String,
    pub from: Vec<Address>,
    pub to: Vec<Address>,
    pub subject: String,
    pub preview: String,
    pub received_at: String,
    /// Messages in the thread, in every mailbox.
    pub count: usize,
    /// A message in the thread (other than a draft) is unread.
    pub unread: bool,
    pub has_attachment: bool,
    pub draft: bool,
    pub uni_drafted: bool,
}

/// A page of threads from one or more accounts, newest first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThreadPage {
    pub threads: Vec<ThreadSummary>,
    /// The sources for the next page (positions moved past what this page showed).
    pub next: Vec<Source>,
    pub more: bool,
    /// Threads in all sources, when every account counted them.
    pub total: Option<u64>,
}

/// A thread's messages, oldest first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Thread {
    pub account_id: String,
    pub thread_id: String,
    pub messages: Vec<Message>,
}

/// Most accounts one list reads (the owner's and the shared one, with room to spare).
const MAX_SOURCES: usize = 4;
/// Longest search text sent.
const MAX_SEARCH: usize = 200;
/// Longest triage note shown.
pub const MAX_TRIAGE: usize = 240;
const MAIL_CAP: &str = "urn:ietf:params:jmap:mail";

/// The session the bridge reports (`/mail/session`): the JMAP session's `accounts` and `primaryAccounts`, plus the
/// bridge's own `roles` map (`{accountId: "owner" | "uni"}`, from its principal map).
///
/// - YOU is the primary mail account: the principal this device's key reads as. If `roles` names it, it must be
///   `owner` (a key that reads as Uni is not an owner device).
/// - UNI is the one other account `roles` names `uni`; two are refused.
/// - Any other account (unnamed, or named something else) is left out: not listed, never queried.
pub fn parse_session(v: &Value) -> MailResult<MailSession> {
    let login = v.get("account").and_then(Value::as_str).unwrap_or_default().to_string();
    let accounts = v.get("accounts").and_then(Value::as_object).ok_or_else(|| invalid("no accounts in the mail session"))?;
    let primary = v.pointer("/primaryAccounts").and_then(|p| p.get(MAIL_CAP)).and_then(Value::as_str).ok_or_else(|| invalid("the mail session names no account of its own"))?;
    let roles = v.get("roles").and_then(Value::as_object);
    let role = |id: &str| roles.and_then(|r| r.get(id)).and_then(Value::as_str);
    let mut out: Vec<SessionAccount> = Vec::new();
    for (id, a) in accounts {
        if check_id(id).is_err() {
            continue;
        }
        // an account the session lists without mail (a calendar, say) isn't a mailbox
        if a.get("accountCapabilities").and_then(Value::as_object).is_some_and(|c| !c.contains_key(MAIL_CAP)) {
            continue;
        }
        let who = if id == primary {
            if role(id).is_some_and(|r| r != "owner") {
                return Err(invalid("this key reads a mailbox the bridge says isn't the owner's"));
            }
            Who::Owner
        } else if role(id) == Some("uni") {
            Who::Uni
        } else {
            continue;
        };
        out.push(SessionAccount { id: id.clone(), name: a.get("name").and_then(Value::as_str).unwrap_or(id).to_string(), who });
    }
    if !out.iter().any(|a| a.who == Who::Owner) {
        return Err(invalid("the mail session's own account isn't a mailbox"));
    }
    if out.iter().filter(|a| a.who == Who::Uni).count() > 1 {
        return Err(invalid("the bridge names more than one mailbox as Uni's"));
    }
    out.sort_by_key(|a| a.who != Who::Owner);
    Ok(MailSession { login, accounts: out, multi: true })
}

/// Check that the answer to call `id` is about `account` (JMAP puts `accountId` in every `/get` and `/query` answer).
/// A bridge that reads another account than the one asked (v1's override, say) is caught here, not shown.
pub fn answered_for(r: &HashMap<String, Value>, id: &str, account: &str) -> MailResult<()> {
    let Some(answer) = r.get(id) else { return Ok(()) };
    match answer.get("accountId").and_then(Value::as_str) {
        Some(a) if a == account => Ok(()),
        Some(a) => Err(invalid(format!("the mail bridge answered for account {a} when asked about {account}"))),
        None => Err(invalid(format!("the mail bridge's answer doesn't say which account it is about (asked about {account})"))),
    }
}

/// Whether a bridge answer is "this path doesn't exist" (a v1 bridge without the v2 endpoints).
fn not_found(e: &MailError) -> bool {
    matches!(e, MailError::Refused { status: 404, .. })
}

/// Seconds since 1970 for an RFC 3339 time (`2026-10-18T07:12:00Z`, `…+02:00`, fractions ignored); `None` if it isn't one.
pub fn rfc3339_seconds(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't' | b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (num(0..4)?, num(5..7)?, num(8..10)?, num(11..13)?, num(14..16)?, num(17..19)?);
    let mut rest = &s[19..];
    if let Some(r) = rest.strip_prefix('.') {
        rest = r.trim_start_matches(|c: char| c.is_ascii_digit());
    }
    let offset = match rest {
        "Z" | "z" => 0,
        r if r.len() == 6 && (r.starts_with('+') || r.starts_with('-')) && &r[3..4] == ":" => {
            let v = r[1..3].parse::<i64>().ok()? * 3600 + r[4..6].parse::<i64>().ok()? * 60;
            if r.starts_with('-') { -v } else { v }
        }
        _ => return None,
    };
    // days from the civil date (Howard Hinnant's algorithm)
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (mo + if mo > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + h * 3600 + mi * 60 + se - offset)
}

/// Merge each account's page (its source, its threads newest first, its total) into one page of at most `limit`,
/// newest first. Each source's next position moves past only the threads this page took from it, so the next page
/// carries on where this one stopped in every account. Ties keep the sources' order.
pub fn merge(pages: Vec<(Source, Vec<ThreadSummary>, Option<u64>)>, limit: usize) -> ThreadPage {
    let mut all: Vec<(usize, i64, ThreadSummary)> = Vec::new();
    for (i, (_, threads, _)) in pages.iter().enumerate() {
        for t in threads {
            all.push((i, rfc3339_seconds(&t.received_at).unwrap_or(i64::MIN), t.clone()));
        }
    }
    all.sort_by(|a, b| b.1.cmp(&a.1)); // stable: ties stay in source order, and each source's own order
    all.truncate(limit);
    let mut taken = vec![0u64; pages.len()];
    for (i, _, _) in &all {
        taken[*i] += 1;
    }
    let mut more = false;
    let mut total = Some(0u64);
    let next = pages
        .iter()
        .enumerate()
        .map(|(i, (src, threads, t))| {
            let position = src.position + taken[i];
            more |= match t {
                Some(t) => position < *t,
                None => threads.len() as u64 > taken[i] || threads.len() >= limit,
            };
            total = total.zip(*t).map(|(a, b)| a + b);
            Source { position, ..src.clone() }
        })
        .collect();
    ThreadPage { threads: all.into_iter().map(|(_, _, t)| t).collect(), next, more, total }
}

/// A list row from the representative email `e`, its thread's email ids, and those emails' keywords.
fn thread_summary(account: &str, e: &Value, thread: Option<&Vec<String>>, states: &HashMap<String, &Value>) -> ThreadSummary {
    let thread_id = text_of(e, "threadId");
    let id = text_of(e, "id");
    let ids = thread.cloned().unwrap_or_else(|| vec![id.clone()]);
    let members: Vec<&Value> = ids.iter().filter_map(|i| states.get(i).copied()).collect();
    let unread_any = if members.is_empty() { unread(e) && !keyword(e, "$draft") } else { members.iter().any(|m| unread(m) && !keyword(m, "$draft")) };
    let attach = e.get("hasAttachment").and_then(Value::as_bool).unwrap_or(false) || members.iter().any(|m| m.get("hasAttachment").and_then(Value::as_bool) == Some(true));
    ThreadSummary {
        account_id: account.to_string(),
        thread_id,
        email_id: id,
        from: addresses(e.get("from")),
        to: addresses(e.get("to")),
        subject: text_of(e, "subject"),
        preview: text_of(e, "preview"),
        received_at: text_of(e, "receivedAt"),
        count: ids.len().max(1),
        unread: unread_any,
        has_attachment: attach,
        draft: keyword(e, "$draft"),
        uni_drafted: keyword(e, "$uni-drafted"),
    }
}

/// Plain text, one line, at most [`MAX_TRIAGE`] characters: a triage note is shown as text, never as markup.
pub fn clean_note(s: &str) -> String {
    let visible: String = s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let line = visible.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() > MAX_TRIAGE {
        let cut: String = line.chars().take(MAX_TRIAGE - 1).collect();
        format!("{}…", cut.trim_end())
    } else {
        line
    }
}

impl MailBridge<'_> {
    /// The session's accounts: the key's own, and the one shared with it. A v1 bridge (no `/mail/session`) is one
    /// account, the one it reads.
    pub async fn session(&self) -> MailResult<MailSession> {
        match self.post("/mail/session", &json!({}), super::JMAP_TIMEOUT, 1024 * 1024).await {
            Ok(raw) => parse_session(&serde_json::from_slice(&raw).map_err(|e| invalid(format!("bad bridge answer: {e}")))?),
            Err(e) if not_found(&e) => {
                let (login, r) = self.jmap(json!([["Mailbox/get", { "ids": [] }, "m"]])).await?;
                let id = r.get("m").and_then(|m| m.get("accountId")).and_then(Value::as_str).ok_or_else(|| invalid("no account id in the answer"))?.to_string();
                check_id(&id)?;
                Ok(MailSession { accounts: vec![SessionAccount { id, name: login.clone(), who: Who::Owner }], login, multi: false })
            }
            Err(e) => Err(e),
        }
    }

    /// Every account in the session with its mailboxes (one `Mailbox/get` per account, in one request).
    pub async fn overview(&self) -> MailResult<Overview> {
        let session = self.session().await?;
        let calls: Vec<Value> = session
            .accounts
            .iter()
            .enumerate()
            .map(|(i, a)| json!(["Mailbox/get", { "accountId": a.id, "ids": null, "properties": ["id", "name", "parentId", "role", "sortOrder", "totalEmails", "unreadEmails"] }, format!("m{i}")]))
            .collect();
        let (_, r) = self.jmap(Value::Array(calls)).await?;
        let mut accounts = Vec::new();
        for (i, a) in session.accounts.into_iter().enumerate() {
            answered_for(&r, &format!("m{i}"), &a.id)?;
            let list = r.get(&format!("m{i}")).and_then(|m| m.get("list")).and_then(Value::as_array).ok_or_else(|| invalid("no mailbox list in the answer"))?;
            accounts.push(AccountBoxes { id: a.id, name: a.name, who: a.who, mailboxes: parse_mailboxes(list) });
        }
        Ok(Overview { login: session.login, multi: session.multi, accounts })
    }

    /// Threads newest first from each source (a mailbox, or a whole account for a search), merged into one page of at
    /// most `limit`. `text` searches (JMAP `Email/query` text filter) within each source.
    pub async fn threads(&self, sources: &[Source], text: Option<&str>, limit: u64) -> MailResult<ThreadPage> {
        if sources.is_empty() || sources.len() > MAX_SOURCES {
            return Err(invalid("a list reads one to four accounts"));
        }
        let text = text.map(str::trim).filter(|t| !t.is_empty());
        if text.is_some_and(|t| t.chars().count() > MAX_SEARCH) {
            return Err(invalid("that search is too long"));
        }
        let limit = limit.clamp(1, 100);
        let mut calls = Vec::new();
        for (i, s) in sources.iter().enumerate() {
            check_id(&s.account_id)?;
            let mut filter = serde_json::Map::new();
            if let Some(m) = &s.mailbox_id {
                check_id(m)?;
                filter.insert("inMailbox".into(), json!(m));
            }
            if !s.exclude.is_empty() {
                for m in &s.exclude {
                    check_id(m)?;
                }
                filter.insert("inMailboxOtherThan".into(), json!(s.exclude));
            }
            if let Some(t) = text {
                filter.insert("text".into(), json!(t));
            }
            let a = &s.account_id;
            calls.push(json!(["Email/query", {
                "accountId": a, "filter": filter, "sort": [{ "property": "receivedAt", "isAscending": false }],
                "collapseThreads": true, "position": s.position, "limit": limit, "calculateTotal": true
            }, format!("q{i}")]));
            calls.push(json!(["Email/get", {
                "accountId": a, "#ids": { "resultOf": format!("q{i}"), "name": "Email/query", "path": "/ids" },
                "properties": ["id", "threadId", "mailboxIds", "keywords", "from", "to", "subject", "preview", "receivedAt", "hasAttachment"]
            }, format!("e{i}")]));
            calls.push(json!(["Thread/get", {
                "accountId": a, "#ids": { "resultOf": format!("e{i}"), "name": "Email/get", "path": "/list/*/threadId" }
            }, format!("t{i}")]));
            calls.push(json!(["Email/get", {
                "accountId": a, "#ids": { "resultOf": format!("t{i}"), "name": "Thread/get", "path": "/list/*/emailIds" },
                "properties": ["id", "keywords", "hasAttachment"]
            }, format!("k{i}")]));
        }
        let (_, r) = self.jmap(Value::Array(calls)).await?;
        let list = |id: &str| r.get(id).and_then(|v| v.get("list")).and_then(Value::as_array).cloned().unwrap_or_default();
        let mut pages = Vec::new();
        for (i, s) in sources.iter().enumerate() {
            for call in ["q", "e", "t", "k"] {
                answered_for(&r, &format!("{call}{i}"), &s.account_id)?;
            }
            let q = r.get(&format!("q{i}")).ok_or_else(|| invalid("no query answer"))?;
            let ids: Vec<&str> = q.get("ids").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
            let emails = list(&format!("e{i}"));
            let by_id: HashMap<&str, &Value> = emails.iter().filter_map(|e| Some((e.get("id")?.as_str()?, e))).collect();
            let threads_list = list(&format!("t{i}"));
            let threads: HashMap<String, Vec<String>> = threads_list
                .iter()
                .filter_map(|t| Some((t.get("id")?.as_str()?.to_string(), t.get("emailIds")?.as_array()?.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())))
                .collect();
            let states_list = list(&format!("k{i}"));
            let states: HashMap<String, &Value> = states_list.iter().filter_map(|e| Some((e.get("id")?.as_str()?.to_string(), e))).collect();
            // Email/get may answer in any order; the query's order is newest first
            let rows: Vec<ThreadSummary> = ids
                .iter()
                .filter_map(|id| by_id.get(id))
                .map(|e| thread_summary(&s.account_id, e, e.get("threadId").and_then(Value::as_str).and_then(|t| threads.get(t)), &states))
                .collect();
            pages.push((s.clone(), rows, q.get("total").and_then(Value::as_u64)));
        }
        Ok(merge(pages, limit as usize))
    }

    /// A thread's messages, oldest first, with bodies (HTML sanitized) and attachments. `Email/get` only: reading
    /// never marks anything read.
    pub async fn thread(&self, account: &str, thread_id: &str) -> MailResult<Thread> {
        check_id(account)?;
        check_id(thread_id)?;
        let calls = json!([
            ["Thread/get", { "accountId": account, "ids": [thread_id] }, "t"],
            ["Email/get", {
                "accountId": account, "#ids": { "resultOf": "t", "name": "Thread/get", "path": "/list/0/emailIds" },
                "properties": ["id", "threadId", "mailboxIds", "keywords", "from", "to", "cc", "replyTo", "subject", "receivedAt", "sentAt",
                               "textBody", "htmlBody", "attachments", "bodyValues"],
                "fetchTextBodyValues": true, "fetchHTMLBodyValues": true, "maxBodyValueBytes": MAX_BODY_VALUE_BYTES
            }, "g"]
        ]);
        let gone = || invalid("that thread is no longer in the mailbox");
        let (_, r) = match self.jmap(calls).await {
            // no such thread: Thread/get lists it as not found, so the Email/get that refers to it can't resolve
            Err(MailError::Server { message }) if message.starts_with("invalidResultReference") => return Err(gone()),
            r => r?,
        };
        answered_for(&r, "t", account)?;
        answered_for(&r, "g", account)?;
        let ids: Vec<String> = r
            .get("t")
            .and_then(|t| t.get("list"))
            .and_then(Value::as_array)
            .and_then(|l| l.first())
            .and_then(|t| t.get("emailIds"))
            .and_then(Value::as_array)
            .ok_or_else(gone)?
            .iter()
            .filter_map(|x| x.as_str().map(str::to_string))
            .collect();
        let got: HashMap<String, &Value> = r
            .get("g")
            .and_then(|g| g.get("list"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|e| Some((e.get("id")?.as_str()?.to_string(), e)))
            .collect();
        let messages: Vec<Message> = ids.iter().filter_map(|id| got.get(id)).map(|e| message(e)).collect();
        if messages.is_empty() {
            return Err(gone());
        }
        Ok(Thread { account_id: account.to_string(), thread_id: thread_id.to_string(), messages })
    }

    /// Uni's triage notes on these messages, from Uni's own store behind the bridge (`/mail/triage`), keyed by email
    /// id; never from the mail itself. Plain text ([`clean_note`]). A bridge without triage answers 404: no notes.
    pub async fn triage(&self, account: &str, email_ids: &[String]) -> MailResult<HashMap<String, String>> {
        check_id(account)?;
        if email_ids.len() > 200 {
            return Err(invalid("too many messages at once"));
        }
        for id in email_ids {
            check_id(id)?;
        }
        if email_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let raw = match self.post("/mail/triage", &json!({ "accountId": account, "emailIds": email_ids }), super::JMAP_TIMEOUT, 1024 * 1024).await {
            Ok(raw) => raw,
            Err(e) if not_found(&e) => return Ok(HashMap::new()),
            Err(e) => return Err(e),
        };
        let v: Value = serde_json::from_slice(&raw).map_err(|e| invalid(format!("bad bridge answer: {e}")))?;
        let answer = HashMap::from([("n".to_string(), v)]);
        answered_for(&answer, "n", account)?;
        let v = &answer["n"];
        Ok(v.get("notes")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .filter(|(id, _)| email_ids.contains(id))
            .filter_map(|(id, n)| Some((id.clone(), clean_note(n.as_str()?))))
            .filter(|(_, n)| !n.is_empty())
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(account: &str, id: &str, at: &str) -> ThreadSummary {
        ThreadSummary {
            account_id: account.into(), thread_id: format!("T{id}"), email_id: id.into(), from: vec![], to: vec![], subject: id.into(), preview: String::new(),
            received_at: at.into(), count: 1, unread: false, has_attachment: false, draft: false, uni_drafted: false,
        }
    }

    fn src(account: &str, position: u64) -> Source {
        Source { account_id: account.into(), mailbox_id: Some(format!("{account}-inbox")), exclude: vec![], position }
    }

    fn session(roles: Value, extra: Value) -> Value {
        let mut accounts = json!({
            "g": { "name": "uni@example.com", "isPersonal": false, "isReadOnly": false, "accountCapabilities": { "urn:ietf:params:jmap:mail": {} } },
            "f": { "name": "robin@example.com", "isPersonal": true, "isReadOnly": false, "accountCapabilities": { "urn:ietf:params:jmap:mail": {}, "urn:ietf:params:jmap:submission": {} } },
            "c": { "name": "calendar only", "isPersonal": false, "accountCapabilities": { "urn:ietf:params:jmap:calendars": {} } },
            "../x": { "name": "bad id", "isPersonal": false }
        });
        for (k, v) in extra.as_object().into_iter().flatten() {
            accounts[k] = v.clone();
        }
        json!({ "account": "robin@example.com", "primaryAccounts": { "urn:ietf:params:jmap:mail": "f" }, "accounts": accounts, "roles": roles })
    }

    fn whose(s: &MailSession) -> Vec<(&str, Who)> {
        s.accounts.iter().map(|a| (a.id.as_str(), a.who)).collect()
    }

    #[test]
    fn a_session_lists_the_keys_own_account_first_and_the_one_the_bridge_names_uni() {
        let s = parse_session(&session(json!({ "f": "owner", "g": "uni" }), json!({}))).unwrap();
        assert_eq!(s.login, "robin@example.com");
        assert!(s.multi);
        assert_eq!(s.accounts, vec![
            SessionAccount { id: "f".into(), name: "robin@example.com".into(), who: Who::Owner },
            SessionAccount { id: "g".into(), name: "uni@example.com".into(), who: Who::Uni },
        ]);
    }

    /// Codex review 1, P0: a shared account is not Uni's because it is shared.
    #[test]
    fn an_account_the_bridge_doesnt_name_uni_is_left_out() {
        let third = json!({ "h": { "name": "someone@example.com", "isPersonal": false, "accountCapabilities": { "urn:ietf:params:jmap:mail": {} } } });
        let s = parse_session(&session(json!({ "f": "owner", "g": "uni" }), third.clone())).unwrap();
        assert_eq!(whose(&s), [("f", Who::Owner), ("g", Who::Uni)], "the third shared account is not shown as Uni's");
        let s = parse_session(&session(json!({ "f": "owner", "g": "uni", "h": "guest" }), third)).unwrap();
        assert_eq!(whose(&s), [("f", Who::Owner), ("g", Who::Uni)]);
        let s = parse_session(&session(json!({}), json!({}))).unwrap();
        assert_eq!(whose(&s), [("f", Who::Owner)], "no roles: only the key's own mailbox");
        let s = parse_session(&json!({ "account": "robin@example.com", "primaryAccounts": { "urn:ietf:params:jmap:mail": "f" }, "accounts": { "f": {}, "g": {} } })).unwrap();
        assert_eq!(whose(&s), [("f", Who::Owner)], "no roles map at all: the same");
    }

    #[test]
    fn a_key_that_reads_as_uni_or_two_unis_is_refused() {
        // reciprocal sharing seen from Uni's key: its primary account is Uni's, and the owner's is shared to it
        let uni_key = json!({ "account": "uni@example.com", "primaryAccounts": { "urn:ietf:params:jmap:mail": "g" },
            "accounts": { "g": { "name": "uni@example.com" }, "f": { "name": "robin@example.com" } }, "roles": { "g": "uni", "f": "owner" } });
        assert!(parse_session(&uni_key).is_err(), "Uni's own mail must never be shown as YOU");
        let two = json!({ "h": { "name": "other@example.com", "accountCapabilities": { "urn:ietf:params:jmap:mail": {} } } });
        assert!(parse_session(&session(json!({ "f": "owner", "g": "uni", "h": "uni" }), two)).is_err());
    }

    #[test]
    fn a_session_needs_its_own_mail_account() {
        assert!(parse_session(&json!({ "accounts": {} })).is_err());
        assert!(parse_session(&json!({ "accounts": { "a": { "isPersonal": true } } })).is_err(), "no primary account: whose is it?");
        assert!(parse_session(&json!({ "primaryAccounts": { "urn:ietf:params:jmap:mail": "z" }, "accounts": { "a": {} }, "roles": { "a": "uni" } })).is_err(), "the primary isn't listed");
        assert!(parse_session(&json!({ "nothing": 1 })).is_err());
    }

    #[test]
    fn an_answer_about_another_account_is_refused() {
        let mut r = HashMap::new();
        r.insert("m0".to_string(), json!({ "accountId": "f", "list": [] }));
        r.insert("m1".to_string(), json!({ "list": [] }));
        assert!(answered_for(&r, "m0", "f").is_ok());
        assert!(answered_for(&r, "m0", "g").is_err());
        assert!(answered_for(&r, "m1", "f").is_err(), "an answer that doesn't say whose it is");
        assert!(answered_for(&r, "absent", "f").is_ok(), "a missing answer is reported by its caller");
    }

    #[test]
    fn times_compare_across_offsets() {
        assert_eq!(rfc3339_seconds("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(rfc3339_seconds("2026-10-18T07:12:00Z"), Some(1_792_307_520));
        assert_eq!(rfc3339_seconds("2026-10-18T09:12:00+02:00"), rfc3339_seconds("2026-10-18T07:12:00Z"));
        assert_eq!(rfc3339_seconds("2026-10-18T07:12:00.123Z"), rfc3339_seconds("2026-10-18T07:12:00Z"));
        assert_eq!(rfc3339_seconds("2024-02-29T00:00:00Z"), Some(1_709_164_800));
        for bad in ["", "yesterday", "2026-10-18", "2026-10-18T07:12:00", "2026-10-18T07:12:00+0200"] {
            assert_eq!(rfc3339_seconds(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_combined_view_merges_newest_first_and_pages_each_account_on_its_own() {
        // A has 3 threads, U has 2; their times interleave, and one of U's is in another offset
        let a = vec![row("A", "a1", "2026-10-18T10:00:00Z"), row("A", "a2", "2026-10-17T10:00:00Z")];
        let u = vec![row("U", "u1", "2026-10-18T13:30:00+02:00"), row("U", "u2", "2026-10-16T10:00:00Z")];
        let page = merge(vec![(src("A", 0), a, Some(3)), (src("U", 0), u, Some(2))], 2);
        assert_eq!(page.threads.iter().map(|t| t.email_id.as_str()).collect::<Vec<_>>(), ["u1", "a1"], "11:30Z before 10:00Z");
        assert_eq!(page.next.iter().map(|s| (s.account_id.as_str(), s.position)).collect::<Vec<_>>(), [("A", 1), ("U", 1)]);
        assert!(page.more);
        assert_eq!(page.total, Some(5));
        assert_eq!(page.next[0].mailbox_id.as_deref(), Some("A-inbox"), "the source is kept, only its position moves");

        // the next page starts each account where this one stopped
        let a = vec![row("A", "a2", "2026-10-17T10:00:00Z"), row("A", "a3", "2026-10-15T10:00:00Z")];
        let u = vec![row("U", "u2", "2026-10-16T10:00:00Z")];
        let page = merge(vec![(page.next[0].clone(), a, Some(3)), (page.next[1].clone(), u, Some(2))], 2);
        assert_eq!(page.threads.iter().map(|t| t.email_id.as_str()).collect::<Vec<_>>(), ["a2", "u2"]);
        assert_eq!(page.next.iter().map(|s| s.position).collect::<Vec<_>>(), [2, 2]);
        assert!(page.more, "a3 is still to come");

        let page = merge(vec![(page.next[0].clone(), vec![row("A", "a3", "2026-10-15T10:00:00Z")], Some(3)), (page.next[1].clone(), vec![], Some(2))], 2);
        assert_eq!(page.threads.iter().map(|t| t.email_id.as_str()).collect::<Vec<_>>(), ["a3"]);
        assert!(!page.more);
    }

    #[test]
    fn ties_keep_the_accounts_order_and_an_uncounted_total_is_unknown() {
        let at = "2026-10-18T10:00:00Z";
        let page = merge(vec![(src("A", 0), vec![row("A", "a1", at)], None), (src("U", 0), vec![row("U", "u1", at)], Some(1))], 10);
        assert_eq!(page.threads.iter().map(|t| t.email_id.as_str()).collect::<Vec<_>>(), ["a1", "u1"]);
        assert_eq!(page.total, None);
        assert!(!page.more);
    }

    #[test]
    fn a_triage_note_is_one_plain_line() {
        assert_eq!(clean_note("  Needs you:\n\treply by Friday \u{7}"), "Needs you: reply by Friday");
        let long = clean_note(&"word ".repeat(100));
        assert_eq!(long.chars().count(), MAX_TRIAGE);
        assert!(long.ends_with('…'));
    }
}
