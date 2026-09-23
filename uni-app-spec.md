# Uni app — technical spec (draft 1)

**Status:** proposal, 2026-09-20. Sources read: `/Users/uni/Code/buzz` (relay, SDK, ACP harness, desktop/mobile clients) and `/Users/uni/REPOS/ParachuteComputer` (`parachute-vault`, `lane-hub-864` / `parachute-hub`, `parachute-surface`, `parachute-app`). Every claim about existing code cites a path. Unverified items are collected in §8.

## 1. Thesis

The Buzz desktop client is a Tauri + React shell with ~287k lines of TypeScript across 30 feature slices (`buzz/desktop/src/features/` — agents, huddle, mesh-compute, workflows, forum, moderation, terminal, …) plus ~140k lines of Rust in `buzz/desktop/src-tauri/src/`. A fork inherits all of that as maintenance surface even though the protocol a client needs to be *on the network* is small: NIP-01 framing, NIP-42 auth, kind 9 with an `h` tag, kind 7, kind 0, and three relay-signed discovery kinds (`buzz/NOSTR.md:45-75`). The relay dispatches purely on `kind` (`buzz/ARCHITECTURE.md:116`), so a thin client that emits only those kinds is a first-class peer. On the Parachute side the vault is a REST + WebSocket resource server with a published wire contract (`parachute-vault/docs/HTTP_API.md`) and an npm client that already implements OAuth/PKCE, the typed REST client, and the live-query WS transport (`parachute-surface/packages/surface-client/src/{oauth,vault-client,ws-transport}.ts`). Both sides are speakable from one small codebase with two thin adapters over one local store. The unification (one timeline, one identity, one search) is the part neither existing app has, and it is easier to build on a fresh core than to bolt onto either.

## 2. Minimal Buzz protocol surface

Relay contract: NIP-01 frames over WebSocket, NIP-42 challenge sent proactively on connect, `["AUTH", <event>]` required before any `REQ`/`EVENT` (`buzz/ARCHITECTURE.md:146-196`). Limits: 64 KiB frame, 1024 subs/conn, 500 results per historical filter (`ARCHITECTURE.md:161`). Kind constants live in `buzz/crates/buzz-core/src/kind.rs`.

