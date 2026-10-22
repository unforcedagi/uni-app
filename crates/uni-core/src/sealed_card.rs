//! T-234 sealed credentials, milestone 2: Uni's approval card and the morning card (uni-ops CARD.md §2–5; the morning
//! card's fence is CONTRACT-CHANGES.md P2), checked and answered natively.
//!
//! **The card.** Uni posts a kind-9 message whose fields are in a fenced ```` ```uni-sealed-approval ```` block (one
//! request) or ```` ```uni-sealed-morning ```` block (`{"v":1,"rows":[…]}`, one request per routine credential). The
//! prose around the block is a courtesy; nothing here reads it.
//!
//! **The checks** ([`check_card`]), in CARD.md §3's order, all before an approve button shows:
//! 1. signed by the trusted Uni key, kind 9;
//! 2. the fields present and typed exactly, `v == 1`, nothing extra;
//! 3. not expired;
//! 4. `payload_digest` recomputed from `action` and `payload`;
//! 5. the box opens with this device's sealing key and names the card's credential and ciphertext;
//! 6. the class inside the box is the card's, and the window and uses are within that class's caps.
//!
//! The morning card is refused whole if any row is not `routine`, and every row is checked as a single card.
//!
//! **The answer** ([`answer`]) is a NIP-59 gift wrap per request: `p` = Uni, both layers encrypted to the request's
//! one-time key `rpk`, sealed by the identity key; the rumor is kind 46042, `["e", <card id>]`,
//! `{"dek","v","rid","request_digest","decision"}` (`dek` only on approve); its `expiration` is the card's `expires`.
//! The data key is opened again from the signed card at the tap, never taken from the webview, and never shown,
//! logged or put in any view. Each request is answered once, with one decision: the answer is written to
//! [`ANSWERS_FILE`] before its wrap goes out, so a retry sends the same decision and a second tap sends nothing. A card
//! carrying a request id or one-time key already answered under another card is a replay and is refused.

use std::path::Path;

use nostr::hashes::{sha256, Hash};
use nostr::{Event, EventId, JsonUtil, Keys, Kind, PublicKey, Tag};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use zeroize::Zeroizing;

use crate::sealed::{derive_seal_key, save_json, SealKey};
use crate::store::Store;
use crate::{Error, Result};

/// Fence language of a single approval card.
pub const CARD_FENCE: &str = "uni-sealed-approval";
/// Fence language of the morning card (CONTRACT-CHANGES.md P2).
pub const MORNING_FENCE: &str = "uni-sealed-morning";
/// Rumor kind of an answer (inside the gift wrap only), next to the secret desk's 46040 and 46041.
pub const KIND_APPROVAL_REPLY: u16 = 46042;
/// In the app's data folder: every request answered here (public facts and, until the relay has it, the wrap).
pub const ANSWERS_FILE: &str = "sealed-answers.json";
/// The broker puts at most this many rows on a morning card.
pub const MORNING_MAX_ROWS: usize = 20;
/// A wrap kept for a retry is sent again as the same event while it is this young; Buzz refuses events more than
/// 15 minutes from its clock, so an older one is wrapped afresh (same decision, same rumor content).
pub const RESEND_SAME_WRAP_SECS: u64 = 600;
/// Answers are kept this long after their card expired, then dropped from the file.
const KEEP_AFTER_EXPIRY_SECS: u64 = 7 * 86_400;
const PAYLOAD_VERSION: &str = "uni-sealed-payload/v1";
const REQUEST_VERSION: &str = "uni-sealed-request/v1";
/// The fields of one request (CARD.md §2), exactly.
const FIELDS: [&str; 13] =
    ["v", "rid", "action", "credential", "class", "scope", "ttl_s", "uses", "payload", "payload_digest", "expires", "rpk", "box"];

/// The class fixed when the credential was sealed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Class {
    Routine,
    Powerful,
}

impl Class {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "routine" => Some(Self::Routine),
            "powerful" => Some(Self::Powerful),
            _ => None,
        }
    }

    /// The most one tap may release: (seconds open, uses) (CARD.md §3.6).
    pub fn caps(self) -> (u64, u64) {
        match self {
            Self::Routine => (50_400, 200),
            Self::Powerful => (600, 1),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CardKind {
    Single,
    Morning,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Approve,
    Deny,
}

/// Why a card shows greyed out with no buttons, in the one line the card shows (CARD.md §3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    NotUni,
    Incomplete,
    Expired,
    Mismatch,
    NotSealedHere,
    OtherCredential,
    Misstated,
    TooLong(Class),
    PowerfulOnMorning,
    Replayed,
}

impl Refusal {
    pub fn message(self) -> &'static str {
        match self {
            Self::NotUni => "Not signed by Uni.",
            Self::Incomplete => "This card is incomplete.",
            Self::Expired => "This card has expired.",
            Self::Mismatch => "What's shown doesn't match what's approved.",
            Self::NotSealedHere => "This card isn't sealed to this device's approvals key.",
            Self::OtherCredential => "The key in this card belongs to a different credential.",
            Self::Misstated => "This card misstates the credential's class.",
            Self::TooLong(Class::Powerful) => "A powerful credential can't be opened for that long.",
            Self::TooLong(Class::Routine) => "A routine credential can't be opened for that long or that often.",
            Self::PowerfulOnMorning => "A powerful credential can never be on the morning card.",
            Self::Replayed => "This card repeats a request that was already answered.",
        }
    }
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

impl From<Refusal> for Error {
    fn from(r: Refusal) -> Self {
        Error::Invalid(r.message().into())
    }
}

/// `canonical_json` of CARD.md §2 (Python `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)`):
/// sorted keys, no spaces, UTF-8. Integers only: a float could print differently here and in the broker, so a payload
/// holding one can't be checked (None), and the card is refused rather than shown.
pub fn canonical_json(v: &Value) -> Option<String> {
    fn write(v: &Value, out: &mut String) -> bool {
        match v {
            Value::Null => out.push_str("null"),
            Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Value::Number(n) => match (n.as_i64(), n.as_u64()) {
                (Some(i), _) => out.push_str(&i.to_string()),
                (None, Some(u)) => out.push_str(&u.to_string()),
                _ => return false,
            },
            // serde_json escapes exactly what Python does with ensure_ascii=False: `"`, `\`, and U+0000..U+001F
            // (\b \f \n \r \t short, the rest as lowercase \u00xx)
            Value::String(s) => out.push_str(&serde_json::to_string(s).unwrap_or_default()),
            Value::Array(xs) => {
                out.push('[');
                for (i, x) in xs.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    if !write(x, out) {
                        return false;
                    }
                }
                out.push(']');
            }
            Value::Object(m) => {
                // Rust orders strings by UTF-8 bytes, which is code point order, as Python sorts
                let mut keys: Vec<&String> = m.keys().collect();
                keys.sort();
                out.push('{');
                for (i, k) in keys.into_iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&serde_json::to_string(k).unwrap_or_default());
                    out.push(':');
                    if !write(&m[k], out) {
                        return false;
                    }
                }
                out.push('}');
            }
        }
        true
    }
    let mut out = String::new();
    write(v, &mut out).then_some(out)
}

