//! Linking accounts (T-282): Telegram, Signal, WhatsApp, Google Messages, Messenger and Instagram, through the
//! mautrix bridges on our own homeserver.
//!
//! Each bridge has a bot (`@signalbot:<our server>`, …). Linking is a conversation with it in an end-to-end encrypted
//! DM: `login`, then whatever it asks for (a QR to scan, a phone number and a code, cookies), and `list-logins` to see
//! what is linked. The app never shows that DM as a conversation. Here, the bot's replies are read as steps the app
//! can draw: the flows to pick from, a field to fill, a QR, a code, a cookie paste, done or failed. The words are
//! mautrix-go's bridgev2 command replies (v0.32.0, the bridges' v0.2610.0); `read_exchange` is where they are read.
//!
//! Nothing here completes a login by itself: every value is typed by the person, and the QR is scanned on their phone.

use std::{collections::HashMap, sync::Arc, time::Duration};

use tokio::task::JoinHandle;

use futures_util::StreamExt;
use matrix_sdk::{
    ruma::{
        events::room::{member::MembershipState, message::MessageType},
        OwnedUserId, UserId,
    },
    Client, Room, RoomState,
};
use matrix_sdk_ui::{eyeball_im::Vector, timeline::TimelineItem};
use serde::Serialize;

use crate::{from_sdk, invalid, server, signed_out, Messages, MessagesError, Result, Update};

/// One network and its bridge bot's localpart on our homeserver (uni-ops matrix/bridges.py names them).
#[derive(Debug, Clone, Copy)]
pub struct Network {
    pub id: &'static str,
    pub name: &'static str,
    pub bot: &'static str,
}

/// In the order the Link screen shows them: the order to link in, least fragile first.
pub const NETWORKS: [Network; 6] = [
    Network { id: "signal", name: "Signal", bot: "signalbot" },
    Network { id: "telegram", name: "Telegram", bot: "telegrambot" },
    Network { id: "whatsapp", name: "WhatsApp", bot: "whatsappbot" },
    Network { id: "gmessages", name: "Google Messages", bot: "gmessagesbot" },
    Network { id: "messenger", name: "Messenger", bot: "messengerbot" },
    Network { id: "instagram", name: "Instagram", bot: "instagrambot" },
];

/// How long a bot may take to join its DM, or to answer `list-logins`, before its bridge counts as not running.
const BOT_JOIN_WAIT: Duration = Duration::from_secs(15);
const BOT_ANSWER_WAIT: Duration = Duration::from_secs(30);

fn network(id: &str) -> Result<Network> {
    NETWORKS.iter().copied().find(|n| n.id == id).ok_or_else(|| invalid("That isn't a network Messages can link."))
}

/// The bot of `net` on the account's own homeserver.
fn bot_id(own: &UserId, net: &Network) -> Option<OwnedUserId> {
    UserId::parse(format!("@{}:{}", net.bot, own.server_name())).ok()
}

/// Which network's bot a room is a DM with, if it is one: such rooms are linking, not conversations.
pub(crate) fn bridge_of(room: &Room) -> Option<&'static str> {
    let own = room.own_user_id();
    let targets = room.direct_targets();
    if targets.len() != 1 {
        return None;
    }
    let target = targets.iter().next()?.as_user_id()?.to_owned();
    NETWORKS.iter().find(|n| bot_id(own, n).as_deref() == Some(&*target)).map(|n| n.id)
}

/// One linked account, as `list-logins` names it.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LinkedAccount {
    pub id: String,
    pub name: String,
    /// The bridge's state word: CONNECTED, TRANSIENT_DISCONNECT, BAD_CREDENTIALS, LOGGED_OUT, …
    pub state: String,
    /// The bridge says it can't use this login until it's linked again.
    pub attention: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Flow {
    pub id: String,
    pub description: String,
}

/// What the bot is waiting for in a login under way.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LinkStep {
    /// The ways in this bridge offers; the app sends `login <id>`.
    Flows { flows: Vec<Flow> },
    /// One value to type: a phone number, a code, a password.
    Input { name: String, description: Option<String>, options: Vec<String>, optional: bool, secret: bool },
    /// A QR to scan with the phone app. `modules` is the QR itself, one string of 0 and 1 per row, so the app draws it
    /// without a QR library (and it can't be mistaken for a picture from anyone else).
    Qr { modules: Vec<String> },
    /// Something to compare or type on the phone: a pairing code, or Google's emoji.
    Code { code: String },
    /// Cookies from a browser signed in at `url`, pasted as a cURL command or JSON.
    Cookies { url: String },
    /// Sent; the bridge hasn't answered yet.
    Waiting,
    Done { text: String },
    Failed { text: String },
}

