//! T-176 secret handoff: answer Uni's "secret request" with a sealed reply.
//!
//! Uni asks in the room with an ordinary kind-9 message whose body ends in a
//! fenced ```` ```uni-secret-request ```` JSON block (the
//! T-176 design note, kept privately with the plugin). The app answers with a NIP-59 gift wrap
//! (kind 1059, `p` = the requester so the relay routes and p-gates it), never
//! a chat message. Both NIP-44 layers (seal and wrap) are encrypted to the
//! request's one-time key `rpk`, not the requester's long-term key, so a later
//! leak of Uni's nsec does not open wraps still sitting on the relay once Uni
//! has dropped the one-time key. The rumor (kind 46040) is signed by nobody;
//! the seal (kind 13) is signed by this account, which is how Uni knows who
//! sent the value.
//!
//! Buzz rejects events more than 15 minutes from server time, so the wrap's
//! `created_at` is tweaked by at most 10 minutes, not NIP-59's two days. The
//! seal and rumor are never published and keep NIP-59's wider tweak.

use nostr::hashes::{sha256, Hash, HashEngine};
use nostr::nips::nip44;
use nostr::{Event, EventBuilder, EventId, JsonUtil, Keys, Kind, PublicKey, Tag, Timestamp, UnsignedEvent};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

use crate::buzz::BuzzClient;
use crate::store::Store;
use crate::{Error, Result};

/// Fence language of the machine block in a request message.
pub const REQUEST_FENCE: &str = "uni-secret-request";
/// Rumor kind carrying a secret value (inside the gift wrap only).
pub const KIND_SECRET_DELIVERY: u16 = 46040;
/// Rumor kind asking Uni to forget a stored secret.
pub const KIND_SECRET_FORGET: u16 = 46041;
/// NIP-40 expiration on the wrap: the relay may drop the ciphertext after a day.
pub const WRAP_LIFETIME_SECS: u64 = 86_400;
/// Longest value the app will seal (NIP-44 allows 65535 bytes of plaintext;
/// leave room for the JSON around it).
pub const MAX_VALUE_BYTES: usize = 16 * 1024;

/// The JSON block of a request, as Uni wrote it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SecretRequest {
    pub v: u8,
    /// Request id, 32 hex chars; the delivery must echo it.
    pub rid: String,
    /// File name under Uni's secret directory (`[a-z0-9][a-z0-9._-]{0,63}`).
    pub name: String,
    pub label: String,
    pub purpose: String,
    /// Where Uni says it will keep the value (shown to the person, not trusted).
    pub store: String,
    pub keep_days: u32,
    /// Unix seconds after which the request is no longer answered.
    pub expires: u64,
    /// One-time x-only pubkey (hex) both NIP-44 layers are encrypted to.
    pub rpk: String,
}

/// A request found in a stored message, with who asked.
#[derive(Debug, Clone)]
pub struct Asked {
    pub request: SecretRequest,
    pub requester: PublicKey,
    pub event_id: EventId,
    pub one_time_key: PublicKey,
}

fn valid_name(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(c))
}

fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// The request block in `body`, if the message carries a well-formed one.
/// The last fenced block wins; anything malformed is `None` (shown as text).
pub fn parse_request(body: &str) -> Option<SecretRequest> {
    let open = format!("```{REQUEST_FENCE}\n");
    let start = body.rfind(&open)? + open.len();
    let end = start + body[start..].find("\n```")?;
    let req: SecretRequest = serde_json::from_str(body[start..end].trim()).ok()?;
    let ok = req.v == 1
        && is_hex(&req.rid, 32)
        && valid_name(&req.name)
        && is_hex(&req.rpk, 64)
        && !req.label.trim().is_empty()
        && req.label.chars().count() <= 80
        && req.purpose.chars().count() <= 280
        && req.store.chars().count() <= 200
        && (1..=365).contains(&req.keep_days);
    ok.then_some(req)
}

/// The request in a signed kind-9 event, from its own id and signature. The
/// requester is the key that signed it, never a cached `author` column, a
/// relay's say-so or something the webview supplies. Edits are not applied: a
/// request is answered exactly as it was signed.
pub fn verified_request(event_json: &str) -> Result<Asked> {
    let ev = Event::from_json(event_json).map_err(|e| Error::Invalid(format!("request event: {e}")))?;
    ev.verify()
        .map_err(|_| Error::Invalid("the request's signature does not verify; it can't be answered".into()))?;
    if ev.kind != Kind::Custom(9) {
        return Err(Error::Invalid("message is not a secret request".into()));
    }
    let request = parse_request(&ev.content)
        .ok_or_else(|| Error::Invalid("message is not a secret request".into()))?;
    let one_time_key = PublicKey::from_hex(&request.rpk)
        .map_err(|e| Error::Invalid(format!("request key: {e}")))?;
    Ok(Asked { request, requester: ev.pubkey, event_id: ev.id, one_time_key })
}

