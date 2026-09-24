//! `uni-core-cli` — one-shot driver for uni-core.
//!
//! ```text
//! uni-core-cli key init                                   create a persistent app key in the keyring
//! uni-core-cli key show                                   print the keyring key's pubkey
//! uni-core-cli sync [--relay wss://…] [--db path] [--ephemeral] [--auth-tag '["auth","…"]']
//! uni-core-cli live [--relay …] [--db path] [--max-attempts N]
//! uni-core-cli show [--db path] [--limit N]
//! uni-core-cli search <query> [--db path] [--limit N]
//! uni-core-cli probe [--relay …] [--ephemeral]
//! ```
//!
//! The private key is read from `UNI_NSEC` or the macOS keyring (`uni-app`/`nsec`)
//! and is never printed.

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use uni_core::{load_keys, sync_once, Backoff, KeySource, LiveConfig, LiveEvent, Store};

#[derive(Parser)]
#[command(name = "uni-core-cli", version, about)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Manage the persistent app identity in the macOS keyring.
    Key {
        #[command(subcommand)]
        cmd: KeyCmd,
    },
    /// Connect, auth, discover channels, pull kind-9 history into SQLite, print counts.
    Sync {
        /// Relay WebSocket URL.
        #[arg(
            long,
            env = "BUZZ_RELAY_URL",
            default_value = "wss://buzz.unforced.org"
        )]
        relay: String,
        /// SQLite path.
        #[arg(long, default_value = "uni.db")]
        db: String,
        /// Use a freshly generated throwaway key if none is configured.
        #[arg(long)]
        ephemeral: bool,
        /// Optional NIP-OA auth tag as JSON array, e.g. '["auth","<token>"]'.
        /// Read from BUZZ_AUTH_TAG if set. Value is never printed.
        #[arg(long, env = "BUZZ_AUTH_TAG", hide_env_values = true)]
        auth_tag: Option<String>,
    },
    /// Stay connected: live subscriptions, membership notifications, reconnect with backoff.
    Live {
        #[arg(
            long,
            env = "BUZZ_RELAY_URL",
            default_value = "wss://buzz.unforced.org"
        )]
        relay: String,
        #[arg(long, default_value = "uni.db")]
        db: String,
        #[arg(long)]
        ephemeral: bool,
        #[arg(long, env = "BUZZ_AUTH_TAG", hide_env_values = true)]
        auth_tag: Option<String>,
        /// Give up after this many consecutive failed reconnects (default: never).
        #[arg(long)]
        max_attempts: Option<u32>,
    },
    /// Print the newest N items from the local store.
    Show {
        #[arg(long, default_value = "uni.db")]
        db: String,
        #[arg(long, default_value_t = 20)]
        limit: usize,
    },
    /// Full-text search over stored message bodies.
    Search {
        /// Words to search for (matched by prefix, all must appear).
        query: Vec<String>,
        #[arg(long, default_value = "uni.db")]
        db: String,
        #[arg(long, default_value_t = 20)]
        limit: usize,
    },
    /// Connect, record the relay's pre-auth REQ response, then try NIP-42 auth.
    Probe {
        #[arg(
            long,
            env = "BUZZ_RELAY_URL",
            default_value = "wss://buzz.unforced.org"
        )]
        relay: String,
        #[arg(long)]
        ephemeral: bool,
        #[arg(long, env = "BUZZ_AUTH_TAG", hide_env_values = true)]
        auth_tag: Option<String>,
    },
}

#[derive(Subcommand)]
enum KeyCmd {
    /// Generate a new key and store it in the keyring (no-op if one exists). Prints the pubkey only.
    Init,
    /// Print the pubkey of the key in the keyring.
    Show,
}

fn parse_auth_tag(s: Option<String>) -> Result<Option<nostr::Tag>> {
    match s {
        Some(s) => {
            let parts: Vec<String> =
                serde_json_parse(&s).context("--auth-tag must be a JSON string array")?;
            Ok(Some(nostr::Tag::parse(parts).context("invalid auth tag")?))
        }
        None => Ok(None),
    }
}

fn key_source_label(source: KeySource) -> &'static str {
    match source {
        KeySource::Env => "env UNI_NSEC",
        KeySource::Keyring => "keyring uni-app/nsec",
        KeySource::Device => "device store (Android Keystore)",
        KeySource::Ephemeral => "EPHEMERAL (throwaway, generated now)",
    }
}