fn sha256_hex(parts: &[&[u8]]) -> String {
    use nostr::hashes::HashEngine;
    let mut e = sha256::HashEngine::default();
    for p in parts {
        e.input(p);
    }
    sha256::Hash::from_engine(e).to_string()
}

/// `sha256("uni-sealed-payload/v1\n" + action + "\n" + canonical_json(payload))`, hex.
pub fn payload_digest(action: &str, payload: &Value) -> Option<String> {
    let c = canonical_json(payload)?;
    Some(sha256_hex(&[PAYLOAD_VERSION.as_bytes(), b"\n", action.as_bytes(), b"\n", c.as_bytes()]))
}

/// `sha256("uni-sealed-request/v1\n" + canonical_json(all fields))`, hex: what the answer echoes.
pub fn request_digest(fields: &Value) -> Option<String> {
    let c = canonical_json(fields)?;
    Some(sha256_hex(&[REQUEST_VERSION.as_bytes(), b"\n", c.as_bytes()]))
}

fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// `[a-z0-9][a-z0-9._-]{0,63}` (a credential), or with `:` too (an action).
fn valid_name(s: &str, colon: bool) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(c) || (colon && *c == b':'))
}

/// One request, checked. The data key opened from its box stays in here: no `Serialize`, and `Debug` leaves it out.
pub struct Request {
    pub rid: String,
    pub action: String,
    pub credential: String,
    pub class: Class,
    pub scope: String,
    pub ttl_s: u64,
    pub uses: u64,
    pub payload: Value,
    pub payload_digest: String,
    pub expires: u64,
    pub rpk: PublicKey,
    pub request_digest: String,
    dek: Zeroizing<String>,
}

impl std::fmt::Debug for Request {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Request")
            .field("rid", &self.rid)
            .field("credential", &self.credential)
            .field("action", &self.action)
            .field("request_digest", &self.request_digest)
            .finish_non_exhaustive()
    }
}

/// What the box holds (CARD.md §3.5). Extra fields are allowed (a later inner version may add some).
#[derive(Deserialize)]
struct Inner {
    v: u64,
    name: String,
    class: String,
    dek: String,
    ct_sha256: String,
}

/// §3 steps 2 to 6 for one request's fields.
fn check_request(f: &Value, seal: &SealKey, now: u64) -> std::result::Result<Request, Refusal> {
    use Refusal::*;
    let m = f.as_object().ok_or(Incomplete)?;
    if m.len() != FIELDS.len() || !FIELDS.iter().all(|k| m.contains_key(*k)) {
        return Err(Incomplete);
    }
    let s = |k: &str| m[k].as_str().ok_or(Incomplete);
    let n = |k: &str| m[k].as_u64().ok_or(Incomplete);
    let (rid, action, credential, scope, digest) = (s("rid")?, s("action")?, s("credential")?, s("scope")?, s("payload_digest")?);
    let class = Class::parse(s("class")?).ok_or(Incomplete)?;
    let (v, ttl_s, uses, expires) = (n("v")?, n("ttl_s")?, n("uses")?, n("expires")?);
    let rpk = s("rpk")?;
    let bx = m["box"].as_object().ok_or(Incomplete)?;
    let bs = |k: &str| bx.get(k).and_then(Value::as_str).ok_or(Incomplete);
    let (epk, dek_box, ct_sha256) = (bs("epk")?, bs("dek_box")?, bs("ct_sha256")?);
    let scope_len = scope.chars().count();
    let well_formed = v == 1
        && is_hex(rid, 32)
        && valid_name(action, true)
        && valid_name(credential, false)
        && !scope.trim().is_empty()
        && (1..=280).contains(&scope_len)
        && is_hex(digest, 64)
        && is_hex(rpk, 64)
        && bx.len() == 3
        && is_hex(epk, 64)
        && is_hex(ct_sha256, 64);
    if !well_formed {
        return Err(Incomplete);
    }
    // nostr's `from_hex` takes any 32 bytes; `xonly` checks the point is on the curve
    let key = |h: &str| PublicKey::from_hex(h).ok().filter(|k| k.xonly().is_ok()).ok_or(Incomplete);
    let (rpk, epk) = (key(rpk)?, key(epk)?);
    // 3
    if expires <= now {
        return Err(Expired);
    }
    // 4
    if payload_digest(action, &m["payload"]).as_deref() != Some(digest) {
        return Err(Mismatch);
    }
    let request_digest = request_digest(f).ok_or(Mismatch)?;
    // 5
    let opened = seal.open_box(&epk, dek_box).map_err(|_| NotSealedHere)?;
    let inner: Inner = serde_json::from_str(&opened).map_err(|_| NotSealedHere)?;
    let dek = Zeroizing::new(inner.dek);
    if inner.v != 1 || inner.name != credential || inner.ct_sha256 != ct_sha256 || !is_hex(&dek, 64) {
        return Err(OtherCredential);
    }
    // 6
    if Class::parse(&inner.class) != Some(class) {
        return Err(Misstated);
    }
    let (max_ttl, max_uses) = class.caps();
    if !(1..=max_ttl).contains(&ttl_s) || !(1..=max_uses).contains(&uses) {
        return Err(TooLong(class));
    }
    Ok(Request {
        rid: rid.into(),
        action: action.into(),
        credential: credential.into(),
        class,
        scope: scope.into(),
        ttl_s,
        uses,
        payload: m["payload"].clone(),
        payload_digest: digest.into(),
        expires,
        rpk,
        request_digest,
        dek,
    })
}

/// The one fenced block of `lang` in `body`: Err when the fence opens twice or never closes.
fn fenced<'a>(body: &'a str, lang: &str) -> std::result::Result<Option<&'a str>, Refusal> {
    let open = format!("```{lang}\n");
    let Some(at) = body.find(&open) else { return Ok(None) };
    if body[at + open.len()..].contains(&open) {
        return Err(Refusal::Incomplete);
    }
    let start = at + open.len();
    let end = body[start..].find("\n```").ok_or(Refusal::Incomplete)?;
    Ok(Some(&body[start..start + end]))
}

