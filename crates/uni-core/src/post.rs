//! The "To post" queue (T-335): Aaron's verdict on a `post` note, signed with this device's key.
//!
//! A `post` note (tag `post`) holds one post as typed fields in its metadata: `account` (`aaron` or `uni`),
//! `platform`, `provenance` (`aaron-typed`, `aaron-excerpt` or `uni`), `piece` (the published piece it quotes or
//! shares), `body` (the exact text), `media`, and `state` (`proposed` → `approved` → `posted` | `failed` | `dropped`).
//!
//! **Approve** signs a kind-46335 event whose content is the exact body and whose tags name the vault, the note, the
//! account, platform, provenance and piece, the `digest` over all of it, and the window it may post in (`not_before`:
//! now, or the scheduled time; `expiration`: a day later). The event is stored on the note as `approval_event` in the
//! same compare-and-set that moves `state` to `approved`. The poster on uni (`uni-ops/post`, uni-post) posts only when
//! that signature is by Aaron's pinned key and still matches the note as stored; `state` alone, which any vault writer
//! can set, is never enough. **Not this** on an approved post signs a reject, so the poster won't use the old approval.
//!
//! The digest is sha256 over the compact JSON array
//! `["uni-post/1", vault, note, account, platform, provenance, piece, body, [media sha256...], [[name, value]...]]`
//! (serde_json's escaping is NIP-01's, which the poster's Python writes byte for byte; the cross vector below is pinned
//! on both sides). The last element is empty except for an essay record (`atproto-site`), where it is
//! `[["published_at", ..], ["site_path", ..], ["title", ..]]`.
//!
//! The voice rule is checked here and again by the poster: Aaron's account carries only his words, Uni's only Uni's.
//! Ported in shape from T-179's X drafts (`xdraft.rs` on `feat/t179-x-drafts`), without its "go" handshake: a post
//! can be scheduled for a time when this device is closed, so the poster can't wait on the device to answer.

use nostr::{Event, EventBuilder, JsonUtil as _, Keys, Kind, Tag, Timestamp};
use serde::Serialize;
use serde_json::{json, Value};

use crate::media::sha256_hex;
use crate::parachute::VaultClient;
use crate::{Error, Result};

/// The verdict kind (Buzz's 46xxx custom range). Stored on the note; never published to a relay.
pub const KIND: u16 = 46335;
/// Domain separation: an approval can't be any other event Aaron's key signs.
pub const DOMAIN: &str = "uni-post-approval/1";
pub const DIGEST_DOMAIN: &str = "uni-post/1";
pub const POST_TAG: &str = "post";
/// The poster refuses an approval whose window is longer than this (postcore.VALID_FOR_S).
pub const VALID_FOR_S: u64 = 24 * 3600;
/// How far ahead a post may be scheduled.
pub const MAX_SCHEDULE_AHEAD_S: u64 = 60 * 24 * 3600;
pub const ACCOUNTS: [&str; 2] = ["aaron", "uni"];
pub const PLATFORMS: [&str; 3] = ["bluesky", "x", "atproto-site"];
pub const SITE_FIELDS: [&str; 3] = ["published_at", "site_path", "title"];

/// Who may speak on which account: Aaron's account carries only his words; Uni's account only Uni's.
pub fn voice_ok(account: &str, provenance: &str) -> bool {
    matches!((account, provenance), ("aaron", "aaron-typed") | ("aaron", "aaron-excerpt") | ("uni", "uni"))
}

/// The platform's length limit in code points (Bluesky counts graphemes, which are never more than code points).
pub fn max_chars(platform: &str) -> usize {
    match platform {
        "bluesky" => 300,
        "x" => 280,
        "atproto-site" => 100_000,
        _ => 0,
    }
}

/// A post note's fields as stored (missing strings are empty).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Post {
    pub account: String,
    pub platform: String,
    pub provenance: String,
    pub piece: String,
    pub body: String,
    pub state: String,
    pub media: Vec<String>,
    pub extra: Vec<(String, String)>,
}

