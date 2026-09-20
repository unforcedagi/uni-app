//! `uni-core-cli` — one-shot driver for uni-core.
//!
//! ```text
//! uni-core-cli sync [--relay wss://…] [--db path] [--ephemeral] [--auth-tag '["auth","…"]']
//! uni-core-cli show [--db path] [--limit N]
//! ```
//!
//! The private key is read from `UNI_NSEC` or the macOS keyring (`uni-app`/`nsec`)
//! and is never printed.

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use uni_core::{load_keys, sync_once, KeySource, Store};

#[derive(Parser)]
#[command(name = "uni-core-cli", version, about)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
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
    /// Print the newest N items from the local store.
    Show {
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
        KeySource::Ephemeral => "EPHEMERAL (throwaway, generated now)",
    }
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
                let body: String = it.body.chars().take(80).collect();
                let body = body.replace('\n', " ");
                println!(
                    "{} {} {}{} {:.8} {}",
                    it.ts,
                    it.source,
                    &it.channel[..8.min(it.channel.len())],
                    if it.mentions_me { " @" } else { "  " },
                    it.author,
                    body
                );
            }
            Ok(())
        }
    }
}

fn serde_json_parse(s: &str) -> Result<Vec<String>> {
    // Tiny shim to keep serde_json out of the CLI's direct deps: nostr re-exports it.
    Ok(nostr::serde_json::from_str::<Vec<String>>(s)?)
}
