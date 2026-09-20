# uni-app

Phase 1 of the Uni app (spec: `uni-app-spec.md`, §5/§7). This repo currently
contains only the Rust core crate and a proving CLI — no Tauri shell, no UI,
no vault adapter yet.

```
Cargo.toml                 workspace
crates/uni-core            library: buzz adapter + SQLite store (FTS5, profiles) + one-shot sync + live loop
crates/uni-core-cli        `uni-core-cli key init|show, sync, live, show, search, probe`
```

Upstream Buzz crates are path dependencies on `../buzz` (`buzz-ws-client`,
`buzz-sdk`), so `/Users/uni/Code/buzz` must exist as a sibling checkout.

## Build / test

```sh
cargo build
cargo test                        # 15 unit tests + 9 end-to-end tests against an in-process mock relay
cargo clippy --all-targets -- -D warnings
```

Toolchain proven: rustc 1.97.1 on macOS 26.3.

## What works (verified)

| Piece | Where | Status |
|---|---|---|
| Identity: `UNI_NSEC` env → macOS keyring (`uni-app`/`nsec`) → `--ephemeral` throwaway | `identity.rs` | works; key is never printed or logged |
| `key init`: generate a persistent app key into the keyring (`keyring` crate, same service/account layout as Buzz desktop), read it back, print **only** the npub/hex; no-op if one exists | `identity.rs::init_keyring_key` | works (run once on this Mac — pubkey below) |
| WebSocket connect + NIP-42 auth (proactive `AUTH` challenge, signed kind 22242, optional NIP-OA `["auth", …]` tag) | `buzz.rs` via `buzz_ws_client::NostrWsConnection` | works against `wss://buzz.unforced.org` up to the relay's membership gate (see findings) |
| Channel discovery: `REQ {kinds:[39002], "#p":[me]}` → `d` tags → `REQ {kinds:[39000], "#d":[…]}`, skip `archived=true` | `buzz.rs::discover_channels` (mirrors `buzz-acp/src/relay.rs:687-733`, over WS instead of `/query`) | works (mock relay e2e) |
| Per-channel history: `REQ {kinds:[9], "#h":[uuid], since?, limit:500}` under sub id `ch-<uuid>`, collected until `EOSE`, `CLOSED` surfaced as a per-channel error | `buzz.rs::channel_history` | works (mock relay e2e) |
| SQLite `items(source, ref, channel, author, ts, body, mentions_me)` + `channels` + `sync_state` watermarks; idempotent `INSERT OR IGNORE`; `mentions_me` from `p` tags | `store.rs`, `sync.rs` | works |
| `uni-core-cli sync` prints per-channel fetched/new counts and totals; `probe` reports the relay's pre-auth and auth behaviour; `show` dumps the timeline | `crates/uni-core-cli` | works |
| Incremental, idempotent `sync`: per-channel `since` = last seen `created_at`; `UNIQUE(ref)` + `INSERT OR IGNORE` so any number of re-runs converge (the phone's whole loop: connect → one pass → disconnect) | `sync.rs`, `store.rs` | works (mock: `sync_is_incremental_and_idempotent_across_new_events`) |
| Kind-0 profile cache (`profiles` table): after history, one `{kinds:[0], authors:[…]}` REQ for authors with no row; newest `created_at` wins; `show`/`search` render `display_name`/`name`, else `hex[..8]…`; channel names resolve from `channels` | `store.rs::Profile`, `sync.rs::refresh_profiles` | works (mock: `sync_caches_profiles_and_show_resolves_names`) |
| FTS5 over `items.body` (external-content table + triggers; rebuilt on first open of a pre-FTS db); `uni-core-cli search <words>`; literal quoting so punctuation never hits the FTS parser; prefix match, AND across words, bm25 order | `store.rs::search` | works (mock: `fts_search_over_synced_items`) |
| Live mode (`uni-core-cli live`): after auth+discovery, one open `ch-<uuid>` REQ per channel from the watermark (backfill → `EOSE` → live), plus the global `{kinds:[44100,44101],"#p":[me]}` membership sub; a 44100 opens the new channel's sub (and a `meta-<uuid>` lookup for its name), a 44101 CLOSEs it; live kind-0 lookups for unknown authors after backfill | `live.rs` | works (mock: `live_appends_new_events_after_eose_and_stops_cleanly`, `live_membership_notification_opens_new_channel_sub`) |
| Reconnect with exponential backoff (1 s → 60 s, ×2, reset after each successful auth) and re-AUTH (fresh challenge, fresh signed kind 22242); subs re-opened from current watermarks; `AuthFailed` (policy) is fatal, not retried; optional attempt budget | `backoff.rs`, `live.rs` | works (mock: `live_reconnects_with_backoff_and_reauths`, `live_backoff_grows_and_gives_up_when_relay_is_down`, `live_auth_rejection_is_fatal_not_retried`) |

## Sync model (mobile constraint)

`uni-app-mobile.md` says the phone is connect-on-open → sync → disconnect,
never always-connected. So `sync_once` is the unit of correctness: one pass
is complete (discovery, every channel from its watermark, missing profiles)
and idempotent (every write is `INSERT OR IGNORE` on the event id). `live`
is an optional layer on the same ingest path — a `sync_once` run after any
amount of live traffic inserts nothing (asserted in the live test).

## What is stubbed / not done

- **No rate-limit gate handling** (`buzz-acp` has it; not ported).
- **No vault adapter, no Tauri shell.** Live-mode profile refresh only fires for authors with no cached row; a changed kind 0 for a known author is picked up by the next live session's lookup only if the row is missing — a periodic refresh is a Phase 2 nicety.
- **`since` is inclusive** per NIP-01, so a re-run re-fetches exactly the watermark event; it dedupes on `ref`. Fine for now; a `since+1` would risk missing same-second events.
- **Membership sub `since`** is `now - 60 s` on each connect; a 44100 that arrives while disconnected is caught by the next `sync_once`/`live` discovery pass (39002), not by the sub.
- **500-result cap**: one REQ per channel with `limit=500`; channels with more history are not paginated backwards yet.
- **Backoff has no jitter** (deterministic for tests); add before many clients share one relay.

## Real relay run

The relay URL was learned from `buzz --help` (`BUZZ_RELAY_URL=wss://buzz.unforced.org`). Uni's own key is never read or copied.

### Persistent app key (keyring)

```
$ uni-core-cli key init
keyring:  uni-app/nsec (created)
npub:     npub16s4xkv00asn5yn3ny5drp7r0emselt0n9l66f0x57c42pvq4herqrwdnzv
hex:      d42a6b31efec27424e33251a30f86fcee19fadf32ff5a4bcd4f62aa0b015be46

$ uni-core-cli probe            # non-ephemeral: key source = keyring
relay:      wss://buzz.unforced.org
key source: keyring uni-app/nsec
pubkey:     d42a6b31efec27424e33251a30f86fcee19fadf32ff5a4bcd4f62aa0b015be46
auth tag:   none
proactive AUTH challenge: true
REQ before auth:          NOTICE: auth-required: authenticate before subscribing
NIP-42 auth result:       Authentication failed: restricted: not a relay member
```

The rejection is expected until that pubkey is added as a relay member
(`buzz-admin add-member`); it proves the keyring → sign → AUTH path
end-to-end. Once added, `uni-core-cli sync` / `live` need no flags.

### Earlier throwaway-key run (kept for the findings)

```
$ uni-core-cli probe --ephemeral
relay:      wss://buzz.unforced.org
key source: EPHEMERAL (throwaway, generated now)
pubkey:     69674263c0e79159980368eacebb691d05217360b0cb6ffe7c4f8237c0632957
auth tag:   none
proactive AUTH challenge: true
REQ before auth:          NOTICE: auth-required: authenticate before subscribing
NIP-42 auth result:       Authentication failed: restricted: not a relay member

$ uni-core-cli sync --ephemeral --db /tmp/uni-ephemeral.db
relay:      wss://buzz.unforced.org
db:         /tmp/uni-ephemeral.db
key source: EPHEMERAL (throwaway, generated now)
pubkey:     948212b53ccb919c3201c26dcf30542f54e08e7772bc93730efc2e9801007443
auth tag:   none
SYNC FAILED: relay: Authentication failed: restricted: not a relay member
(exit 2)
```

So the full pipeline (auth → discovery → per-channel history → SQLite) is proven
end-to-end only against the mock relay in `tests/mock_relay.rs`, which
replays the real relay's exact rejection string for non-members and enforces
`CLOSED restricted` on non-member `#h` REQs. Against the real relay, the code is
proven through TLS connect, the proactive challenge, the pre-auth NOTICE, and
the signed AUTH round-trip up to the membership gate.

To run it for real, add Uni's (or Aaron's) pubkey to the relay membership and
run with the key in `UNI_NSEC` or the keyring — outside this task's scope.

