# Interfaces: the contract, manifests, kits and sealing

An **interface** is a small app that the Uni app runs inside a sealed frame: today the HTML note
`Areas/<Name>/app`, later other notes. It reaches the vault and chat only through the **interface
contract** (version 1). The contract lives in `src/interface/` with no imports from `App.tsx`, so it can
be lifted into a package. Area apps are its first consumer (`src/areas/`).

Example apps: [`areas-seed/techne.html`](../areas-seed/techne.html), [`areas-seed/unforced.html`](../areas-seed/unforced.html).
Publish an app by creating or updating the note `Areas/<Name>/app` with `extension: html`.

## How it fits together

```
 app (sealed iframe)            host (Uni app)
 ───────────────────            ──────────────────────────────────────────────
 uni.* kits  ── postMessage ──▶ frame.tsx ─▶ session.ts (limits) ─▶ router.ts ─▶ modules/*
                                                         grant (manifest + user) ┘     │
                                    consent.tsx ◀── suggestions.ts ◀── chat.draft / note.open
                                    (only a tap here acts)
```

| File | Role |
|---|---|
| `contract.ts` | version, namespaces, capabilities, error codes, limits, envelope validation, `inScope` / `safePrefix` |
| `manifest.ts` | parse `interface:` metadata, default needs, resolve `area`, grant key (SHA-256 of the resolved needs), plain-words description |
| `grants.ts` | grant store: note id → hash of the RESOLVED needs + hash of the app HTML (injectable storage) |
| `router.ts` | `createRouter(modules)`: namespace/method → handler, enforcing grant, params and scope |
| `session.ts` | one frame's message pump: two rate buckets of 60 per 10 s (requests: a message costs 1; reads: each underlying note read or searched prefix costs 1), 8 pending, replies |
| `suggestions.ts` | pending suggestions (max 3). Adding never acts; only `accept()` does |
| `modules/vault.ts` | read-only REST subset of surface-client's `VaultClient` over the frame |
| `modules/chat.ts`, `note.ts`, `theme.ts` | `chat.recent` / `chat.draft`, `note.open`, `theme.get` |
| `modules/frameFetch.ts` | the one adapter that knows the `pfr` wire shape (swap for the published `createFrameFetch`/`serveFrameFetch`) |
| `kits/` | `frameKit.ts` (the code injected into the frame) and the bundled `VaultClient` |
| `srcdoc.ts`, `frame.tsx` | the srcdoc builder and the sealed frame host |
| `consent.tsx`, `grantPrompt.tsx` | host-rendered suggestion bar and first-open grant prompt |
| `selftest/` | the in-app sandbox self-test and the platform gate |

## The manifest

In the app note's metadata:

```yaml
interface:
  contract: 1
  needs:
    - vault.read: Areas/Techne/     # a folder prefix ending in "/", or "area"
    - chat.read: area               # "area" = the area's linked room(s), or a room id
    - chat.draft: area
```

- No `interface` key → the default: `vault.read: area`, `chat.read: area`, `chat.draft: area`.
- `area` resolves against the host: `vault.read` → `Areas/<Name>/`; `chat.*` → the area's `channel` rooms.
- Invalid manifests (unknown capability, `..`, `%`, backslash, no trailing `/`, > 12 needs, wrong contract
  version) never run; the area shows its default view with the reason.
- The grant is keyed by the note id, the SHA-256 of what the needs **resolve to** (folder prefixes, room
  ids and the area path) and the SHA-256 of the app HTML. A different resolution asks again: a granted
  app note moved into another area, or an area whose `channel` is edited, is a new question, even though
  the symbolic `area` need reads the same. An **HTML-only** change runs, and the host shows an "updated
  since you allowed it" line with an **Accept** button in the area bar (the frame cannot draw it). The line
  stays, across restarts, until the user taps Accept; only then is the new HTML hash stored.
- Scopes and `note.open` refs may not contain any invisible character (the same classifier as drafts,
  below, including tag characters). A `vault.read` prefix outside the area's own folder, or a `chat.read` /
  `chat.draft` room that is not one of the area's channels, is allowed but the prompt says so in bold
  ("Read notes outside this area, in Journal/", "Read recent messages in a room outside this area, #x").

## Consent

1. **First open: grant prompt** (`grantPrompt.tsx`, outside the frame). Lists the needs in plain words:
   *Read notes in Areas/Techne/ · Read recent messages in #Techne · Suggest drafts for #Techne*.
   Every sentence is the host's; the only text from the note is the area name, quoted and marked as
   unverified. **Allow** stores the grant; **Not now** shows the default view and is not remembered.
