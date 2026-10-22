//! T-234 sealed credentials, milestone 1: the sealing key and the enrollment event (uni-ops CARD.md §1).
//!
//! The app derives a **sealing key** from this account's Nostr secret key, HKDF-SHA256 with one expand block:
//! `prk = HMAC-SHA256(key = "uni-sealed/v1", msg = sk)`, then
//! `seal_sk = HMAC-SHA256(prk, "uni-sealed-credentials/v1 seal key" || counter)` for counter 1, 2, … 255 until the
//! result is a valid secp256k1 scalar (`0 < k < n`). It is a different key from the identity key, so nothing sealed
//! to it can make the app open one of the account's DMs. It never leaves this process: no IPC view, record or event
//! carries it, only its public half.
//!
//! **Enrollment** tells Uni that public half, once: a kind-9 room message signed by the identity key, tag
//! `["t","uni-sealed-enroll"]`, content `{"v":1,"seal_pub":"<hex>","for":"<Uni's pubkey hex>"}`. `for` is always
//! the Uni key compiled into the app ([`crate::archive::UNI_PUBKEY`]), never a key a message or the webview supplies,
//! and the event goes only into a room Uni is a member of, so Uni can read it (Buzz needs the `h` tag on kind 9). It
//! carries no `p` tag for Uni: that would be a mention and wake Uni as if spoken to.
//!
//! The whole sealing key is derivable from the identity key this process already holds, so a copy left in memory is
//! no worse than the identity key's own. The HKDF buffers here are zeroed when dropped and the key's own storage is
//! erased with it (nostr's `SecretKey` drop), but a move may leave a stack copy behind, as it can for the identity key.

use std::path::Path;

use nostr::hashes::hmac::{Hmac, HmacEngine};
use nostr::hashes::{sha256, Hash, HashEngine};
use nostr::{Event, Keys, Kind, PublicKey, SecretKey, Tag, Timestamp};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::store::Store;
use crate::{Error, Result};

/// HKDF salt (the HMAC key of the extract step).
pub const SEAL_SALT: &[u8] = b"uni-sealed/v1";
/// HKDF info of the one expand block; the counter byte follows it.
pub const SEAL_INFO: &[u8] = b"uni-sealed-credentials/v1 seal key";
/// `t` tag value marking an enrollment message.
pub const ENROLL_TAG: &str = "uni-sealed-enroll";
/// A signed enrollment that didn't reach the relay is sent again as the same event (same id, so the relay can't hold
/// two) while it is this young; Buzz refuses events more than 15 minutes from its clock.
pub const RETRY_SAME_EVENT_SECS: u64 = 600;
/// In the app's data folder: the published enrollment's public facts.
pub const RECORD_FILE: &str = "sealed-enrollment.json";
/// In the app's data folder: the last signed enrollment not yet known to be on the relay (a public, signed event).
pub const PENDING_FILE: &str = "sealed-enrollment-pending.json";

fn hmac_sha256(key: &[u8], parts: &[&[u8]]) -> Zeroizing<[u8; 32]> {
    let mut engine = HmacEngine::<sha256::Hash>::new(key);
    for p in parts {
        engine.input(p);
    }
    Zeroizing::new(Hmac::<sha256::Hash>::from_engine(engine).to_byte_array())
}

/// The account's sealing key. No `Debug`, `Clone` or `Serialize`: only its public half leaves this module.
pub struct SealKey(Keys);

impl SealKey {
    /// The public half (x-only, as in every Nostr key), what enrollment publishes.
    pub fn public_key(&self) -> PublicKey {
        self.0.public_key()
    }

    #[cfg(test)]
    fn secret_hex(&self) -> String {
        self.0.secret_key().to_secret_hex()
    }
}

impl std::fmt::Debug for SealKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SealKey({})", self.public_key().to_hex())
    }
}

/// The first counter (1 to 255) whose candidate is a valid secp256k1 scalar, as the reference loop does.
fn first_valid_scalar(mut candidate: impl FnMut(u8) -> Zeroizing<[u8; 32]>) -> Result<SecretKey> {
    for counter in 1..=255u8 {
        if let Ok(sk) = SecretKey::from_slice(&*candidate(counter)) {
            return Ok(sk);
        }
    }
    Err(Error::Invalid("could not derive a sealing key".into()))
}