/// One network on the Link screen.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LinkRow {
    pub network: &'static str,
    pub name: &'static str,
    /// `checking` | `linked` | `not_linked` | `needs_attention` | `unavailable` (its bridge isn't running)
    pub state: &'static str,
    pub accounts: Vec<LinkedAccount>,
    /// A login under way, if any.
    pub step: Option<LinkStep>,
    /// The bot's words that go with the step (its instructions), or its last word on something that went wrong.
    pub note: Option<String>,
    /// `list-logins` has answered since this account started.
    #[serde(skip)]
    known: bool,
    /// How many times `list-logins` has answered: a check whose count hasn't moved got no answer.
    #[serde(skip)]
    answers: u64,
}

impl LinkRow {
    fn new(net: &Network) -> Self {
        LinkRow { network: net.id, name: net.name, state: "checking", accounts: vec![], step: None, note: None, known: false, answers: 0 }
    }
}

/// One message in a bot DM, as the reader needs it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Said {
    pub own: bool,
    pub image: bool,
    pub body: String,
    pub html: Option<String>,
}

/// What the latest exchange with a bot says: the reply to our last message.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Exchange {
    /// Nothing asked yet.
    Idle,
    /// `list-logins` was asked; `None` until it answers.
    Logins(Option<Vec<LinkedAccount>>),
    /// A login, or a value sent into one.
    Login { step: LinkStep, note: Option<String> },
    /// `cancel` (or nothing under way anymore).
    Cancelled,
}

const ATTENTION: [&str; 4] = ["BAD_CREDENTIALS", "LOGGED_OUT", "UNKNOWN_ERROR", "BRIDGE_UNREACHABLE"];

/// `* `id` (name) - `STATE`` lines, as bridgev2's `GetFormattedUserLogins` writes them.
pub(crate) fn read_logins(body: &str) -> Option<Vec<LinkedAccount>> {
    if body.contains("You're not logged in") {
        return Some(vec![]);
    }
    let mut out = vec![];
    for line in body.lines() {
        let Some(rest) = line.trim().strip_prefix("* `") else { continue };
        let Some((id, rest)) = rest.split_once("` (") else { continue };
        let Some((name, state)) = rest.rsplit_once(") - `") else { continue };
        let state = state.trim_end_matches('`').trim().to_owned();
        out.push(LinkedAccount { id: id.to_owned(), name: name.to_owned(), attention: ATTENTION.contains(&state.as_str()), state });
    }
    (!out.is_empty()).then_some(out)
}

/// `* `id` - description` lines after "Please specify a login flow".
fn read_flows(body: &str) -> Vec<Flow> {
    body.lines()
        .filter_map(|l| {
            let rest = l.trim().strip_prefix("* `")?;
            let (id, desc) = rest.split_once("` - ")?;
            Some(Flow { id: id.to_owned(), description: desc.trim().to_owned() })
        })
        .collect()
}

/// "Please enter your <name>\n<description>\nOptions: `a`, `b`\nEnter `skip` to skip this field".
fn read_input(body: &str) -> LinkStep {
    let mut lines = body.lines();
    let name = lines.next().unwrap_or_default().trim().trim_start_matches("Please enter your ").trim().to_owned();
    let mut description = vec![];
    let mut options = vec![];
    let mut optional = false;
    for l in lines {
        if let Some(o) = l.strip_prefix("Options: ") {
            options = o.split(',').map(|x| x.trim().trim_matches('`').to_owned()).filter(|x| !x.is_empty()).collect();
        } else if l.starts_with("Enter `skip`") {
            optional = true;
        } else if !l.trim().is_empty() {
            description.push(l.trim());
        }
    }
    let lower = name.to_lowercase();
    let secret = ["password", "passcode", "2fa", "two-factor", "token"].iter().any(|w| lower.contains(w));
    LinkStep::Input { name, description: (!description.is_empty()).then(|| description.join("\n")), options, optional, secret }
}

/// A message of only emoji and spaces: Google Messages' pairing emoji.
fn emoji_only(s: &str) -> bool {
    let s = s.trim();
    !s.is_empty() && s.chars().all(|c| c.is_whitespace() || (!c.is_ascii() && !c.is_alphanumeric()))
}

