//! What the app is shown: rows built from matrix-sdk's rooms and timeline items, and the homeserver address check.

use std::sync::Arc;

use matrix_sdk::{
    ruma::{
        events::room::{message::MessageType, MediaSource},
        UInt, UserId,
    },
    Room, RoomState,
};
use matrix_sdk_ui::{
    eyeball_im::Vector,
    timeline::{EventSendState, EventTimelineItem, LatestEventValue, TimelineDetails, TimelineItem, TimelineItemContent},
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
    /// A photo, video, voice message or file: `MessageRow::media` says which, and the app fetches it by its event
    /// (`Messages::media`).
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
    /// T-313: what a media message carries, for its player or preview.
    pub media: Option<Media>,
    /// T-313: the message this one answers.
    pub reply: Option<Reply>,
    /// T-313: its reactions, one per emoji, in the order they first came.
    pub reactions: Vec<Reaction>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MediaKind {
    Image,
    Video,
    Audio,
    /// A recorded voice message (MSC3245, as the bridges mark them).
    Voice,
    File,
}

/// A media message's attachment, as its event describes it. The bytes come from `Messages::media`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Media {
    pub kind: MediaKind,
    /// Its file name, at most `NAME_MAX` characters.
    pub name: String,
    /// The type the app may give the bytes (`safe_mime`): never one a webview would run.
    pub mime: String,
    pub size: Option<u64>,
    pub duration_ms: Option<u64>,
    pub width: Option<u64>,
    pub height: Option<u64>,
    /// Words sent with it, if any (not its file name).
    pub caption: Option<String>,
}

/// The message a reply answers: who wrote it and its words, once known (`None` while it is fetched).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Reply {
    pub event_id: String,
    pub sender_name: Option<String>,
    /// At most `QUOTE_MAX` characters.
    pub text: Option<String>,
    /// It couldn't be fetched (deleted, not visible to this account, or the homeserver didn't give it).
    pub unavailable: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Reaction {
    /// The emoji (or the words) reacted with, at most `REACTION_MAX` characters.
    pub key: String,
    pub count: usize,
    /// One of them is yours.
    pub own: bool,
}

const NAME_MAX: usize = 120;
const QUOTE_MAX: usize = 200;
const REACTION_MAX: usize = 16;

/// At most `max` characters, with "…" if cut.
fn clip(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((at, _)) => format!("{}…", &s[..at]),
        None => s.to_owned(),
    }
}

/// The type the app may hand a webview with the bytes: a picture (never SVG, which can carry script), sound or video
/// as declared, anything else as plain bytes. The declared type is only a hint the app passes on, so it is checked
/// for shape too (no parameters, no spaces).
pub fn safe_mime(kind: MediaKind, declared: Option<&str>) -> String {
    let d = declared.unwrap_or_default().trim().to_ascii_lowercase();
    let shaped = !d.is_empty()
        && d.len() <= 100
        && d.split_once('/').is_some_and(|(a, b)| !a.is_empty() && !b.is_empty())
        && d.bytes().all(|c| c.is_ascii_alphanumeric() || b"/.+-_".contains(&c));
    let fits = match kind {
        MediaKind::Image => d.starts_with("image/") && !d.starts_with("image/svg"),
        MediaKind::Video => d.starts_with("video/"),
        MediaKind::Audio | MediaKind::Voice => d.starts_with("audio/"),
        MediaKind::File => false,
    };
    if shaped && fits {
        return d;
    }
    match kind {
        // a voice message the bridge didn't type is Ogg Opus, as WhatsApp and Signal send them
        MediaKind::Voice => "audio/ogg".into(),
        _ => "application/octet-stream".into(),
    }
}

fn int(n: Option<UInt>) -> Option<u64> {
    n.map(u64::from)
}