/// The sealing key of `identity` (module docs). Deterministic: the same identity key always gives the same key.
pub fn derive_seal_key(identity: &Keys) -> Result<SealKey> {
    let prk = hmac_sha256(SEAL_SALT, &[identity.secret_key().as_secret_bytes()]);
    let sk = first_valid_scalar(|counter| hmac_sha256(&*prk, &[SEAL_INFO, &[counter]]))?;
    Ok(SealKey(Keys::new(sk)))
}

/// The enrollment content, exactly these three fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Enrollment {
    pub v: u8,
    pub seal_pub: String,
    #[serde(rename = "for")]
    pub for_uni: String,
}

fn tag(parts: &[&str]) -> Result<Tag> {
    Tag::parse(parts.iter().copied()).map_err(|e| Error::Invalid(e.to_string()))
}

/// `ev` carries the enrollment tag (it may still not verify).
pub fn has_enroll_tag(ev: &Event) -> bool {
    has_tag(ev, "t", ENROLL_TAG)
}

fn has_tag(ev: &Event, name: &str, value: &str) -> bool {
    ev.tags.iter().any(|t| {
        let s = t.as_slice();
        s.len() >= 2 && s[0] == name && s[1] == value
    })
}

/// The enrollment event: `identity` says "this is my sealing key, for this Uni", in room `channel`. Same shape as an
/// ordinary message from this app (`h`, our own `p`), plus the `t` tag; signed at `now`.
pub fn enrollment_event(identity: &Keys, uni: &PublicKey, channel: Uuid, now: u64) -> Result<Event> {
    build_enrollment(identity, &derive_seal_key(identity)?, uni, channel, now)
}

fn build_enrollment(identity: &Keys, seal: &SealKey, uni: &PublicKey, channel: Uuid, now: u64) -> Result<Event> {
    let body = Enrollment { v: 1, seal_pub: seal.public_key().to_hex(), for_uni: uni.to_hex() };
    let content = serde_json::to_string(&body).map_err(|e| Error::Invalid(e.to_string()))?;
    let me = identity.public_key().to_hex();
    let event = buzz_sdk::build_message(channel, &content, None, &[me.as_str()], false, &[], &[])
        .map_err(|e| Error::Invalid(e.to_string()))?
        .tag(tag(&["t", ENROLL_TAG])?)
        .custom_created_at(Timestamp::from_secs(now))
        .sign_with_keys(identity)
        .map_err(|e| Error::Invalid(format!("cannot sign enrollment: {e}")))?;
    // What goes out is checked the way Uni's broker checks it.
    verify_enrollment(&event, &identity.public_key(), uni)?;
    Ok(event)
}

/// What Uni's broker checks (uni-ops `sealed enroll`): a valid signature from `signer`, kind 9, the `t` tag, exactly
/// the three fields with `v == 1`, `seal_pub` a public key and `for` this `uni`. Returns the content.
pub fn verify_enrollment(ev: &Event, signer: &PublicKey, uni: &PublicKey) -> Result<Enrollment> {
    ev.verify().map_err(|_| Error::Invalid("the enrollment's signature does not verify".into()))?;
    if ev.kind != Kind::Custom(9) || !has_enroll_tag(ev) {
        return Err(Error::Invalid("not an enrollment".into()));
    }
    if &ev.pubkey != signer {
        return Err(Error::Invalid("the enrollment isn't signed by this identity".into()));
    }
    let body: Enrollment =
        serde_json::from_str(&ev.content).map_err(|_| Error::Invalid("the enrollment's fields don't parse".into()))?;
    let canonical = |s: &str| PublicKey::from_hex(s).ok().filter(|k| k.to_hex() == s);
    if body.v != 1 || canonical(&body.seal_pub).is_none() {
        return Err(Error::Invalid("the enrollment's fields are incomplete".into()));
    }
    if canonical(&body.for_uni).as_ref() != Some(uni) {
        return Err(Error::Invalid("the enrollment is for a different Uni key".into()));
    }
    Ok(body)
}

/// Public facts of a published enrollment, kept in app data so Settings can say approvals are on. Holds no secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnrollmentRecord {
    /// Identity that signed it.
    pub identity: String,
    pub uni: String,
    pub seal_pub: String,
    pub event_id: String,
    pub channel: String,
    pub created_at: u64,
}

impl EnrollmentRecord {
    /// This record is for `identity`, `uni` and that identity's sealing key (a re-paired device with another key, or
    /// a build trusting another Uni, is not enrolled by it).
    fn current(&self, identity: &Keys, uni: &PublicKey, seal: &SealKey) -> bool {
        self.identity == identity.public_key().to_hex()
            && self.uni == uni.to_hex()
            && self.seal_pub == seal.public_key().to_hex()
    }
}