| Feature | Kind / mechanism | Must / Should | Citation |
|---|---|---|---|
| Auth | NIP-42 `kind 22242` signed challenge; optional `["auth", <token>]` tag | MUST | `ARCHITECTURE.md:183-196`; `crates/buzz-ws-client/src/message.rs:171-182` |
| Channel discovery | REQ `{kinds:[39002], "#p":[me]}` → collect `d` tags → REQ `{kinds:[39000], "#d":[…]}`; skip `archived=true` | MUST | `crates/buzz-acp/src/relay.rs:687-733`; `kind.rs:422-426` |
| Channel messages | `kind 9` with `["h", <channel-uuid>]` (required); REQ `{kinds:[9], "#h":[uuid]}` for history + live | MUST | `NOSTR.md:49,348`; `crates/buzz-sdk/src/builders.rs:224-245` |
| Mentions | one `["p", <hex>]` per mentioned pubkey; sender also self-p-tags; cap 50, deduped lowercase | MUST (this is how agents wake) | `builders.rs:193-206`; `desktop/src/features/messages/hooks.ts:112-120`; `crates/buzz-acp/src/filter.rs:389-398` |
| Threads | NIP-10: direct reply `["e", root, "", "reply"]`; nested adds `["e", root, "", "root"]` + `["e", parent, "", "reply"]`; reply p-tags parent author | SHOULD (phase 2) | `desktop/src/features/messages/lib/threading.ts:101-125`; `NOSTR.md:70` |
| Reactions | `kind 7`, content emoji or `+`, `["e", target]`; relay derives channel from target — subscribe with `#h` to receive live | SHOULD | `builders.rs:474-483`; `NOSTR.md:50,192-198` |
| Profiles | `kind 0` JSON (`display_name`, `name`, `picture`, `nip05`); needed to render names and resolve `@name` → pubkey | MUST (read), SHOULD (write) | `NOSTR.md:52`; `crates/buzz-sdk/src/mentions.rs:1-50`; `desktop/src/shared/lib/resolveMentionNames.ts` |
| Agent roster | `kind 10100` agent profile (replaceable); query `{kinds:[10100]}` unfiltered | SHOULD (mention picker) | `kind.rs:86-87`; `desktop/src-tauri/src/commands/agent_discovery.rs:1041-1049` |
| Membership notifications | `kind 44100/44101`, relay-signed; global REQ MUST include `#p` = own pubkey | SHOULD (auto-refresh channel list) | `NOSTR.md:128-149` |
| Deletion | `kind 5` with `["e", target]`, self-authored only | SHOULD | `NOSTR.md:51,350` |
| Edits | `kind 40003` — Buzz-only, no NIP-29 client renders it | MAY (render as overlay; phase 3) | `NOSTR.md:74`; `kind.rs:483` |
| Read state | `kind 30078`, `d = read-state:<32hex>`, NIP-44 encrypted to self | MAY (cross-device unread) | `docs/nips/NIP-RS.md:34-60`; `kind.rs:75` |
| HTTP bridge | `POST /events`, `POST /query`, `POST /count` with NIP-98 `kind 27235` | Alternative to WS for one-shot reads | `ARCHITECTURE.md:620-622`; `crates/buzz-acp/src/relay.rs:413-445` |
| Media | Blossom `PUT /media/upload`; `imeta` tags on kind 9 | MAY (phase 3) | `NOSTR.md:68`; `builders.rs:208-215` |
| DMs (1059), presence/typing (20001/2), workflows/jobs/forum/huddle/git (43001+, 45001+, 48100+, 30617+) | — | NOT needed to interoperate | `NOSTR.md:64-71`; `kind.rs:518-632` |

Fan-out rule the client must respect: channel-scoped events are delivered only to subscriptions carrying a matching `#h`; a kinds-only global sub never sees channel traffic (`ARCHITECTURE.md:242,304`). So the client opens one `REQ` per joined channel (sub id `ch-<uuid>` as `buzz-acp` does, `relay.rs:3509`), not one global sub. NIP-50 search is a one-shot REQ with `search` in the filter (`NOSTR.md:69`).

The protocol-level definition of "a Uni-style client interoperates" is therefore: it can be @-mentioned by the existing desktop app (it renders `p`-tagged kind 9s), and its own kind 9s with `p` tags wake `buzz-acp` agents (`filter.rs:389-398`). Nothing else is load-bearing.

## 3. Minimal Parachute API surface

All per-vault routes are `/vault/{name}/api/...` behind the hub; auth is `Authorization: Bearer <hub JWT>` with scopes `vault:<name>:read|write|admin` (`parachute-vault/docs/HTTP_API.md:98-149`). Note that `parachute-vault` itself does not accept NIP-98 — the hub explicitly says "the daemon does not speak it" (`parachute-hub/src/hub-server.ts:4276-4279`).