2. **While running: suggestion bar** (`consent.tsx`, outside the frame). `chat.draft` and `note.open`
   only create a *pending suggestion*: "Techne suggests a draft for #Techne: … [Add to draft] [Dismiss]".
   Only a tap on that host UI adds the text to the room's composer (after any existing draft; it never
   sends) or opens the note. The bar shows the **whole** draft that will be inserted. The block is at most
   the smaller of 40% of the window height and 24rem, and scrolls past that. **Add to draft** stays disabled
   until the block has been scrolled to its bottom, or the draft fits without scrolling; once read, it stays
   enabled. Drafts are capped at 500 characters. Cleaning removes every control (Cc, except newline and tab),
   format (Cf: bidi, zero-width, **tag characters** U+E0000–E007F), private-use, unassigned and surrogate code
   point, every Default_Ignorable_Code_Point (this covers all variation selectors, U+034F, U+17B4–17B5,
   U+180B–180F, the Hangul fillers, ZWJ U+200D and VS16 U+FE0F), and the braille blank U+2800. ZWJ and VS16
   are removed everywhere, so a combined emoji degrades to its parts (family → three separate emoji). CR,
   U+2028 and U+2029 become newlines, and a run of whitespace-only lines (any Unicode space, including U+3000)
   collapses to one blank line. A draft with more than 12 lines after cleaning is **refused** (`bad_params`),
   not altered. The same cleaning runs in the module and in the suggestion store, so the bar and the insert
   are the same text. An unbreakable run of characters wraps or scrolls sideways inside the block, so **Add to
   draft** and **Dismiss** stay on screen. `note.open` is judged on the note the ref resolves to, and the
   suggestion carries that path. At most 3 pending; duplicates collapse. There is no gesture inference
   (no `userActivation`, no blur or focus heuristics): a frame that steals focus gains nothing.
3. **Stop, revoke, restore.** The area bar has **Stop app** (unmounts the frame) and **Revoke access**
   (forgets the grant; the next open asks again). Both clear pending suggestions, and a call that finishes after the frame is gone adds none. A stopped app shows **Open <Name> app**. An app starts
   only on a tap in the current process (the area card, **Allow**, or **Open app**): an area tab restored
   from the last launch never starts its app by itself, so a faulty app cannot freeze Uni on every launch.

## Wire protocol

Frame → host, one of two envelopes; the host answers on the same `id`.

```
{uni:1, id, ns, method, params?}                 → {uni:1, id, result} | {uni:1, id, error:{code, message}}
{pfr:1, channel:"vault", id, method, path, headers, body}
                                                 → {pfr:1, channel:"vault", id, status, statusText, headers, body}
host → frame events:  {uni:1, event:"ready"|"theme", data}
```

Exact keys only; `id` is a string of 1–64 chars; ≤ 8 KB per request (checked by a budgeted walk, never by
stringifying attacker data); depth ≤ 6; plain JSON only. Over the request limit a message with a usable `id` gets `rate_limited` (a frame-fetch gets 429); a message with no usable id gets no reply.

**Namespaces and methods**

| ns.method | Needs | Params | Result |
|---|---|---|---|
| `vault.fetch` (via `pfr`) | `vault.read` | an HTTP-like GET, below | HTTP-like response |
| `chat.recent` | `chat.read` | `{limit?}` 1–30 | `{messages:[{id, author, content, created_at}]}`, newest first, granted rooms only |
| `chat.draft` | `chat.draft` | `{text ≤ 2000, room?}` | `{pending:true, room}`; creates a pending suggestion, nothing else |
| `note.open` | `vault.read` | `{ref}` inside the granted prefix | `{pending:true}`; a pending suggestion |
| `theme.get` | none | none | `{text, muted, accent, surface, line, sans, serif, mono}` |