/// The saved record, if any and readable.
pub fn load_record(path: &Path) -> Option<EnrollmentRecord> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn save_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let json = serde_json::to_vec_pretty(value).map_err(|e| Error::Invalid(e.to_string()))?;
    let tmp = path.with_extension("tmp");
    let write = || -> std::io::Result<()> {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&json)?;
        // on disk before the rename, so a crash can't leave an empty record (and a second enrollment after it)
        f.sync_all()
    };
    write().map_err(|e| Error::Invalid(e.to_string()))?;
    std::fs::rename(&tmp, path).map_err(|e| Error::Invalid(e.to_string()))
}

/// The pending enrollment, if it is still one of `identity`'s for `uni` with this sealing key.
fn load_pending(path: &Path, identity: &Keys, uni: &PublicKey, seal: &SealKey) -> Option<Event> {
    let ev: Event = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    let body = verify_enrollment(&ev, &identity.public_key(), uni).ok()?;
    (body.seal_pub == seal.public_key().to_hex()).then_some(ev)
}

/// A room enrollment can go into: a joined room Uni is a member of.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RoomChoice {
    pub id: String,
    pub name: String,
    pub members: usize,
}

/// Joined rooms with `uni` among their members, the one with fewest members first (a room of just you and Uni),
/// then the most recently active.
pub fn rooms_with(store: &Store, uni: &PublicKey) -> Result<Vec<RoomChoice>> {
    let uni = uni.to_hex();
    let mut out = Vec::new();
    for room in store.rooms()? {
        let members = store.channel_members(&room.id)?;
        if members.iter().any(|m| m.pubkey.eq_ignore_ascii_case(&uni)) {
            out.push((RoomChoice { name: room.name.clone().unwrap_or_else(|| "Room".into()), id: room.id, members: members.len() }, room.last_ts));
        }
    }
    out.sort_by_key(|(r, ts)| (r.members, std::cmp::Reverse(*ts)));
    Ok(out.into_iter().map(|(r, _)| r).collect())
}

/// What Settings shows. Public facts only (the IPC payload of `sealed_status`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SealedStatus {
    /// The Uni key approvals are for.
    pub uni: String,
    /// The public half of this account's sealing key.
    pub seal_pub: String,
    pub rooms: Vec<RoomChoice>,
    /// The enrollment already published for this identity, Uni and key, if any.
    pub enrolled: Option<EnrollmentRecord>,
}

/// Settings' view. `state_dir` is the app's data folder, where the record is kept.
pub fn status(identity: &Keys, uni: &PublicKey, store: &Store, state_dir: &Path) -> Result<SealedStatus> {
    let seal = derive_seal_key(identity)?;
    Ok(SealedStatus {
        uni: uni.to_hex(),
        seal_pub: seal.public_key().to_hex(),
        rooms: rooms_with(store, uni)?,
        enrolled: load_record(&state_dir.join(RECORD_FILE)).filter(|r| r.current(identity, uni, &seal)),
    })
}