/// A media message's source and description; `None` for anything else.
pub(crate) fn media_of(ev: &EventTimelineItem) -> Option<(MediaSource, Media)> {
    let msg = ev.content().as_message()?;
    let caption = |c: Option<&str>| c.map(str::trim).filter(|c| !c.is_empty()).map(|c| clip(c, 4000));
    let (kind, source, name, mime, size, duration, w, h, cap) = match msg.msgtype() {
        MessageType::Image(i) => {
            let info = i.info.as_deref();
            (MediaKind::Image, i.source.clone(), i.filename(), info.and_then(|x| x.mimetype.clone()), int(info.and_then(|x| x.size)), None, int(info.and_then(|x| x.width)), int(info.and_then(|x| x.height)), caption(i.caption()))
        }
        MessageType::Video(v) => {
            let info = v.info.as_deref();
            let dur = info.and_then(|x| x.duration).map(|d| d.as_millis() as u64);
            (MediaKind::Video, v.source.clone(), v.filename(), info.and_then(|x| x.mimetype.clone()), int(info.and_then(|x| x.size)), dur, int(info.and_then(|x| x.width)), int(info.and_then(|x| x.height)), caption(v.caption()))
        }
        MessageType::Audio(a) => {
            let info = a.info.as_deref();
            let dur = info.and_then(|x| x.duration).map(|d| d.as_millis() as u64);
            let kind = if is_voice(ev) { MediaKind::Voice } else { MediaKind::Audio };
            (kind, a.source.clone(), a.filename(), info.and_then(|x| x.mimetype.clone()), int(info.and_then(|x| x.size)), dur, None, None, caption(a.caption()))
        }
        MessageType::File(f) => {
            let info = f.info.as_deref();
            (MediaKind::File, f.source.clone(), f.filename(), info.and_then(|x| x.mimetype.clone()), int(info.and_then(|x| x.size)), None, None, None, caption(f.caption()))
        }
        _ => return None,
    };
    let name = clip(name.trim(), NAME_MAX);
    let mime = safe_mime(kind, mime.as_deref());
    Some((source, Media { kind, name, mime, size, duration_ms: duration, width: w, height: h, caption: cap }))
}

/// A voice message: the MSC3245 mark the bridges put on a recorded clip (read from the event as sent, so it holds
/// whichever of ruma's unstable features are on).
fn is_voice(ev: &EventTimelineItem) -> bool {
    #[derive(serde::Deserialize)]
    struct Raw {
        content: Marks,
    }
    #[derive(serde::Deserialize)]
    struct Marks {
        #[serde(rename = "org.matrix.msc3245.voice")]
        voice: Option<serde::de::IgnoredAny>,
        #[serde(rename = "org.matrix.msc3245.voice.v2")]
        voice2: Option<serde::de::IgnoredAny>,
    }
    // ruma reads the first version's mark; only an event without it is read again, for the second's
    if ev.content().as_message().is_some_and(|m| matches!(m.msgtype(), MessageType::Audio(a) if a.voice.is_some())) {
        return true;
    }
    let Some(raw) = ev.latest_json().or_else(|| ev.original_json()) else { return false };
    raw.deserialize_as_unchecked::<Raw>().is_ok_and(|r| r.content.voice.is_some() || r.content.voice2.is_some())
}

/// What a reply answers, as far as it is known. `names`: the senders' names the timeline already has, for a quoted event
/// whose own profile isn't loaded (it would show by user id).
fn reply_of(content: &TimelineItemContent, names: &std::collections::HashMap<&UserId, String>) -> Option<Reply> {
    let details = content.in_reply_to()?;
    let (sender_name, text) = match &details.event {
        TimelineDetails::Ready(e) => {
            let words = content_words(&e.content).map(|(_, w, _)| clip(w.trim(), QUOTE_MAX));
            let name = match &e.sender_profile {
                TimelineDetails::Ready(_) => name_of(&e.sender_profile, &e.sender),
                _ => names.get::<&UserId>(&&*e.sender).cloned().unwrap_or_else(|| name_of(&e.sender_profile, &e.sender)),
            };
            (Some(name), words.or_else(|| Some("Message".into())))
        }
        _ => (None, None),
    };
    let unavailable = matches!(details.event, TimelineDetails::Error(_));
    Some(Reply { event_id: details.event_id.to_string(), sender_name, text, unavailable })
}

fn reactions_of(content: &TimelineItemContent, me: Option<&UserId>) -> Vec<Reaction> {
    let Some(all) = content.reactions() else { return vec![] };
    all.iter()
        .filter(|(_, by)| !by.is_empty())
        .map(|(key, by)| Reaction { key: clip(key, REACTION_MAX), count: by.len(), own: me.is_some_and(|me| by.contains_key(me)) })
        .collect()
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
        // T-313: a recorded voice message reads as one, with its length, as a chat app's list says it
        MessageType::Audio(a) if a.voice.is_some() => {
            let secs = a.info.as_deref().and_then(|i| i.duration).map(|d| d.as_secs());
            (MessageKind::Media, secs.map_or("Voice message".into(), |s| format!("Voice message ({}:{:02})", s / 60, s % 60)))
        }
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
/// `me`: the account, to tell its reactions.
pub(crate) fn message_rows(items: &Vector<Arc<TimelineItem>>, me: Option<&UserId>) -> Vec<MessageRow> {
    let names: std::collections::HashMap<&UserId, String> = items
        .iter()
        .filter_map(|i| i.as_event())
        .filter(|e| matches!(e.sender_profile(), TimelineDetails::Ready(_)))
        .map(|e| (e.sender(), name_of(e.sender_profile(), e.sender())))
        .collect();
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
                media: media_of(ev).map(|(_, m)| m),
                reply: reply_of(ev.content(), &names),
                reactions: reactions_of(ev.content(), me),
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