const PROBLEMS: [&str; 12] = [
    "Login failed",
    "Failed to",
    "Invalid value",
    "Invalid login flow",
    "Invalid number of extra parameters",
    "Missing some keys",
    "Some keys can't be extracted",
    "Unknown command",
    "You already have an ongoing",
    "No login flows available",
    "You have reached the maximum number of logins",
    "This login flow requires a client",
];

/// Read the bot's replies to our last message. `said` is the DM, oldest first.
pub(crate) fn read_exchange(said: &[Said]) -> Exchange {
    let Some(last_own) = said.iter().rposition(|s| s.own) else { return Exchange::Idle };
    let asked = said[last_own].body.trim().to_lowercase();
    let replies: Vec<&Said> = said[last_own + 1..].iter().filter(|s| !s.own).collect();
    if asked == "list-logins" {
        return Exchange::Logins(replies.iter().find_map(|r| read_logins(&r.body)));
    }
    if asked == "cancel" {
        return Exchange::Cancelled;
    }
    let mut step = LinkStep::Waiting;
    let mut note: Option<String> = None;
    for r in replies {
        let body = r.body.trim();
        if r.image {
            if !body.is_empty() {
                step = match qr_modules(body) {
                    Some(modules) => LinkStep::Qr { modules },
                    None => LinkStep::Failed { text: "The bridge sent a QR code this app couldn't read.".into() },
                };
            }
        } else if body.starts_with("Please specify a login flow") {
            step = LinkStep::Flows { flows: read_flows(body) };
        } else if body.starts_with("Please enter your ") {
            step = read_input(body);
        } else if let Some(url) = body.strip_prefix("Login URL:") {
            step = LinkStep::Cookies { url: url.trim().trim_start_matches('<').trim_end_matches('>').to_owned() };
        } else if r.html.as_deref().is_some_and(|h| h.trim_start().starts_with("<code>")) || emoji_only(body) {
            step = LinkStep::Code { code: body.to_owned() };
        } else if body.starts_with("Login cancelled") {
            return Exchange::Cancelled;
        } else if body.contains("uccessfully logged in") || body.starts_with("Logged in as") {
            step = LinkStep::Done { text: body.to_owned() };
            note = None;
        } else if PROBLEMS.iter().any(|p| body.starts_with(p)) {
            // a refused value keeps its field open; a failed login ends the login
            if body.starts_with("Login failed") || body.starts_with("Failed to") {
                step = LinkStep::Failed { text: body.to_owned() };
            } else if body.starts_with("Invalid login flow") {
                step = LinkStep::Flows { flows: read_flows(body) };
            }
            note = Some(body.to_owned());
        } else if !body.starts_with('\u{26a0}') {
            // the step's instructions ("Scan the QR code…"); the warning about the management room is left out
            note = Some(body.to_owned());
        }
    }
    Exchange::Login { step, note }
}

/// The QR's modules, one string per row.
fn qr_modules(data: &str) -> Option<Vec<String>> {
    let code = qrcode::QrCode::with_error_correction_level(data.as_bytes(), qrcode::EcLevel::L).ok()?;
    let width = code.width();
    let colors = code.to_colors();
    Some(colors.chunks(width).map(|row| row.iter().map(|c| if *c == qrcode::Color::Dark { '1' } else { '0' }).collect()).collect())
}

/// The DM's messages, oldest first: ours, and the bot's.
fn said_in(items: &Vector<Arc<TimelineItem>>, bot: &UserId) -> Vec<Said> {
    items
        .iter()
        .filter_map(|item| {
            let ev = item.as_event()?;
            let own = ev.is_own();
            if !own && ev.sender() != bot {
                return None;
            }
            let msg = ev.content().as_message()?;
            let (image, body, html) = match msg.msgtype() {
                MessageType::Image(i) => (true, i.body.clone(), None),
                MessageType::Notice(n) => (false, n.body.clone(), n.formatted.as_ref().map(|f| f.body.clone())),
                MessageType::Text(t) => (false, t.body.clone(), t.formatted.as_ref().map(|f| f.body.clone())),
                _ => return None,
            };
            Some(Said { own, image, body, html })
        })
        .collect()
}