/// One enrollment at a time in this process: a second caller waits, then finds the first one's record.
static ENROLLING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Enable approvals: sign the enrollment and publish it in `channel`, once. `state_dir` keeps the record and the
/// pending event.
///
/// - Already enrolled (a current record): returns it and publishes nothing.
/// - A signed enrollment from an earlier try (kept on disk) is looked for on the relay by id first: if its OK was lost,
///   it is there, and it is recorded rather than sent again. While it is young and for the same room, it is resent as
///   the same event; otherwise a new one is signed. The pending event is saved before it goes out.
/// - `channel` must have `uni` in it by the relay's own roster, fetched now, not the cache.
/// - The record is written only after the relay has the event, and the pending event is dropped only after that.
#[allow(clippy::too_many_arguments)]
pub async fn enroll(
    relay_url: &str,
    identity: &Keys,
    auth_tag: Option<&Tag>,
    store: &Store,
    channel: Uuid,
    uni: &PublicKey,
    state_dir: &Path,
    now: u64,
) -> Result<EnrollmentRecord> {
    let _one = ENROLLING.lock().await;
    let (record_path, pending_path) = (state_dir.join(RECORD_FILE), state_dir.join(PENDING_FILE));
    let seal = derive_seal_key(identity)?;
    if let Some(r) = load_record(&record_path).filter(|r| r.current(identity, uni, &seal)) {
        return Ok(r);
    }
    let pending = load_pending(&pending_path, identity, uni, &seal);

    crate::init_crypto();
    let mut client = crate::BuzzClient::connect(relay_url, identity, auth_tag).await?;
    let checked = async {
        if let Some(ev) = &pending {
            // A relay that refuses the lookup (CLOSED) counts as "not found": the young event is then resent with
            // the same id, so a refusal can't block every later retry.
            let found = match client.req_until_eose("sealed-pending", &[nostr::Filter::new().id(ev.id)]).await {
                Err(Error::SubscriptionClosed { .. }) => Vec::new(),
                other => other?,
            };
            if found.iter().any(|f| f.id == ev.id) {
                return Ok(Some(ev.clone()));
            }
        }
        let roster = client.discover().await?.members.remove(&channel).unwrap_or_default();
        if !roster.iter().any(|m| m.eq_ignore_ascii_case(&uni.to_hex())) {
            return Err(Error::Invalid("Uni isn't a member of that room, so it couldn't read the enrollment".into()));
        }
        Ok(None)
    }
    .await;
    let _ = client.disconnect().await;

    let event = match checked? {
        Some(on_relay) => on_relay,
        None => {
            let resend = pending.filter(|ev| {
                crate::buzz::event_channel(ev) == Some(channel)
                    && now.saturating_sub(ev.created_at.as_secs()) <= RETRY_SAME_EVENT_SECS
            });
            let ev = match resend {
                Some(ev) => ev,
                None => build_enrollment(identity, &seal, uni, channel, now)?,
            };
            save_json(&pending_path, &ev).map_err(|e| Error::Invalid(format!("couldn't keep the enrollment for a retry: {e}")))?;
            match crate::compose::publish_message(relay_url, identity, auth_tag, store, channel, ev.clone()).await {
                // Accepted: the relay has it; only the local copy of the message failed.
                Ok(_) | Err(Error::Accepted { .. }) => {}
                Err(e) => return Err(e),
            }
            ev
        }
    };
    let record = EnrollmentRecord {
        identity: identity.public_key().to_hex(),
        uni: uni.to_hex(),
        seal_pub: seal.public_key().to_hex(),
        event_id: event.id.to_hex(),
        channel: crate::buzz::event_channel(&event).map(|c| c.to_string()).unwrap_or_default(),
        created_at: event.created_at.as_secs(),
    };
    save_json(&record_path, &record)
        .map_err(|e| Error::Invalid(format!("Uni has the enrollment, but this device couldn't note that ({e}); try again")))?;
    let _ = std::fs::remove_file(&pending_path);
    Ok(record)
}

/// `ev` is an enrollment its author signed for `uni` (the room's "You enabled approvals for Uni" line is drawn
/// only from this, never from a message body alone).
pub fn is_enrollment_for(ev: &Event, uni: &PublicKey) -> bool {
    verify_enrollment(ev, &ev.pubkey, uni).is_ok()
}