impl Post {
    pub fn from_note(note: &Value) -> Post {
        let m = &note["metadata"];
        let s = |k: &str| m[k].as_str().unwrap_or_default().to_string();
        let platform = s("platform");
        let extra = if platform == "atproto-site" {
            SITE_FIELDS.iter().map(|k| (k.to_string(), s(k))).collect()
        } else {
            vec![]
        };
        let media = m["media"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
        Post { account: s("account"), platform, provenance: s("provenance"), piece: s("piece"), body: s("body"), state: s("state"), media, extra }
    }
}

/// sha256 over the post as it would go out (`media` are the attachments' sha256s, in order).
pub fn digest(vault: &str, note: &str, p: &Post, media: &[String]) -> String {
    let extra: Vec<[&str; 2]> = p.extra.iter().map(|(k, v)| [k.as_str(), v.as_str()]).collect();
    let bytes = serde_json::to_vec(&json!([
        DIGEST_DOMAIN, vault, note, p.account, p.platform, p.provenance, p.piece, p.body, media, extra
    ]))
    .unwrap_or_default();
    sha256_hex(&bytes)
}

fn tag(parts: &[&str]) -> Result<Tag> {
    Tag::parse(parts.iter().copied()).map_err(|e| Error::Invalid(e.to_string()))
}

/// Sign Aaron's approval of exactly this post, to go out from `not_before` for [`VALID_FOR_S`].
pub fn approval_event(keys: &Keys, vault: &str, note: &str, p: &Post, not_before: u64, now: u64) -> Result<Event> {
    let d = digest(vault, note, p, &[]);
    let tags = vec![
        tag(&["domain", DOMAIN])?,
        tag(&["verdict", "approve"])?,
        tag(&["vault", vault])?,
        tag(&["note", note])?,
        tag(&["account", &p.account])?,
        tag(&["platform", &p.platform])?,
        tag(&["provenance", &p.provenance])?,
        tag(&["piece", &p.piece])?,
        tag(&["digest", &d])?,
        tag(&["not_before", &not_before.to_string()])?,
        tag(&["expiration", &(not_before + VALID_FOR_S).to_string()])?,
    ];
    EventBuilder::new(Kind::from(KIND), p.body.as_str())
        .tags(tags)
        .custom_created_at(Timestamp::from(now))
        .sign_with_keys(keys)
        .map_err(|e| Error::Invalid(format!("signing failed: {e}")))
}

/// Sign "not this" over the digest of the post as it stands: that exact post can never go out again, whatever any
/// clock says (the poster keeps every reject it ever sees for the note, from the note and its whole history). Only an
/// edited post, with a new digest and a fresh approval, can.
pub fn reject_event(keys: &Keys, vault: &str, note: &str, digest: &str, now: u64) -> Result<Event> {
    let tags = vec![
        tag(&["domain", DOMAIN])?,
        tag(&["verdict", "reject"])?,
        tag(&["vault", vault])?,
        tag(&["note", note])?,
        tag(&["digest", digest])?,
    ];
    EventBuilder::new(Kind::from(KIND), "")
        .tags(tags)
        .custom_created_at(Timestamp::from(now))
        .sign_with_keys(keys)
        .map_err(|e| Error::Invalid(format!("signing failed: {e}")))
}

fn is_post(note: &Value) -> bool {
    note["tags"].as_array().is_some_and(|t| t.iter().any(|t| t.as_str() == Some(POST_TAG)))
}

fn at_revision(note: &Value, if_updated_at: &str) -> Result<()> {
    if if_updated_at.is_empty() || note["updatedAt"].as_str() != Some(if_updated_at) {
        return Err(Error::Conflict("the post changed since you read it; look again".into()));
    }
    Ok(())
}

/// What a post must be before Aaron approves it: a proposed `post` note at the revision he saw, in a voice its account
/// may carry, that fits its platform. Media isn't posted yet, so a post with media can't be approved.
pub fn check_approvable(note: &Value, if_updated_at: &str) -> Result<Post> {
    if !is_post(note) {
        return Err(Error::Invalid("only post notes (tag post) can be approved".into()));
    }
    let p = Post::from_note(note);
    if p.state != "proposed" {
        return Err(Error::Invalid(format!("this post is {:?}; only a proposed post can be approved", p.state)));
    }
    at_revision(note, if_updated_at)?;
    if !ACCOUNTS.contains(&p.account.as_str()) || !PLATFORMS.contains(&p.platform.as_str()) {
        return Err(Error::Invalid("the post names no known account or platform".into()));
    }
    if !voice_ok(&p.account, &p.provenance) {
        return Err(Error::Invalid(if p.account == "aaron" {
            "Uni's words never go out under your name; this post can't be approved".into()
        } else {
            format!("Uni's account never carries {:?}", p.provenance)
        }));
    }
    if p.provenance == "aaron-excerpt" && p.piece.is_empty() {
        return Err(Error::Invalid("an excerpt must name the published piece it quotes".into()));
    }
    if p.body.trim().is_empty() {
        return Err(Error::Invalid("nothing to post".into()));
    }
    let n = p.body.chars().count();
    if n > max_chars(&p.platform) {
        return Err(Error::Invalid(format!("{n} characters; {} allows {}", p.platform, max_chars(&p.platform))));
    }
    if !p.media.is_empty() {
        return Err(Error::Invalid("posts with media can't go out yet".into()));
    }
    if p.extra.iter().any(|(_, v)| v.is_empty()) {
        return Err(Error::Invalid("an essay record needs its title, site_path and published_at".into()));
    }
    Ok(p)
}

/// Whether "Not this" can still stop the post. Once the poster has claimed it (`posting`, its compare-and-set from
/// `approved`), it is going out; ours, from `approved`, would fail anyway, and this says why instead.
pub fn check_droppable(note: &Value) -> Result<Post> {
    let p = Post::from_note(note);
    match p.state.as_str() {
        "proposed" | "approved" => Ok(p),
        "posting" => Err(Error::Invalid(GOING_OUT.into())),
        s => Err(Error::Invalid(format!("this post is {s:?}; only a proposed or approved post can be stopped"))),
    }
}

/// Whether the poster ever claimed this post: a version in the note's history in state `posting`. A vault writer can
/// reset the state and blank the approval afterwards, but can't erase the history (that takes an admin token). A post
/// the poster has claimed never becomes stoppable again (it goes to posted or failed), so any claim at all means the
/// app must not say "Stopped", whatever the note says now.
pub fn claimed(versions: &[Value]) -> bool {
    versions.iter().any(|v| v["metadata"]["state"].as_str() == Some("posting"))
}

/// One page of a history read: the vault's own answer (`{versions, total}`), or the hub's fan-out of it
/// (`{results: [{vault, notes: {versions, total}}]}`). Any other shape is an error, never "no history": an empty
/// list would read as "not claimed" and let Not this say Stopped.
pub fn versions_in(v: &Value, vault: &str) -> Result<(Vec<Value>, usize)> {
    let page = if v["versions"].is_array() {
        v
    } else {
        v["results"]
            .as_array()
            .and_then(|r| r.iter().find(|x| x["vault"].as_str() == Some(vault)))
            .map(|x| &x["notes"])
            .filter(|n| n["versions"].is_array())
            .ok_or_else(|| Error::Vault("the vault's history answer has a shape this app doesn't know".into()))?
    };
    let total = page["total"].as_u64().ok_or_else(|| Error::Vault("the vault's history answer has no total".into()))?;
    Ok((page["versions"].as_array().cloned().unwrap_or_default(), total as usize))
}

/// The id of the approval event stored on the note, if any.
pub fn approval_id(note: &Value) -> String {
    note["metadata"]["approval_event"]
        .as_str()
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .and_then(|e| e["id"].as_str().map(String::from))
        .unwrap_or_default()
}

const GOING_OUT: &str = "it's already going out; once it's posted it can be taken down";

/// The update-note arguments for an approval: the state compare-and-set, the signed event, the digest.
pub fn approve_args(vault: &str, id: &str, ev: &Event, digest: &str, scheduled_for: Option<u64>, if_updated_at: &str) -> Value {
    json!({"vault": vault, "id": id, "include_content": false, "if_updated_at": if_updated_at,
        "state_transition": {"field": "state", "from": "proposed", "to": "approved"},
        "metadata": {"approval_event": ev.as_json(), "digest": digest, "approved_at": iso(ev.created_at.as_secs()),
            "scheduled_for": scheduled_for.map(iso), "failed_reason": null}})
}

fn iso(t: u64) -> String {
    Timestamp::from(t).to_human_datetime().to_string()
}

/// The poster's outcome fields a card shows, as the note says them (the vault is not proof of a post; the platform is).
pub fn summary(note: &Value) -> String {
    let p = Post::from_note(note);
    let who = if p.account == "aaron" { "your account" } else { "Uni's account" };
    let first: String = p.body.chars().take(120).collect();
    format!("Post on {} as {who}:\n\n{first}{}", p.platform, if p.body.chars().count() > 120 { "…" } else { "" })
}

impl VaultClient {
    /// Every version in a note's history (the vault keeps each superseded state, metadata included).
    pub async fn note_versions(&self, vault: &str, id: &str) -> Result<Vec<Value>> {
        let mut out: Vec<Value> = vec![];
        for page in 0..20 {
            let v = self
                .call("query-notes", json!({"vault": vault, "versions": {"note_id": id, "limit": 200, "offset": page * 200}}))
                .await?;
            crate::parachute::check_vault_errors(&v)?;
            let (rows, total) = versions_in(&v, vault)?;
            let n = rows.len();
            out.extend(rows);
            if n == 0 || out.len() >= total {
                return Ok(out);
            }
        }
        Err(Error::Vault(format!("more than 4000 versions of {id}")))
    }