impl Messages {
    /// Every network's row, as last known; a check of each starts in the background (its rows follow as updates).
    pub async fn links(self: &Arc<Self>) -> Result<Vec<LinkRow>> {
        let (client, account) = self.client().await?;
        let rows = self.link_rows();
        for net in NETWORKS {
            let me = self.clone();
            let (client, account) = (client.clone(), account.clone());
            tokio::spawn(async move {
                if let Err(e) = me.link_check_with(&client, &account, &net).await {
                    tracing::warn!("checking {}: {e}", net.id);
                }
            });
        }
        Ok(rows)
    }

    /// Ask one bridge what is linked (`list-logins`), unless a login is under way there.
    pub async fn link_check(self: &Arc<Self>, id: &str) -> Result<LinkRow> {
        let net = network(id)?;
        let (client, account) = self.client().await?;
        self.link_check_with(&client, &account, &net).await?;
        Ok(self.link_row(&net))
    }

    async fn link_check_with(self: &Arc<Self>, client: &Client, account: &str, net: &Network) -> Result<()> {
        let Some(room) = self.link_room(client, account, net).await? else { return Ok(()) };
        if matches!(self.link_row(net).step, Some(LinkStep::Flows { .. } | LinkStep::Input { .. } | LinkStep::Qr { .. } | LinkStep::Code { .. } | LinkStep::Cookies { .. } | LinkStep::Waiting)) {
            return Ok(());
        }
        let before = self.link_row(net).answers;
        self.send(room.room_id().as_str(), "list-logins").await?;
        // a bot that has joined but doesn't answer: its bridge is down now
        let me = self.clone();
        let net = *net;
        tokio::spawn(async move {
            tokio::time::sleep(BOT_ANSWER_WAIT).await;
            let mut row = me.link_row(&net);
            if row.answers == before && row.step.is_none() {
                row.state = "unavailable";
                row.note = Some(format!("The {} bridge isn't answering on the homeserver.", net.name));
                me.set_link_row(row);
            }
        });
        Ok(())
    }

    /// Start linking: `login` (the bot lists its ways in, or starts the only one), `login <flow>`, or, for a login the
    /// bridge can't use anymore, `relogin <login id> [flow]`.
    pub async fn link_start(self: &Arc<Self>, id: &str, flow: Option<&str>, relogin: Option<&str>) -> Result<LinkRow> {
        let net = network(id)?;
        let word = |s: &str| !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.+@:".contains(c));
        let flow = flow.filter(|f| !f.is_empty());
        let relogin = relogin.filter(|r| !r.is_empty());
        if flow.is_some_and(|f| !word(f)) || relogin.is_some_and(|r| !word(r)) {
            return Err(invalid("That isn't a login the bridge offers."));
        }
        let command = match (relogin, flow) {
            (Some(r), Some(f)) => format!("relogin {r} {f}"),
            (Some(r), None) => format!("relogin {r}"),
            (None, Some(f)) => format!("login {f}"),
            (None, None) => "login".to_owned(),
        };
        self.link_say(&net, &command).await
    }

    /// Answer the bot: the value its step asks for (a phone number, a code, cookies).
    pub async fn link_send(self: &Arc<Self>, id: &str, value: &str) -> Result<LinkRow> {
        let net = network(id)?;
        let value = value.trim();
        if value.is_empty() {
            return Err(invalid("There's nothing to send."));
        }
        // a value that reads as a command would be run as one: the step's fields are never commands
        if matches!(value.split_whitespace().next(), Some("cancel" | "login" | "relogin" | "logout" | "list-logins" | "help")) {
            return Err(invalid("That reads as a command to the bridge, not an answer."));
        }
        self.link_say(&net, value).await
    }

    /// Stop a login under way.
    pub async fn link_cancel(self: &Arc<Self>, id: &str) -> Result<LinkRow> {
        let net = network(id)?;
        self.link_say(&net, "cancel").await
    }

    async fn link_say(self: &Arc<Self>, net: &Network, text: &str) -> Result<LinkRow> {
        let (client, account) = self.client().await?;
        let room = self
            .link_room(&client, &account, net)
            .await?
            .ok_or_else(|| MessagesError::Unreachable { message: format!("The {} bridge isn't running.", net.name) })?;
        self.send(room.room_id().as_str(), text).await?;
        Ok(self.link_row(net))
    }

    fn mark_unavailable(&self, net: &Network) {
        let mut row = self.link_row(net);
        row.state = "unavailable";
        row.step = None;
        row.note = Some(format!("The {} bridge isn't answering on the homeserver.", net.name));
        self.set_link_row(row);
    }

