//! T-210: writing mail through the bridge's named operations.
//!
//! The app never sends JMAP that writes ([`super::check_read_only`] still guards `/mail/jmap`). A write is one named
//! operation on `POST /mail/op`, and the bridge builds the JMAP itself after checking who may do what on which account.
//! The bridge says, per account, which operations this key may run there (`/mail/session` → `operations`); this
//! client runs only those ([`MailBridge::run`] asks the session first), so a bridge without the write patch, or with
//! writes off, leaves every write disabled.
//!
//! Sending follows the bridge's submission contract: save the draft (`draft.save`), review exactly what was saved (its
//! fingerprint is the SHA-256 of the stored message), then `send` that draft by id and fingerprint under one `opId` per
//! review. A retry with the same `opId` gets the first outcome, never a second message. The owner sends as Uni only
//! through the bridge's deputy path (`send_as_uni`), under Uni's outbound rules.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{check_id, invalid, Address, MailBridge, MailError, MailResult, JMAP_TIMEOUT};

/// Every operation this client knows (the bridge's names).
pub const OPERATIONS: &[&str] = &[
    "mark_seen", "flag", "archive", "draft.save", "draft.review", "draft.discard", "draft.add_for_owner", "send", "send_as_uni", "send.check",
];
const MAX_IDS: usize = 100;
const MAX_RECIPIENTS: usize = 50;
/// The bridge's cap on a body (48 KB; its whole request is 64 KB).
pub const MAX_TEXT: usize = 48 * 1024;

/// A message's fields as the composer has them. There is no From: the bridge sets it from the account.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DraftFields {
    #[serde(default)]
    pub to: Vec<Address>,
    #[serde(default)]
    pub cc: Vec<Address>,
    #[serde(default)]
    pub bcc: Vec<Address>,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub text: String,
    /// The message replied to (an email id in the same account): the bridge sets In-Reply-To and References.
    #[serde(default)]
    pub in_reply_to: Option<String>,
}

/// A saved draft as the bridge reports it, for review: its fingerprint, and the Uni drafts sending it will discard.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Reviewed {
    pub account_id: String,
    pub draft_id: String,
    pub thread_id: Option<String>,
    pub fingerprint: String,
    pub discard: Vec<String>,
    pub uni_drafted: bool,
}

/// Where a send stands. `Cleaned` and `Submitted` went out; `Unknown` is blocked until the bridge can tell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SendState {
    Drafting,
    Reserved,
    Submitting,
    Submitted,
    Cleaned,
    Refused,
    AwaitingApproval,
    Failed,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SendOutcome {
    pub op_id: String,
    pub account_id: String,
    pub draft_id: Option<String>,
    pub state: SendState,
    pub reason: Option<String>,
    pub submission_id: Option<String>,
    /// Per recipient, from the submission's delivery status (`send.check` only).
    pub delivery: Option<HashMap<String, String>>,
    /// The bridge returned an earlier send's outcome for this draft (it was already sent under another opId).
    pub note: Option<String>,
}

/// The operations a session answer lists for `account` (unknown names dropped). A bridge without the write patch lists
/// none.
pub fn operations_of(session: &Value, account: &str) -> Vec<String> {
    session
        .get("operations")
        .and_then(|o| o.get(account))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|op| OPERATIONS.contains(op))
        .map(str::to_string)
        .collect()
}

/// An operation id: 16 to 64 of `[A-Za-z0-9_-]`, made once per review by the composer.
pub fn check_op_id(op_id: &str) -> MailResult<()> {
    if !(16..=64).contains(&op_id.len()) || !op_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return Err(invalid("bad operation id"));
    }
    Ok(())
}

fn check_ids(ids: &[String]) -> MailResult<()> {
    if ids.is_empty() || ids.len() > MAX_IDS {
        return Err(invalid(format!("one to {MAX_IDS} messages at once")));
    }
    ids.iter().try_for_each(|i| check_id(i))
}

