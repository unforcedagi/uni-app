#![deny(unsafe_code)]
//! `uni-core` — the Uni app's protocol core (Phase 1: Buzz read path).
//!
//! Modules:
//! - [`identity`]: load the Nostr key from an env var or the macOS keyring (never logs it);
//!   `init_keyring_key` creates a persistent app key and returns only the pubkey.
//! - [`store`]: local SQLite store with the unified `items` table (spec §5), a
//!   kind-0 `profiles` cache and an FTS5 index over `items.body`.
//! - [`buzz`]: relay adapter — NIP-42 auth, channel discovery, per-channel kind-9
//!   history, profile fetch, and open (live) subscriptions.
//! - [`sync`]: one-shot orchestration: connect → discover → pull → profiles → store.
//!   A single pass is complete and idempotent (the phone's whole loop).
//! - [`live`]: optional long-lived loop on top: open subs after EOSE, membership
//!   notifications, reconnect with [`backoff`] and re-AUTH.

pub mod backoff;
pub mod buzz;
pub mod compose;
pub mod identity;
pub mod live;
pub mod store;
pub mod sync;

pub use backoff::Backoff;
pub use buzz::{probe, BuzzClient, ChannelInfo, ProbeReport};
pub use compose::send_message;
pub use identity::{init_keyring_key, keyring_pubkey, load_keys, KeyInit, KeySource};
pub use live::{run_live, LiveConfig, LiveEvent};
pub use store::{ConversationMessage, Item, Profile, Room, Store};
pub use sync::{sync_once, SyncReport};

/// Errors produced by uni-core.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// Relay WebSocket / NIP-42 failure.
    #[error("relay: {0}")]
    Relay(#[from] buzz_ws_client::WsClientError),
    /// Relay closed a subscription (e.g. `restricted: …`).
    #[error("subscription {sub_id} closed by relay: {message}")]
    SubscriptionClosed { sub_id: String, message: String },
    /// Relay declined a signed message; not stored locally.
    #[error("relay rejected message: {0}")]
    RelayRejected(String),
    /// SQLite failure.
    #[error("store: {0}")]
    Store(#[from] rusqlite::Error),
    /// Identity could not be loaded.
    #[error("identity: {0}")]
    Identity(String),
    /// Bad input.
    #[error("invalid: {0}")]
    Invalid(String),
}

/// Result alias.
pub type Result<T> = std::result::Result<T, Error>;

/// Install the `ring` rustls CryptoProvider once per process.
///
/// `tokio-tungstenite` (via `buzz-ws-client`) links rustls without selecting a
/// provider; without this, the first TLS connect panics. Idempotent.
pub fn init_crypto() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}