    fn link_rows(&self) -> Vec<LinkRow> {
        NETWORKS.iter().map(|n| self.link_row(n)).collect()
    }

    fn link_row(&self, net: &Network) -> LinkRow {
        self.links.lock().unwrap().get(net.id).cloned().unwrap_or_else(|| LinkRow::new(net))
    }

    fn set_link_row(&self, row: LinkRow) {
        let changed = {
            let mut all = self.links.lock().unwrap();
            let changed = all.get(row.network) != Some(&row);
            all.insert(row.network, row.clone());
            changed
        };
        if changed {
            let _ = self.tx.send(Update::Link { link: row });
        }
    }

    /// The DM with `net`'s bot, made if there is none, and watched; `None` if the bot doesn't join (its bridge isn't
    /// running), and the row says so.
    async fn link_room(self: &Arc<Self>, client: &Client, account: &str, net: &Network) -> Result<Option<Room>> {
        let own = client.user_id().ok_or_else(signed_out)?.to_owned();
        let bot = bot_id(&own, net).ok_or_else(|| server("no bot address on this homeserver"))?;
        let key = (account.to_owned(), net.id);
        let mut fresh_tried = false;
        loop {
            // one at a time: continuwuity 26.9.1 gives two rooms created in the same moment by one account the same room
            // id (a room id is the hash of its create event), so DMs made side by side would be one room with every bot
            let mut made = self.link_creating.lock().await;
            // the DM this account already made here: m.direct, which marks it, may not have synced back yet
            let mut room = made.get(&key).and_then(|id| client.get_room(id)).filter(|r| r.state() == RoomState::Joined);
            if room.is_none() {
                let existing = client
                    .joined_rooms()
                    .into_iter()
                    .filter(|r| r.direct_targets().iter().any(|t| t.as_user_id() == Some(&*bot)))
                    .collect::<Vec<_>>();
                for r in &existing {
                    if bot_joined(r, &bot).await {
                        room = Some(r.clone());
                        break;
                    }
                }
                room = room.or_else(|| existing.into_iter().next());
            }
            let fresh = room.is_none();
            let room = match room {
                Some(r) => r,
                None => {
                    // a bot its bridge has never started has no account yet: no DM for it, so none waits on a dead invite
                    if let Err(e) = client.account().fetch_user_profile_of(&bot).await {
                        if e.as_client_api_error().is_some_and(|api| api.status_code.as_u16() == 404) {
                            drop(made);
                            self.mark_unavailable(net);
                            return Ok(None);
                        }
                    }
                    client.create_dm(&bot).await.map_err(from_sdk)?
                }
            };
            made.insert(key.clone(), room.room_id().to_owned());
            drop(made);
            self.watch_link(client, account, net, &room, &bot).await?;
            let started = std::time::Instant::now();
            while !bot_joined(&room, &bot).await && started.elapsed() < BOT_JOIN_WAIT {
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            if bot_joined(&room, &bot).await {
                // a member bot may still be down: only its answer (apply_exchange) says it's running again
                return Ok(Some(room));
            }
            // the bot never came (its bridge was down when it was invited, and an invite isn't sent again): leave this
            // DM, so a fresh one is made, which the running bridge sees. Once; if that one isn't joined either, the
            // bridge isn't running.
            self.link_creating.lock().await.remove(&key);
            if let Some(t) = self.open.lock().await.links.remove(net.id) {
                t.abort();
            }
            let _ = self.close(room.room_id().as_str()).await;
            let _ = room.leave().await;
            let _ = room.forget().await;
            if fresh || fresh_tried {
                self.mark_unavailable(net);
                return Ok(None);
            }
            fresh_tried = true;
        }
    }

    /// Follow the bot DM's timeline and keep `net`'s row up to date. Once per room and account.
    async fn watch_link(self: &Arc<Self>, client: &Client, account: &str, net: &Network, room: &Room, bot: &UserId) -> Result<()> {
        let room_id = room.room_id().to_owned();
        if self.open.lock().await.links.contains_key(net.id) {
            return Ok(());
        }
        let timeline = self.timeline(client, account, &room_id).await?;
        if timeline.items().await.len() < 10 {
            let _ = timeline.paginate_backwards(20).await;
        }
        let (items, mut stream) = timeline.subscribe().await;
        let me = Arc::downgrade(self);
        let (net, bot) = (*net, bot.to_owned());
        let task = tokio::spawn(async move {
            let mut items = items;
            let mut was_done = false;
            let mut paging: Option<JoinHandle<()>> = None;
            loop {
                let Some(me) = me.upgrade() else { break };
                // after a gap (the homeserver restarted, or the device slept) the window can start after our last
                // message, and a reply can't be read without what it answers: load earlier messages until it's back
                if !items.is_empty() && !items.iter().any(|i| i.as_event().is_some_and(|e| e.is_own())) && paging.as_ref().is_none_or(|p| p.is_finished()) {
                    let t = timeline.clone();
                    paging = Some(tokio::spawn(async move {
                        let _ = t.paginate_backwards(20).await;
                    }));
                }
                let exchange = read_exchange(&said_in(&items, &bot));
                let done = me.apply_exchange(&net, exchange);
                if done && !was_done {
                    // a finished login: ask what is linked now, so the card says so
                    let me = me.clone();
                    let rid = room_id.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        let _ = me.send(rid.as_str(), "list-logins").await;
                    });
                }
                was_done = done;
                drop(me);
                let Some(diffs) = stream.next().await else { break };
                for d in diffs {
                    d.apply(&mut items);
                }
            }
        });
        let mut open = self.open.lock().await;
        if open.account.as_deref() != Some(account) {
            task.abort();
            return Err(signed_out());
        }
        if let Some(old) = open.links.insert(net.id, task) {
            old.abort();
        }
        Ok(())
    }

    /// Fold what the latest exchange says into the row; whether a login just finished.
    fn apply_exchange(&self, net: &Network, exchange: Exchange) -> bool {
        let mut row = self.link_row(net);
        let mut done = false;
        match exchange {
            // nothing new from the bot: the card stays as it is (a bridge found not running stays so)
            Exchange::Idle | Exchange::Logins(None) => return false,
            Exchange::Logins(Some(accounts)) => {
                row.step = None;
                row.note = None;
                row.accounts = accounts;
                row.known = true;
                row.answers += 1;
            }
            Exchange::Cancelled => {
                row.step = None;
                row.note = None;
            }
            Exchange::Login { step, note } => {
                done = matches!(step, LinkStep::Done { .. });
                row.step = Some(step);
                row.note = note;
            }
        }
        row.state = state_of(&row.accounts, row.known);
        self.set_link_row(row);
        done
    }
}