| Need | Endpoint | Citation |
|---|---|---|
| List / filter notes (lean `NoteIndex[]`) | `GET /api/notes?tag=&path_prefix=&meta[created_at][gte]=…&limit=&include_content=` | `HTTP_API.md:848-990` |
| Incremental sync | `GET /api/notes?cursor=` (bootstrap `cursor=`), ordered by `updated_at ASC`; incompatible with `search=` and `order_by` | `HTTP_API.md:290-330` |
| Full-text search | `GET /api/notes?search=…` (literal by default; `search_mode=advanced`) | `HTTP_API.md:382-413` |
| Read one note (bounded) | `GET /api/notes/{idOrPath}` with `content_offset`/`content_length` | `HTTP_API.md:1430`, `661` |
| Create | `POST /api/notes` | `HTTP_API.md:1288` |
| Update (OCC) | `PATCH /api/notes/{idOrPath}` with `if_updated_at`; `append`/`content_edit` modes | `HTTP_API.md:1622`, `574-595` |
| Delete | `DELETE /api/notes/{idOrPath}` | `HTTP_API.md:1719` |
| Tags | `GET /api/tags`, `GET /api/tags/{name}` (schema/hierarchy); `PUT`/rename/merge are `admin` and out of app scope | `HTTP_API.md:1895-2233` |
| Links / graph | `include_links=true` on list; `GET /api/find-path` | `HTTP_API.md:866-890`, `1860` |
| Attachments | `POST /api/notes/{id}/attachments`, `GET …/attachments`, storage `GET /api/storage/{date}/{filename}`; ticket flow `PUT /tickets/{id}` | `HTTP_API.md:1722-1780`, `2453-2536` |
| Live query | `GET /api/subscribe?<same query params>` with `Upgrade: websocket`; first message `{"type":"auth","token"}`; frames `snapshot{notes,done}` / `upsert{note}` / `remove{id}`; client sends `"ping"` ~30s; close codes 4400/4401/4403/4408. `search=`/`near=` rejected 400. **SSE is retired (410).** | `parachute-vault/src/ws-subscribe.ts:1-50,180-187`; `src/routing.ts:1162-1175`; `design/2026-06-08-live-query-sse.md:68-90` |
| Vault info / stats | `GET /api/vault`, `GET /vault/{name}` | `HTTP_API.md:2278`, `805` |
| MCP (optional) | `GET|POST /vault/{name}/mcp` streaming HTTP; root `/mcp` on the hub | `HTTP_API.md:2547-2560`; `hub-server.ts:4308-4330` |

Hub (auth) surface:

| Need | Endpoint | Citation |
|---|---|---|
| OAuth discovery | `/.well-known/oauth-authorization-server`, `/vault/<name>/.well-known/oauth-protected-resource` | `parachute-vault/docs/auth-model.md:48-59` |
| PKCE + DCR | `POST /oauth/register`, `GET /oauth/authorize`, `POST /oauth/token` (`authorization_code`, `refresh_token`) | `lane-hub-864/src/oauth-handlers.ts:12,579,2519-2531` |
| JWKS | `<hub>/.well-known/jwks.json` (RS256) | `auth-model.md:28` |
| Nostr key ↔ hub user linkage | `GET/POST /api/account/pubkeys{,/challenge,/verify,/unlink}` — signed `kind 27235` event with `u`/`method` tags, cookie-session gated | `lane-hub-864/src/api-account-pubkeys.ts:15-40` |
| NIP-98 door | `Authorization: Nostr <b64 event>` on `/mcp` → account-MCP (tools incl. fan-out `query-notes`); `autoProvision` may create key-only users | `parachute-hub/src/nostr-http-auth.ts:1-14`; `hub-server.ts:4293-4300`; `account-mcp.ts:5-20` |
| Principal attribution | hub stamps `permissions.principal_pubkey` on NIP-98-minted hop tokens; vault writes `created_via = nostr:<hex>` | `parachute-vault/docs/contracts/nostr-principal-attribution.md:1-45`; `src/auth.ts:497-509` |

Reusable library: `@openparachute/surface-client` (`parachute-surface/packages/surface-client/src/`, v`0.3.7-rc.2`) exports `ParachuteOAuth`, `VaultClient` (auto-refresh on 401), `subscribe()` (WS transport), `buildNotesQuery`, and token storage (`README.md:1-25`).

## 4. Existing Parachute app — what not to duplicate

