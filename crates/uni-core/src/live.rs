//! Live mode: an optional long-lived loop layered on top of the one-shot
//! sync model.
//!
//! One connection: NIP-42 auth → discovery → one open `ch-<uuid>` REQ per
//! channel (`since` = watermark, so the backfill before `EOSE` is exactly what
//! [`crate::sync_once`] would fetch) → the global `{kinds:[44100,44101],
//! "#p":[me]}` membership sub → pump messages until the socket drops. New
//! kind-9 events are ingested through the same idempotent path as sync, so
//! live mode never produces state a later `sync_once` would disagree with.
//!
//! On any connection failure the loop waits per [`Backoff`] and reconnects,
//! which re-runs NIP-42 auth (a new challenge, a new signed kind 22242) and
//! re-opens every subscription from the current watermarks. Backoff resets
//! after each successful auth. The phone does not use this module.

use std::collections::BTreeSet;
use std::time::Duration;

use buzz_ws_client::{RelayMessage, WsClientError};
use nostr::{Event, Filter, Keys, Kind, PublicKey, Tag};
use tokio::sync::{mpsc, watch};
use uuid::Uuid;

use crate::backoff::Backoff;
use crate::buzz::{
    channel_of_sub_id, channel_sub_id, merge_discovered_channels, BuzzClient, KIND_CHANNEL_MESSAGE,
    KIND_MEMBER_ADDED, KIND_MEMBER_REMOVED, KIND_PROFILE, MEMBERSHIP_SUB_ID,
};
use crate::store::{Item, Store};
use crate::sync::{ingest_message, ingest_profile};
use crate::{Error, Result};

/// Sub id for the live profile lookup.
const PROFILES_SUB_ID: &str = "profiles-live";

/// Live-loop tunables.
#[derive(Debug, Clone)]
pub struct LiveConfig {
    /// Relay WebSocket URL.
    pub relay_url: String,
    /// Reconnect schedule.
    pub backoff: Backoff,
    /// How long one `next_message` poll waits before checking the stop flag.
    pub poll_timeout: Duration,
}

impl LiveConfig {
    /// Production defaults: 1 s → 60 s backoff, unbounded attempts, 30 s poll.
    pub fn new(relay_url: impl Into<String>) -> Self {
        Self {
            relay_url: relay_url.into(),
            backoff: Backoff::default(),
            poll_timeout: Duration::from_secs(30),
        }
    }
}

/// Events the live loop reports to its caller (UI / CLI).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LiveEvent {
    /// Authenticated. `reconnect` is the number of prior connections this run.
    Connected { reconnect: u32 },
    /// Backfill for a channel sub finished; live events follow.
    Eose { channel: Uuid },
    /// A kind-9 event was stored (`new == false` means it was a duplicate).
    Message { item: Item, new: bool },
    /// Relay refused a channel subscription.
    ChannelClosed { channel: Uuid, message: String },
    /// A kind-44100 notification added us to a channel; its sub is now open.
    ChannelAdded { channel: Uuid },
    /// A kind-44101 notification removed us; its sub is closed.
    ChannelRemoved { channel: Uuid },
    /// Kind-0 profiles stored.
    Profiles { stored: usize },
    /// Connection lost; the loop will retry after `retry_in`.
    Disconnected { reason: String, retry_in: Duration },
    /// The loop is exiting (stop requested or attempts exhausted).
    Stopped { reason: String },
}

/// Handle to stop a running live loop.
pub type StopSender = watch::Sender<bool>;

/// Run the live loop until `stop` becomes `true` or the reconnect budget is
/// exhausted. Progress is reported on `events`; dropping the receiver does
/// not stop the loop.
pub async fn run_live(
    cfg: LiveConfig,
    keys: &Keys,
    auth_tag: Option<&Tag>,
    store: &Store,
    events: mpsc::UnboundedSender<LiveEvent>,
    mut stop: watch::Receiver<bool>,
) -> Result<()> {
    crate::init_crypto();
    let mut backoff = cfg.backoff.clone();
    let mut connections: u32 = 0;
    let emit = |e: LiveEvent| {
        let _ = events.send(e);
    };

    loop {
        if *stop.borrow() {
            emit(LiveEvent::Stopped {
                reason: "stop requested".into(),
            });
            return Ok(());
        }

        let outcome = match BuzzClient::connect(&cfg.relay_url, keys, auth_tag).await {
            Ok(client) => {
                backoff.reset();
                emit(LiveEvent::Connected {
                    reconnect: connections,
                });
                connections += 1;
                Session::new(client, store, &emit)
                    .run(cfg.poll_timeout, &mut stop)
                    .await
            }
            Err(e) => Err(e),
        };

        match outcome {
            Ok(()) => {
                emit(LiveEvent::Stopped {
                    reason: "stop requested".into(),
                });
                return Ok(());
            }
            Err(Error::Relay(WsClientError::AuthFailed(msg))) => {
                // A policy rejection (e.g. not a relay member) will not fix
                // itself by retrying; surface it.
                emit(LiveEvent::Stopped {
                    reason: format!("auth failed: {msg}"),
                });
                return Err(Error::Relay(WsClientError::AuthFailed(msg)));
            }
            Err(e) => match backoff.next_delay() {
                Some(delay) => {
                    tracing::warn!("live: {e}; reconnecting in {delay:?}");
                    emit(LiveEvent::Disconnected {
                        reason: e.to_string(),
                        retry_in: delay,
                    });
                    tokio::select! {
                        _ = tokio::time::sleep(delay) => {}
                        _ = stop.changed() => {}
                    }
                }
                None => {
                    emit(LiveEvent::Stopped {
                        reason: format!("reconnect attempts exhausted: {e}"),
                    });
                    return Err(e);
                }
            },
        }
    }
}

