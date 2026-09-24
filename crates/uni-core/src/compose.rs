//! Send a kind-9 Buzz channel message after explicit room validation.
use std::collections::HashSet;

use buzz_sdk::{builders::build_message, ThreadRef};
use nostr::{EventId, Keys, PublicKey, Tag};
use uuid::Uuid;

use crate::{buzz::BuzzClient, store::Item, sync::ingest_message, Error, Result, Store};

/// Sign and publish a message. Only an accepted relay `OK` enters the store.
/// `reply_to` must identify a cached message in the selected channel; callers
/// retain their draft until this future succeeds. Explicit mention pubkeys are
/// supplied by the UI; typed `@name` text is never guessed into a recipient.
// Boundary method takes relay, identity, storage, and wire-level message fields.
#[allow(clippy::too_many_arguments)]
pub async fn send_message(
    relay_url: &str,
    keys: &Keys,
    auth_tag: Option<&Tag>,
    store: &Store,
    channel: Uuid,
    content: &str,
    reply_to: Option<&str>,
    recipients: &[String],
) -> Result<Item> {
    if content.trim().is_empty() || content.len() > 64 * 1024 {
        return Err(Error::Invalid(
            "message must contain text and be at most 64 KiB".into(),
        ));
    }
    if !store.rooms()?.iter().any(|r| r.id == channel.to_string()) {
        return Err(Error::Invalid("select a joined room before sending".into()));
    }
    let parent = match reply_to {
        Some(id) => Some(
            store
                .message(&channel.to_string(), id)?
                .ok_or_else(|| Error::Invalid("reply target is not cached in this room".into()))?,
        ),
        None => None,
    };
    let thread = if let Some(p) = &parent {
        Some(ThreadRef {
            root_event_id: EventId::from_hex(p.root.as_deref().unwrap_or(&p.item.r#ref))
                .map_err(|_| Error::Invalid("invalid thread root".into()))?,
            parent_event_id: EventId::from_hex(&p.item.r#ref)
                .map_err(|_| Error::Invalid("invalid reply target".into()))?,
        })
    } else {
        None
    };
    let mut unique = HashSet::new();
    let mut mentions = Vec::new();
    for value in std::iter::once(keys.public_key().to_hex())
        .chain(parent.iter().map(|p| p.item.author.clone()))
        .chain(recipients.iter().cloned())
    {
        let pk = PublicKey::from_hex(&value)
            .map_err(|_| Error::Invalid("recipient must be a public key (64 hex digits)".into()))?;
        let canonical = pk.to_hex();
        if unique.insert(canonical.clone()) {
            mentions.push(canonical);
        }
    }
    if mentions.len() > 50 {
        return Err(Error::Invalid("too many recipients (max 50)".into()));
    }
    let mention_refs: Vec<&str> = mentions.iter().map(String::as_str).collect();
    let event = build_message(
        channel,
        content,
        thread.as_ref(),
        &mention_refs,
        false,
        &[],
        &[],
    )
    .map_err(|e| Error::Invalid(e.to_string()))?
    .sign_with_keys(keys)
    .map_err(|e| Error::Invalid(format!("cannot sign message: {e}")))?;
    crate::init_crypto();
    let mut client = BuzzClient::connect(relay_url, keys, auth_tag).await?;
    let response = client.publish(event.clone()).await?;
    if !response.accepted {
        return Err(Error::RelayRejected(response.message));
    }
    let (_, item) = ingest_message(store, &event, &keys.public_key(), channel)?;
    store.set_since(&channel.to_string(), item.ts)?;
    Ok(item)
}