/// A card's word: what `list-logins` last said, or `checking` until it has answered.
fn state_of(accounts: &[LinkedAccount], known: bool) -> &'static str {
    if accounts.iter().any(|a| a.attention) {
        "needs_attention"
    } else if !accounts.is_empty() {
        "linked"
    } else if known {
        "not_linked"
    } else {
        "checking"
    }
}

/// Whether the bot has joined the room.
async fn bot_joined(room: &Room, bot: &UserId) -> bool {
    if room.state() != RoomState::Joined {
        return false;
    }
    matches!(room.get_member_no_sync(bot).await, Ok(Some(m)) if *m.membership() == MembershipState::Join)
}

/// The rows by network, for `Messages`.
pub(crate) type LinkRows = HashMap<&'static str, LinkRow>;

#[cfg(test)]
mod tests {
    use super::*;

    fn own(b: &str) -> Said {
        Said { own: true, image: false, body: b.into(), html: None }
    }
    fn bot(b: &str) -> Said {
        Said { own: false, image: false, body: b.into(), html: None }
    }

    #[test]
    fn logins_linked_unlinked_and_needing_attention() {
        assert_eq!(read_exchange(&[own("list-logins")]), Exchange::Logins(None));
        assert_eq!(read_exchange(&[own("list-logins"), bot("You're not logged in")]), Exchange::Logins(Some(vec![])));
        let two = "\n* `4917` (Alex Example) - `CONNECTED`\n* `5550` (+1 555 0100) - `BAD_CREDENTIALS`";
        let Exchange::Logins(Some(a)) = read_exchange(&[own("list-logins"), bot(two)]) else { panic!() };
        assert_eq!(a.len(), 2);
        assert_eq!((a[0].id.as_str(), a[0].name.as_str(), a[0].state.as_str(), a[0].attention), ("4917", "Alex Example", "CONNECTED", false));
        assert!(a[1].attention);
        // a name with parentheses in it
        let Exchange::Logins(Some(a)) = read_exchange(&[own("list-logins"), bot("* `x1` (Sam (work)) - `CONNECTED`")]) else { panic!() };
        assert_eq!(a[0].name, "Sam (work)");
    }