/// Which card a message body carries, unverified (to route it to the card; [`check_card`] decides what it is).
pub fn card_kind(body: &str) -> Option<CardKind> {
    if body.contains(&format!("```{CARD_FENCE}\n")) {
        Some(CardKind::Single)
    } else if body.contains(&format!("```{MORNING_FENCE}\n")) {
        Some(CardKind::Morning)
    } else {
        None
    }
}

/// A card that passed every check: one request (single) or one per row (morning).
#[derive(Debug)]
pub struct Card {
    pub kind: CardKind,
    pub event_id: EventId,
    pub rows: Vec<Request>,
}

impl Card {
    pub fn expires(&self) -> u64 {
        self.rows.iter().map(|r| r.expires).min().unwrap_or(0)
    }
}

/// CARD.md §3 for the signed event `ev`, at `now`, with `uni` the trusted Uni key and `seal` this device's sealing key.
pub fn check_card(ev: &Event, uni: &PublicKey, seal: &SealKey, now: u64) -> std::result::Result<Card, Refusal> {
    use Refusal::*;
    // 1
    if ev.verify().is_err() || ev.pubkey != *uni || ev.kind != Kind::Custom(9) {
        return Err(NotUni);
    }
    let parse = |s: &str| serde_json::from_str::<Value>(s).map_err(|_| Incomplete);
    match (fenced(&ev.content, CARD_FENCE)?, fenced(&ev.content, MORNING_FENCE)?) {
        (Some(block), None) => {
            let f = parse(block)?;
            Ok(Card { kind: CardKind::Single, event_id: ev.id, rows: vec![check_request(&f, seal, now)?] })
        }
        (None, Some(block)) => {
            let body = parse(block)?;
            let m = body.as_object().ok_or(Incomplete)?;
            let rows = m.get("rows").and_then(Value::as_array).ok_or(Incomplete)?;
            if m.len() != 2 || m.get("v").and_then(Value::as_u64) != Some(1) || rows.is_empty() || rows.len() > MORNING_MAX_ROWS {
                return Err(Incomplete);
            }
            // the whole card, before any row is opened (P2: "if any row's class is not routine, refuse the whole card")
            if rows.iter().any(|r| r.get("class").is_some_and(|c| c.as_str() != Some("routine"))) {
                return Err(PowerfulOnMorning);
            }
            // every row is then routine inside its box too (§3.6 refuses a misstated class)
            let rows = rows.iter().map(|r| check_request(r, seal, now)).collect::<std::result::Result<Vec<_>, _>>()?;
            // one row per credential, each its own request and one-time key, all answered by the same time
            let distinct = |f: fn(&Request) -> String| {
                let mut xs: Vec<String> = rows.iter().map(f).collect();
                xs.sort();
                xs.dedup();
                xs.len() == rows.len()
            };
            if !distinct(|r| r.rid.clone()) || !distinct(|r| r.rpk.to_hex()) || !distinct(|r| r.credential.clone())
                || rows.iter().any(|r| r.expires != rows[0].expires)
            {
                return Err(Incomplete);
            }
            Ok(Card { kind: CardKind::Morning, event_id: ev.id, rows })
        }
        _ => Err(Incomplete),
    }
}

/// One request answered here. Public facts, plus the signed wrap until the relay has taken it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Answer {
    /// The card's event id.
    pub card: String,
    pub rid: String,
    pub request_digest: String,
    pub rpk: String,
    pub decision: Decision,
    /// When it was tapped.
    pub at: u64,
    /// Approve: when the broker's window closes at the latest (tap + `ttl_s`).
    pub until: Option<u64>,
    pub expires: u64,
    /// The wrap (a public, signed event: ciphertext to `rpk`) while it isn't known to be on the relay.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wrap: Option<String>,
    pub sent: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Answers {
    pub answers: Vec<Answer>,
}

impl Answers {
    /// The answers file. Missing is empty; unreadable is an error, never empty (that would forget what was answered).
    pub fn load(dir: &Path) -> Result<Self> {
        match std::fs::read_to_string(dir.join(ANSWERS_FILE)) {
            Ok(s) => serde_json::from_str(&s).map_err(|_| Error::Invalid("the record of answered approvals can't be read".into())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(_) => Err(Error::Invalid("the record of answered approvals can't be read".into())),
        }
    }

    fn save(&mut self, dir: &Path, now: u64) -> Result<()> {
        // an unsent answer past its card's expiry can never be taken (the broker refuses it), so it ages out the same way
        self.answers.retain(|a| a.expires + KEEP_AFTER_EXPIRY_SECS > now);
        save_json(&dir.join(ANSWERS_FILE), self)
    }

    /// This card's answers.
    pub fn for_card(&self, id: &EventId) -> Vec<&Answer> {
        let id = id.to_hex();
        self.answers.iter().filter(|a| a.card == id).collect()
    }

    /// A row of `card` already answered as part of something else: its request id or one-time key under another card,
    /// or its request id with other fields.
    pub fn replays(&self, card: &Card) -> bool {
        let id = card.event_id.to_hex();
        card.rows.iter().any(|r| {
            let rpk = r.rpk.to_hex();
            self.answers.iter().any(|a| {
                (a.rid == r.rid || a.rpk == rpk) && (a.card != id || a.rid != r.rid || a.request_digest != r.request_digest)
            })
        })
    }
}

/// The 46042 rumor content. The data key comes first, so the serialized rumor's tail (the last bytes a hash engine
/// holds, see `secret::rumor_id`) is the request id, digest and decision, never part of the key.
fn reply_json(r: &Request, decision: Decision) -> Result<Zeroizing<String>> {
    #[derive(Serialize)]
    struct Reply<'a> {
        #[serde(skip_serializing_if = "Option::is_none")]
        dek: Option<&'a str>,
        v: u8,
        rid: &'a str,
        request_digest: &'a str,
        decision: Decision,
    }
    let dek = (decision == Decision::Approve).then_some(r.dek.as_str());
    let body = Reply { dek, v: 1, rid: &r.rid, request_digest: &r.request_digest, decision };
    crate::secret::json_zeroizing(&body, 256 + 6 * (r.dek.len() + r.rid.len() + r.request_digest.len()))
}

/// The gift wrap answering `r` (CARD.md §5): routed to `uni`, encrypted to the request's one-time key, sealed by
/// `identity`, expiring with the card.
pub fn reply_wrap(identity: &Keys, uni: &PublicKey, card: &EventId, r: &Request, decision: Decision, now: u64) -> Result<Event> {
    let content = reply_json(r, decision)?;
    let e = Tag::parse(["e", &card.to_hex()]).map_err(|e| Error::Invalid(e.to_string()))?;
    crate::secret::wrap(identity, uni, &r.rpk, KIND_APPROVAL_REPLY, &content, vec![e], now, r.expires)
}