/// The signer of message `reference` in `channel` if its kept signed event verifies as an enrollment for `uni`.
pub fn stored_enrollment(store: &Store, channel: &str, reference: &str, uni: &PublicKey) -> Result<Option<String>> {
    if store.message(channel, reference)?.is_none() {
        return Ok(None);
    }
    let Some(json) = store.signed_event(reference)? else { return Ok(None) };
    let Ok(ev) = <Event as nostr::JsonUtil>::from_json(&json) else { return Ok(None) };
    Ok((ev.id.to_hex() == reference && crate::buzz::event_channel(&ev).map(|c| c.to_string()).as_deref() == Some(channel)
        && is_enrollment_for(&ev, uni))
    .then(|| ev.pubkey.to_hex()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Computed by the reference, uni-ops `sealed/app_sim.py` `derive_seal_key`, from these synthetic keys
    /// (1, 0x01 × 32, n − 1, and two SHA-256 outputs).
    const VECTORS: [(&str, &str, &str); 5] = [
        ("0000000000000000000000000000000000000000000000000000000000000001",
         "a3ce4196826da37a6946c61a9c7d76d1f2b32520fcb6c0cc01f7887718c71ecb",
         "f40cb93cae50bd135f3ed10bf7acc4bf66e98cc81ff0a63ea80e3eed20108813"),
        ("0101010101010101010101010101010101010101010101010101010101010101",
         "27a333758dcde85d75253566142e71caffebb5acff41f532860d005760fb825d",
         "a5ce04ac8002c2bc5e10029636248b808b7c7fbdb03b41b47ab74f594f28b655"),
        ("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140",
         "3aa83c5a5e807ad9303756ca3c25dc21b588f8afcfcbc2841039ca55cfaa2f40",
         "454b677fb44e67c6f56b5edd1da8837949216683e5d223b4e3f302ded9e530c7"),
        ("b5dba0d8854745918e99a966613c9e12ed6909d69cad4e96872b553c64637035",
         "d57de1556e398401ae993565d4a582ef93e6438d8e5652038a2c9dc67172f41b",
         "0ab98b29acd8983d6163749228e12380344f9e91f139f7673ecba8f5b8930d8f"),
        ("525b35baa0d1e74e9a7c3332421a91f4f00831d8bc31d5e34ec2d14b39911dc1",
         "92c81df8599c4068a8f6e45ccfa54d5ff50523d53e5c24de3f2bfe32b0a5681c",
         "5885971b9f86968c14473ef962789a83c49f8b2d1fd8c5da315623315d69aea9"),
    ];
    const N: &str = "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141";

    fn keys(hex: &str) -> Keys {
        Keys::new(SecretKey::from_hex(hex).unwrap())
    }
    fn bytes(hex: &str) -> Zeroizing<[u8; 32]> {
        let mut b = [0u8; 32];
        for (i, out) in b.iter_mut().enumerate() {
            *out = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap();
        }
        Zeroizing::new(b)
    }

    #[test]
    fn seal_key_matches_the_reference_vectors() {
        for (sk, seal_sk, seal_pub) in VECTORS {
            let seal = derive_seal_key(&keys(sk)).unwrap();
            assert_eq!(seal.secret_hex(), seal_sk, "{sk}");
            assert_eq!(seal.public_key().to_hex(), seal_pub, "{sk}");
            assert_ne!(seal.public_key(), keys(sk).public_key(), "a different key from the identity");
        }
    }

    #[test]
    fn the_counter_skips_every_invalid_scalar_and_stops_at_255() {
        let valid = "00000000000000000000000000000000000000000000000000000000000000aa";
        let n_minus_1 = "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140";
        // 0, n and 2^256 − 1 are not scalars: counters 1-3 are skipped, 4 is taken
        let (zero, max) = ("00".repeat(32), "ff".repeat(32));
        let mut seen = vec![];
        let sk = first_valid_scalar(|c| {
            seen.push(c);
            bytes(match c { 1 => &zero, 2 => N, 3 => &max, _ => valid })
        })
        .unwrap();
        assert_eq!((seen, sk.to_secret_hex()), (vec![1, 2, 3, 4], valid.to_string()));
        // n − 1 is the largest scalar and is taken at once
        assert_eq!(first_valid_scalar(|_| bytes(n_minus_1)).unwrap().to_secret_hex(), n_minus_1);
        // nothing valid in 255 tries: an error, never counter 0 or a wrap-around
        let mut last = 0;
        assert!(first_valid_scalar(|c| { last = c; bytes(N) }).is_err());
        assert_eq!(last, 255);
    }

    fn uni() -> Keys {
        keys("c3b34a297de769127d3e59f26d0241e1f4a4b5e2a58990a2607009f102a00a56")
    }
    const ROOM: &str = "6a0c3f1e-1111-4222-8333-944455556666";

    #[test]
    fn the_enrollment_is_the_documented_event() {
        let me = keys(VECTORS[3].0);
        let ev = enrollment_event(&me, &uni().public_key(), ROOM.parse().unwrap(), 1_760_000_000).unwrap();
        ev.verify().unwrap();
        assert_eq!((ev.kind, ev.pubkey, ev.created_at.as_secs()), (Kind::Custom(9), me.public_key(), 1_760_000_000));
        let content: serde_json::Value = serde_json::from_str(&ev.content).unwrap();
        assert_eq!(content, serde_json::json!({"v": 1, "seal_pub": VECTORS[3].2, "for": uni().public_key().to_hex()}));
        let tags: Vec<Vec<String>> = ev.tags.iter().map(|t| t.as_slice().to_vec()).collect();
        assert!(tags.contains(&vec!["t".into(), ENROLL_TAG.into()]));
        assert!(tags.contains(&vec!["h".into(), ROOM.into()]));
        assert!(!tags.iter().any(|t| t[0] == "p" && t[1] == uni().public_key().to_hex()), "no mention of Uni");
        // nothing secret in it
        let json = nostr::JsonUtil::as_json(&ev);
        assert!(!json.contains(VECTORS[3].0) && !json.contains(VECTORS[3].1));
    }

    #[test]
    fn a_wrong_signer_uni_or_content_is_refused() {
        let me = keys(VECTORS[3].0);
        let other = keys(VECTORS[4].0);
        let room: Uuid = ROOM.parse().unwrap();
        let ev = enrollment_event(&me, &uni().public_key(), room, 1_760_000_000).unwrap();
        assert!(verify_enrollment(&ev, &me.public_key(), &uni().public_key()).is_ok());
        assert!(verify_enrollment(&ev, &other.public_key(), &uni().public_key()).is_err(), "another identity");
        assert!(verify_enrollment(&ev, &me.public_key(), &other.public_key()).is_err(), "another Uni");
        // a content swap breaks the signature; re-signed by an impostor it's the wrong signer
        let mut swapped = ev.clone();
        swapped.content = ev.content.replace(VECTORS[3].2, VECTORS[4].2);
        assert!(verify_enrollment(&swapped, &me.public_key(), &uni().public_key()).is_err());
        let forged = enrollment_event(&other, &uni().public_key(), room, 1_760_000_000).unwrap();
        assert!(verify_enrollment(&forged, &me.public_key(), &uni().public_key()).is_err());
        // malformed bodies, properly signed
        let signed = |content: &str, t: bool| {
            let mut b = nostr::EventBuilder::new(Kind::Custom(9), content).tag(tag(&["h", ROOM]).unwrap());
            if t {
                b = b.tag(tag(&["t", ENROLL_TAG]).unwrap());
            }
            b.sign_with_keys(&me).unwrap()
        };
        let u = uni().public_key().to_hex();
        let good = format!(r#"{{"v":1,"seal_pub":"{}","for":"{u}"}}"#, VECTORS[3].2);
        assert!(verify_enrollment(&signed(&good, true), &me.public_key(), &uni().public_key()).is_ok());
        for bad in [
            signed(&good, false),
            signed(&good.replace("\"v\":1", "\"v\":2"), true),
            signed(&good.replace(VECTORS[3].2, "00"), true),
            signed(&good.replace(VECTORS[3].2, &VECTORS[3].2.to_uppercase()), true),
            signed(&good.replace('}', r#","extra":1}"#), true),
            signed(&format!(r#"{{"v":1,"seal_pub":"{}"}}"#, VECTORS[3].2), true),
        ] {
            assert!(verify_enrollment(&bad, &me.public_key(), &uni().public_key()).is_err(), "{}", bad.content);
        }
    }

    #[test]
    fn no_ipc_view_or_record_holds_a_secret() {
        let me = keys(VECTORS[3].0);
        let store = Store::open_in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(RECORD_FILE);
        let ev = enrollment_event(&me, &uni().public_key(), ROOM.parse().unwrap(), 1_760_000_000).unwrap();
        let record = EnrollmentRecord {
            identity: me.public_key().to_hex(),
            uni: uni().public_key().to_hex(),
            seal_pub: VECTORS[3].2.into(),
            event_id: ev.id.to_hex(),
            channel: ROOM.into(),
            created_at: 1_760_000_000,
        };
        save_json(&path, &record).unwrap();
        let st = status(&me, &uni().public_key(), &store, dir.path()).unwrap();
        assert_eq!(st.enrolled.as_ref(), Some(&record));
        assert_eq!(st.seal_pub, VECTORS[3].2);
        let seal = derive_seal_key(&me).unwrap();
        assert_eq!(format!("{seal:?}"), format!("SealKey({})", VECTORS[3].2));
        for text in [serde_json::to_string(&st).unwrap(), std::fs::read_to_string(&path).unwrap(), format!("{seal:?}"), format!("{st:?}")] {
            for secret in [VECTORS[3].0, VECTORS[3].1] {
                assert!(!text.contains(secret), "a secret in {text}");
            }
        }
        // a record for another identity or another Uni doesn't count
        assert!(status(&keys(VECTORS[4].0), &uni().public_key(), &store, dir.path()).unwrap().enrolled.is_none());
        assert!(status(&me, &keys(VECTORS[4].0).public_key(), &store, dir.path()).unwrap().enrolled.is_none());
    }
}