/// One connection's worth of state.
struct Session<'a, F: Fn(LiveEvent)> {
    client: BuzzClient,
    store: &'a Store,
    emit: &'a F,
    me: PublicKey,
    /// Channel subs currently open.
    open: BTreeSet<Uuid>,
    /// Authors seen with no profile row, to be looked up.
    pending_profiles: BTreeSet<PublicKey>,
    profile_sub_open: bool,
    /// Channel subs still waiting for their first EOSE.
    backfilling: BTreeSet<Uuid>,
}

impl<'a, F: Fn(LiveEvent)> Session<'a, F> {
    fn new(client: BuzzClient, store: &'a Store, emit: &'a F) -> Self {
        let me = client.pubkey();
        Self {
            client,
            store,
            emit,
            me,
            open: BTreeSet::new(),
            pending_profiles: BTreeSet::new(),
            profile_sub_open: false,
            backfilling: BTreeSet::new(),
        }
    }

    /// Returns `Ok(())` only when stop was requested; any relay failure is `Err`.
    async fn run(mut self, poll: Duration, stop: &mut watch::Receiver<bool>) -> Result<()> {
        // Discovery uses one-shot REQs; nothing else is open yet so no
        // live frames can be lost while they run.
        let channels = self.client.discover_channels().await?;
        let now = nostr::Timestamp::now().as_secs() as i64;
        for ci in channels.values() {
            self.store.upsert_channel(
                &ci.id.to_string(),
                ci.name.as_deref(),
                ci.description.as_deref(),
                ci.archived,
                now,
            )?;
        }
        let mut ids: Vec<Uuid> = channels.keys().copied().collect();
        ids.sort();
        for ch in ids {
            self.open_channel(ch).await?;
        }
        // Membership notifications: only need ones newer than our newest
        // watermark is not safe (a channel add carries no message), so ask
        // from "now" minus a minute; duplicates are harmless (idempotent).
        self.client
            .open_membership_sub(Some((now - 60).max(0) as u64))
            .await?;

        loop {
            if *stop.borrow() {
                let _ = self.client.disconnect().await;
                return Ok(());
            }
            match self.client.next_message(poll).await {
                Ok(msg) => self.handle(msg).await?,
                Err(Error::Relay(WsClientError::Timeout)) => {
                    self.maybe_open_profile_sub().await?;
                }
                Err(e) => return Err(e),
            }
        }
    }

    async fn open_channel(&mut self, ch: Uuid) -> Result<()> {
        let since = self.store.since_for(&ch.to_string())?.map(|s| s as u64);
        self.client.open_channel_sub(ch, since).await?;
        self.open.insert(ch);
        self.backfilling.insert(ch);
        Ok(())
    }

    async fn maybe_open_profile_sub(&mut self) -> Result<()> {
        if self.profile_sub_open || self.pending_profiles.is_empty() || !self.backfilling.is_empty()
        {
            return Ok(());
        }
        let authors: Vec<PublicKey> = self.pending_profiles.iter().copied().collect();
        let filter = Filter::new()
            .kind(Kind::Custom(KIND_PROFILE))
            .authors(authors);
        self.client.open_sub(PROFILES_SUB_ID, &[filter]).await?;
        self.profile_sub_open = true;
        Ok(())
    }

    fn note_author(&mut self, author: PublicKey) -> Result<()> {
        if self.store.profile(&author.to_hex())?.is_none() {
            self.pending_profiles.insert(author);
        }
        Ok(())
    }

