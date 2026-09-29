//! Typing indicators (kind 20002), in Buzz desktop's shape: empty content,
//! an `h` tag for the channel and NIP-10 `e` tags when typing in a thread.
//! Published on the live WebSocket (the relay's HTTP bridge rejects
//! ephemeral kinds), via `LiveConfig::outbox`.
use nostr::{EventBuilder, Keys, Kind, Tag};
use uuid::Uuid;

use crate::{Error, Result};

pub const KIND_TYPING: u16 = 20002;
/// How long a received indicator stays on screen (Buzz desktop uses 8 s).
pub const TYPING_TTL_SECS: u64 = 8;

/// Build a signed typing event for `channel`, optionally inside a thread.
pub fn typing_event(keys: &Keys, channel: Uuid, root: Option<&str>, parent: Option<&str>) -> Result<nostr::Event> {
    let tag = |parts: &[&str]| Tag::parse(parts.iter().copied()).map_err(|e| Error::Invalid(e.to_string()));
    let mut tags = vec![tag(&["h", &channel.to_string()])?];
    let hex = |s: &str| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit());
    if let Some(r) = root.filter(|r| hex(r)) {
        tags.push(tag(&["e", r, "", "root"])?);
        if let Some(p) = parent.filter(|p| hex(p) && *p != r) {
            tags.push(tag(&["e", p, "", "reply"])?);
        }
    }
    EventBuilder::new(Kind::Custom(KIND_TYPING), "")
        .tags(tags)
        .sign_with_keys(keys)
        .map_err(|e| Error::Invalid(format!("cannot sign typing event: {e}")))
}

/// Thread root named by a typing event's `e` tags (`root` marker, else first `e`).
pub fn typing_root(ev: &nostr::Event) -> Option<String> {
    let es: Vec<&[String]> = ev.tags.iter().map(|t| t.as_slice()).filter(|s| s.len() >= 2 && s[0] == "e").collect();
    es.iter().find(|s| s.get(3).map(String::as_str) == Some("root")).or_else(|| es.first()).map(|s| s[1].clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shapes_channel_and_thread_tags() {
        let keys = Keys::generate();
        let ch = Uuid::new_v4();
        let root = "a".repeat(64);
        let parent = "b".repeat(64);
        let ev = typing_event(&keys, ch, Some(&root), Some(&parent)).unwrap();
        assert_eq!(ev.kind.as_u16(), KIND_TYPING);
        assert!(ev.content.is_empty());
        assert_eq!(typing_root(&ev).as_deref(), Some(root.as_str()));
        assert!(ev.tags.iter().any(|t| t.as_slice() == ["h".to_string(), ch.to_string()]));
        let top = typing_event(&keys, ch, None, None).unwrap();
        assert_eq!(top.tags.len(), 1);
        assert_eq!(typing_root(&top), None);
        // Junk thread ids are dropped, not sent.
        assert_eq!(typing_event(&keys, ch, Some("nope"), None).unwrap().tags.len(), 1);
    }
}