/// The request in message `request_ref` of `channel`, verified from the signed
/// event kept when it was ingested. A message cached without one (an older
/// build, or anything that didn't come through a verified ingest) is refused.
pub fn stored_request(store: &Store, channel: &str, request_ref: &str) -> Result<Asked> {
    store
        .message(channel, request_ref)?
        .ok_or_else(|| Error::Invalid("request not found; refresh the room".into()))?;
    let json = store
        .signed_event(request_ref)?
        .ok_or_else(|| Error::Invalid("this request can't be verified; ask Uni for a new one".into()))?;
    let asked = verified_request(&json)?;
    if asked.event_id.to_hex() != request_ref {
        return Err(Error::Invalid("this request can't be verified; ask Uni for a new one".into()));
    }
    Ok(asked)
}

/// Refuse a request from a key the person has not pinned, or one past its window.
pub fn check_answerable(asked: &Asked, pinned: &[PublicKey], now: u64) -> Result<()> {
    if !pinned.contains(&asked.requester) {
        return Err(Error::Invalid("this requester is not trusted for secrets".into()));
    }
    if now > asked.request.expires {
        return Err(Error::Invalid("this request has expired; ask Uni for a new one".into()));
    }
    Ok(())
}

fn tag(parts: &[&str]) -> Result<Tag> {
    Tag::parse(parts.iter().copied()).map_err(|e| Error::Invalid(e.to_string()))
}

/// NIP-59 rumor → seal (signed by `sender`) → gift wrap (signed by a fresh key),
/// both layers NIP-44 v2 to `enc_to`; the wrap is `p`-tagged to `route` and carries a NIP-40 `expiration`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn wrap(
    sender: &Keys,
    route: &PublicKey,
    enc_to: &PublicKey,
    kind: u16,
    content: &str,
    tags: Vec<Tag>,
    now: u64,
    expiration: u64,
) -> Result<Event> {
    // The rumor's copy of `content` is zeroed however this returns, errors included.
    struct Rumor(UnsignedEvent);
    impl Drop for Rumor {
        fn drop(&mut self) {
            self.0.content.zeroize();
        }
    }
    // Not `EventBuilder::build`, which computes the id with nostr's `ensure_id()`: see `rumor_id`.
    let mut rumor = Rumor(UnsignedEvent::new(sender.public_key(), Timestamp::from_secs(now), Kind::Custom(kind), tags, content));
    rumor.0.id = Some(rumor_id(&rumor.0)?);
    // worst case: every byte of the content and tags escaped as `\uXXXX`, plus the fixed fields
    let tags_len: usize = rumor.0.tags.iter().map(|t| t.as_slice().iter().map(|v| v.len() + 3).sum::<usize>() + 2).sum();
    let rumor_json = json_zeroizing(&rumor.0, 512 + 6 * (rumor.0.content.len() + tags_len))?;
    drop(rumor);
    let sealed = nip44::encrypt(sender.secret_key(), enc_to, rumor_json.as_str(), nip44::Version::V2)
        .map_err(|e| Error::Invalid(format!("nip44 seal: {e}")))?;
    let seal = EventBuilder::new(Kind::Seal, sealed)
        .custom_created_at(Timestamp::tweaked(0..172_800))
        .sign_with_keys(sender)
        .map_err(|e| Error::Invalid(format!("cannot sign seal: {e}")))?;
    let one_off = Keys::generate();
    let wrapped = nip44::encrypt(one_off.secret_key(), enc_to, seal.as_json(), nip44::Version::V2)
        .map_err(|e| Error::Invalid(format!("nip44 wrap: {e}")))?;
    // up to 10 minutes back: `tweaked` is "now minus a random amount in the range"
    let jitter = Timestamp::now().as_secs().saturating_sub(Timestamp::tweaked(0..600).as_secs());
    let at = now.saturating_sub(jitter.min(600));
    EventBuilder::new(Kind::GiftWrap, wrapped)
        .tags([
            tag(&["p", &route.to_hex()])?,
            tag(&["expiration", &expiration.to_string()])?,
        ])
        .custom_created_at(Timestamp::from_secs(at))
        .sign_with_keys(&one_off)
        .map_err(|e| Error::Invalid(format!("cannot sign wrap: {e}")))
}

