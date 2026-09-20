# uni-app

Phase 1 of the Uni app (spec: `uni-app-spec.md`, §5/§7). This repo currently
contains only the Rust core crate and a proving CLI — no Tauri shell, no UI,
no vault adapter yet.

```
Cargo.toml                 workspace
crates/uni-core            library: buzz adapter + SQLite store + one-shot sync
crates/uni-core-cli        `uni-core-cli sync|probe|show`
```

Upstream Buzz crates are path dependencies on `../buzz` (`buzz-ws-client`,
`buzz-sdk`), so `/Users/uni/Code/buzz` must exist as a sibling checkout.

## Build / test

```sh
cargo build
cargo test          # 7 unit tests + 1 end-to-end test against an in-process mock relay
```

Toolchain proven: rustc 1.97.1 on macOS 26.3.

## What works (verified)

| Piece | Where | Status |
|---|---|---|
| Identity: `UNI_NSEC` env → macOS keyring (`uni-app`/`nsec`) → `--ephemeral` throwaway | `identity.rs` | works; key is never printed or logged |
| WebSocket connect + NIP-42 auth (proactive `AUTH` challenge, signed kind 22242, optional NIP-OA `["auth", …]` tag) | `buzz.rs` via `buzz_ws_client::NostrWsConnection` | works against `wss://buzz.unforced.org` up to the relay's membership gate (see findings) |
| Channel discovery: `REQ {kinds:[39002], "#p":[me]}` → `d` tags → `REQ {kinds:[39000], "#d":[…]}`, skip `archived=true` | `buzz.rs::discover_channels` (mirrors `buzz-acp/src/relay.rs:687-733`, over WS instead of `/query`) | works (mock relay e2e) |
| Per-channel history: `REQ {kinds:[9], "#h":[uuid], since?, limit:500}` under sub id `ch-<uuid>`, collected until `EOSE`, `CLOSED` surfaced as a per-channel error | `buzz.rs::channel_history` | works (mock relay e2e) |
| SQLite `items(source, ref, channel, author, ts, body, mentions_me)` + `channels` + `sync_state` watermarks; idempotent `INSERT OR IGNORE`; `mentions_me` from `p` tags | `store.rs`, `sync.rs` | works |
| `uni-core-cli sync` prints per-channel fetched/new counts and totals; `probe` reports the relay's pre-auth and auth behaviour; `show` dumps the timeline | `crates/uni-core-cli` | works |

## What is stubbed / not done

- **No live subscription.** `sync_once` is one-shot: REQ → EOSE → CLOSE per channel. Keeping the `ch-<uuid>` subs open for live events (and the `{kinds:[44100,44101],"#p":[me]}` membership sub) is Day 4–5 work.
- **No reconnect/backoff**, no rate-limit gate handling (`buzz-acp` has both; not ported).
- **No profiles (kind 0)**, no FTS5, no vault adapter, no Tauri shell.
- **`since` is inclusive** per NIP-01, so a re-run re-fetches exactly the watermark event; it dedupes on `(source, ref)`. Fine for now; a `since+1` would risk missing same-second events.
- **Keyring write path** is not implemented (only read). Storing the nsec is a manual/Tauri-onboarding concern.
- **500-result cap**: one REQ per channel with `limit=500`; channels with more history are not paginated backwards yet.

## Real relay run

The relay URL was learned from `buzz --help` (`BUZZ_RELAY_URL=wss://buzz.unforced.org`). Per the task, the run used a **freshly generated throwaway key**, never Uni's real key.

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
