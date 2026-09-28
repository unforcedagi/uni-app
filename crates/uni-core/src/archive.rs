//! NIP-IA archived identities.
//!
//! The relay publishes a relay-signed, NIP-70-protected kind:13535 snapshot
//! listing every archived (retired) identity as a bare `["p", <hex>]` tag.
//! Archived agents stay NIP-29 channel members (the relay won't remove
//! them), so the app hides them from member lists and @-mention suggestions.
//!
//! Trust mirrors `buzz agents archived`: the snapshot must be kind 13535,
//! authored by the relay's NIP-11 `self` key, carry exactly one `-` tag and a
//! valid signature. A snapshot that fails any check is ignored (the cached set
//! stays), so a spoofed event can never hide a real person.

use nostr::{Event, Filter, Kind, PublicKey};

use crate::{BuzzClient, Error, Result};

/// NIP-IA archived-identities snapshot (buzz-core `KIND_IA_ARCHIVED_LIST`).
pub const KIND_IA_ARCHIVED_LIST: u16 = 13535;

/// Uni's pubkey: never hidden, whatever the snapshot says.
pub const UNI_PUBKEY: &str = "a284302e6e5286c59767651184da6e0cde08c883706bad9bb8e3500049290362";

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Verify a kind:13535 event against the relay's `self` key and return its
/// archived pubkeys (lowercase hex, deduped, in tag order).
pub fn verify_archived_event(event: &Event, relay_self_hex: &str) -> Result<Vec<String>> {
    if event.kind != Kind::Custom(KIND_IA_ARCHIVED_LIST) {
        return Err(Error::Invalid(format!(
            "archived list has wrong kind {}",
            event.kind.as_u16()
        )));
    }
    if !event.pubkey.to_hex().eq_ignore_ascii_case(relay_self_hex) {
        return Err(Error::Invalid(
            "archived list is not signed by the relay".into(),
        ));
    }
    let protected = event
        .tags
        .iter()
        .filter(|t| t.as_slice().first().map(String::as_str) == Some("-"))
        .count();
    if protected != 1 {
        return Err(Error::Invalid(format!(
            "archived list must carry exactly one '-' tag, found {protected}"
        )));
    }
    event
        .verify()
        .map_err(|e| Error::Invalid(format!("archived list signature: {e}")))?;
    let mut out: Vec<String> = Vec::new();
    for t in event.tags.iter() {
        let s = t.as_slice();
        if s.first().map(String::as_str) != Some("p") {
            continue;
        }
        if let Some(pk) = s.get(1).filter(|pk| is_hex64(pk)) {
            let pk = pk.to_ascii_lowercase();
            if !out.contains(&pk) {
                out.push(pk);
            }
        }
    }
    Ok(out)
}

/// Drop identities that must never be hidden: Uni and the signed-in user.
pub fn without_protected(archived: Vec<String>, me: &str) -> Vec<String> {
    archived
        .into_iter()
        .filter(|pk| !pk.eq_ignore_ascii_case(UNI_PUBKEY) && !pk.eq_ignore_ascii_case(me))
        .collect()
}

/// The relay's NIP-11 `self` pubkey (the key that signs 13535 snapshots).
pub async fn fetch_relay_self(relay_url: &str) -> Result<String> {
    let http = relay_url
        .replacen("wss://", "https://", 1)
        .replacen("ws://", "http://", 1);
    let body = crate::media::http_client()?
        .get(http.trim_end_matches('/').to_string() + "/")
        .header("Accept", "application/nostr+json")
        .send()
        .await
        .map_err(|e| Error::Invalid(format!("relay info: {e}")))?
        .text()
        .await
        .map_err(|e| Error::Invalid(format!("relay info: {e}")))?;
    let doc: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| Error::Invalid(format!("relay info is not JSON: {e}")))?;
    let me = doc
        .get("self")
        .and_then(|v| v.as_str())
        .filter(|s| is_hex64(s))
        .ok_or_else(|| Error::Invalid("relay info has no valid 'self' pubkey".into()))?;
    Ok(me.to_ascii_lowercase())
}

/// Fetch and verify the current archived set. `Ok(vec![])` when the relay
/// has published no snapshot.
pub async fn fetch_archived(client: &mut BuzzClient, relay_self_hex: &str) -> Result<Vec<String>> {
    let author = PublicKey::from_hex(relay_self_hex)
        .map_err(|e| Error::Invalid(format!("relay self pubkey: {e}")))?;
    let filter = Filter::new()
        .kind(Kind::Custom(KIND_IA_ARCHIVED_LIST))
        .author(author)
        .limit(1);
    let events = client.req_until_eose("archived", &[filter]).await?;
    // Replaceable: newest wins if a relay ever returns more than one.
    match events.iter().max_by_key(|e| e.created_at) {
        None => Ok(Vec::new()),
        Some(ev) => verify_archived_event(ev, relay_self_hex),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Tag};

    fn snapshot(keys: &Keys, tags: Vec<Vec<String>>) -> Event {
        let tags: Vec<Tag> = tags.into_iter().map(|t| Tag::parse(t).unwrap()).collect();
        EventBuilder::new(Kind::Custom(KIND_IA_ARCHIVED_LIST), "")
            .tags(tags)
            .sign_with_keys(keys)
            .unwrap()
    }

    fn p(pk: &str) -> Vec<String> {
        vec!["p".into(), pk.into()]
    }

    #[test]
    fn verifies_relay_snapshot_and_collects_p_tags() {
        let relay = Keys::generate();
        let (a, b) = ("a".repeat(64), "B".repeat(64));
        let ev = snapshot(
            &relay,
            vec![
                vec!["-".into()],
                p(&a),
                p(&b),
                p(&a),
                p("short"),
                vec!["e".into(), "c".repeat(64)],
            ],
        );
        let got = verify_archived_event(&ev, &relay.public_key().to_hex()).unwrap();
        assert_eq!(got, vec![a, "b".repeat(64)]);
    }

    #[test]
    fn rejects_foreign_author_and_missing_protection() {
        let relay = Keys::generate();
        let other = Keys::generate();
        let spoof = snapshot(&other, vec![vec!["-".into()], p(&"a".repeat(64))]);
        assert!(verify_archived_event(&spoof, &relay.public_key().to_hex()).is_err());
        let open = snapshot(&relay, vec![p(&"a".repeat(64))]);
        assert!(verify_archived_event(&open, &relay.public_key().to_hex()).is_err());
    }

    #[test]
    fn never_hides_uni_or_me() {
        let me = "d".repeat(64);
        let x = "e".repeat(64);
        let kept = without_protected(vec![UNI_PUBKEY.into(), me.to_uppercase(), x.clone()], &me);
        assert_eq!(kept, vec![x]);
    }
}