`parachute-app` (`/Users/uni/REPOS/ParachuteComputer/parachute-app`) is the "super-surface": a Vite/React PWA (~43k lines in `src/`) with the OAuth/PKCE flow, an IndexedDB/OPFS offline outbox + sync engine (`src/lib/sync/`), notes CRUD, calendar/day views, import/export, and account/vault management (`README.md:1-40`; `src/app/routes/`). It contains no Nostr or Buzz code (grep `nostr|buzz` in `src/` is empty). It is served by the hub at `/app` and is what Aaron's box runs at the hub root (`parachute-app/CLAUDE.md:12-16`).

The Uni app should **not** re-implement offline outbox, import/export, calendar, transcription UI, or account/vault admin; it deep-links to `<hub>/app/notes/<id>` for those. Its vault scope is read, live-query, search, quick capture, tag, link — what is needed to see notes *alongside* channels.

## 5. Architecture

**Recommended stack: Tauri 2 shell + TypeScript/React UI + Rust core crate for the two protocol adapters + SQLite local store.**
Rationale: the two upstreams already publish the exact pieces this needs in these two languages — `buzz-sdk` (typed event builders, pure, no keys held: `crates/buzz-sdk/src/lib.rs:1-14`), `buzz-ws-client` (564 lines: NIP-42 auth, REQ/EVENT framing, `crates/buzz-ws-client/src/`), and `@openparachute/surface-client` (OAuth + REST + WS-live) — and Tauri gives OS keyring access for the nsec the same way Buzz desktop does (`buzz/desktop/src-tauri/Cargo.toml:25-59`, `keyring` crate) without inheriting Buzz's 140k lines of Rust.

Top rejected alternative: **pure web PWA (no native shell) served from the hub next to `parachute-app`.** Rejected because the Nostr private key would live in browser storage on an origin shared with other hub-served pages, and a PWA cannot receive mention wakeups when closed. The TS half stays shell-agnostic so a read-only web mirror remains possible later. Forking `buzz/desktop` and adding a vault pane is rejected per §1.

```
┌──────────────────────── Tauri 2 shell (macOS first) ────────────────────────┐
│  UI (React/TS)                                                              │
│   Timeline ▸ Channel ▸ Note ▸ Search ▸ Compose                              │
│        │ tauri invoke / events                                              │
│  Core (Rust crate `uni-core`)                                               │
│   ┌────────────────┐   ┌─────────────────┐   ┌─────────────────────────┐    │
│   │ buzz adapter   │   │ vault adapter   │   │ store (SQLite, FTS5)    │    │
│   │ buzz-ws-client │   │ reqwest + WS    │   │ items(kind, src, ts,    │    │
│   │ buzz-sdk       │   │ hub JWT refresh │   │   body, author, ref)    │    │
│   │ NIP-42/98 sign │   │ cursor sync     │   │ channels, notes, tags,  │    │
│   └────────────────┘   └─────────────────┘   │ profiles, read_marks    │    │
│   identity: keyring(nsec) + keyring(refresh_token)                          │
└──────────────────────────────────────────────────────────────────────────────┘
        │ wss NIP-01 + NIP-42            │ https Bearer JWT + wss /api/subscribe
   Buzz relay (block/buzz fork)     Parachute hub → vault(s)
```

Store: one `items` table is the unified timeline (`source ∈ {buzz, vault}`, `ref` = event id or note id, `channel_or_path`, `author`, `ts`, `body`, `mentions_me`). Typed tables hold the raw events and notes; `items` is a projection so the timeline is one ordered query, and FTS5 over `items.body` gives one search box across both sources. Relay NIP-50 and vault `search=` fill gaps beyond the local window.

Sync: Buzz = per-channel `REQ` with `since` = last seen `created_at` (`buzz-acp` pattern, `relay.rs:1146`), plus a global `{kinds:[44100,44101],"#p":[me]}` sub for new channels. Vault = `GET /api/notes?cursor=` backfill on start/reconnect, then `GET /api/subscribe` WS per watched query. Vault writes go straight to REST (no local outbox in v1); Buzz sends are optimistic-then-`OK` like the desktop app (`hooks.ts:99`).