    #[test]
    fn a_login_walks_flows_input_qr_code_cookies_and_done() {
        let flows = "Please specify a login flow, e.g. `login qr`.\n\n* `qr` - Scan a QR code\n* `phone` - Pair with a code\n";
        let Exchange::Login { step: LinkStep::Flows { flows }, .. } = read_exchange(&[own("login"), bot(flows)]) else { panic!() };
        assert_eq!(flows, vec![Flow { id: "qr".into(), description: "Scan a QR code".into() }, Flow { id: "phone".into(), description: "Pair with a code".into() }]);

        let ask = "Please enter your Phone number\nInclude the country code\nEnter `skip` to skip this field";
        let Exchange::Login { step, .. } = read_exchange(&[own("login phone"), bot(ask)]) else { panic!() };
        assert_eq!(step, LinkStep::Input { name: "Phone number".into(), description: Some("Include the country code".into()), options: vec![], optional: true, secret: false });
        let Exchange::Login { step: LinkStep::Input { secret, .. }, .. } = read_exchange(&[own("login"), bot("Please enter your Password")]) else { panic!() };
        assert!(secret);

        // instructions first, then the QR as an image whose body is the code's data
        let qr = Said { own: false, image: true, body: "2@example-pairing-data".into(), html: None };
        let Exchange::Login { step: LinkStep::Qr { modules }, note } = read_exchange(&[own("login qr"), bot("Scan the QR code on your phone"), qr]) else { panic!() };
        assert_eq!(note.as_deref(), Some("Scan the QR code on your phone"));
        assert!(modules.len() >= 21 && modules.iter().all(|r| r.len() == modules.len()));

        let code = Said { own: false, image: false, body: "ABCD-EFGH".into(), html: Some("<code>ABCD-EFGH</code>".into()) };
        assert!(matches!(read_exchange(&[own("+15550100"), code]), Exchange::Login { step: LinkStep::Code { code }, .. } if code == "ABCD-EFGH"));
        assert!(matches!(read_exchange(&[own("login google"), bot("🦊 🍕 🚲")]), Exchange::Login { step: LinkStep::Code { .. }, .. }));

        let Exchange::Login { step, .. } = read_exchange(&[own("login messenger"), bot("Login URL: <https://www.messenger.com/>")]) else { panic!() };
        assert_eq!(step, LinkStep::Cookies { url: "https://www.messenger.com/".into() });

        assert!(matches!(read_exchange(&[own("1234"), bot("Successfully logged in as +1 555 0100")]), Exchange::Login { step: LinkStep::Done { .. }, .. }));
        assert_eq!(read_exchange(&[own("login qr"), bot("Login cancelled.")]), Exchange::Cancelled);
        assert_eq!(read_exchange(&[own("cancel")]), Exchange::Cancelled);
        assert_eq!(read_exchange(&[bot("Hello, I'm a bridge bot.")]), Exchange::Idle);
    }

    #[test]
    fn problems_keep_a_field_open_or_end_the_login() {
        let ask = bot("Please enter your Phone number");
        let Exchange::Login { step, note } = read_exchange(&[own("+1"), ask.clone(), bot("Invalid value: too short")]) else { panic!() };
        assert!(matches!(step, LinkStep::Input { .. }), "a refused value keeps the field");
        assert_eq!(note.as_deref(), Some("Invalid value: too short"));
        let Exchange::Login { step, .. } = read_exchange(&[own("login qr"), bot("Login failed: timed out")]) else { panic!() };
        assert_eq!(step, LinkStep::Failed { text: "Login failed: timed out".into() });
        let Exchange::Login { step, note } = read_exchange(&[own("login"), bot("You already have an ongoing login. You can use `cancel` to cancel it.")]) else { panic!() };
        assert_eq!(step, LinkStep::Waiting);
        assert!(note.unwrap().contains("ongoing"));
        // the bot's management-room warning is not an instruction
        let Exchange::Login { note, .. } = read_exchange(&[own("login"), bot("\u{26a0}\u{fe0f} This is not your management room.")]) else { panic!() };
        assert_eq!(note, None);
        // only the replies to the last thing we said count
        assert_eq!(read_exchange(&[own("login qr"), bot("Please enter your Code"), own("list-logins")]), Exchange::Logins(None));
    }
}