fn print_item(store: &Store, it: &uni_core::Item) -> Result<()> {
    let body: String = it.body.chars().take(80).collect();
    let body = body.replace('\n', " ");
    let who = store.display_name(&it.author)?;
    let ch = store
        .channel_name(&it.channel)?
        .unwrap_or_else(|| it.channel[..8.min(it.channel.len())].to_string());
    println!(
        "{} {} {:<12.12}{} {:<12.12} {}",
        it.ts,
        it.source,
        ch,
        if it.mentions_me { " @" } else { "  " },
        who,
        body
    );
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "uni_core=info,buzz_ws_client=info".into()),
        )
        .with_writer(std::io::stderr)
        .init();

    match Cli::parse().cmd {
        Cmd::Key { cmd: KeyCmd::Init } => {
            let ki = uni_core::init_keyring_key().context("initialising keyring key")?;
            println!(
                "keyring:  {}/{} ({})",
                uni_core::identity::KEYRING_SERVICE,
                uni_core::identity::KEYRING_ACCOUNT,
                if ki.created {
                    "created"
                } else {
                    "already existed, unchanged"
                }
            );
            println!("npub:     {}", ki.npub());
            println!("hex:      {}", ki.hex());
            Ok(())
        }
        Cmd::Key { cmd: KeyCmd::Show } => match uni_core::keyring_pubkey()? {
            Some(pk) => {
                use nostr::nips::nip19::ToBech32;
                println!("npub:     {}", pk.to_bech32()?);
                println!("hex:      {}", pk.to_hex());
                Ok(())
            }
            None => {
                println!("no key in keyring; run `uni-core-cli key init`");
                std::process::exit(1);
            }
        },
        Cmd::Sync {
            relay,
            db,
            ephemeral,
            auth_tag,
        } => {
            let (keys, source) = load_keys(ephemeral).context("loading identity")?;
            let auth_tag = parse_auth_tag(auth_tag)?;
            let store = Store::open(&db).context("opening store")?;

            println!("relay:      {relay}");
            println!("db:         {db}");
            println!("key source: {}", key_source_label(source));
            println!("pubkey:     {}", keys.public_key().to_hex());
            println!(
                "auth tag:   {}",
                if auth_tag.is_some() { "yes" } else { "none" }
            );

            let report = match sync_once(&relay, &keys, auth_tag.as_ref(), &store).await {
                Ok(r) => r,
                Err(e) => {
                    println!("SYNC FAILED: {e}");
                    std::process::exit(2);
                }
            };

            println!();
            println!("channels discovered: {}", report.channels.len());
            for (id, name) in &report.channels {
                let fetched = report.fetched.get(id).copied().unwrap_or(0);
                let inserted = report.inserted.get(id).copied().unwrap_or(0);
                match report.channel_errors.get(id) {
                    Some(err) => println!(
                        "  {id}  {:<20} ERROR: {err}",
                        name.as_deref().unwrap_or("(unknown)")
                    ),
                    None => println!(
                        "  {id}  {:<20} fetched={fetched:<4} new={inserted}",
                        name.as_deref().unwrap_or("(unknown)")
                    ),
                }
            }
            println!();
            println!("items in store by channel:");
            for (ch, n) in store.count_by_channel("buzz")? {
                let name = report
                    .channels
                    .get(&ch)
                    .cloned()
                    .flatten()
                    .unwrap_or_else(|| "(unknown)".into());
                println!("  {ch}  {name:<20} {n}");
            }
            println!("total items: {}", report.total_items);
            let mentions = store
                .timeline(10_000)?
                .iter()
                .filter(|i| i.mentions_me)
                .count();
            println!("mentions_me: {mentions}");
            println!(
                "profiles:    requested={} stored={} cached={}",
                report.profiles_requested,
                report.profiles_stored,
                store.count_profiles()?
            );
            Ok(())
        }
        Cmd::Live {
            relay,
            db,
            ephemeral,
            auth_tag,
            max_attempts,
        } => {
            let (keys, source) = load_keys(ephemeral).context("loading identity")?;
            let auth_tag = parse_auth_tag(auth_tag)?;
            let store = Store::open(&db).context("opening store")?;
            println!("relay:      {relay}");
            println!("db:         {db}");
            println!("key source: {}", key_source_label(source));
            println!("pubkey:     {}", keys.public_key().to_hex());

            let mut cfg = LiveConfig::new(relay);
            let mut backoff = Backoff::default();
            if let Some(n) = max_attempts {
                backoff = backoff.with_max_attempts(n);
            }
            cfg.backoff = backoff;

            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
            tokio::spawn(async move {
                let _ = tokio::signal::ctrl_c().await;
                let _ = stop_tx.send(true);
            });

            let store_ref = &store;
            let printer = async move {
                while let Some(ev) = rx.recv().await {
                    match ev {
                        LiveEvent::Message { item, new } if new => {
                            print!("NEW  ");
                            let _ = print_item(store_ref, &item);
                        }
                        LiveEvent::Message { .. } => {}
                        other => println!("live: {other:?}"),
                    }
                }
            };
            let runner = uni_core::run_live(cfg, &keys, auth_tag.as_ref(), &store, tx, stop_rx);
            let (r, _) = tokio::join!(runner, printer);
            if let Err(e) = r {
                println!("LIVE ENDED: {e}");
                std::process::exit(2);
            }
            Ok(())
        }
        Cmd::Probe {
            relay,
            ephemeral,
            auth_tag,
        } => {
            let (keys, source) = load_keys(ephemeral).context("loading identity")?;
            let auth_tag = parse_auth_tag(auth_tag)?;
            uni_core::init_crypto();
            println!("relay:      {relay}");
            println!("key source: {}", key_source_label(source));
            println!("pubkey:     {}", keys.public_key().to_hex());
            println!(
                "auth tag:   {}",
                if auth_tag.is_some() { "yes" } else { "none" }
            );
            let r = uni_core::probe(&relay, &keys, auth_tag.as_ref()).await?;
            println!("proactive AUTH challenge: {}", r.challenge_received);
            println!("REQ before auth:          {}", r.pre_auth_req);
            println!("NIP-42 auth result:       {}", r.auth_result);
            Ok(())
        }
        Cmd::Show { db, limit } => {
            let store = Store::open(&db)?;
            for it in store.timeline(limit)? {
                print_item(&store, &it)?;
            }
            Ok(())
        }
        Cmd::Search { query, db, limit } => {
            let store = Store::open(&db)?;
            let q = query.join(" ");
            let hits = store.search(&q, limit)?;
            for it in &hits {
                print_item(&store, it)?;
            }
            println!("{} hit(s) for {q:?}", hits.len());
            Ok(())
        }
    }
}

fn serde_json_parse(s: &str) -> Result<Vec<String>> {
    // Tiny shim to keep serde_json out of the CLI's direct deps: nostr re-exports it.
    Ok(nostr::serde_json::from_str::<Vec<String>>(s)?)
}
