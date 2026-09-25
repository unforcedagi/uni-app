# Ask everything — one search across Buzz and Parachute

Status: **messages shipped (local FTS), notes designed (handoff to Uni for now).**

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

### Today (shipped): Ask Uni

With no token, the Notes section in search results is shown as **coming soon**,
with the button "✦ Ask Uni to search my notes". The button posts
`@Uni search my notes for: <q>` (`uniActions.searchHandoffText`: one line, capped
at 500 chars, `p`-tags Uni) to #Uni. Uni runs `query-notes semantic` with its own
credentials and replies in #Uni. This is the same pattern as Keep and Ask Uni on a
message. The privacy boundary stays where it is today: in Uni.

### Later: a device read token, paired through Uni

1. **Request.** In Settings, "Search my notes on this phone" posts a pairing request
   to #Uni (a kind-9 addressed to Uni). It carries a one-time nonce and an X25519
   public key generated on the device.
2. **Consent and mint.** Uni asks Aaron in #Uni which slice to share, suggesting
   the tags he keeps for this app (e.g. `buzz`, `uni-app`, `people`, `projects`),
   and confirms that the app gets **read** access only. Uni then mints:
   - `scope: vault:uni:read` only (never write/admin),
   - `permissions.scoped_tags: [...]`, required (Uni refuses to mint an unscoped
     device token),
   - `long_lived: true` with a TTL of at most 30 days, and `description: "Talk to
     Uni — <device label>"` so it shows up in the hub token list.
3. **Deliver.** Uni seals the JWT to the device key (NIP-44 to the device pubkey,
   or the X25519 key from step 1) and sends it back as a DM or #Uni event. The
   token never appears in chat text. The device stores it in the same secure
   keystore as the nsec (`secure_store`), never in SQLite or `localStorage`.
4. **Use.** A Rust Tauri command `vault_search(q)` calls
   `GET /notes?semantic=true&near_text=q&limit=20&include_content=false` (the
   webview never sees the token). The token only works on the tailnet, so off the
   tailnet the Notes section falls back to Ask Uni. Hits render as note cards
   (title/path, preview, tags, score), and tapping one opens `parachute://` or
   hands the note to Uni ("talk about this note").
5. **Revoke.** "Forget vault access" in Settings deletes the token locally and asks
   Uni to `manage_token revoke {jti}`. Uni (or the hub admin UI) can also revoke it
   unilaterally. Expiry means Uni renews it over the same #Uni channel with no user
   action, unless Aaron has said stop. `identity_forget` wipes it with the nsec.

### Privacy boundary (non-negotiable)

- **Never the `unforced` vault by default.** The device token is only ever for
  `vault:uni:read`. Any other vault (unforced, parachute, …) needs a separate,
  explicit request by name, and Uni asks Aaron each time.
- Read-only and tag-scoped. There is no unscoped device token. Vault
  `private_tags` (e.g. `capture`, `transcript`, `health`) should be set so that even
  a mis-scoped token cannot see them.
- One JWT per device, revocable by jti, and short enough to expire if the phone is
  lost.
- Queries and results stay on the device (no analytics). With Ask Uni, the query
  is visible in #Uni, and the UI says so ("results will arrive in #Uni").

### Unified ranking (later)

Messages and notes use different scores (bm25 vs cosine), so they are shown as two
sections rather than merged into one list. A later step is meaning search over
messages too: Uni embeds Buzz messages into a `buzz` tag in the vault (or the app
embeds locally). The two sources could then share one score and appear as one
"what's related" list, as the prototype shows.
