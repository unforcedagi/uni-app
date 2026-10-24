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

use crate::{from_sdk, invalid, now_ms, server, signed_out, Messages, MessagesError, Result, Update};

/// One network and its bridge bot's localpart on our homeserver (uni-ops matrix/bridges.py names them).
/// Every command goes with the bridge's command prefix (uni-ops matrix/bridges.py sets it): then it works in any DM
/// with the bot, not only the one the bridge took as the account's management room.
#[derive(Debug, Clone, Copy)]
pub struct Network {
    pub id: &'static str,
    pub name: &'static str,
    pub bot: &'static str,
    pub prefix: &'static str,
}

/// In the order the Link screen shows them: the order to link in, least fragile first.
pub const NETWORKS: [Network; 6] = [
    Network { id: "signal", name: "Signal", bot: "signalbot", prefix: "!signal" },
    Network { id: "telegram", name: "Telegram", bot: "telegrambot", prefix: "!tg" },
    Network { id: "whatsapp", name: "WhatsApp", bot: "whatsappbot", prefix: "!wa" },
    Network { id: "gmessages", name: "Google Messages", bot: "gmessagesbot", prefix: "!gm" },
    Network { id: "messenger", name: "Messenger", bot: "messengerbot", prefix: "!fb" },
    Network { id: "instagram", name: "Instagram", bot: "instagrambot", prefix: "!ig" },
];

/// mautrix-go v0.32.0 bridgev2's commands and aliases (commands/processor.go and the files it lists).
const BOT_COMMANDS: [&str; 46] = [
    "help", "cancel", "debug-register-push", "debug-account-data", "debug-reset-network", "delete-portal",
    "delete-all-portals", "set-management-room", "login", "relogin", "list-logins", "logout", "set-preferred-login",
    "prefer", "set-relay", "unset-relay", "resolve-identifier", "start-chat", "pm", "create-group", "create", "search",
    "create-portal", "id", "unbridge", "bridge", "sync-chat", "sync", "mute", "unmute", "delete-chat", "block-user",
    "block", "unblock", "filter", "sudo", "doas", "do-as", "runas", "run-as", "doin", "do-in", "runin", "run-in",
    "import-image-pack", "version",
];

/// How long a bot may take to join its DM, or to answer `list-logins`, before its bridge counts as not running.
const BOT_JOIN_WAIT: Duration = Duration::from_secs(15);
const BOT_ANSWER_WAIT: Duration = Duration::from_secs(30);
/// How long the Link screen's checks wait for a new sign-in's first sync.
const FIRST_SYNC_WAIT: Duration = Duration::from_secs(10);

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
    let is_bot = |u: &UserId| NETWORKS.iter().find(|n| bot_id(own, n).as_deref() == Some(u)).map(|n| n.id);
    let targets = room.direct_targets();
    if targets.len() == 1 {
        if let Some(net) = targets.iter().next().and_then(|t| t.as_user_id()).and_then(is_bot) {
            return Some(net);
        }
    }
    // a DM just made here, before m.direct has synced back: us and a bot, and no one else
    if targets.is_empty() && room.active_members_count() <= 2 {
        let heroes = room.heroes();
        if heroes.len() == 1 {
            return is_bot(&heroes[0].user_id);
        }
    }
    None
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

impl LinkStep {
    /// A login is under way: the bot waits for the person, or the person for the bot.
    pub fn in_progress(&self) -> bool {
        !matches!(self, LinkStep::Done { .. } | LinkStep::Failed { .. })
    }
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
    /// Goes up with every change, so the app keeps the newest of a command's answer and an update that crossed it.
    pub rev: u64,
    /// `list-logins` has answered since this account started.
    #[serde(skip)]
    known: bool,
    /// When `list-logins` last answered (the answer's own time, ms): a check asked after it got no answer yet.
    #[serde(skip)]
    answered_at: u64,
}

impl LinkRow {
    fn new(net: &Network) -> Self {
        LinkRow { network: net.id, name: net.name, state: "checking", accounts: vec![], step: None, note: None, rev: 0, known: false, answered_at: 0 }
    }
}