**Vault REST subset** (compatible with surface-client's `VaultClient`; GET only, everything else is 405):

- `GET /api/vault` → `{name, scope}`.
- `GET /api/notes?path_prefix&tag&search&limit&id&path&include_content` → notes, newest first, `limit` ≤ 50.
  No `path_prefix` means the granted scope, never the vault. A `path_prefix` outside the grant is 403.
  `tag` and `include_content` read at most 20 in-scope notes (the Tauri vault commands expose no tag
  filter, so this is a bounded scan); `search` is scoped by prefix and its results are filtered again.
  The app note itself (`html`) is left out of lists. Reads are cached by note id for 10 s; a cache miss
  costs one read token (a cache hit is free), a `search` costs one per granted prefix searched, and a request that runs out of read budget answers 429. Reads have their own bucket, so spent reads never silence other requests.
  Parameters outside the list (`offset`, `sort`, `metadata`, `include_links`, `near`, `cursor`, …) are
  `400 bad_params` rather than silently ignored; `GET /api/vault` accepts `include_stats`. This is a
  **subset** of `VaultClient`, not the whole client.
- `GET /api/notes/:idOrPath` → the note, or 404.

Scope is judged on the **note that comes back** (its `path` must be strictly inside a granted prefix),
whatever key it was looked up by, so ids, search hits and tags cannot leak a note from another area.
Out-of-scope reads are 404, not 403, so the vault has no existence oracle.

Errors (`error.code`): `bad_request`, `bad_version`, `bad_params`, `too_large`, `unknown_namespace`,
`unknown_method`, `not_granted`, `out_of_scope`, `rate_limited`, `too_many_pending`, `failed`.

## Kits (`window.uni`, frozen)

```js
const ctx = await uni.ready();                 // {contract:1, area:{name,title,purpose,status,since}, theme}
const notes = await uni.vault.queryNotes({ pathPrefix: `Areas/${ctx.area.name}/`, limit: 12 });
const note = await uni.vault.getNote("Areas/Techne/Plan");      // null when out of scope
const { messages } = await uni.chat.recent(12);
await uni.chat.draft("text");                  // → pending suggestion; the user taps in the host
await uni.note.open("Areas/Techne/Plan");      // → pending suggestion
uni.theme.on((t) => { /* host colours; --text, --accent… are also set on <html> */ });
```

`uni.VaultClient` is surface-client's real `VaultClient` (about 20 KB minified, bundled into every
srcdoc by the `virtual:uni-vault-client` Vite plugin); `uni.vault` is one pointed at `uni.frameFetch`.
Mutating methods exist on the client but the host answers 405. `uni.frameFetch(url, init)` is the
transport. Bare `#anchor` links scroll in place (a srcdoc frame would otherwise resolve them against
the host's URL and navigate away).

Authoring: inline CSS/JS only; `textContent`, never `innerHTML`, for anything from a message or note;
handle empty/loading/error for every call; make it work at 390 px and 1600 px; say that a draft was
*suggested*, never that it was sent. The host injects Cormorant Garamond (400–600, italic 400/500) and
Inter (400–600) as `data:` fonts.

## Sealing: what is guaranteed, per platform

The frame is `<iframe srcdoc sandbox="allow-scripts">` (opaque origin: no storage, no cookies, no Tauri,
no top navigation), with an app CSP inserted before any app markup
(`default-src 'none'; … connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`),
inside a host whose own CSP allows only `frame-src about:`. That host CSP is what stops navigation of the
frame (self, meta refresh, link, `document.write`, and navigation **during parse**). The host listens for
the resulting `frame-src` violation and stops the app.

What each part really guarantees:

- **Network** (fetch, XHR, WebSocket, beacon, images, prefetch hints, forms): sealed by the CSP; tested
  against a real HTTP listener on Chromium and WebKit.
- **Navigation**: sealed only if the host CSP is delivered. The self-test therefore requires a
  *host-observed* `frame-src` violation for each navigation vector; a reload count is not proof, and a
  missing host CSP makes the self-test **fail**. There is no load tripwire any more (it false-positived
  on `#anchor`). Unverified: that Tauri delivers `frame-src about:` on `tauri://` responses on every
  platform. The self-test is the only proof, per device.
- **WebRTC is not sealed by us.** CSP does not govern it, and a `srcdoc` child frame is a fresh realm
  where the in-frame neutraliser never ran: on a webview that has WebRTC a hostile app can send data in
  TURN credentials (reproduced on Chromium). The neutraliser is best effort only. The guarantee is a
  webview with WebRTC **off**, and the self-test's `WebRTC unavailable in a child frame` check (run in a
  probe-created child frame; constructible means fail) is what keeps the gate closed otherwise.
  - Linux (WebKitGTK): `enable-webrtc` is off by default; `src-tauri` also sets it off explicitly at
    startup (`disable_webrtc` in `lib.rs`). Compiles; behaviour on a running Tauri bundle unverified.
  - Android WebView (Chromium) and macOS WKWebView have WebRTC: the `webrtc` and `webrtcChild` checks fail
    there. That is no longer a closed gate by itself: see **Approved-code mode** below. A native switch to
    turn WebRTC off is still not implemented.