/// One enrollment-style lock: one answer at a time in this process, so two taps can't both find a request unanswered.
static ANSWERING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Answer `rids` of the card `ev` with `decision`: check the card again (§3, at `now`), refuse a replay or a second
/// answer, record each answer before its wrap goes out, then publish. A retry (an earlier answer the relay didn't
/// take) sends the same decision again and nothing new. Returns this card's answers.
#[allow(clippy::too_many_arguments)]
pub async fn answer(
    relay_url: &str,
    identity: &Keys,
    auth_tag: Option<&Tag>,
    ev: &Event,
    uni: &PublicKey,
    decision: Decision,
    rids: &[String],
    state_dir: &Path,
    now: u64,
) -> Result<Vec<Answer>> {
    let _one = ANSWERING.lock().await;
    let seal = derive_seal_key(identity)?;
    let mut answers = Answers::load(state_dir)?;
    let card = check_card(ev, uni, &seal, now)?;
    if answers.replays(&card) {
        return Err(Refusal::Replayed.into());
    }
    let mut wanted: Vec<&Request> = Vec::new();
    for rid in rids {
        let r = card.rows.iter().find(|r| &r.rid == rid).ok_or_else(|| Error::Invalid("that request isn't on this card".into()))?;
        if wanted.iter().any(|w| w.rid == r.rid) {
            return Err(Error::Invalid("a request was named twice".into()));
        }
        wanted.push(r);
    }
    if wanted.is_empty() {
        return Err(Error::Invalid("nothing was chosen".into()));
    }
    let earlier = answers.for_card(&card.event_id);
    if !earlier.is_empty() {
        // answered before: only a retry of exactly what was decided then
        let same = wanted.iter().all(|r| earlier.iter().any(|a| a.rid == r.rid && a.decision == decision));
        if !same {
            return Err(Error::Invalid("this card was already answered".into()));
        }
    } else {
        for r in &wanted {
            let wrap = reply_wrap(identity, uni, &card.event_id, r, decision, now)?;
            answers.answers.push(Answer {
                card: card.event_id.to_hex(),
                rid: r.rid.clone(),
                request_digest: r.request_digest.clone(),
                rpk: r.rpk.to_hex(),
                decision,
                at: now,
                until: (decision == Decision::Approve).then_some(now + r.ttl_s),
                expires: r.expires,
                wrap: Some(wrap.as_json()),
                sent: false,
            });
        }
        // on disk before anything goes out: whatever happens next, this request has this answer and no other
        answers.save(state_dir, now).map_err(|e| Error::Invalid(format!("couldn't keep the answer, so nothing was sent ({e})")))?;
    }

    let card_id = card.event_id.to_hex();
    let unsent: Vec<usize> = (0..answers.answers.len())
        .filter(|&i| {
            let a = &answers.answers[i];
            a.card == card_id && !a.sent && wanted.iter().any(|r| r.rid == a.rid)
        })
        .collect();
    if !unsent.is_empty() {
        crate::init_crypto();
        let mut client = crate::BuzzClient::connect(relay_url, identity, auth_tag).await?;
        let mut failed: Option<Error> = None;
        for i in unsent {
            let a = &answers.answers[i];
            let kept = a.wrap.as_deref().and_then(|w| Event::from_json(w).ok());
            let wrap = match kept.filter(|w| now.saturating_sub(w.created_at.as_secs()) <= RESEND_SAME_WRAP_SECS) {
                Some(w) => w,
                None => {
                    // an error here still saves what this loop already sent, and closes the socket, below
                    let r = wanted.iter().find(|r| r.rid == a.rid).expect("filtered to wanted rows");
                    match reply_wrap(identity, uni, &card.event_id, r, a.decision, now) {
                        Ok(w) => {
                            answers.answers[i].wrap = Some(w.as_json());
                            w
                        }
                        Err(e) => {
                            failed = Some(e);
                            break;
                        }
                    }
                }
            };
            match client.publish(wrap).await {
                Ok(ok) if ok.accepted => {
                    answers.answers[i].sent = true;
                    answers.answers[i].wrap = None;
                }
                Ok(ok) => {
                    failed = Some(Error::RelayRejected(ok.message));
                    break;
                }
                Err(e) => {
                    failed = Some(e);
                    break;
                }
            }
        }
        let _ = client.disconnect().await;
        answers.save(state_dir, now)?;
        if let Some(e) = failed {
            return Err(e);
        }
    }
    Ok(answers.for_card(&card.event_id).into_iter().cloned().collect())
}

/// The signed card behind message `reference` in `channel`, as kept at ingest (never the cached row).
pub fn stored_card(store: &Store, channel: &str, reference: &str) -> Result<Event> {
    let unverifiable = || Error::Invalid("this card can't be verified; ask Uni for a new one".into());
    store.message(channel, reference)?.ok_or_else(|| Error::Invalid("card not found; refresh the room".into()))?;
    let json = store.signed_event(reference)?.ok_or_else(unverifiable)?;
    let ev = Event::from_json(&json).map_err(|_| unverifiable())?;
    if ev.id.to_hex() != reference || crate::buzz::event_channel(&ev).map(|c| c.to_string()).as_deref() != Some(channel) {
        return Err(unverifiable());
    }
    Ok(ev)
}

/// An answer, as the card shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AnswerView {
    pub decision: Decision,
    pub at: u64,
    pub until: Option<u64>,
    pub sent: bool,
}

/// One verified request, as the card draws it. No data key, no box.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RowView {
    pub rid: String,
    pub action: String,
    pub credential: String,
    pub class: Class,
    pub scope: String,
    pub ttl_s: u64,
    pub uses: u64,
    pub payload: Value,
    pub request_digest: String,
    pub expires: u64,
    pub answer: Option<AnswerView>,
}

/// What the card shows: its rows when every check passed, else the one-line reason and nothing to tap.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CardView {
    pub kind: Option<CardKind>,
    pub event_id: String,
    pub refused: Option<String>,
    pub rows: Vec<RowView>,
}