## 6. Identity model

The app holds two credentials for one person:

1. **Nostr secp256k1 key** (Aaron's own key, or a managed key — the same class Uni's own identity uses). Stored in the OS keyring via the `keyring` crate as Buzz desktop does. Used for: NIP-42 relay auth, signing kind 9/7/0, NIP-98 to the relay HTTP bridge, and NIP-98 to the hub's `/mcp` door.
2. **Parachute hub session**: an OAuth PKCE access JWT (`aud = vault.<name>`, scopes `vault:<name>:read write`) plus a refresh token, obtained once through the browser via `/oauth/authorize` with DCR (`oauth-handlers.ts:12`). Refresh token in keyring; access JWT in memory. `VaultClient` in surface-client already does refresh-on-401.

Binding the two: the hub's pubkey-linkage ceremony (`/api/account/pubkeys/challenge` → sign kind 27235 with `u`/`method` tags → `/verify`, `api-account-pubkeys.ts:15-40`) links the Nostr key to the hub user. After linking, the app *could* reach vault data with only the Nostr key through `Authorization: Nostr …` on `<hub>/mcp` (`nostr-http-auth.ts`, `hub-server.ts:4293`). That door is MCP-only (JSON-RPC `tools/call`, fan-out `query-notes`), which is enough for reads and note writes but does **not** give the REST list/cursor endpoints or the `/api/subscribe` WebSocket, because the vault daemon rejects NIP-98 (`hub-server.ts:4276-4279`) and `POST /account/vaults/<name>/token` requires a Bearer with admin scopes, not NIP-98 (`account-api.ts:740-748`). So v1 keeps the OAuth session as the vault credential and uses the linkage only for attribution (`created_via = nostr:<hex>`, `nostr-principal-attribution.md`) and as a future path to "one key, both networks".

Risks, stated plainly:

- **Two secrets, one keyring.** A machine compromise yields both posting-as-Aaron on Buzz and vault read/write. Mitigation: never expose the nsec to the web layer — sign in Rust only, the boundary Buzz desktop keeps (`src-tauri/src/nostr_bind.rs`, `identity_storage.rs`).
- **Refresh-token lifetime vs. NIP-42 statelessness.** Relay auth is a per-connection signature and never expires; hub JWTs do (`oauth-handlers.ts:2737-2743`). The timeline will half-work when the vault side is logged out, so the UI must show per-source connection state.
- **Nostr-first vault auth is incomplete upstream.** The NIP-98 hop mint is 60 s and MCP-scoped (`account-mcp-hop.ts:1-12`). If the hub later mints REST/WS-capable vault JWTs for NIP-98 callers, OAuth can be dropped. Track as an upstream ask, not an assumption.
- **Key collision with agents.** If the app used the same key as Uni's agent, mentions of Uni would wake both. Use Aaron's personal key; `docs/nips/NIP-OA.md` covers owner→agent delegation if wanted later.
- **Privacy boundary (AGENTS.md).** Vault items from `unforced` are held material. Compose must require an explicit destination confirmation and never auto-quote vault items into Buzz sends.

## 7. Phased build plan

**Phase 1 — read-only unified timeline (target: 3–5 working days).**
Deliverable: one window showing, newest-first, kind 9 messages from every channel I'm a member of, interleaved with vault notes changed in the last N days, with a source badge and a "mentions me" highlight.
- Day 1: Tauri 2 scaffold; `uni-core` crate with path deps on `buzz-ws-client` + `buzz-sdk`; connect, NIP-42 auth (`message.rs:171-182`), discover channels (`relay.rs:687-733`), one `REQ {kinds:[9],"#h":[uuid],since}` per channel into SQLite.
- Day 2: vault adapter with a pasted read JWT (`parachute auth mint-token --scope vault:<name>:read`, `auth-model.md:117`) — no OAuth UI yet; `GET /api/notes?cursor=` backfill; `GET /api/subscribe` WS for `tag=`/`path_prefix=` watches (`ws-transport.ts:35-52` is the reference client).
- Day 3: `items` projection + FTS5; virtualised React timeline; kind 0 profile cache; `mentions_me` from `p` tags.
- Day 4–5: reconnect/backoff both sides; per-source connection indicators; package as a local `.app`. Acceptance: a `[done]` mention from a specialist in the Uni channel appears within ~1 s; a note edited in `parachute-app` appears without restart.

