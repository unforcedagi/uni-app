//! What the app is shown: rows built from matrix-sdk's rooms and timeline items, and the homeserver address check.

use std::sync::Arc;

use matrix_sdk::{
    ruma::{events::room::message::MessageType, UserId},
    Room, RoomState,
};
use matrix_sdk_ui::{
    eyeball_im::Vector,
    timeline::{EventSendState, LatestEventValue, TimelineDetails, TimelineItem, TimelineItemContent},
};
use serde::Serialize;
use url::{Host, Url};

use crate::MessagesError;

/// One room in the list.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RoomRow {
    pub id: String,
    pub name: String,
    /// The latest message, in words ("Photo" for a picture); `None` until known.
    pub preview: Option<String>,
    /// The latest message is yours ("You: …").
    pub preview_own: bool,
    /// Milliseconds since the epoch of the latest message (or the invite).
    pub ts: Option<u64>,
    pub unread: u64,
    pub encrypted: bool,
    pub invited: bool,
    /// Who invited you, for an invite.
    pub inviter: Option<String>,
    pub direct: bool,
    /// T-310: the network it comes through (`signal`, `whatsapp`, …, from link.rs), `matrix` for a plain Matrix
    /// conversation, or `other` when it can't be told.
    pub network: &'static str,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
    Text,
    Notice,
    Emote,
    /// A photo, video, voice message or file: shown by its kind and name (the prototype doesn't fetch media).
    Media,
    /// An encrypted message this device has no key for (yet).
    Undecryptable,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SendState {
    /// Someone else's message, or yours from another device.
    Remote,
    /// Yours, on its way.
    Sending,
    /// Yours, the homeserver has it.
    Sent,
    /// Yours, it didn't go.
    Failed,
}

/// One message in a room.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MessageRow {
    /// Stable across the local echo turning into the sent event.
    pub key: String,
    pub event_id: Option<String>,
    pub sender: String,
    pub sender_name: String,
    pub own: bool,
    pub ts: u64,
    pub kind: MessageKind,
    pub body: String,
    pub state: SendState,
    pub encrypted: bool,
    pub edited: bool,
}

/// A message's content in words, for a list preview and for media without a viewer.
fn content_words(content: &TimelineItemContent) -> Option<(MessageKind, String, bool)> {
    if content.is_unable_to_decrypt() {
        return Some((MessageKind::Undecryptable, "Encrypted message: this device doesn't have its key yet.".into(), false));
    }
    let msg = content.as_message()?;
    let named = |what: &str, name: &str| if name.is_empty() { what.to_owned() } else { format!("{what}: {name}") };
    let (kind, body) = match msg.msgtype() {
        MessageType::Text(t) => (MessageKind::Text, t.body.clone()),
        MessageType::Notice(n) => (MessageKind::Notice, n.body.clone()),
        MessageType::Emote(e) => (MessageKind::Emote, e.body.clone()),
        MessageType::Image(i) => (MessageKind::Media, named("Photo", i.filename())),
        MessageType::Video(v) => (MessageKind::Media, named("Video", v.filename())),
        MessageType::Audio(a) => (MessageKind::Media, named("Audio", a.filename())),
        MessageType::File(f) => (MessageKind::Media, named("File", f.filename())),
        MessageType::Location(_) => (MessageKind::Media, "Location".into()),
        other => (MessageKind::Text, other.body().to_owned()),
    };
    Some((kind, body, msg.is_edited()))
}

fn ms(ts: matrix_sdk::ruma::MilliSecondsSinceUnixEpoch) -> u64 {
    u64::from(ts.0)
}

fn name_of(profile: &TimelineDetails<matrix_sdk_ui::timeline::Profile>, user: &UserId) -> String {
    match profile {
        TimelineDetails::Ready(p) => p.display_name.clone().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| user.localpart().to_owned()),
        _ => user.localpart().to_owned(),
    }
}

