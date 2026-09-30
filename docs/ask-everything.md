# Ask everything — one search across Buzz and Parachute

Status: **messages shipped (local FTS); notes shipped (meaning search signed with the user's Nostr key).**

The vision (see `prototype/app-next.html`, "Ask everything"): one box that searches
what was *said* (Buzz rooms and threads) and what was *kept* (Parachute notes),
by words and by meaning. This doc covers what ships on branch `t1c-search`, and how
the app could search the vault directly later without breaking the current rule
that **the phone holds no vault credentials**.

## 1. Messages — local, shipped

- `Store::search_messages(query, limit)` (`crates/uni-core/src/store.rs`) searches
  the SQLite cache and returns `SearchHit { message, channel_name, snippet }`.
- It searches what a message says **now**:
  - `items_fts` indexes the original body; a new `edits_fts` indexes kind-40003
    edit content (trigger on `aux_events`, backfilled on upgrade).
  - Both arms join through `visible_items`, so a deleted message (kind 5/9005) is
    never a hit. An unedited message matches through `items_fts`. An edited one
    matches only through its *current* edit (`visible_items.edit_id`), so it is
    found by its new words and not by words the author removed. Edits by other
    people, and deleted edits, are ignored, exactly as the timeline does.
- The query is literal (`fts_literal_query`: tokens quoted, ANDed, prefix-matched),
  so user punctuation never reaches FTS5 syntax.
- `snippet` comes from FTS5 `snippet()`, with U+E000/U+E001 (private-use) around
  each match. `src/search.ts#snippetSegments` splits on those markers and
  `Search.tsx` renders the matches as React `<mark>` elements. Message text is
  never parsed as HTML.
- Tauri command `search { query, limit }` → `SearchHitView[]`. It is read-only, so it
  runs on `spawn_blocking` without `IO_GATE`.
- UI: the ⌕ button in the rooms header opens `Search.tsx`. The input is debounced
  (250 ms). Results are grouped by room in best-hit order. Tapping a hit opens the
  room, or the thread when the hit is a reply, then scrolls to the message and
  flashes it. If the message is older than the loaded window, the window grows
  once (to 3000).

Limit: only messages cached on this device are searchable. The relay has no
search API that we use today.

## 2. Notes — the vault

### What the vault offers (read from `~/Code/parachute-vault`, v0.7.9 live)

- REST base: `https://uni-1.taildf9ce2.ts.net/vault/uni/api` (tailnet only; Tailscale
  `serve`, no funnel). Without credentials, every route returns
  `401 {"error":"Unauthorized","message":"API key required"}`. CORS is `*`.
- **Meaning search**: `GET /notes?semantic=true&near_text=<q>&limit=N[&tag=…]`
  (`src/routes.ts`, "Semantic search (EXPERIMENTAL)"). It is the same engine as MCP
  `query-notes {semantic, near_text}`. Results carry a cosine `score`. It cannot be
  combined with `search` / `aggregate` / `cursor`, and a provider-less vault
  returns `semantic_unavailable`. The live `uni` vault has `embeddings_enabled: true`.
  Keyword fallback: `GET /notes?search=<q>` (FTS5, literal by default).
- Auth: bearer **hub-issued JWT** with scope `vault:uni:read`. The hub advertises
  OAuth at `/.well-known/oauth-authorization-server`: authorization_code + PKCE
  (S256), `refresh_token`, a revocation endpoint, and scopes
  `vault:read|write|admin`.
- **Tag scoping** (`docs/contracts/tag-scoped-tokens.md`): a JWT may carry
  `permissions.scoped_tags: [root tags]`. The token then sees only notes carrying
  one of those tags or a sub-tag. This is enforced fail-closed on every read path
  (REST, semantic, subscriptions). Out-of-scope notes are indistinguishable from
  missing ones, and each note's `.tags` is scrubbed to the in-scope subset.
- **Vault-level deny list**: `private_tags` in vault config (vault#766). Deny beats
  `scoped_tags`, so tags like `capture`/`transcript` can be walled off from every
  scoped token.
- Mint/revoke: hub `POST /api/auth/mint-token` (body carries `scope` and
  `permissions.scoped_tags`). A minted token is an attenuation, so it can never be
  broader than the minter. Revoke with `POST /api/auth/revoke-token {jti}`. Uni
  already has the equivalent MCP `manage_token` (mint/list/revoke, 15 min–1 h, or
  up to 90 days with `long_lived`).

### Shipped: search with your own Nostr key

The app already reaches Parachute as **you**: the Journal and note view sign each
request with the device's Nostr key (NIP-98, kind 27235, bound to URL, method and
body) against the hub's `/mcp` door. The hub maps the pubkey to your hub user and
applies your vault grants. No token is minted or stored; the only secret on the
device is the nsec, already in the secure keystore.

Search uses the same door:

- Tauri command `vault_search { query, vault?, limit? }` →
  `VaultClient::search_notes` (`crates/uni-core/src/parachute.rs`) →
  MCP `query-notes { semantic: true, near_text, include_content, content_length: 600 }`.
  With no `vault`, the hub fans out across every vault your key can read.
- If meaning search fails (no embedding provider, or the vault is mid-backfill with
  an error), it retries once as keyword full-text (`search`), and the section header
  says "keyword".
- Hits (`NoteHit { vault, id, path, snippet, score, mode }`) render in the Notes
  section under the messages. Tapping one opens the note in the in-app note view
  (a tab). Snippets are plain text; nothing is parsed as HTML.
- Access is exactly what your key has on the hub; revoke it by removing the
  pubkey's grant (`revoke_access`) or forgetting the identity on the device.
- If the hub is unreachable (e.g. off the tailnet), the section shows the error
  and offers the old **"✦ Ask Uni to search my notes"** handoff to #Uni.

### Unified ranking (later)

Messages and notes use different scores (bm25 vs cosine), so they are shown as two
sections rather than merged into one list. A later step is meaning search over
messages too: Uni embeds Buzz messages into a `buzz` tag in the vault (or the app
embeds locally). The two sources could then share one score and appear as one
"what's related" list, as the prototype shows.