/// The NIP-01 id of `rumor`, hashed while it is serialized. nostr's `ensure_id()` builds a `serde_json::Value`
/// and then a `String` of the whole event, content included, and frees both unzeroed; here the JSON goes
/// straight into the SHA-256 engine, whose buffer is overwritten afterwards. What the engine last held is the end of the
/// serialized event, which [`delivery_json`] arranges to be the request id and name, not the value.
fn rumor_id(rumor: &UnsignedEvent) -> Result<EventId> {
    struct Sha(sha256::HashEngine);
    impl std::io::Write for Sha {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.input(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut sha = Sha(sha256::HashEngine::default());
    let fields = (0u8, &rumor.pubkey, &rumor.created_at, &rumor.kind, &rumor.tags, &rumor.content);
    let done = serde_json::to_writer(&mut sha, &fields).map(|()| sha256::Hash::from_engine(sha.0.clone()));
    // A full block of zeros overwrites every byte of the engine's block buffer (this crate forbids `unsafe`,
    // so no `zeroize_flat_type`); `black_box` keeps the compiler from dropping the dead writes.
    sha.0.input(&[0u8; 64]);
    std::hint::black_box(&sha.0);
    let hash = done.map_err(|e| Error::Invalid(format!("json: {e}")))?;
    Ok(EventId::from_byte_array(hash.to_byte_array()))
}

/// `v` as JSON, written straight into one zeroizing buffer of `capacity` bytes. Sized for the worst case, the
/// buffer never grows, so serializing leaves no smaller, reallocated copy of a secret behind.
pub(crate) fn json_zeroizing<T: Serialize>(v: &T, capacity: usize) -> Result<Zeroizing<String>> {
    let mut buf = Zeroizing::new(Vec::with_capacity(capacity));
    serde_json::to_writer(&mut *buf, v).map_err(|e| Error::Invalid(format!("json: {e}")))?;
    let text = String::from_utf8(std::mem::take(&mut *buf)).map_err(|e| Error::Invalid(e.to_string()))?;
    Ok(Zeroizing::new(text))
}

/// `{"value","v":1,"rid","name"}`, without copying `value` into a `serde_json::Value` (see [`json_zeroizing`]).
/// The value comes first so the event's serialized tail, the last bytes a hash engine holds, is the 32-hex
/// request id and the name (over 64 bytes once escaped inside the event), never part of the value.
fn delivery_json(rid: &str, name: &str, value: &str) -> Result<Zeroizing<String>> {
    #[derive(Serialize)]
    struct Delivery<'a> {
        value: &'a str,
        v: u8,
        rid: &'a str,
        name: &'a str,
    }
    json_zeroizing(&Delivery { value, v: 1, rid, name }, 64 + 6 * (rid.len() + name.len() + value.len()))
}

/// The gift wrap carrying `value` in answer to `asked`.
pub fn seal_delivery(sender: &Keys, asked: &Asked, value: &str, now: u64) -> Result<Event> {
    if value.is_empty() {
        return Err(Error::Invalid("nothing to send".into()));
    }
    if value.len() > MAX_VALUE_BYTES {
        return Err(Error::Invalid("value is too long".into()));
    }
    let r = &asked.request;
    let body = delivery_json(&r.rid, &r.name, value)?;
    let tags = vec![
        tag(&["e", &asked.event_id.to_hex()])?,
        tag(&["p", &asked.requester.to_hex()])?,
    ];
    wrap(sender, &asked.requester, &asked.one_time_key, KIND_SECRET_DELIVERY, &body, tags, now, now + WRAP_LIFETIME_SECS)
}

/// The gift wrap asking the requester to forget what it stored for `asked`. It names the request
/// as well as the secret, so an old card can't delete a newer secret stored under the same name.
/// It holds no secret, so it is encrypted to the requester's long-term key.
pub fn seal_forget(sender: &Keys, asked: &Asked, now: u64) -> Result<Event> {
    let (requester, r) = (&asked.requester, &asked.request);
    let body = serde_json::json!({ "v": 1, "name": r.name, "rid": r.rid }).to_string();
    let tags = vec![tag(&["p", &requester.to_hex()])?];
    wrap(sender, requester, requester, KIND_SECRET_FORGET, &body, tags, now, now + WRAP_LIFETIME_SECS)
}

/// Publish a wrap over a NIP-42-authenticated socket (as this account; Buzz
/// accepts a kind-1059 whose signer differs from the authenticated key).
pub async fn publish_wrap(
    relay_url: &str,
    keys: &Keys,
    auth_tag: Option<&Tag>,
    wrap: Event,
) -> Result<EventId> {
    if wrap.kind != Kind::GiftWrap {
        return Err(Error::Invalid("not a gift wrap".into()));
    }
    crate::init_crypto();
    let id = wrap.id;
    let mut client = BuzzClient::connect(relay_url, keys, auth_tag).await?;
    let response = client.publish(wrap).await?;
    let _ = client.disconnect().await;
    if !response.accepted {
        return Err(Error::RelayRejected(response.message));
    }
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::{ingest_channel_event, Ingested};
    use crate::Item;

    const CHANNEL: &str = "6a0c3f1e-1111-4222-8333-944455556666";

    fn request_body(rpk: &str, expires: u64) -> String {
        format!(
            "🔐 Uni is asking for a secret\n\n```{REQUEST_FENCE}\n{}\n```",
            serde_json::json!({
                "v": 1, "rid": "0123456789abcdef0123456789abcdef", "name": "tailscale-api",
                "label": "Tailscale API token", "purpose": "list devices", "store": "~/.config/uni/tailscale-api",
                "keep_days": 30, "expires": expires, "rpk": rpk,
            })
        )
    }

    /// A kind-9 request in `CHANNEL`, signed by `author`.
    fn request_event(author: &Keys, rpk: &str, expires: u64) -> Event {
        EventBuilder::new(Kind::Custom(9), request_body(rpk, expires))
            .tags([tag(&["h", CHANNEL]).unwrap()])
            .sign_with_keys(author)
            .unwrap()
    }

    /// `ev` as JSON with `change` applied, keeping its id and signature (what a lying relay serves).
    fn tampered(ev: &Event, change: impl FnOnce(&mut serde_json::Value)) -> String {
        let mut v: serde_json::Value = serde_json::from_str(&ev.as_json()).unwrap();
        change(&mut v);
        v.to_string()
    }

    #[test]
    fn delivery_json_is_the_documented_shape_and_never_reallocates() {
        let value = "t176-\"dummy\"\n\u{1}é";
        let body = delivery_json("0123456789abcdef0123456789abcdef", "tok", value).unwrap();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v, serde_json::json!({"v": 1, "rid": "0123456789abcdef0123456789abcdef", "name": "tok", "value": value}));
        assert!(body.capacity() >= body.len() && body.capacity() <= 64 + 6 * (32 + 3 + value.len()));
        // the worst case (every byte a control character) still fits: the buffer never grew
        let worst = "\u{1}".repeat(1000);
        let cap = 64 + 6 * (32 + 3 + worst.len());
        assert_eq!(delivery_json("0123456789abcdef0123456789abcdef", "tok", &worst).unwrap().capacity(), cap);
    }

    #[test]
    fn rumor_id_is_nostrs_id_and_the_value_is_not_in_the_hashed_tail() {
        let sender = Keys::generate();
        for value in ["t176-dummy", "t176-\"dummy\"\n\u{1}é\u{2028}🔐", "x"] {
            let body = delivery_json("0123456789abcdef0123456789abcdef", "a", value).unwrap();
            let tags = [tag(&["e", &"ab".repeat(32)]).unwrap()];
            let at = Timestamp::from_secs(1_760_000_000);
            let rumor = UnsignedEvent::new(sender.public_key(), at, Kind::Custom(KIND_SECRET_DELIVERY), tags.clone(), body.as_str());
            assert_eq!(rumor.id, None, "UnsignedEvent::new must not hash the content itself");
            let nostrs = EventBuilder::new(Kind::Custom(KIND_SECRET_DELIVERY), body.as_str()).tags(tags).custom_created_at(at);
            assert_eq!(Some(rumor_id(&rumor).unwrap()), nostrs.build(sender.public_key()).id, "{value:?}");
            // the engine's last block holds at most the final 64 bytes of the serialized event
            let event = serde_json::json!([0, rumor.pubkey, rumor.created_at, rumor.kind, rumor.tags, rumor.content]).to_string();
            let escaped = serde_json::to_string(&serde_json::to_string(value).unwrap()).unwrap();
            let at = event.find(&escaped[3..escaped.len() - 3]).unwrap();
            assert!(event.len() - (at + escaped.len() - 6) >= 64, "{value:?}");
        }
    }

    #[test]
    fn parses_only_well_formed_requests() {
        let rpk = Keys::generate().public_key().to_hex();
        assert_eq!(parse_request(&request_body(&rpk, 10)).unwrap().name, "tailscale-api");
        assert!(parse_request("no fence here").is_none());
        // a path in the name, a short rid, an unknown version: all shown as plain text
        for (from, to) in [
            ("\"tailscale-api\"", "\"../etc/passwd\""),
            ("0123456789abcdef0123456789abcdef", "0123"),
            ("\"v\":1", "\"v\":2"),
        ] {
            assert!(parse_request(&request_body(&rpk, 10).replace(from, to)).is_none(), "{to}");
        }
    }

    #[test]
    fn delivery_opens_only_with_the_one_time_key_and_names_the_sender() {
        let uni = Keys::generate();
        let one_time = Keys::generate();
        let owner = Keys::generate();
        let now = Timestamp::now().as_secs();
        let asked = verified_request(&request_event(&uni, &one_time.public_key().to_hex(), now + 600).as_json()).unwrap();
        check_answerable(&asked, &[uni.public_key()], now).unwrap();
        let value = "t176-dummy-unit";
        let ev = seal_delivery(&owner, &asked, value, now).unwrap();

        assert_eq!(ev.kind, Kind::GiftWrap);
        assert_ne!(ev.pubkey, owner.public_key(), "wrap is signed by a throwaway key");
        assert!(ev.verify().is_ok());
        assert!(now - ev.created_at.as_secs() <= 600, "inside Buzz's 15-minute window");
        assert!(!ev.as_json().contains(value));
        assert!(!ev.as_json().contains("tailscale"), "the name is inside the wrap too");
        // Uni's long-term key cannot open it; the one-time key can.
        assert!(nip44::decrypt(uni.secret_key(), &ev.pubkey, &ev.content).is_err());
        let seal = Event::from_json(nip44::decrypt(one_time.secret_key(), &ev.pubkey, &ev.content).unwrap()).unwrap();
        assert_eq!(seal.kind, Kind::Seal);
        assert_eq!(seal.pubkey, owner.public_key());
        seal.verify().unwrap();
        let rumor: serde_json::Value =
            serde_json::from_str(&nip44::decrypt(one_time.secret_key(), &seal.pubkey, &seal.content).unwrap()).unwrap();
        assert_eq!(rumor["kind"], KIND_SECRET_DELIVERY);
        assert_eq!(rumor["pubkey"], owner.public_key().to_hex());
        let inner: serde_json::Value = serde_json::from_str(rumor["content"].as_str().unwrap()).unwrap();
        assert_eq!(inner["value"], value);
        assert_eq!(inner["rid"], "0123456789abcdef0123456789abcdef");
    }

    #[test]
    fn parses_the_request_the_plugin_writes() {
        // written by the plugin's desk.py, then re-signed with a throwaway key; the TS card parses the same file
        // (scripts/secretRequest.test.ts)
        let fx: serde_json::Value =
            serde_json::from_str(include_str!("../../../scripts/fixtures/t176-messages.json")).unwrap();
        let r = parse_request(fx["request"]["content"].as_str().unwrap()).unwrap();
        assert_eq!((r.name.as_str(), r.keep_days), ("tailscale-api", 30));
        assert!(parse_request(fx["stored"]["content"].as_str().unwrap()).is_none());
        // the plugin's own signature verifies here (its pure-Python BIP-340 agrees with rust-nostr)
        let asked = verified_request(&fx["request"].to_string()).unwrap();
        assert_eq!(asked.requester.to_hex(), fx["author"].as_str().unwrap());
    }

    #[test]
    fn unpinned_or_expired_requests_are_refused() {
        let uni = Keys::generate();
        let impostor = Keys::generate();
        let rpk = Keys::generate().public_key().to_hex();
        let asked = verified_request(&request_event(&impostor, &rpk, 100).as_json()).unwrap();
        assert!(check_answerable(&asked, &[uni.public_key()], 50).is_err());
        let asked = verified_request(&request_event(&uni, &rpk, 100).as_json()).unwrap();
        assert!(check_answerable(&asked, &[uni.public_key()], 101).is_err());
        assert!(check_answerable(&asked, &[uni.public_key()], 100).is_ok());
    }

    /// Codex T-176 review P1: a relay that claims Uni wrote a request carrying the relay's own one-time key.
    #[test]
    fn a_forged_author_or_a_swapped_key_is_not_a_request() {
        let uni = Keys::generate();
        let attacker = Keys::generate();
        let attacker_rpk = Keys::generate().public_key().to_hex();
        let genuine = request_event(&uni, &Keys::generate().public_key().to_hex(), u64::MAX);
        let attackers = request_event(&attacker, &attacker_rpk, u64::MAX);
        let uni_hex = uni.public_key().to_hex();
        let forgeries = [
            // the attacker's own request, relabelled as Uni's
            tampered(&attackers, |v| v["pubkey"] = uni_hex.clone().into()),
            // Uni's real request with the attacker's one-time key swapped in
            tampered(&genuine, |v| {
                let c = v["content"].as_str().unwrap().replace(&genuine_rpk(&genuine), &attacker_rpk);
                v["content"] = c.into();
            }),
            // the same, with the id recomputed to match (the signature still can't)
            {
                let mut ev = attackers.clone();
                ev.pubkey = uni.public_key();
                ev.id = EventId::new(&ev.pubkey, &ev.created_at, &ev.kind, &ev.tags, &ev.content);
                ev.as_json()
            },
        ];
        for (i, json) in forgeries.iter().enumerate() {
            assert!(verified_request(json).is_err(), "forgery {i} was accepted");
            // and it never gets into the store through the receive path
            let ev = Event::from_json(json).unwrap();
            let store = Store::open_in_memory().unwrap();
            let ch = uuid::Uuid::parse_str(CHANNEL).unwrap();
            assert!(matches!(ingest_channel_event(&store, &ev, &uni.public_key(), ch).unwrap(), Ingested::Ignored));
            assert!(store.message(CHANNEL, &ev.id.to_hex()).unwrap().is_none(), "forgery {i} was stored");
            assert!(stored_request(&store, CHANNEL, &ev.id.to_hex()).is_err());
        }
    }

    fn genuine_rpk(ev: &Event) -> String {
        parse_request(&ev.content).unwrap().rpk
    }

    /// A row cached by a build that didn't verify (or written any other way) is never answered from.
    #[test]
    fn a_cached_row_without_its_signed_event_is_not_answerable() {
        let uni = Keys::generate();
        let store = Store::open_in_memory().unwrap();
        let rpk = Keys::generate().public_key().to_hex();
        store
            .upsert_item(&Item {
                source: "buzz".into(),
                r#ref: "a".repeat(64),
                channel: CHANNEL.into(),
                author: uni.public_key().to_hex(),
                ts: 0,
                body: request_body(&rpk, u64::MAX),
                mentions_me: false,
            })
            .unwrap();
        let err = stored_request(&store, CHANNEL, &"a".repeat(64)).unwrap_err();
        assert!(err.to_string().contains("can't be verified"), "{err}");
    }

    #[test]
    fn a_verified_request_is_answered_as_signed_even_after_an_edit() {
        let uni = Keys::generate();
        let store = Store::open_in_memory().unwrap();
        let ch = uuid::Uuid::parse_str(CHANNEL).unwrap();
        let rpk = Keys::generate().public_key().to_hex();
        let ev = request_event(&uni, &rpk, u64::MAX);
        assert!(matches!(ingest_channel_event(&store, &ev, &uni.public_key(), ch).unwrap(), Ingested::Message { new: true, .. }));
        let asked = stored_request(&store, CHANNEL, &ev.id.to_hex()).unwrap();
        assert_eq!((asked.requester, asked.request.rpk.as_str()), (uni.public_key(), rpk.as_str()));
        // A (signed) edit changes what the room shows, not what the card answers.
        let other_rpk = Keys::generate().public_key().to_hex();
        let edit = EventBuilder::new(Kind::Custom(40003), request_body(&other_rpk, u64::MAX))
            .tags([tag(&["e", &ev.id.to_hex()]).unwrap(), tag(&["h", CHANNEL]).unwrap()])
            .sign_with_keys(&uni)
            .unwrap();
        ingest_channel_event(&store, &edit, &uni.public_key(), ch).unwrap();
        assert_eq!(stored_request(&store, CHANNEL, &ev.id.to_hex()).unwrap().request.rpk, rpk);
        // A signed request in another room is not this room's.
        assert!(stored_request(&store, "elsewhere", &ev.id.to_hex()).is_err());
    }
}