/// One message in a bot DM, as the reader needs it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Said {
    pub own: bool,
    /// Milliseconds since the epoch.
    pub ts: u64,
    pub image: bool,
    pub body: String,
    pub html: Option<String>,
}

/// What the latest exchange with a bot says: the reply to our last message.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Exchange {
    /// Nothing asked yet.
    Idle,
    /// `list-logins` was asked; `None` until it answers, then the logins and the answer's time.
    Logins(Option<(Vec<LinkedAccount>, u64)>),
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

/// Refusals after which the bridge still waits for the same field (mautrix-go bridgev2 commands/login.go returns
/// without clearing its command state): the field stays open for a corrected value.
const RETRY_SAME_FIELD: [&str; 4] = ["Invalid value", "Missing some keys", "Some keys can't be extracted", "Failed to parse"];

fn retry_same_field(note: &str) -> bool {
    RETRY_SAME_FIELD.iter().any(|p| note.starts_with(p))
}

/// Read the bot's replies to our last message. `said` is the DM, oldest first. A refusal of a value the field is still
/// waiting for keeps that field (walking back over earlier refusals to the prompt they answer), with the refusal as
/// its note.
pub(crate) fn read_exchange(said: &[Said]) -> Exchange {
    let latest = read_one(said);
    let Exchange::Login { step: LinkStep::Waiting, note: Some(problem) } = &latest else { return latest };
    if !retry_same_field(problem) {
        return latest;
    }
    let mut cut = said.iter().rposition(|s| s.own).unwrap_or(0);
    loop {
        match read_one(&said[..cut]) {
            Exchange::Login { step: step @ (LinkStep::Input { .. } | LinkStep::Cookies { .. }), .. } => {
                return Exchange::Login { step, note: Some(problem.clone()) };
            }
            Exchange::Login { step: LinkStep::Waiting, note: Some(p) } if retry_same_field(&p) => {
                let Some(prev) = said[..cut].iter().rposition(|s| s.own) else { return latest };
                cut = prev;
            }
            _ => return latest,
        }
    }
}