    async fn handle(&mut self, msg: RelayMessage) -> Result<()> {
        match msg {
            RelayMessage::Event {
                subscription_id,
                event,
            } => self.handle_event(&subscription_id, *event).await,
            RelayMessage::Eose { subscription_id } => {
                if let Some(ch) = channel_of_sub_id(&subscription_id) {
                    self.backfilling.remove(&ch);
                    (self.emit)(LiveEvent::Eose { channel: ch });
                    self.maybe_open_profile_sub().await?;
                } else if subscription_id == PROFILES_SUB_ID {
                    self.client.close_sub(PROFILES_SUB_ID).await?;
                    self.profile_sub_open = false;
                    // Anything still pending has no kind 0 on the relay;
                    // record an empty row so we don't re-ask every time.
                    let now = nostr::Timestamp::now().as_secs() as i64;
                    for pk in std::mem::take(&mut self.pending_profiles) {
                        let hex = pk.to_hex();
                        if self.store.profile(&hex)?.is_none() {
                            self.store.upsert_profile(&crate::store::Profile {
                                pubkey: hex,
                                updated_at: now,
                                ..Default::default()
                            })?;
                        }
                    }
                } else if subscription_id.starts_with("meta-") {
                    self.client.close_sub(&subscription_id).await?;
                }
                Ok(())
            }
            RelayMessage::Closed {
                subscription_id,
                message,
            } => {
                if let Some(ch) = channel_of_sub_id(&subscription_id) {
                    self.open.remove(&ch);
                    self.backfilling.remove(&ch);
                    (self.emit)(LiveEvent::ChannelClosed {
                        channel: ch,
                        message,
                    });
                } else if subscription_id == PROFILES_SUB_ID {
                    self.profile_sub_open = false;
                    tracing::warn!("profile sub closed: {message}");
                } else {
                    tracing::warn!(sub = %subscription_id, "sub closed: {message}");
                }
                Ok(())
            }
            RelayMessage::Notice { message } => {
                tracing::warn!("relay NOTICE: {message}");
                Ok(())
            }
            other => {
                tracing::debug!("ignoring relay message: {other:?}");
                Ok(())
            }
        }
    }

    async fn handle_event(&mut self, sub: &str, ev: Event) -> Result<()> {
        let kind = ev.kind.as_u16();
        if let Some(ch) = channel_of_sub_id(sub) {
            if kind != KIND_CHANNEL_MESSAGE {
                return Ok(());
            }
            let (new, item) = ingest_message(self.store, &ev, &self.me, ch)?;
            self.store.set_since(&item.channel, item.ts)?;
            self.note_author(ev.pubkey)?;
            (self.emit)(LiveEvent::Message { item, new });
            return Ok(());
        }
        if sub == MEMBERSHIP_SUB_ID {
            let Some(ch) = crate::buzz::event_channel(&ev) else {
                return Ok(());
            };
            match kind {
                KIND_MEMBER_ADDED => {
                    if !self.open.contains(&ch) {
                        self.store.upsert_channel(
                            &ch.to_string(),
                            None,
                            None,
                            false,
                            ev.created_at.as_secs() as i64,
                        )?;
                        self.client.open_channel_meta_sub(ch).await?;
                        self.open_channel(ch).await?;
                        (self.emit)(LiveEvent::ChannelAdded { channel: ch });
                    }
                }
                KIND_MEMBER_REMOVED if self.open.remove(&ch) => {
                    self.backfilling.remove(&ch);
                    self.client.close_sub(&channel_sub_id(ch)).await?;
                    (self.emit)(LiveEvent::ChannelRemoved { channel: ch });
                }
                _ => {}
            }
            return Ok(());
        }
        if sub == PROFILES_SUB_ID && kind == KIND_PROFILE {
            self.pending_profiles.remove(&ev.pubkey);
            if ingest_profile(self.store, &ev)? {
                (self.emit)(LiveEvent::Profiles { stored: 1 });
            }
            return Ok(());
        }
        if sub.starts_with("meta-") {
            if let Some(ch) = sub
                .strip_prefix("meta-")
                .and_then(|s| s.parse::<Uuid>().ok())
            {
                let merged = merge_discovered_channels(vec![ch], std::slice::from_ref(&ev));
                let now = nostr::Timestamp::now().as_secs() as i64;
                match merged.get(&ch) {
                    Some(ci) => self.store.upsert_channel(
                        &ch.to_string(),
                        ci.name.as_deref(),
                        ci.description.as_deref(),
                        false,
                        now,
                    )?,
                    None => {
                        // Archived: drop the live sub we just opened.
                        if self.open.remove(&ch) {
                            self.backfilling.remove(&ch);
                            self.client.close_sub(&channel_sub_id(ch)).await?;
                        }
                        self.store
                            .upsert_channel(&ch.to_string(), None, None, true, now)?;
                    }
                }
            }
            return Ok(());
        }
        tracing::debug!(sub, kind, "unhandled event");
        Ok(())
    }
}
