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
| `manifest.ts` | parse `interface:` metadata, default needs, resolve `area`, hash, plain-words description |
| `grants.ts` | grant store keyed by note id + needs hash (injectable storage) |
| `router.ts` | `createRouter(modules)`: namespace/method → handler, enforcing grant, params and scope |
| `session.ts` | one frame's message pump: rate limit (60 / 10 s, every message counts), 8 pending, replies |
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
- The **hash** of the normalised needs (order-independent) keys the grant. Change the needs and the user
  is asked again.

## Consent

1. **First open: grant prompt** (`grantPrompt.tsx`, outside the frame). Lists the needs in plain words:
   *Read notes in Areas/Techne/ · Read recent messages in #Techne · Suggest drafts for #Techne*.
   **Allow** stores the grant; **Not now** shows the default view and is not remembered.
2. **While running: suggestion bar** (`consent.tsx`, outside the frame). `chat.draft` and `note.open`
   only create a *pending suggestion*: "Techne suggests a draft for #Techne: … [Add to draft] [Dismiss]".
   Only a tap on that host UI adds the text to the room's composer (after any existing draft; it never
   sends) or opens the note. At most 3 pending; duplicates collapse. There is no gesture inference
   (no `userActivation`, no blur or focus heuristics): a frame that steals focus gains nothing.

## Wire protocol

Frame → host, one of two envelopes; the host answers on the same `id`.

```
{uni:1, id, ns, method, params?}                 → {uni:1, id, result} | {uni:1, id, error:{code, message}}
{pfr:1, channel:"vault", id, method, path, headers, body}
                                                 → {pfr:1, channel:"vault", id, status, statusText, headers, body}
host → frame events:  {uni:1, event:"ready"|"theme", data}
```

Exact keys only; `id` is a string of 1–64 chars; ≤ 8 KB per request (checked by a budgeted walk, never by
stringifying attacker data); depth ≤ 6; plain JSON only. Over the rate limit the host is silent.

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
  `tag` scans at most 100 in-scope notes; `search` is scoped by prefix and its results are filtered again.
  The app note itself (`html`) is left out of lists.
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
  - Android WebView (Chromium) and macOS WKWebView have WebRTC: the self-test is expected to fail there,
    so live apps stay off until a native switch exists. Not yet implemented.
- **Cookies**: Chromium throws in an opaque origin; WebKit returns `""`. The self-test passes on a throw,
  or on `""` where a write does not persist.
- **Consent**: the frame cannot reach the host UI. `chat.draft` and `note.open` cannot act on their own.

Live apps run only where the in-app self-test (Settings → Run sandbox self-test) has passed for this
platform, app version and webview user agent, or where the platform is listed in `LIVE_AREA_PLATFORMS`
(`src/interface/selftest/gate.ts`, empty by default). A failed re-run revokes the pass.