/// The replies to our last message alone.
fn read_one(said: &[Said]) -> Exchange {
    let Some(last_own) = said.iter().rposition(|s| s.own) else { return Exchange::Idle };
    let asked = said[last_own].body.trim().to_lowercase();
    let replies: Vec<&Said> = said[last_own + 1..].iter().filter(|s| !s.own).collect();
    if asked == "list-logins" {
        return Exchange::Logins(replies.iter().find_map(|r| read_logins(&r.body).map(|a| (a, r.ts))));
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
        } else if let Some(rest) = body.strip_prefix("Login URL:") {
            step = LinkStep::Cookies { url: login_url(rest) };
        } else if r.html.as_deref().is_some_and(|h| h.trim_start().starts_with("<code>")) || emoji_only(body) {
            step = LinkStep::Code { code: body.to_owned() };
        } else if body.starts_with("Login cancelled") {
            return Exchange::Cancelled;
        } else if body.contains("uccessfully logged in") || body.starts_with("Logged in as") {
            step = LinkStep::Done { text: body.to_owned() };
            note = None;
        } else if PROBLEMS.iter().any(|p| body.starts_with(p)) {
            // a refused value keeps its field open; a failed login ends the login
            if body.starts_with("Login failed") || (body.starts_with("Failed to") && !retry_same_field(body)) {
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

/// The link in "Login URL: <https://…>": the first word, without its angle brackets, if it is an https URL; else
/// empty (the card then says where to sign in without a link).
fn login_url(rest: &str) -> String {
    let word = rest.trim().split_whitespace().next().unwrap_or_default();
    let word = word.trim_start_matches('<');
    let word = word.split('>').next().unwrap_or_default();
    match url::Url::parse(word) {
        Ok(u) if u.scheme() == "https" && u.host_str().is_some() => u.to_string(),
        _ => String::new(),
    }
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
            let (image, mut body, html) = match msg.msgtype() {
                MessageType::Image(i) => (true, i.body.clone(), None),
                MessageType::Notice(n) => (false, n.body.clone(), n.formatted.as_ref().map(|f| f.body.clone())),
                MessageType::Text(t) => (false, t.body.clone(), t.formatted.as_ref().map(|f| f.body.clone())),
                _ => return None,
            };
            if own {
                // what we said, without the bridge's command prefix: "!signal list-logins" is "list-logins"
                if let Some(rest) = body.strip_prefix('!').and_then(|b| b.split_once(' ')).map(|(_, rest)| rest.to_owned()) {
                    body = rest;
                }
            }
            Some(Said { own, ts: u64::from(ev.timestamp().0), image, body, html })
        })
        .collect()
}

impl Messages {
    /// Every network's row, as last known; a check of each starts in the background (its rows follow as updates).
    pub async fn links(self: &Arc<Self>) -> Result<Vec<LinkRow>> {
        let (client, account) = self.client().await?;
        let rows = self.link_rows();
        let me = self.clone();
        tokio::spawn(async move {
            // a device that has just signed in hasn't synced its rooms yet: looking for the bots' DMs before that would
            // make new ones
            let started = std::time::Instant::now();
            while me.status().state != "live" && started.elapsed() < FIRST_SYNC_WAIT {
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            for net in NETWORKS {
                let me = me.clone();
                let (client, account) = (client.clone(), account.clone());
                tokio::spawn(async move {
                    if let Err(e) = me.link_check_with(&client, &account, &net, false).await {
                        tracing::warn!("checking {}: {e}", net.id);
                    }
                });
            }
        });
        Ok(rows)
    }

    /// Ask one bridge what is linked (`list-logins`), unless a login is under way there.
    pub async fn link_check(self: &Arc<Self>, id: &str) -> Result<LinkRow> {
        let net = network(id)?;
        let (client, account) = self.client().await?;
        self.link_check_with(&client, &account, &net, true).await?;
        Ok(self.link_row(&net))
    }

    async fn link_check_with(self: &Arc<Self>, client: &Client, account: &str, net: &Network, force: bool) -> Result<()> {
        let Some(room) = self.link_room(client, account, net).await? else { return Ok(()) };
        let row = self.link_row(net);
        if row.step.as_ref().is_some_and(LinkStep::in_progress) {
            return Ok(());
        }
        let asked_at = now_ms();
        // the screen opening again within a minute doesn't ask again; "Check again" always does
        if !force && row.state != "unavailable" && row.answered_at + 60_000 > asked_at {
            return Ok(());
        }
        self.send(room.room_id().as_str(), &format!("{} list-logins", net.prefix)).await?;
        // a bot that has joined but doesn't answer: its bridge is down now
        let me = self.clone();
        let (net, account) = (*net, account.to_owned());
        tokio::spawn(async move {
            tokio::time::sleep(BOT_ANSWER_WAIT).await;
            if me.client().await.map(|(_, a)| a) != Ok(account) {
                return;
            }
            let mut row = me.link_row(&net);
            if row.answered_at < asked_at.saturating_sub(5_000) && row.step.is_none() {
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
        // the bridge runs any message whose first word is one of its commands as that command, in any case, even in
        // the middle of a login step (mautrix-go bridgev2 commands/processor.go): such a value can't be sent as an answer
        let first = value.split_whitespace().next().unwrap_or_default().to_lowercase();
        if BOT_COMMANDS.contains(&first.as_str()) {
            return Err(invalid(format!("The bridge would read a reply starting with \"{first}\" as its own command, not as your answer.")));
        }
        self.link_say(&net, value).await
    }

    /// Stop a login under way.
    pub async fn link_cancel(self: &Arc<Self>, id: &str) -> Result<LinkRow> {
        let net = network(id)?;
        self.link_say(&net, "cancel").await
    }

    /// Say `text` to the bot. What is said here can be a login value (a code, a password, cookies), so it goes only
    /// into a room that is safe for it (`safe_for_secrets`), checked again right before the send: a room that has
    /// stopped being safe since it was picked is dropped and a fresh one made.
    async fn link_say(self: &Arc<Self>, net: &Network, text: &str) -> Result<LinkRow> {
        let (client, account) = self.client().await?;
        let own = client.user_id().ok_or_else(signed_out)?.to_owned();
        let bot = bot_id(&own, net).ok_or_else(|| server("no bot address on this homeserver"))?;
        for _ in 0..2 {
            let room = self
                .link_room(&client, &account, net)
                .await?
                .ok_or_else(|| MessagesError::Unreachable { message: format!("The {} bridge isn't running.", net.name) })?;
            if safe_for_secrets(&client, &room, &own, &bot).await {
                self.send(room.room_id().as_str(), &format!("{} {text}", net.prefix)).await?;
                return Ok(self.link_row(net));
            }
            self.link_creating.lock().await.remove(&(account.clone(), net.id));
        }
        Err(MessagesError::Refused { message: format!("No safe room with the {} bridge: nothing was sent.", net.name) })
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

    fn set_link_row(&self, mut row: LinkRow) {
        let changed = {
            let mut all = self.links.lock().unwrap();
            let same = all.get(row.network).is_some_and(|prev| LinkRow { rev: prev.rev, ..row.clone() } == *prev);
            if !same {
                row.rev = self.link_rev.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                all.insert(row.network, row.clone());
            }
            !same
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
            if let Some(r) = &room {
                if !safe_for_secrets(client, r, &own, &bot).await {
                    // gained a member, say: never used again for this bridge
                    made.remove(&key);
                    room = None;
                }
            }
            if room.is_none() {
                // marked as a DM with the bot, or just the two of us in it
                let mut existing = Vec::new();
                for r in client.joined_rooms() {
                    let marked = r.direct_targets().iter().any(|t| t.as_user_id() == Some(&*bot));
                    if marked || (r.joined_members_count() == 2 && !r.is_space() && bot_joined(&r, &bot).await) {
                        existing.push(r);
                    }
                }
                if existing.is_empty() {
                    // a device that has just signed in may not have loaded every room yet: the account's own list of
                    // DMs on the server says whether there is one to wait for, instead of making another
                    existing = server_dms(client, &bot).await;
                }
                // only a room safe for login values: encrypted, with exactly us and the bot in it. Others (a DM someone
                // else was added to, an unencrypted one) are left as they are and never used here.
                let mut safe = Vec::new();
                for r in existing {
                    if safe_for_secrets(client, &r, &own, &bot).await {
                        safe.push(r);
                    }
                }
                let existing = safe;
                if existing.len() > 1 {
                    // more than one DM with this bot (two devices each made one before seeing the other's): keep the
                    // one where the bot spoke last, which is the one it answers in, and leave the others
                    let mut scored = Vec::new();
                    for r in existing {
                        scored.push((bot_spoke_at(&r, &bot).await, r));
                    }
                    scored.sort_by_key(|(at, _)| std::cmp::Reverse(*at));
                    let mut rest = scored.into_iter().map(|(_, r)| r);
                    room = rest.next();
                    for extra in rest {
                        let bot = bot.clone();
                        tokio::spawn(async move {
                            let _ = extra.kick_user(&bot, Some("a duplicate DM; another one with this bot is kept")).await;
                            let _ = extra.leave().await;
                            let _ = extra.forget().await;
                        });
                    }
                } else {
                    room = existing.into_iter().next();
                }
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
                    // encrypted from its first event, the bot the only one invited
                    let r = client.create_dm(&bot).await.map_err(from_sdk)?;
                    if !safe_for_secrets(client, &r, &own, &bot).await {
                        return Err(server("the new room with the bridge isn't encrypted"));
                    }
                    r
                }
            };
            made.insert(key.clone(), room.room_id().to_owned());
            drop(made);
            self.watch_link(client, account, net, &room, &bot).await?;
            let started = std::time::Instant::now();
            while !bot_joined_now(client, &room, &bot).await && started.elapsed() < BOT_JOIN_WAIT {
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            if bot_joined_now(client, &room, &bot).await {
                // a member bot may still be down: only its answer (apply_exchange) says it's running again
                return Ok(Some(room));
            }
            // the bot never came (its bridge was down when it was invited, and an invite isn't sent again): leave this
            // DM, so a fresh one is made, which the running bridge sees. Once; if that one isn't joined either, the
            // bridge isn't running.
            self.link_creating.lock().await.remove(&key);
            if let Some((_, t)) = self.open.lock().await.links.remove(net.id) {
                t.abort();
            }
            let _ = self.close(room.room_id().as_str()).await;
            // take the invite back first, so the bridge, when it does start, doesn't join a room nobody is in
            let _ = room.kick_user(&bot, Some("the bridge didn't answer; a new DM replaces this one")).await;
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
        if self.open.lock().await.links.get(net.id).is_some_and(|(watched, _)| *watched == room_id) {
            return Ok(());
        }
        // not forwarded to the app as a conversation: what is typed into a login step (a password, a code, cookies)
        // stays in Rust
        let timeline = self.timeline_with(client, account, &room_id, false).await?;
        if timeline.items().await.len() < 10 {
            let _ = timeline.paginate_backwards(20).await;
        }
        let (items, mut stream) = timeline.subscribe().await;
        let me = Arc::downgrade(self);
        let (net, bot) = (*net, bot.to_owned());
        let watched = room_id.clone();
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
                        let _ = me.send(rid.as_str(), &format!("{} list-logins", net.prefix)).await;
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
        if let Some((_, old)) = open.links.insert(net.id, (watched, task)) {
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
            Exchange::Logins(Some((accounts, at))) => {
                row.step = None;
                row.note = None;
                row.accounts = accounts;
                row.known = true;
                row.answered_at = row.answered_at.max(at);
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

/// The account's DMs with `bot` as the homeserver has them (m.direct), once this device has them as joined rooms
/// (it waits a little for the sync to bring them). Empty if there are none, or they don't arrive.
async fn server_dms(client: &Client, bot: &UserId) -> Vec<Room> {
    use matrix_sdk::ruma::events::{direct::DirectEventContent, GlobalAccountDataEventType};
    let Ok(Some(raw)) = client.account().fetch_account_data(GlobalAccountDataEventType::Direct).await else { return vec![] };
    let Ok(direct) = raw.deserialize_as_unchecked::<DirectEventContent>() else { return vec![] };
    let ids: Vec<_> = direct.iter().filter(|(k, _)| k.as_user_id() == Some(bot)).flat_map(|(_, v)| v.clone()).collect();
    if ids.is_empty() {
        return vec![];
    }
    let started = std::time::Instant::now();
    loop {
        // rooms left long ago stay listed in m.direct and never arrive here: the first joined one is enough
        let joined: Vec<Room> = ids.iter().filter_map(|id| client.get_room(id)).filter(|r| r.state() == RoomState::Joined).collect();
        if !joined.is_empty() || started.elapsed() > FIRST_SYNC_WAIT {
            return joined;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// When the bot last sent anything in the room (ms), from the newest page of its events: their senders and times are
/// readable without decrypting them. 0 if it hasn't, or the page can't be had.
async fn bot_spoke_at(room: &Room, bot: &UserId) -> u64 {
    let Ok(page) = room.messages(matrix_sdk::room::MessagesOptions::backward()).await else { return 0 };
    page.chunk
        .iter()
        .filter_map(|e| {
            let raw = e.raw();
            let sender: Option<OwnedUserId> = raw.get_field("sender").ok().flatten();
            let ts: Option<u64> = raw.get_field("origin_server_ts").ok().flatten();
            (sender.as_deref() == Some(bot)).then_some(ts).flatten()
        })
        .max()
        .unwrap_or(0)
}

/// The room's members as the homeserver has them now: user id → membership. `None` if it can't be asked.
async fn server_members(client: &Client, room: &Room) -> Option<HashMap<String, String>> {
    use matrix_sdk::ruma::api::client::membership::get_member_events;
    let answer = client.send(get_member_events::v3::Request::new(room.room_id().to_owned())).await.ok()?;
    let mut out = HashMap::new();
    for ev in &answer.chunk {
        let key: String = ev.get_field("state_key").ok().flatten()?;
        let content: serde_json::Value = ev.get_field("content").ok().flatten()?;
        out.insert(key, content["membership"].as_str()?.to_owned());
    }
    Some(out)
}

/// Whether a room may hold login values for `bot`'s bridge: end-to-end encrypted, and its joined and invited members
/// exactly us and the bot. Both asked of the homeserver, not this device's copy, so someone invited a moment ago
/// counts. Anything that can't be checked counts as unsafe.
async fn safe_for_secrets(client: &Client, room: &Room, own: &UserId, bot: &UserId) -> bool {
    if room.state() != RoomState::Joined {
        return false;
    }
    if !matches!(room.latest_encryption_state().await, Ok(state) if state.is_encrypted()) {
        return false;
    }
    let Some(members) = server_members(client, room).await else { return false };
    let present: std::collections::BTreeSet<&str> =
        members.iter().filter(|(_, m)| matches!(m.as_str(), "join" | "invite")).map(|(u, _)| u.as_str()).collect();
    present == std::collections::BTreeSet::from([own.as_str(), bot.as_str()])
}

/// Whether the bot has joined the room.
async fn bot_joined(room: &Room, bot: &UserId) -> bool {
    if room.state() != RoomState::Joined {
        return false;
    }
    matches!(room.get_member_no_sync(bot).await, Ok(Some(m)) if *m.membership() == MembershipState::Join)
}

/// As `bot_joined`, and if this device hasn't seen the join yet, as the homeserver has it.
async fn bot_joined_now(client: &Client, room: &Room, bot: &UserId) -> bool {
    bot_joined(room, bot).await
        || (room.state() == RoomState::Joined
            && server_members(client, room).await.is_some_and(|m| m.get(bot.as_str()).map(String::as_str) == Some("join")))
}

/// The rows by network, for `Messages`.
pub(crate) type LinkRows = HashMap<&'static str, LinkRow>;

#[cfg(test)]
mod tests {
    use super::*;

    fn own(b: &str) -> Said {
        Said { own: true, ts: 1, image: false, body: b.into(), html: None }
    }
    fn bot(b: &str) -> Said {
        Said { own: false, ts: 2, image: false, body: b.into(), html: None }
    }

    #[test]
    fn logins_linked_unlinked_and_needing_attention() {
        assert_eq!(read_exchange(&[own("list-logins")]), Exchange::Logins(None));
        assert_eq!(read_exchange(&[own("list-logins"), bot("You're not logged in")]), Exchange::Logins(Some((vec![], 2))));
        let two = "\n* `4917` (Alex Example) - `CONNECTED`\n* `5550` (+1 555 0100) - `BAD_CREDENTIALS`";
        let Exchange::Logins(Some((a, _))) = read_exchange(&[own("list-logins"), bot(two)]) else { panic!() };
        assert_eq!(a.len(), 2);
        assert_eq!((a[0].id.as_str(), a[0].name.as_str(), a[0].state.as_str(), a[0].attention), ("4917", "Alex Example", "CONNECTED", false));
        assert!(a[1].attention);
        // a name with parentheses in it
        let Exchange::Logins(Some((a, _))) = read_exchange(&[own("list-logins"), bot("* `x1` (Sam (work)) - `CONNECTED`")]) else { panic!() };
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
        let qr = Said { own: false, ts: 2, image: true, body: "2@example-pairing-data".into(), html: None };
        let Exchange::Login { step: LinkStep::Qr { modules }, note } = read_exchange(&[own("login qr"), bot("Scan the QR code on your phone"), qr]) else { panic!() };
        assert_eq!(note.as_deref(), Some("Scan the QR code on your phone"));
        assert!(modules.len() >= 21 && modules.iter().all(|r| r.len() == modules.len()));

        let code = Said { own: false, ts: 2, image: false, body: "ABCD-EFGH".into(), html: Some("<code>ABCD-EFGH</code>".into()) };
        assert!(matches!(read_exchange(&[own("+15550100"), code]), Exchange::Login { step: LinkStep::Code { code }, .. } if code == "ABCD-EFGH"));
        assert!(matches!(read_exchange(&[own("login google"), bot("🦊 🍕 🚲")]), Exchange::Login { step: LinkStep::Code { .. }, .. }));

        let Exchange::Login { step, .. } = read_exchange(&[own("login messenger"), bot("Login URL: <https://www.messenger.com/>")]) else { panic!() };
        assert_eq!(step, LinkStep::Cookies { url: "https://www.messenger.com/".into() });
        // only an https link is offered; anything else leaves the card without one
        for odd in ["Login URL: accounts.example.com", "Login URL: <javascript:alert(1)>", "Login URL: <http://example.com/>"] {
            let Exchange::Login { step, .. } = read_exchange(&[own("login"), bot(odd)]) else { panic!() };
            assert_eq!(step, LinkStep::Cookies { url: String::new() }, "{odd}");
        }
        let Exchange::Login { step, .. } = read_exchange(&[own("login"), bot("Login URL: <https://example.com/a> then paste")]) else { panic!() };
        assert_eq!(step, LinkStep::Cookies { url: "https://example.com/a".into() });

        assert!(matches!(read_exchange(&[own("1234"), bot("Successfully logged in as +1 555 0100")]), Exchange::Login { step: LinkStep::Done { .. }, .. }));
        assert_eq!(read_exchange(&[own("login qr"), bot("Login cancelled.")]), Exchange::Cancelled);
        assert_eq!(read_exchange(&[own("cancel")]), Exchange::Cancelled);
        assert_eq!(read_exchange(&[bot("Hello, I'm a bridge bot.")]), Exchange::Idle);
    }

    #[tokio::test]
    async fn a_reply_the_bridge_would_run_as_its_own_command_is_never_sent() {
        let dir = tempfile::tempdir().unwrap();
        let m = Messages::new(dir.path().join("data"), Arc::new(crate::FileSecrets::new(dir.path().join("secrets"))));
        // any case: the bridge lowercases the first word (phone keyboards capitalise it)
        for value in ["Cancel", "logout 4917", "HELP me 123", "Sync now", "pm @someone"] {
            let e = m.link_send("signal", value).await.unwrap_err();
            assert!(matches!(e, MessagesError::Invalid { .. }), "{value}: {e:?}");
        }
        // an ordinary answer gets past the guard (and then needs a signed-in account)
        assert!(matches!(m.link_send("signal", "+1 555 0100").await, Err(MessagesError::SignedOut { .. })));
        assert!(matches!(m.link_send("signal", "helpful-passphrase").await, Err(MessagesError::SignedOut { .. })));
    }

    /// Codex review lk82bn43, P2: in the order the bridge really writes it (login, its prompt, our value, its refusal),
    /// the field that's still waiting stays, with the refusal as its note, so the value can be corrected.
    #[test]
    fn a_refused_value_keeps_the_field_that_still_waits_for_it() {
        let ask = "Please enter your Phone number\nInclude the country code with +";
        let said = [own("login phone"), bot(ask), own("+1"), bot("Invalid value: too short")];
        let Exchange::Login { step, note } = read_exchange(&said) else { panic!() };
        assert!(matches!(&step, LinkStep::Input { name, .. } if name == "Phone number"), "the phone field is still there: {step:?}");
        assert_eq!(note.as_deref(), Some("Invalid value: too short"));
        // a second wrong try in a row: still the same field
        let said = [own("login phone"), bot(ask), own("+1"), bot("Invalid value: too short"), own("+12"), bot("Invalid value: still too short")];
        let Exchange::Login { step, note } = read_exchange(&said) else { panic!() };
        assert!(matches!(step, LinkStep::Input { .. }));
        assert_eq!(note.as_deref(), Some("Invalid value: still too short"));
        // the cookie step: an unreadable paste leaves the paste box (the bridge keeps waiting for cookies)
        let said = [own("login messenger"), bot("Login URL: <https://www.messenger.com/>"), own("not json"), bot("Failed to parse input as JSON: invalid character")];
        let Exchange::Login { step, note } = read_exchange(&said) else { panic!() };
        assert!(matches!(step, LinkStep::Cookies { .. }), "{step:?}");
        assert!(note.unwrap().starts_with("Failed to parse"));
        // while the corrected value is on its way, the bridge hasn't answered: waiting
        let said = [own("login phone"), bot(ask), own("+1"), bot("Invalid value: too short"), own("+15550100")];
        assert!(matches!(read_exchange(&said), Exchange::Login { step: LinkStep::Waiting, .. }));
    }

    #[test]
    fn problems_keep_a_field_open_or_end_the_login() {
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