/// A plain email address: something@domain.tld, no spaces, no angle brackets, no line breaks.
pub fn valid_address(a: &str) -> bool {
    let Some((local, domain)) = a.split_once('@') else { return false };
    !local.is_empty()
        && a.len() <= 254
        && local.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+/=?^_`{|}~.-".contains(&b))
        && domain.split('.').count() >= 2
        && domain.split('.').all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
}

fn one_line(s: &str) -> bool {
    !s.chars().any(char::is_control)
}

impl DraftFields {
    /// Checked before anything is sent: addresses, one-line names and subject, sizes. The bridge checks them again.
    pub fn check(&self) -> MailResult<()> {
        let all: Vec<&Address> = self.to.iter().chain(&self.cc).chain(&self.bcc).collect();
        if all.len() > MAX_RECIPIENTS {
            return Err(invalid(format!("at most {MAX_RECIPIENTS} recipients")));
        }
        for a in &all {
            if !valid_address(&a.email) {
                return Err(invalid(format!("not an email address: {}", a.email.chars().take(80).collect::<String>())));
            }
            if a.name.as_deref().is_some_and(|n| !one_line(n) || n.chars().count() > 100) {
                return Err(invalid("a recipient's name must be one short line"));
            }
        }
        if !one_line(&self.subject) || self.subject.chars().count() > 300 {
            return Err(invalid("the subject must be one line of at most 300 characters"));
        }
        if self.text.len() > MAX_TEXT || self.text.contains('\0') {
            return Err(invalid(format!("the message is longer than {} KB", MAX_TEXT / 1024)));
        }
        if let Some(r) = &self.in_reply_to {
            check_id(r)?;
        }
        Ok(())
    }

    fn json(&self) -> Value {
        let list = |l: &[Address]| l.iter().map(|a| match &a.name { Some(n) if !n.trim().is_empty() => json!({ "email": a.email, "name": n.trim() }), _ => json!({ "email": a.email }) }).collect::<Vec<_>>();
        let mut v = json!({ "to": list(&self.to), "cc": list(&self.cc), "bcc": list(&self.bcc), "subject": self.subject.trim(), "text": self.text });
        if let Some(r) = &self.in_reply_to {
            v["inReplyTo"] = json!(r);
        }
        v
    }
}

fn reviewed(v: &Value, account: &str) -> MailResult<Reviewed> {
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    let draft_id = s("draftId").ok_or_else(|| invalid("the bridge didn't say which draft it saved"))?;
    check_id(&draft_id)?;
    let fingerprint = s("fingerprint").filter(|f| f.len() == 64 && f.bytes().all(|b| b.is_ascii_hexdigit())).ok_or_else(|| invalid("the bridge's answer has no fingerprint"))?;
    if s("accountId").is_some_and(|a| a != account) {
        return Err(invalid("the bridge answered about another account"));
    }
    Ok(Reviewed {
        account_id: account.to_string(),
        draft_id,
        thread_id: s("threadId"),
        fingerprint,
        discard: v.get("discard").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect(),
        uni_drafted: v.get("uniDrafted").and_then(Value::as_bool).unwrap_or(false),
    })
}

fn outcome(v: &Value, account: &str, op_id: &str) -> MailResult<SendOutcome> {
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    let state: SendState = serde_json::from_value(v.get("state").cloned().unwrap_or(Value::Null)).map_err(|_| invalid("the bridge's answer has no send state"))?;
    if s("opId").as_deref() != Some(op_id) || s("accountId").as_deref() != Some(account) {
        return Err(invalid("the bridge answered about another send"));
    }
    Ok(SendOutcome {
        op_id: op_id.to_string(),
        account_id: account.to_string(),
        draft_id: s("draftId"),
        state,
        reason: s("reason"),
        submission_id: s("submissionId"),
        delivery: v.get("delivery").and_then(Value::as_object).map(|d| d.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or("unknown").to_string())).collect()),
        note: s("note"),
    })
}

impl MailBridge<'_> {
    /// Run `op` on `account` with `args`, if the bridge's session lists it for this key there. Anything else never
    /// leaves the device.
    pub async fn run(&self, op: &str, account: &str, args: Value) -> MailResult<Value> {
        check_id(account)?;
        if !OPERATIONS.contains(&op) {
            return Err(invalid(format!("unknown mail operation {op}")));
        }
        let session = self.session().await?;
        let allowed = session.accounts.iter().find(|a| a.id == account).is_some_and(|a| a.operations.iter().any(|o| o == op));
        if !allowed {
            return Err(MailError::Refused { status: 403, message: format!("the mail bridge doesn't offer {op} on this mailbox") });
        }
        let mut body = json!({ "op": op, "accountId": account });
        for (k, v) in args.as_object().into_iter().flatten() {
            body[k] = v.clone();
        }
        let raw = self.post("/mail/op", &body, JMAP_TIMEOUT, 1024 * 1024).await?;
        serde_json::from_slice(&raw).map_err(|e| invalid(format!("bad bridge answer: {e}")))
    }

    /// Set or clear `$seen` on these messages.
    pub async fn mark_seen(&self, account: &str, ids: &[String], seen: bool) -> MailResult<()> {
        check_ids(ids)?;
        self.run("mark_seen", account, json!({ "emailIds": ids, "seen": seen })).await.map(|_| ())
    }

    /// Set or clear `$flagged` on these messages.
    pub async fn flag(&self, account: &str, ids: &[String], flagged: bool) -> MailResult<()> {
        check_ids(ids)?;
        self.run("flag", account, json!({ "emailIds": ids, "flagged": flagged })).await.map(|_| ())
    }

    /// Move these messages from the account's Inbox to its Archive.
    pub async fn archive(&self, account: &str, ids: &[String]) -> MailResult<()> {
        check_ids(ids)?;
        self.run("archive", account, json!({ "emailIds": ids })).await.map(|_| ())
    }

    /// Save a draft in the account's Drafts (replacing `replaces`, a draft opened with fingerprint `base`). The answer
    /// is what to review.
    pub async fn draft_save(&self, account: &str, fields: &DraftFields, replaces: Option<(&str, &str)>) -> MailResult<Reviewed> {
        fields.check()?;
        let mut args = json!({ "fields": fields.json() });
        if let Some((id, base)) = replaces {
            check_id(id)?;
            args["replaces"] = json!(id);
            args["base"] = json!(base);
        }
        reviewed(&self.run("draft.save", account, args).await?, account)
    }

    /// An existing draft, for review as it is: its fingerprint and discard list.
    pub async fn draft_review(&self, account: &str, draft_id: &str) -> MailResult<Reviewed> {
        check_id(draft_id)?;
        reviewed(&self.run("draft.review", account, json!({ "draftId": draft_id })).await?, account)
    }

    pub async fn draft_discard(&self, account: &str, draft_id: &str) -> MailResult<()> {
        check_id(draft_id)?;
        self.run("draft.discard", account, json!({ "draftId": draft_id })).await.map(|_| ())
    }

    /// Send the reviewed draft, once: by id and fingerprint, under `op_id`.
    pub async fn send(&self, account: &str, op_id: &str, r: &Reviewed) -> MailResult<SendOutcome> {
        check_op_id(op_id)?;
        check_id(&r.draft_id)?;
        r.discard.iter().try_for_each(|d| check_id(d))?;
        let v = self.run("send", account, json!({ "opId": op_id, "draftId": r.draft_id, "fingerprint": r.fingerprint, "discard": r.discard })).await?;
        outcome(&v, account, op_id)
    }

    /// The owner sends as Uni: the bridge drafts it in Uni's account and sends it under Uni's outbound rules.
    pub async fn send_as_uni(&self, account: &str, op_id: &str, fields: &DraftFields) -> MailResult<SendOutcome> {
        check_op_id(op_id)?;
        fields.check()?;
        let v = self.run("send_as_uni", account, json!({ "opId": op_id, "fields": fields.json() })).await?;
        outcome(&v, account, op_id)
    }

    /// Where a send stands now (an unknown outcome is checked with the mail server first), with delivery per recipient.
    pub async fn send_check(&self, account: &str, op_id: &str) -> MailResult<SendOutcome> {
        check_op_id(op_id)?;
        let v = self.run("send.check", account, json!({ "opId": op_id })).await?;
        outcome(&v, account, op_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_operations_are_taken_from_the_session() {
        let s = json!({ "operations": { "A": ["mark_seen", "send", "Email/set", "Principal/get", 7], "U": "send" } });
        assert_eq!(operations_of(&s, "A"), ["mark_seen", "send"]);
        assert!(operations_of(&s, "U").is_empty());
        assert!(operations_of(&json!({}), "A").is_empty(), "a bridge without the write patch: nothing");
    }

    #[test]
    fn fields_that_could_carry_a_header_never_leave() {
        let ok = DraftFields { to: vec![Address { name: Some("Mara Quill".into()), email: "mara@example.org".into() }], subject: "Re: Plans".into(), text: "Line\nline".into(), ..Default::default() };
        assert!(ok.check().is_ok());
        let bad = [
            DraftFields { subject: "Hi\r\nBcc: spy@example.org".into(), ..ok.clone() },
            DraftFields { to: vec![Address { name: None, email: "a@example.org\r\nBcc: spy@example.org".into() }], ..ok.clone() },
            DraftFields { to: vec![Address { name: Some("A\nB".into()), email: "a@example.org".into() }], ..ok.clone() },
            DraftFields { to: vec![Address { name: None, email: "Robin <robin@example.com>".into() }], ..ok.clone() },
            DraftFields { to: vec![Address { name: None, email: "nobody".into() }], ..ok.clone() },
            DraftFields { cc: vec![Address { name: None, email: "a@example.org".into() }; 51], ..ok.clone() },
            DraftFields { text: "x".repeat(MAX_TEXT + 1), ..ok.clone() },
            DraftFields { in_reply_to: Some("../x".into()), ..ok.clone() },
        ];
        for f in bad {
            assert!(f.check().is_err(), "{f:?}");
        }
    }

    #[test]
    fn op_ids_are_long_and_plain() {
        assert!(check_op_id("0123456789abcdef").is_ok());
        assert!(check_op_id("short").is_err());
        assert!(check_op_id(&"a".repeat(65)).is_err());
        assert!(check_op_id("0123456789abcdef/").is_err());
    }

    #[test]
    fn an_answer_about_another_send_is_refused() {
        let v = json!({ "opId": "0123456789abcdef", "accountId": "A", "draftId": "d1", "state": "cleaned" });
        assert_eq!(outcome(&v, "A", "0123456789abcdef").unwrap().state, SendState::Cleaned);
        assert!(outcome(&v, "U", "0123456789abcdef").is_err());
        assert!(outcome(&v, "A", "fedcba9876543210").is_err());
        assert!(outcome(&json!({ "opId": "0123456789abcdef", "accountId": "A", "state": "maybe" }), "A", "0123456789abcdef").is_err());
        assert_eq!(serde_json::from_value::<SendState>(json!("awaiting-approval")).unwrap(), SendState::AwaitingApproval);
    }
}