/// `network`: the room's network if it is known already (link.rs reads it otherwise).
pub(crate) async fn room_row(room: &Room, latest: &LatestEventValue, network: Option<&'static str>) -> RoomRow {
    let name = match room.display_name().await {
        Ok(n) => n.to_string(),
        Err(_) => room.room_id().to_string(),
    };
    let (preview, preview_own, ts, inviter, inviter_id) = match latest {
        LatestEventValue::None => (None, false, None, None, None),
        LatestEventValue::Remote { timestamp, is_own, content, .. } => (content_words(content).map(|c| c.1), *is_own, Some(ms(*timestamp)), None, None),
        LatestEventValue::Local { timestamp, content, .. } => (content_words(content).map(|c| c.1), true, Some(ms(*timestamp)), None, None),
        LatestEventValue::RemoteInvite { timestamp, inviter, inviter_profile } => {
            (None, false, Some(ms(*timestamp)), inviter.as_ref().map(|u| name_of(inviter_profile, u)), inviter.as_deref())
        }
    };
    RoomRow {
        id: room.room_id().to_string(),
        name,
        preview,
        preview_own,
        ts,
        unread: room.num_unread_messages(),
        encrypted: room.encryption_state().is_encrypted(),
        invited: room.state() == RoomState::Invited,
        inviter,
        direct: room.is_direct().await.unwrap_or(false),
        network: match network {
            Some(n) => n,
            None => crate::link::network_of(room, inviter_id).await,
        },
    }
}

/// The messages among a timeline's items, oldest first. State changes (joins, topic) and day dividers are left out.
pub(crate) fn message_rows(items: &Vector<Arc<TimelineItem>>) -> Vec<MessageRow> {
    items
        .iter()
        .filter_map(|item| {
            let ev = item.as_event()?;
            let (kind, body, edited) = content_words(ev.content())?;
            let state = match ev.send_state() {
                None => SendState::Remote,
                Some(EventSendState::NotSentYet { .. }) => SendState::Sending,
                Some(EventSendState::SendingFailed { .. }) => SendState::Failed,
                Some(EventSendState::Sent { .. }) => SendState::Sent,
            };
            // a remote message of our own is one the homeserver has: sent
            let state = if state == SendState::Remote && ev.is_own() { SendState::Sent } else { state };
            Some(MessageRow {
                key: item.unique_id().0.clone(),
                event_id: ev.event_id().map(|e| e.to_string()),
                sender: ev.sender().to_string(),
                sender_name: name_of(ev.sender_profile(), ev.sender()),
                own: ev.is_own(),
                ts: ms(ev.timestamp()),
                kind,
                body,
                state,
                encrypted: ev.encryption_info().is_some() || kind == MessageKind::Undecryptable,
                edited,
            })
        })
        .collect()
}

/// The homeserver address, if it is one a password may be sent to: `https://`, or plain `http://` only to this
/// machine (the prototype's local homeserver). Over the tailnet the homeserver is behind TLS too.
pub fn checked_homeserver(raw: &str) -> Result<Url, MessagesError> {
    let bad = |m: &str| MessagesError::Invalid { message: m.to_owned() };
    let url = Url::parse(raw.trim()).map_err(|_| bad("That isn't a homeserver address."))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(bad("A homeserver address can't carry a username or password."));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(bad("A homeserver address has no query or fragment."));
    }
    let loopback = match url.host() {
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        Some(Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        None => return Err(bad("That isn't a homeserver address.")),
    };
    match url.scheme() {
        "https" => Ok(url),
        "http" if loopback => Ok(url),
        "http" => Err(bad("Use https:// for a homeserver on another machine; a password must not cross the network in the clear.")),
        _ => Err(bad("A homeserver address starts with https://.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn https_anywhere_and_plain_http_only_to_this_machine() {
        for ok in ["https://matrix.example.com", "https://matrix.example.ts.net:8448/", "http://127.0.0.1:8278", "http://localhost:8278", "http://[::1]:8278"] {
            assert!(checked_homeserver(ok).is_ok(), "{ok} should be allowed");
        }
        for no in [
            "http://matrix.example.com",
            "http://127.0.0.1.example.com",
            "http://localhost.example.com:8278",
            "http://10.0.0.5:8008",
            "https://user:pw@matrix.example.com",
            "https://matrix.example.com/?next=x",
            "ftp://matrix.example.com",
            "matrix.example.com",
            "",
        ] {
            assert!(checked_homeserver(no).is_err(), "{no} should be refused");
        }
    }
}