    /// An approved post the poster has claimed can't be stopped: say so instead of showing "Stopped". Read at the
    /// revision the caller then writes against, so a claim can't land between this and that compare-and-set.
    async fn not_claimed(&self, vault: &str, note: &Value) -> Result<()> {
        let id = note["id"].as_str().unwrap_or_default();
        if claimed(&self.note_versions(vault, id).await?) {
            return Err(Error::Invalid(GOING_OUT.into()));
        }
        Ok(())
    }

    /// Approve (or schedule) one post: re-read it, check it, sign over exactly what's stored, and write the signature in
    /// the compare-and-set that moves it to `approved`.
    #[allow(clippy::too_many_arguments)]
    pub async fn post_approve(&self, keys: &Keys, vault: &str, id: &str, if_updated_at: &str, scheduled_for: Option<u64>, now: u64) -> Result<Value> {
        let note = self.get_note(vault, id).await?;
        let p = check_approvable(&note, if_updated_at)?;
        let not_before = match scheduled_for {
            Some(t) if t + 60 < now => return Err(Error::Invalid("that time has passed".into())),
            Some(t) if t > now + MAX_SCHEDULE_AHEAD_S => return Err(Error::Invalid("schedule at most 60 days ahead".into())),
            Some(t) => t.max(now),
            None => now,
        };
        let ev = approval_event(keys, vault, id, &p, not_before, now)?;
        let d = digest(vault, id, &p, &[]);
        let v = self.call("update-note", approve_args(vault, id, &ev, &d, scheduled_for, if_updated_at)).await?;
        crate::parachute::check_vault_errors(&v)?;
        crate::parachute::note_from(&v, id)
    }