**Phase 2 — compose + act (1–2 weeks).** Kind 9 send with `h` + self `p` + mention `p` tags (`builders.rs:224-245`); `@name` picker from kind 0 + kind 10100 (`agent_discovery.rs:1041`); reactions (`builders.rs:474`); NIP-10 replies (`threading.ts:101-125`); quick-capture via `POST /api/notes`; tag add/remove via `PATCH`; OAuth PKCE replaces the pasted JWT (`surface-client/src/oauth.ts`). Acceptance: a mention sent from the Uni app wakes `buzz-acp` (`filter.rs:389-398`).

**Phase 3 — unification.** Note ⇄ message links (a note with `metadata.buzz_event` renders inline; a message can be clipped to a note with provenance); task-record view over `uni-task` notes; membership-notification sub for channel auto-join; `kind 30078` read-state sync so unread matches Buzz desktop (`NIP-RS.md`).

**Phase 4 — optional.** Nostr-only vault auth once the hub mints REST/WS-capable tokens for NIP-98 principals; Blossom media; edit overlays (`kind 40003`); a read-only web build of the TS layer served from the hub.

Non-goals for all phases: huddles, workflows, forum, git, mesh compute, managed-agent config, moderation, DMs.

## 8. Unknowns / things I could not verify

- **Live relay config.** `NOSTR.md:85-100,214-218` describe `BUZZ_PUBKEY_ALLOWLIST` / `BUZZ_REQUIRE_RELAY_MEMBERSHIP`; I did not check which the relay Aaron's agents use has enabled, whether a new client pubkey needs `buzz-admin add-member`, or whether the `["auth", <token>]` NIP-42 tag (`message.rs:171-182`) is required or pubkey-only auth suffices.
- **Fork drift.** I read `/Users/uni/Code/buzz` only; I did not diff the kinds in §2 against upstream block/buzz.
- **Hub `autoProvision`.** `nostr-http-auth.ts:277-295` gates key-only user creation on it; the running hub's setting is unknown, so NIP-98 with an unlinked key may 401.
- **Hub WS bridge to `/api/subscribe`.** `hub-server.ts:404` imports `ws-bridge.ts` and `ws-subscribe.ts:25-27` mentions it; I did not trace end-to-end that a WS upgrade through the public hub origin reaches the vault daemon.
- **`lane-hub-864` vs `parachute-hub` drift.** The lane is at `0f7a294`; the NIP-98 `/mcp` routing cited is from `parachute-hub/src/hub-server.ts:4276-4300`. Not confirmed both carry the same code.
- **`surface-client` WS transport in Tauri.** `subscribe.ts:111-134` accepts any WHATWG `WebSocket`; not verified inside a Tauri webview against a tailnet cert.
- **`mention` tag.** `resolveMentionNames.ts:3-11` accepts a `mention` tag alongside `p`; I did not find where it is emitted or whether the relay indexes it into `event_mentions` (`schema/schema.sql:287-300`). The ACP harness matches only `p` (`filter.rs:389-398`), so v1 emits `p` only.
- **Line counts** (desktop/src 287k, src-tauri 140k, mobile/lib 64k, parachute-app/src 44k) are `wc -l` including tests — scale indicators, not audited figures.
- **Tauri 2 + `keyring` on macOS 26.3** was not test-built; the choice rests on Buzz desktop shipping that combination (`desktop/src-tauri/Cargo.toml:59`).