/// The card `ev` as it stands now. A card answered here is shown as it was when answered, even once it has expired.
pub fn view(ev: &Event, uni: &PublicKey, seal: &SealKey, answers: &Answers, now: u64) -> CardView {
    let kind = card_kind(&ev.content);
    let refused = |r: Refusal| CardView { kind, event_id: ev.id.to_hex(), refused: Some(r.message().into()), rows: vec![] };
    let earlier = answers.for_card(&ev.id);
    let checked = match check_card(ev, uni, seal, now) {
        Err(Refusal::Expired) if !earlier.is_empty() => check_card(ev, uni, seal, earlier.iter().map(|a| a.at).min().unwrap_or(now)),
        other => other,
    };
    let card = match checked {
        Ok(c) => c,
        Err(r) => return refused(r),
    };
    if answers.replays(&card) {
        return refused(Refusal::Replayed);
    }
    let rows = card
        .rows
        .iter()
        .map(|r| RowView {
            rid: r.rid.clone(),
            action: r.action.clone(),
            credential: r.credential.clone(),
            class: r.class,
            scope: r.scope.clone(),
            ttl_s: r.ttl_s,
            uses: r.uses,
            payload: r.payload.clone(),
            request_digest: r.request_digest.clone(),
            expires: r.expires,
            answer: earlier
                .iter()
                .find(|a| a.rid == r.rid)
                .map(|a| AnswerView { decision: a.decision, at: a.at, until: a.until, sent: a.sent }),
        })
        .collect();
    CardView { kind: Some(card.kind), event_id: ev.id.to_hex(), refused: None, rows }
}

/// A card waiting for a tap, for Needs you.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Waiting {
    #[serde(rename = "ref")]
    pub reference: String,
    pub channel: String,
    pub root: Option<String>,
    pub ts: i64,
    pub kind: CardKind,
    /// Single: the credential; morning: none.
    pub credential: Option<String>,
    pub action: Option<String>,
    pub class: Class,
    pub rows: usize,
    pub expires: u64,
    pub fingerprint: String,
}

