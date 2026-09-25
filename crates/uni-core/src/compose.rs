//! Send a kind-9 Buzz channel message after explicit room validation.
use std::collections::HashSet;

use buzz_sdk::{
    builders::{
        build_delete_compat, build_edit, build_message, build_reaction, build_remove_reaction,
    },
    ThreadRef,
};
use nostr::{EventId, Keys, PublicKey, Tag};
use uuid::Uuid;

use crate::{buzz::BuzzClient, store::Item, sync::ingest_message, Error, Result, Store};

/// The `p` tags for an outgoing message: our own key (Buzz convention), the
/// parent's author when replying, then the explicitly bound recipients, as
/// canonical lowercase hex with duplicates removed. Anything that is not a
/// public key is rejected so a bad binding never publishes silently.
pub fn mention_pubkeys(
    me: &str,
    parent_author: Option<&str>,
    recipients: &[String],
) -> Result<Vec<String>> {
    let mut unique = HashSet::new();
    let mut mentions = Vec::new();
    for value in std::iter::once(me)
        .chain(parent_author)
        .chain(recipients.iter().map(String::as_str))
    {
        let pk = PublicKey::from_hex(value.trim())
            .map_err(|_| Error::Invalid("recipient must be a public key (64 hex digits)".into()))?;
        let canonical = pk.to_hex();
        if unique.insert(canonical.clone()) {
            mentions.push(canonical);
        }
    }
    if mentions.len() > 50 {
        return Err(Error::Invalid("too many recipients (max 50)".into()));
    }
    Ok(mentions)
}

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
    let mentions = mention_pubkeys(
        &keys.public_key().to_hex(),
        parent.as_ref().map(|p| p.item.author.as_str()),
        recipients,
    )?;
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