- **In-process, so an app can freeze Uni.** The frame shares the host's renderer, so `for(;;){}`, an
  allocation loop or a DOM bomb freezes the whole app on Chromium and WebKit (reproduced in review). The
  message limiter cannot help; there is no in-process fix. Mitigations shipped: the grant prompt says so,
  **Stop app** and **Revoke access** exist, and a restored tab never auto-starts its app. A frozen host
  cannot be tapped, so recovery is force-quit and, on relaunch, not opening the area. **Out-of-process
  hosting (a separate webview per app) is the follow-up** that actually fixes it.
- **DNS**: `dns-prefetch` and `preconnect` hints are not governed by CSP on Chromium, so a hostname-based
  DNS channel may remain. Our harness could not make those hints fire even without a CSP, so the result is
  inconclusive, not clean. Not tested, not sealed; same follow-up (a separate webview with its own
  network rules).
- **Cookies**: Chromium throws in an opaque origin; WebKit returns `""`. The self-test passes on a throw,
  or on `""` where a write does not persist.
- **Consent**: the frame cannot reach the host UI. `chat.draft` and `note.open` cannot act on their own.

Live apps run only where the in-app self-test (Settings → Run sandbox self-test) has a stored result for this
platform, app version and webview user agent, or where the platform is listed in `LIVE_AREA_PLATFORMS`
(`src/interface/selftest/gate.ts`, empty by default). A re-run that fails for any reason other than the two
WebRTC checks revokes the stored result. `gateMode()` returns `sealed`, `approved-code` or `closed`.

### Approved-code mode (T-74e)

| Stored self-test result | Gate mode | An app runs when |
|---|---|---|
| every check passed (or the platform is in `LIVE_AREA_PLATFORMS`) | **Sealed** | grant status `ok`, or `updated` (runs, with the host's "updated since you allowed it" line and **Accept**) |
| only `webrtc` / `webrtcChild` failed, every other check reported exactly `true` | **Approved code only (WebRTC present)** | grant status `ok` only |
| WebRTC and any other check failed or went unreported, or no result, or a different version, platform or webview | closed | never |

In approved-code mode an app whose HTML hash differs from the one stored at approval (status `updated`) does
**not** run. The area shows the grant prompt again with a host-rendered line, "This app's code changed since you
allowed it. On this device apps can reach the network through WebRTC, so only code you've approved runs.", and
**Allow this version** / **Not now**. Nothing runs until **Allow this version** stores the new hash. A
never-approved app gets the first-open prompt, which in this mode drops the "sealed frame" and "can't reach the
internet" sentences for the host line "On this device apps can reach the network through WebRTC, so this app is only as
safe as its code. Allow it only if you trust it." A running app shows an **Approved code** chip in the host bar. The
grant record stores `grantedUnder` (the mode it was made in; a record without it counts as `sealed`), and a grant made
under a sealed pass asks once more in approved-code mode. `runDecision` treats only `sealed` and `approved-code` as
open; any other value is closed. Settings shows the mode as "Sealed" or
"Approved code only (WebRTC present)"; the result is stored with a `mode` field (a record without one is read
as `sealed`).

**Threat accepted.** WebRTC ignores CSP, so an approved app that was itself hostile could exfiltrate over it
(for example in TURN credentials; see above). The mode accepts that because it only runs HTML the user has
approved, and the only apps approved are ones Aaron or Uni wrote. The approval covers the app's HTML, not what the
HTML does with data: an approved app that turns note or chat text into markup would run note- or chat-authored
script, with WebRTC reachable, outside the hash. It does not defend against a hostile app the user approves, nor
against a note edited and re-approved without reading it; the re-prompt on every code change is the control. Every
other seal (CSP, no IPC, no storage, no navigation) is still required.

**App-authoring rule (required in approved-code mode).** Never turn note or chat text into markup: no `innerHTML`,
`outerHTML`, `insertAdjacentHTML` or `document.write` with data. Use `textContent` and DOM nodes. The shipped seed
apps contain none of these. Follow-up, not done in this round: a nonce- or hash-based `script-src` in approved-code
mode, so inline handlers injected from data do not run (the frame CSP is still `script-src 'unsafe-inline'`).