/// Every card from `uni` in the last day that passes its checks now and isn't answered here, oldest first.
pub fn waiting(store: &Store, me: &str, uni: &PublicKey, seal: &SealKey, answers: &Answers, now: u64) -> Result<Vec<Waiting>> {
    let since = now.saturating_sub(86_400) as i64;
    let rows = store.approval_messages("```uni-sealed-", &[], since, Some(me), 200)?;
    let uni_hex = uni.to_hex();
    let mut out = Vec::new();
    for m in rows {
        if !m.item.author.eq_ignore_ascii_case(&uni_hex) || card_kind(&m.item.body).is_none() {
            continue;
        }
        let Ok(ev) = stored_card(store, &m.item.channel, &m.item.r#ref) else { continue };
        let Ok(card) = check_card(&ev, uni, seal, now) else { continue };
        if !answers.for_card(&card.event_id).is_empty() || answers.replays(&card) {
            continue;
        }
        let first = &card.rows[0];
        let single = card.kind == CardKind::Single;
        out.push(Waiting {
            reference: m.item.r#ref.clone(),
            channel: m.item.channel.clone(),
            root: m.root.clone(),
            ts: m.item.ts,
            kind: card.kind,
            credential: single.then(|| first.credential.clone()),
            action: single.then(|| first.action.clone()),
            class: first.class,
            rows: card.rows.len(),
            expires: card.expires(),
            fingerprint: first.request_digest[..8].to_string(),
        });
    }
    out.sort_by_key(|w| w.ts);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::nips::nip44;
    use nostr::EventBuilder;
    use serde_json::json;

    const ROOM: &str = "6a0c3f1e-1111-4222-8333-944455556666";
    const NOW: u64 = 1_760_000_000;
    /// A synthetic data key: it must reach the one-time key inside the rumor, and nowhere else.
    const DEK: &str = "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a";
    const CT: &str = "c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7";

    struct World {
        me: Keys,
        uni: Keys,
        seal: SealKey,
    }

    fn world() -> World {
        let me = Keys::generate();
        World { seal: derive_seal_key(&me).unwrap(), me, uni: Keys::generate() }
    }

    /// The credential's data key sealed to `to`, as the broker's `seal_value` does.
    fn boxed(to: &PublicKey, name: &str, class: &str) -> Value {
        let esk = Keys::generate();
        let inner = json!({"v": 1, "name": name, "class": class, "dek": DEK, "ct_sha256": CT}).to_string();
        let dek_box = nip44::encrypt(esk.secret_key(), to, inner, nip44::Version::V2).unwrap();
        json!({"epk": esk.public_key().to_hex(), "dek_box": dek_box, "ct_sha256": CT})
    }

    /// One request's fields, as the broker's `_fields` writes them; returns them with the one-time key.
    fn fields(w: &World, credential: &str, class: &str, ttl_s: u64, uses: u64) -> (Value, Keys) {
        let one_time = Keys::generate();
        let action = "dns.edit";
        let payload = json!({"name": "demo", "type": "A", "content": "192.0.2.7", "zone": "example.org", "note": "https://example.org/?a=<b>"});
        let f = json!({
            "v": 1, "rid": &Keys::generate().public_key().to_hex()[..32], "action": action, "credential": credential, "class": class,
            "scope": "Add an A record for demo.example.org", "ttl_s": ttl_s, "uses": uses,
            "payload_digest": payload_digest(action, &payload).unwrap(), "payload": payload, "expires": NOW + 900,
            "rpk": one_time.public_key().to_hex(), "box": boxed(&w.seal.public_key(), credential, class),
        });
        (f, one_time)
    }

    fn signed(by: &Keys, kind: u16, content: String) -> Event {
        EventBuilder::new(Kind::Custom(kind), content).tags([Tag::parse(["h", ROOM]).unwrap()]).sign_with_keys(by).unwrap()
    }

    fn card(by: &Keys, f: &Value) -> Event {
        signed(by, 9, format!("🔑 **Uni asks to use x**\nFor: dns.edit.\n\n```{CARD_FENCE}\n{}\n```", serde_json::to_string_pretty(f).unwrap()))
    }

    fn morning(by: &Keys, rows: &[Value]) -> Event {
        signed(by, 9, format!("🔑 **Uni's morning card**\n\n```{MORNING_FENCE}\n{}\n```", json!({"v": 1, "rows": rows})))
    }

    fn check(w: &World, ev: &Event) -> std::result::Result<Card, Refusal> {
        check_card(ev, &w.uni.public_key(), &w.seal, NOW)
    }

    /// `f` with `change` applied and its payload digest left as it was.
    fn with(f: &Value, change: impl FnOnce(&mut Value)) -> Value {
        let mut g = f.clone();
        change(&mut g);
        g
    }

    #[test]
    fn canonical_json_and_the_digests_match_the_reference() {
        // computed by the broker's `sealed.canonical` / `payload_digest` / `request_digest` (uni-ops sealed.py)
        let v = json!({"b": [1, "é\n\u{1}\"\\\u{7f}", null, true, 0, 18446744073709551615u64],
            "a": {"z": -3, "é": "\u{2028}/<>", "éa": 1, "Z": 2}, "": ""});
        assert_eq!(canonical_json(&v).unwrap(), "{\"\":\"\",\"a\":{\"Z\":2,\"z\":-3,\"é\":\"\u{2028}/<>\",\"éa\":1},\"b\":[1,\"é\\n\\u0001\\\"\\\\\u{7f}\",null,true,0,18446744073709551615]}");
        assert_eq!(payload_digest("dns.edit", &v).unwrap(), "cc495f425fc7a9726c46709df96d81e42365135a96ff62f7466d56d3a3d76894");
        assert_eq!(payload_digest("dns.edit", &Value::Null).unwrap(), "c39de7b5110b9c7f68683d8fe2b9c6ed9680ceaace256ecfc55ca5682a8fefdb");
        assert_eq!(request_digest(&json!({"v": 1, "x": v})).unwrap(), "7ac3dbd43962b7b7c7b71fc0cbba946b2d93d46579728dacec353d642e697a74");
        // a float can't be checked the same way on both sides: refused, not guessed
        assert_eq!(canonical_json(&json!({"a": 1.5})), None);
        assert_eq!(canonical_json(&json!([1.0])), None);
    }

    #[test]
    fn a_good_card_passes_and_binds_its_digest() {
        let w = world();
        let (f, one_time) = fields(&w, "cloudflare-dns", "powerful", 600, 1);
        let c = check(&w, &card(&w.uni, &f)).unwrap();
        assert_eq!(c.kind, CardKind::Single);
        let r = &c.rows[0];
        assert_eq!((r.credential.as_str(), r.class, r.ttl_s, r.uses), ("cloudflare-dns", Class::Powerful, 600, 1));
        assert_eq!(r.rpk, one_time.public_key());
        assert_eq!(r.request_digest, request_digest(&f).unwrap());
        // the digest covers every field: change any one (re-signed by Uni) and the request digest changes
        for k in ["scope", "ttl_s", "expires"] {
            let g = with(&f, |g| g[k] = if k == "scope" { json!("Delete every record") } else { json!(f[k].as_u64().unwrap() - 1) });
            let other = check(&w, &card(&w.uni, &g)).unwrap();
            assert_ne!(other.rows[0].request_digest, r.request_digest, "{k}");
        }
        // the payload is bound by its own digest: a changed payload with the old digest is refused
        let g = with(&f, |g| g["payload"]["content"] = json!("198.51.100.9"));
        assert_eq!(check(&w, &card(&w.uni, &g)).unwrap_err(), Refusal::Mismatch);
        let g = with(&f, |g| g["payload_digest"] = json!("0".repeat(64)));
        assert_eq!(check(&w, &card(&w.uni, &g)).unwrap_err(), Refusal::Mismatch);
        // the data key never shows in a Debug print
        assert!(!format!("{c:?}").contains(DEK));
    }

    #[test]
    fn a_wrong_signer_or_kind_or_a_tampered_event_is_not_unis() {
        let w = world();
        let (f, _) = fields(&w, "cloudflare-dns", "powerful", 600, 1);
        assert_eq!(check(&w, &card(&Keys::generate(), &f)).unwrap_err(), Refusal::NotUni, "another signer");
        assert_eq!(check(&w, &card(&w.me, &f)).unwrap_err(), Refusal::NotUni, "the owner's own key");
        let mut k1 = card(&w.uni, &f);
        k1 = signed(&w.uni, 1, k1.content.clone());
        assert_eq!(check(&w, &k1).unwrap_err(), Refusal::NotUni, "kind 1");
        // Uni's real card with its content changed and its id and signature kept (what a lying relay serves)
        let real = card(&w.uni, &f);
        let mut v: Value = serde_json::from_str(&real.as_json()).unwrap();
        v["content"] = json!(real.content.replace("\"uses\": 1", "\"uses\": 2"));
        let forged = Event::from_json(v.to_string()).unwrap();
        assert_eq!(check(&w, &forged).unwrap_err(), Refusal::NotUni);
    }

    #[test]
    fn a_box_sealed_to_another_device_or_another_credential_is_refused() {
        let w = world();
        let (f, _) = fields(&w, "cloudflare-dns", "powerful", 600, 1);
        // sealed to another enrollment
        let other = derive_seal_key(&Keys::generate()).unwrap();
        let g = with(&f, |g| g["box"] = boxed(&other.public_key(), "cloudflare-dns", "powerful"));
        assert_eq!(check(&w, &card(&w.uni, &g)).unwrap_err(), Refusal::NotSealedHere);
        // sealed to the owner's identity key, not the sealing key: never opened with the identity
        let g = with(&f, |g| g["box"] = boxed(&w.me.public_key(), "cloudflare-dns", "powerful"));
        assert_eq!(check(&w, &card(&w.uni, &g)).unwrap_err(), Refusal::NotSealedHere);
        // the parent's box relabelled as a dummy
        let g = with(&f, |g| g["credential"] = json!("dummy"));
        assert_eq!(check(&w, &card(&w.uni, &g)).unwrap_err(), Refusal::OtherCredential);
        // another credential's ciphertext
        let g = with(&f, |g| g["box"]["ct_sha256"] = json!("ab".repeat(32)));
        assert_eq!(check(&w, &card(&w.uni, &g)).unwrap_err(), Refusal::OtherCredential);
        // a powerful credential called routine, and the other way round
        let g = with(&f, |g| g["class"] = json!("routine"));
        assert_eq!(check(&w, &card(&w.uni, &g)).unwrap_err(), Refusal::Misstated);
        let g = with(&f, |g| g["box"] = boxed(&w.seal.public_key(), "cloudflare-dns", "routine"));
        assert_eq!(check(&w, &card(&w.uni, &g)).unwrap_err(), Refusal::Misstated);
    }

    #[test]
    fn the_class_caps_are_enforced_here() {
        let w = world();
        for (class, ttl, uses, ok) in [
            ("powerful", 600, 1, true), ("powerful", 601, 1, false), ("powerful", 60, 2, false), ("powerful", 0, 1, false),
            ("routine", 50_400, 200, true), ("routine", 50_401, 1, false), ("routine", 60, 201, false), ("routine", 60, 0, false),
        ] {
            let (f, _) = fields(&w, "r2-backups", class, ttl, uses);
            let got = check(&w, &card(&w.uni, &f));
            if ok {
                assert!(got.is_ok(), "{class} {ttl} {uses}");
            } else {
                assert_eq!(got.unwrap_err(), Refusal::TooLong(Class::parse(class).unwrap()), "{class} {ttl} {uses}");
            }
        }
        assert_eq!(Refusal::TooLong(Class::Powerful).message(), "A powerful credential can't be opened for that long.");
    }

    #[test]
    fn expiry_is_checked_before_anything_is_opened() {
        let w = world();
        let (f, _) = fields(&w, "cloudflare-dns", "powerful", 600, 1);
        let ev = card(&w.uni, &f);
        assert!(check_card(&ev, &w.uni.public_key(), &w.seal, NOW + 899).is_ok());
        assert_eq!(check_card(&ev, &w.uni.public_key(), &w.seal, NOW + 900).unwrap_err(), Refusal::Expired);
        // an expired card with a box for another device still says expired (the order of CARD.md §3)
        let other = derive_seal_key(&Keys::generate()).unwrap();
        assert_eq!(check_card(&ev, &w.uni.public_key(), &other, NOW + 900).unwrap_err(), Refusal::Expired);
    }

    #[test]
    fn incomplete_or_mistyped_fields_are_refused() {
        let w = world();
        let (f, _) = fields(&w, "cloudflare-dns", "powerful", 600, 1);
        type Change = Box<dyn Fn(&mut Value)>;
        let changes: Vec<Change> = vec![
            Box::new(|g| { g.as_object_mut().unwrap().remove("payload"); }),
            Box::new(|g| { g.as_object_mut().unwrap().remove("rpk"); }),
            Box::new(|g| g["extra"] = json!("shown nowhere")),
            Box::new(|g| g["box"]["extra"] = json!(1)),
            Box::new(|g| g["v"] = json!(2)),
            Box::new(|g| g["v"] = json!(true)),
            Box::new(|g| g["ttl_s"] = json!(600.0)),
            Box::new(|g| g["ttl_s"] = json!("600")),
            Box::new(|g| g["uses"] = json!(-1)),
            Box::new(|g| g["expires"] = json!(null)),
            Box::new(|g| g["class"] = json!("admin")),
            Box::new(|g| g["rid"] = json!("0123")),
            Box::new(|g| g["rpk"] = json!("AB".repeat(32))),
            Box::new(|g| g["rpk"] = json!("00".repeat(32))),
            Box::new(|g| g["credential"] = json!("../parent")),
            Box::new(|g| g["action"] = json!("DNS edit")),
            Box::new(|g| g["scope"] = json!("")),
            Box::new(|g| g["scope"] = json!("x".repeat(281))),
        ];
        for (i, change) in changes.iter().enumerate() {
            let g = with(&f, |g| change(g));
            assert_eq!(check(&w, &card(&w.uni, &g)).map(|_| ()), Err(Refusal::Incomplete), "change {i}");
        }
        // no block, a block that doesn't parse, two blocks, both fences
        let block = serde_json::to_string(&f).unwrap();
        for body in [
            "🔑 Uni asks to use cloudflare-dns".to_string(),
            format!("```{CARD_FENCE}\n{{not json\n```"),
            format!("```{CARD_FENCE}\n{block}\n```\n```{CARD_FENCE}\n{block}\n```"),
            format!("```{CARD_FENCE}\n{block}\n```\n```{MORNING_FENCE}\n{{\"v\":1,\"rows\":[{block}]}}\n```"),
            format!("```{CARD_FENCE}\n{block}"),
        ] {
            assert_eq!(check(&w, &signed(&w.uni, 9, body.clone())).unwrap_err(), Refusal::Incomplete, "{body}");
        }
    }

    #[test]
    fn the_morning_card_is_routine_only_and_each_row_is_checked() {
        let w = world();
        let rows: Vec<Value> = ["r2-backups", "pages-deploy", "dns-read"].iter().map(|n| fields(&w, n, "routine", 50_400, 200).0).collect();
        let c = check(&w, &morning(&w.uni, &rows)).unwrap();
        assert_eq!((c.kind, c.rows.len()), (CardKind::Morning, 3));
        assert_eq!(c.rows.iter().map(|r| r.request_digest.clone()).collect::<Vec<_>>(), rows.iter().map(|r| request_digest(r).unwrap()).collect::<Vec<_>>());
        // one powerful row refuses the whole card, whether it says so or its box does
        let (p, _) = fields(&w, "cloudflare-parent", "powerful", 600, 1);
        assert_eq!(check(&w, &morning(&w.uni, &[rows[0].clone(), p])).unwrap_err(), Refusal::PowerfulOnMorning);
        let hidden = with(&rows[1], |g| g["box"] = boxed(&w.seal.public_key(), "pages-deploy", "powerful"));
        assert_eq!(check(&w, &morning(&w.uni, &[rows[0].clone(), hidden])).unwrap_err(), Refusal::Misstated);
        // any row failing its own checks refuses the card
        let bad = with(&rows[2], |g| g["payload"] = json!({"zone": "other"}));
        assert_eq!(check(&w, &morning(&w.uni, &[rows[0].clone(), bad])).unwrap_err(), Refusal::Mismatch);
        // a repeated row, request id or one-time key, a mixed answer-by time, no rows, too many rows
        let same_rid = with(&rows[1], |g| g["rid"] = rows[0]["rid"].clone());
        let same_rpk = with(&rows[1], |g| g["rpk"] = rows[0]["rpk"].clone());
        let later = fields(&w, "later", "routine", 60, 1).0;
        let later = with(&later, |g| g["expires"] = json!(NOW + 901));
        let many: Vec<Value> = (0..21).map(|i| fields(&w, &format!("c{i}"), "routine", 60, 1).0).collect();
        for set in [vec![rows[0].clone(), rows[0].clone()], vec![rows[0].clone(), same_rid], vec![rows[0].clone(), same_rpk], vec![rows[0].clone(), later], vec![], many] {
            assert_eq!(check(&w, &morning(&w.uni, &set)).unwrap_err(), Refusal::Incomplete);
        }
        // not Uni's
        assert_eq!(check(&w, &morning(&Keys::generate(), &rows)).unwrap_err(), Refusal::NotUni);
    }

    /// The rumor inside `wrap`, opened with the request's one-time key, and who sealed it.
    fn open(wrap: &Event, one_time: &Keys) -> (Value, PublicKey) {
        let seal = Event::from_json(nip44::decrypt(one_time.secret_key(), &wrap.pubkey, &wrap.content).unwrap()).unwrap();
        seal.verify().unwrap();
        assert_eq!(seal.kind, Kind::Seal);
        let rumor: Value = serde_json::from_str(&nip44::decrypt(one_time.secret_key(), &seal.pubkey, &seal.content).unwrap()).unwrap();
        (rumor, seal.pubkey)
    }

    #[test]
    fn the_reply_goes_only_to_the_one_time_key_with_the_data_key_only_on_approve() {
        let w = world();
        let (f, one_time) = fields(&w, "cloudflare-dns", "powerful", 600, 1);
        let ev = card(&w.uni, &f);
        let c = check(&w, &ev).unwrap();
        let r = &c.rows[0];
        let wrap = reply_wrap(&w.me, &w.uni.public_key(), &ev.id, r, Decision::Approve, NOW).unwrap();
        wrap.verify().unwrap();
        assert_eq!(wrap.kind, Kind::GiftWrap);
        assert_ne!(wrap.pubkey, w.me.public_key(), "signed by a throwaway key");
        let tags: Vec<Vec<String>> = wrap.tags.iter().map(|t| t.as_slice().to_vec()).collect();
        assert_eq!(tags, vec![vec!["p".to_string(), w.uni.public_key().to_hex()], vec!["expiration".into(), (NOW + 900).to_string()]]);
        assert!(!wrap.as_json().contains(DEK) && !wrap.as_json().contains(&r.rid));
        // Uni's long-term key, the owner's and the sealing key can't open it
        for k in [w.uni.secret_key(), w.me.secret_key()] {
            assert!(nip44::decrypt(k, &wrap.pubkey, &wrap.content).is_err());
        }
        let (rumor, sealer) = open(&wrap, &one_time);
        assert_eq!(sealer, w.me.public_key());
        assert_eq!(rumor["kind"], KIND_APPROVAL_REPLY);
        assert_eq!(rumor["tags"], json!([["e", ev.id.to_hex()]]));
        let body: Value = serde_json::from_str(rumor["content"].as_str().unwrap()).unwrap();
        assert_eq!(body, json!({"v": 1, "rid": f["rid"], "request_digest": request_digest(&f).unwrap(), "decision": "approve", "dek": DEK}));

        let deny = reply_wrap(&w.me, &w.uni.public_key(), &ev.id, r, Decision::Deny, NOW).unwrap();
        let (rumor, _) = open(&deny, &one_time);
        let body: Value = serde_json::from_str(rumor["content"].as_str().unwrap()).unwrap();
        assert_eq!(body, json!({"v": 1, "rid": f["rid"], "request_digest": request_digest(&f).unwrap(), "decision": "deny"}));
    }

    #[test]
    fn a_replay_is_seen_by_request_id_or_one_time_key() {
        let w = world();
        let (f, _) = fields(&w, "cloudflare-dns", "powerful", 600, 1);
        let ev = card(&w.uni, &f);
        let c = check(&w, &ev).unwrap();
        let answered = |card: &EventId, rid: &str, digest: &str, rpk: &str| Answers {
            answers: vec![Answer { card: card.to_hex(), rid: rid.into(), request_digest: digest.into(), rpk: rpk.into(),
                decision: Decision::Approve, at: NOW, until: Some(NOW + 600), expires: NOW + 900, wrap: None, sent: true }],
        };
        let r = &c.rows[0];
        // its own answer is not a replay
        assert!(!answered(&ev.id, &r.rid, &r.request_digest, &r.rpk.to_hex()).replays(&c));
        // the same request under another card, the same id with other fields, the same one-time key on another request
        let other = EventId::all_zeros();
        assert!(answered(&other, &r.rid, &r.request_digest, &r.rpk.to_hex()).replays(&c));
        assert!(answered(&ev.id, &r.rid, &"0".repeat(64), &"1".repeat(64)).replays(&c));
        assert!(answered(&other, &"9".repeat(32), &"0".repeat(64), &r.rpk.to_hex()).replays(&c));
        assert!(!answered(&other, &"9".repeat(32), &"0".repeat(64), &"1".repeat(64)).replays(&c));
    }

    #[test]
    fn answers_age_out_a_week_after_their_card_sent_or_not() {
        let dir = tempfile::tempdir().unwrap();
        let a = |rid: &str, sent: bool| Answer { card: "c".repeat(64), rid: rid.into(), request_digest: "d".repeat(64), rpk: "e".repeat(64),
            decision: Decision::Approve, at: NOW, until: None, expires: NOW + 900, wrap: (!sent).then(|| "{}".into()), sent };
        let mut answers = Answers { answers: vec![a("sent", true), a("unsent", false)] };
        answers.save(dir.path(), NOW + 1000).unwrap();
        assert_eq!(Answers::load(dir.path()).unwrap().answers.len(), 2, "kept for replay checks after expiry");
        answers.save(dir.path(), NOW + 900 + KEEP_AFTER_EXPIRY_SECS).unwrap();
        assert!(Answers::load(dir.path()).unwrap().answers.is_empty(), "an unsent answer can never be taken: it goes too");
    }

    #[test]
    fn no_view_holds_the_data_key() {
        let w = world();
        let (f, _) = fields(&w, "cloudflare-dns", "powerful", 600, 1);
        let ev = card(&w.uni, &f);
        let v = view(&ev, &w.uni.public_key(), &w.seal, &Answers::default(), NOW);
        assert_eq!(v.refused, None);
        assert_eq!(v.rows[0].request_digest, request_digest(&f).unwrap());
        let json = serde_json::to_string(&v).unwrap();
        assert!(!json.contains(DEK) && !json.contains("dek_box"), "{json}");
        // refused: the reason and nothing else
        let v = view(&card(&Keys::generate(), &f), &w.uni.public_key(), &w.seal, &Answers::default(), NOW);
        assert_eq!((v.refused.as_deref(), v.rows.len()), (Some("Not signed by Uni."), 0));
        // expired and unanswered: expired; expired after an answer here: shown as answered
        let v = view(&ev, &w.uni.public_key(), &w.seal, &Answers::default(), NOW + 900);
        assert_eq!(v.refused.as_deref(), Some("This card has expired."));
        let r = &check(&w, &ev).unwrap().rows[0];
        let answers = Answers { answers: vec![Answer { card: ev.id.to_hex(), rid: r.rid.clone(), request_digest: r.request_digest.clone(),
            rpk: r.rpk.to_hex(), decision: Decision::Deny, at: NOW + 10, until: None, expires: NOW + 900, wrap: None, sent: true }] };
        let v = view(&ev, &w.uni.public_key(), &w.seal, &answers, NOW + 5000);
        assert_eq!(v.refused, None);
        assert_eq!(v.rows[0].answer, Some(AnswerView { decision: Decision::Deny, at: NOW + 10, until: None, sent: true }));
    }
}