/// Publish a NIP-25 reaction (kind 7) to a cached message in `channel`, in
/// Buzz desktop's exact shape (one `e` tag; the relay derives the channel from
/// the target). Returns the reaction event id once the relay accepts it; only
/// then is it recorded locally.
pub async fn send_reaction(
    relay_url: &str,
    keys: &Keys,
    auth_tag: Option<&Tag>,
    store: &Store,
    channel: Uuid,
    target: &str,
    emoji: &str,
) -> Result<String> {
    let emoji = emoji.trim();
    if emoji.is_empty() {
        return Err(Error::Invalid("reaction must not be empty".into()));
    }
    let msg = store
        .message(&channel.to_string(), target)?
        .ok_or_else(|| Error::Invalid("reaction target is not cached in this room".into()))?;
    let target_id = EventId::from_hex(&msg.item.r#ref)
        .map_err(|_| Error::Invalid("invalid reaction target".into()))?;
    let event = build_reaction(target_id, emoji)
        .map_err(|e| Error::Invalid(e.to_string()))?
        .sign_with_keys(keys)
        .map_err(|e| Error::Invalid(format!("cannot sign reaction: {e}")))?;
    publish_aux(relay_url, keys, auth_tag, store, event, &msg.item.r#ref).await
}

/// Undo our own reaction: a kind-5 deletion of the reaction event. Refuses to
/// delete anything that is not a reaction we signed.
pub async fn remove_reaction(
    relay_url: &str,
    keys: &Keys,
    auth_tag: Option<&Tag>,
    store: &Store,
    reaction_id: &str,
) -> Result<()> {
    let me = keys.public_key().to_hex();
    if !store.is_own_reaction(reaction_id, &me)? {
        return Err(Error::Invalid("not one of your reactions".into()));
    }
    let rid =
        EventId::from_hex(reaction_id).map_err(|_| Error::Invalid("invalid reaction id".into()))?;
    let event = build_remove_reaction(rid)
        .map_err(|e| Error::Invalid(e.to_string()))?
        .sign_with_keys(keys)
        .map_err(|e| Error::Invalid(format!("cannot sign deletion: {e}")))?;
    publish_aux(relay_url, keys, auth_tag, store, event, reaction_id).await?;
    Ok(())
}

/// Look up a cached message in `channel` and require that we authored it.
/// Buzz (and our `visible_items` view) only honours edits signed by the
/// original author, so refusing locally avoids publishing a no-op event.
fn own_message(store: &Store, keys: &Keys, channel: Uuid, target: &str) -> Result<EventId> {
    let msg = store
        .message(&channel.to_string(), target)?
        .ok_or_else(|| Error::Invalid("message is not cached in this room".into()))?;
    if msg.item.author != keys.public_key().to_hex() {
        return Err(Error::Invalid(
            "you can only change your own messages".into(),
        ));
    }
    EventId::from_hex(&msg.item.r#ref).map_err(|_| Error::Invalid("invalid message id".into()))
}

/// Edit one of our own messages: kind 40003 with `h` (channel) and `e`
/// (target), content = full new text. Mirrors `buzz_sdk::builders::build_edit`
/// (~/Code/buzz/crates/buzz-sdk/src/builders.rs), the shape Buzz desktop's
/// `edit_message` command publishes for a plain-text edit that adds no new
/// mentions (desktop only `p`-tags mentions newly added by the edit so a typo
/// fix never re-wakes anyone). Recorded locally only after the relay's `OK`,
/// so `visible_items` shows the new body at once. Returns the edit event id.
pub async fn edit_message(
    relay_url: &str,
    keys: &Keys,
    auth_tag: Option<&Tag>,
    store: &Store,
    channel: Uuid,
    target: &str,
    new_content: &str,
) -> Result<String> {
    let content = new_content.trim();
    if content.is_empty() || content.len() > 64 * 1024 {
        return Err(Error::Invalid(
            "edit must contain text and be at most 64 KiB".into(),
        ));
    }
    let target_id = own_message(store, keys, channel, target)?;
    let event = build_edit(channel, target_id, content)
        .map_err(|e| Error::Invalid(e.to_string()))?
        .sign_with_keys(keys)
        .map_err(|e| Error::Invalid(format!("cannot sign edit: {e}")))?;
    publish_aux(relay_url, keys, auth_tag, store, event, &target_id.to_hex()).await
}

/// Delete one of our own messages exactly as Buzz desktop does
/// (`delete_message` in ~/Code/buzz/desktop/src-tauri/src/commands/messages.rs
/// → `build_delete_compat`): a NIP-09 kind 5 with `h` (so channel-scoped
/// subscriptions see it) and `e` tags, empty content. Recorded locally after
/// the relay's `OK`, which hides the message from `visible_items`.
pub async fn delete_message(
    relay_url: &str,
    keys: &Keys,
    auth_tag: Option<&Tag>,
    store: &Store,
    channel: Uuid,
    target: &str,
) -> Result<String> {
    let target_id = own_message(store, keys, channel, target)?;
    let event = build_delete_compat(channel, target_id)
        .map_err(|e| Error::Invalid(e.to_string()))?
        .sign_with_keys(keys)
        .map_err(|e| Error::Invalid(format!("cannot sign deletion: {e}")))?;
    publish_aux(relay_url, keys, auth_tag, store, event, &target_id.to_hex()).await
}

async fn publish_aux(
    relay_url: &str,
    keys: &Keys,
    auth_tag: Option<&Tag>,
    store: &Store,
    event: nostr::Event,
    target: &str,
) -> Result<String> {
    crate::init_crypto();
    let mut client = BuzzClient::connect(relay_url, keys, auth_tag).await?;
    let response = client.publish(event.clone()).await?;
    let _ = client.disconnect().await;
    if !response.accepted {
        return Err(Error::RelayRejected(response.message));
    }
    store.upsert_aux(
        &event.id.to_hex(),
        event.kind.as_u16() as i64,
        target,
        &event.pubkey.to_hex(),
        event.created_at.as_secs() as i64,
        &event.content,
    )?;
    Ok(event.id.to_hex())
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::Keys;

    #[test]
    fn mention_pubkeys_orders_dedupes_and_canonicalizes() {
        let me = Keys::generate().public_key().to_hex();
        let parent = Keys::generate().public_key().to_hex();
        let uni = Keys::generate().public_key().to_hex();
        let got = mention_pubkeys(
            &me,
            Some(&parent),
            &[uni.to_uppercase(), parent.clone(), me.clone()],
        )
        .unwrap();
        assert_eq!(got, vec![me.clone(), parent, uni]);
        assert_eq!(mention_pubkeys(&me, None, &[]).unwrap(), vec![me.clone()]);
    }

    #[test]
    fn mention_pubkeys_rejects_names_and_too_many() {
        let me = Keys::generate().public_key().to_hex();
        assert!(mention_pubkeys(&me, None, &["Uni".into()]).is_err());
        let many: Vec<String> = (0..50)
            .map(|_| Keys::generate().public_key().to_hex())
            .collect();
        assert!(mention_pubkeys(&me, None, &many).is_err());
    }
}