    /// "Not this": a proposed post is dropped; an approved one is dropped with a signed reject the poster records.
    pub async fn post_drop(&self, keys: &Keys, vault: &str, id: &str, if_updated_at: &str, now: u64) -> Result<Value> {
        let note = self.get_note(vault, id).await?;
        if !is_post(&note) {
            return Err(Error::Invalid("only post notes".into()));
        }
        at_revision(&note, if_updated_at)?;
        let p = check_droppable(&note)?;
        self.not_claimed(vault, &note).await?;
        // always a signed reject, even for a post that looks proposed: a writer may have reset an approved one, and
        // the reject in the history is what keeps any earlier approval from being restored and used
        let d = digest(vault, id, &p, &[]);
        let meta = json!({"dropped_at": iso(now), "approval_event": reject_event(keys, vault, id, &d, now)?.as_json()});
        let args = json!({"vault": vault, "id": id, "include_content": false, "if_updated_at": if_updated_at,
            "state_transition": {"field": "state", "from": p.state, "to": "dropped"}, "metadata": meta});
        let v = self.call("update-note", args).await?;
        crate::parachute::check_vault_errors(&v)?;
        crate::parachute::note_from(&v, id)
    }

    /// Edit. On Aaron's account the new text is his own (`provenance: aaron-typed`), the post goes back to `proposed` and
    /// any approval is void (a reject is signed if it was approved). On Uni's account his words never go out under
    /// Uni's name: the text is a note to Uni (`feedback`), and the post is dropped for Uni to propose again.
    pub async fn post_edit(&self, keys: &Keys, vault: &str, id: &str, if_updated_at: &str, text: &str, now: u64) -> Result<Value> {
        let note = self.get_note(vault, id).await?;
        if !is_post(&note) {
            return Err(Error::Invalid("only post notes".into()));
        }
        at_revision(&note, if_updated_at)?;
        let p = Post::from_note(&note);
        if p.state != "proposed" && p.state != "approved" {
            return Err(Error::Invalid(format!("this post is {:?}; it can't be edited", p.state)));
        }
        self.not_claimed(vault, &note).await?;
        if text.trim().is_empty() || text.chars().count() > 4000 {
            return Err(Error::Invalid("write 1 to 4000 characters".into()));
        }
        let mut meta = if p.account == "aaron" {
            if text.chars().count() > max_chars(&p.platform) {
                return Err(Error::Invalid(format!("{} allows {} characters", p.platform, max_chars(&p.platform))));
            }
            json!({"body": text, "provenance": "aaron-typed", "edited_at": iso(now), "digest": null, "approval_event": null})
        } else {
            json!({"feedback": text, "feedback_at": iso(now)})
        };
        // always a signed reject (see post_drop): no earlier approval of this post can come back
        meta["approval_event"] = json!(reject_event(keys, vault, id, &digest(vault, id, &p, &[]), now)?.as_json());
        let to = if p.account == "aaron" { "proposed" } else { "dropped" };
        let args = json!({"vault": vault, "id": id, "include_content": false, "if_updated_at": if_updated_at,
            "state_transition": {"field": "state", "from": p.state, "to": to}, "metadata": meta});
        let v = self.call("update-note", args).await?;
        crate::parachute::check_vault_errors(&v)?;
        crate::parachute::note_from(&v, id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pinned in uni-ops tests/test_uni_post.py (CROSS_VECTOR): both sides must agree byte for byte.
    const CROSS_VECTOR: &str = "224da0314bf7a5237a050cc79744cef05c5b4ccf9607a608fc7a837f635e9b48";

    fn note(meta: Value) -> Value {
        json!({"id": "01TESTNOTE", "tags": ["post"], "updatedAt": "2026-10-29T10:00:00.000Z", "metadata": meta})
    }

    fn uni_post() -> Value {
        note(json!({"state": "proposed", "account": "uni", "platform": "bluesky", "provenance": "uni", "piece": "",
            "body": "Uni's build log: 3 tests went red, then green.", "media": []}))
    }

    #[test]
    fn the_digest_is_the_documented_serialization() {
        let p = Post {
            account: "aaron".into(), platform: "bluesky".into(), provenance: "aaron-excerpt".into(),
            piece: "https://example.com/p".into(), body: "“Slow is smooth.” https://example.com/p".into(),
            state: "proposed".into(), media: vec![], extra: vec![],
        };
        assert_eq!(digest("uni", "01TESTNOTE", &p, &[]), CROSS_VECTOR);
    }

    #[test]
    fn approval_binds_body_fields_digest_and_window_and_verifies() {
        let keys = Keys::generate();
        let n = uni_post();
        let p = check_approvable(&n, "2026-10-29T10:00:00.000Z").unwrap();
        let ev = approval_event(&keys, "uni", "01TESTNOTE", &p, 1_800_000_100, 1_800_000_000).unwrap();
        ev.verify().unwrap();
        assert_eq!(ev.kind, Kind::from(KIND));
        assert_eq!(ev.content, p.body);
        let t = |k: &str| ev.tags.iter().map(|t| t.as_slice()).find(|t| t[0] == k).map(|t| t[1].clone()).unwrap();
        assert_eq!(t("domain"), DOMAIN);
        assert_eq!(t("verdict"), "approve");
        assert_eq!(t("note"), "01TESTNOTE");
        assert_eq!(t("account"), "uni");
        assert_eq!(t("piece"), "");
        assert_eq!(t("digest"), digest("uni", "01TESTNOTE", &p, &[]));
        assert_eq!(t("not_before"), "1800000100");
        assert_eq!(t("expiration"), (1_800_000_100 + VALID_FOR_S).to_string());
    }

    #[test]
    fn unis_words_on_aarons_account_cant_be_approved() {
        let mut n = uni_post();
        n["metadata"]["account"] = json!("aaron");
        let e = check_approvable(&n, "2026-10-29T10:00:00.000Z").unwrap_err().to_string();
        assert!(e.contains("never go out under your name"), "{e}");
        n["metadata"]["account"] = json!("uni");
        n["metadata"]["provenance"] = json!("aaron-typed");
        assert!(check_approvable(&n, "2026-10-29T10:00:00.000Z").is_err());
    }

    #[test]
    fn only_a_proposed_post_at_the_revision_seen_fits_its_platform() {
        assert!(matches!(check_approvable(&uni_post(), "2026-10-29T09:00:00.000Z"), Err(Error::Conflict(_))));
        let mut n = uni_post();
        n["metadata"]["state"] = json!("posted");
        assert!(check_approvable(&n, "2026-10-29T10:00:00.000Z").is_err());
        let mut n = uni_post();
        n["metadata"]["body"] = json!("x".repeat(301));
        assert!(check_approvable(&n, "2026-10-29T10:00:00.000Z").unwrap_err().to_string().contains("allows 300"));
        let mut n = uni_post();
        n["tags"] = json!(["task"]);
        assert!(check_approvable(&n, "2026-10-29T10:00:00.000Z").is_err());
        let mut n = uni_post();
        n["metadata"]["media"] = json!(["att1"]);
        assert!(check_approvable(&n, "2026-10-29T10:00:00.000Z").is_err());
    }

    #[test]
    fn approve_args_are_one_compare_and_set_with_the_signature() {
        let keys = Keys::generate();
        let p = Post::from_note(&uni_post());
        let ev = approval_event(&keys, "uni", "01TESTNOTE", &p, 1_800_000_000, 1_800_000_000).unwrap();
        let a = approve_args("uni", "01TESTNOTE", &ev, "d", None, "2026-10-29T10:00:00.000Z");
        assert_eq!(a["state_transition"], json!({"field": "state", "from": "proposed", "to": "approved"}));
        assert_eq!(a["if_updated_at"], "2026-10-29T10:00:00.000Z");
        let stored = Event::from_json(a["metadata"]["approval_event"].as_str().unwrap()).unwrap();
        stored.verify().unwrap();
        assert_eq!(stored.id, ev.id);
    }

    #[test]
    fn a_post_the_poster_has_claimed_cant_be_stopped_quietly() {
        let mut n = uni_post();
        assert!(check_droppable(&n).is_ok());
        n["metadata"]["state"] = json!("approved");
        assert!(check_droppable(&n).is_ok());
        n["metadata"]["state"] = json!("posting");
        assert!(check_droppable(&n).unwrap_err().to_string().contains("already going out"));
        n["metadata"]["state"] = json!("posted");
        assert!(check_droppable(&n).is_err());
    }

    #[test]
    fn any_claim_in_the_history_means_going_out_whatever_the_note_says_now() {
        let older = json!({"version_ix": 0, "metadata": {"state": "proposed"}});
        let claim = json!({"version_ix": 1, "metadata": {"state": "posting", "posting_approval": "a".repeat(64)}});
        // a claim on another approval id, or with the current approval blanked, still counts
        let blank = json!({"version_ix": 1, "metadata": {"state": "posting"}});
        assert!(claimed(&[older.clone(), claim]));
        assert!(claimed(&[older.clone(), blank]));
        assert!(!claimed(&[older]));
        assert!(!claimed(&[]));
        let keys = Keys::generate();
        let p = Post::from_note(&uni_post());
        let ev = approval_event(&keys, "uni", "01TESTNOTE", &p, 1_800_000_000, 1_800_000_000).unwrap();
        let mut n = uni_post();
        n["metadata"]["approval_event"] = json!(ev.as_json());
        assert_eq!(approval_id(&n), ev.id.to_hex());
    }

    #[test]
    fn a_history_answer_is_read_from_the_hub_fan_out_and_an_unknown_shape_is_an_error() {
        let row = json!({"version_ix": 0, "metadata": {"state": "posting"}});
        let hub = json!({"vaults_queried": ["uni"], "results": [{"vault": "uni", "notes": {"versions": [row], "total": 1}}]});
        assert_eq!(versions_in(&hub, "uni").unwrap().0.len(), 1);
        let direct = json!({"versions": [], "total": 0});
        assert_eq!(versions_in(&direct, "uni").unwrap(), (vec![], 0));
        assert!(versions_in(&hub, "other").is_err());
        assert!(versions_in(&json!({"notes": []}), "uni").is_err());
        assert!(versions_in(&json!({"versions": []}), "uni").is_err());
    }

    #[test]
    fn a_reject_names_the_note_and_is_not_an_approval() {
        let keys = Keys::generate();
        let ev = reject_event(&keys, "uni", "01TESTNOTE", &"d".repeat(64), 1_800_000_000).unwrap();
        ev.verify().unwrap();
        assert!(ev.tags.iter().any(|t| t.as_slice() == ["verdict", "reject"]));
        // it names the exact post it stops, so that post can never go out again
        assert!(ev.tags.iter().any(|t| t.as_slice() == ["digest".to_string(), "d".repeat(64)]));
        assert!(!ev.tags.iter().any(|t| t.as_slice()[0] == "not_before"));
    }

    #[test]
    fn an_essay_record_digests_its_title_path_and_date() {
        let mut n = note(json!({"state": "proposed", "account": "aaron", "platform": "atproto-site", "provenance": "aaron-typed",
            "piece": "https://example.com/p/", "body": "# Slow work", "media": [], "title": "Slow work", "site_path": "/p/",
            "published_at": "2026-10-29T12:00:00Z"}));
        let a = digest("uni", "01TESTNOTE", &Post::from_note(&n), &[]);
        n["metadata"]["title"] = json!("Another title");
        assert_ne!(a, digest("uni", "01TESTNOTE", &Post::from_note(&n), &[]));
        n["metadata"]["title"] = json!("");
        assert!(check_approvable(&n, "2026-10-29T10:00:00.000Z").is_err());
    }
}