## Findings on spec §8 unknowns

1. **`BUZZ_REQUIRE_RELAY_MEMBERSHIP` is ON at `wss://buzz.unforced.org`.**
   A valid, unknown pubkey authenticates correctly (the signature and challenge
   pass) and is then rejected with `OK false "restricted: not a relay member"`.
   NIP-11 (`curl -H 'Accept: application/nostr+json' https://buzz.unforced.org/`)
   confirms `auth_required: true`, `restricted_writes: true`, `supported_nips`
   includes 43. New client pubkeys need `buzz-admin add-member` (or the
   `./run.sh add-member` wrapper, `ARCHITECTURE.md:684`).
2. **`BUZZ_PUBKEY_ALLOWLIST` is OFF.** In `buzz-relay/src/handlers/auth.rs:186-238`
   the allowlist gate runs *before* the membership gate and rejects with
   `auth-required: verification failed`. We received the membership message, so
   the allowlist branch was not taken.
3. **The NIP-OA `["auth", <token>]` tag is not required** for pubkey-only auth
   to be *processed* — the relay evaluated our tagless AUTH and answered with the
   membership rejection, not a missing-tag error. It matters only as the
   alternative membership path: `enforce_relay_membership` (`auth.rs:217`)
   accepts a non-member pubkey whose auth tag delegates from a member (NIP-OA
   owner attestation). A personal key for the app should simply be added as a
   member; an agent key would use the auth tag.
4. **Auth flow, exact:** relay pushes `["AUTH", <challenge>]` immediately on
   connect; a `REQ` before auth gets `["NOTICE", "auth-required: authenticate
   before subscribing"]` (not `CLOSED`); the AUTH event is a kind 22242 with
   `challenge` + `relay` tags, signed; response is `["OK", id, bool, reason]`.
5. **rustls provider:** `buzz-ws-client` pulls `tokio-tungstenite` with
   `rustls-tls-webpki-roots`, and rustls 0.23 panics at first TLS use unless a
   `CryptoProvider` is installed. `uni_core::init_crypto()` installs `ring`
   (same fix as `buzz-cli`). Any future Tauri binary must call it (sync does).
6. **`nostr::EventBuilder` strips self-`p` tags at sign time.** Real Buzz kind-9
   events *do* carry a self-`p` (the CLI-observed event has one), so the test
   fixture signs via `UnsignedEvent` to keep tags verbatim. Phase 2 senders must
   not rely on `EventBuilder` for the self-p tag — use `buzz-sdk` builders.
7. Not resolved here: hub `autoProvision`, hub WS bridge, `surface-client` in
   Tauri, `mention` tag indexing, Tauri+keyring on macOS 26.3 (no Tauri yet).
