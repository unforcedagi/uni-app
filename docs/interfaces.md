# Interfaces: the contract, manifests, the grant card, kits and sealing

An **applet** is a small app in the Uni app's drawer. Two kinds of code run as applets:

- a **sealed applet**: an HTML note in the vault, run inside a sealed frame. It reaches the vault and chat only
  through the frame's messages (the wire protocol below);
- a **built-in applet**: compiled into the app (Arcade, Calendar, To Post, Mail ...).

Both are described by a manifest on the **interface contract**, which lives in `src/interface/` with no imports from
`App.tsx`, so it can be lifted into a package. There are two versions:

- **Contract 2** (new): one manifest says what the applet reads and writes (which vault, which types or folders, which
  door), what else it reaches, what it offers to search and its screens. The shell resolves it to a **grant**, shows
  exactly that on **one card** the owner allows, and refuses anything outside it at runtime. Arcade is on it, and so is
  the first sealed applet a room made, Recipes (its note lives in its own `recipes` vault; it reads, adds and changes
  notes in `Recipes/`).
- **Contract 1**: a sealed note carries two manifests, `applet:` (how the drawer lists it) and `interface:` (its
  needs). Still accepted, and it asks on the same card. Built-ins other than Arcade are listed on contract 1 and ask for
  nothing yet.

A sealed applet joins the drawer when its note is tagged `applet`, has `extension: html` and a valid manifest
(`src/interface/sealedApplet.ts`, `src/shape/SealedApplet.tsx`). Applet notes are read from **every vault this device
has**, the primary vault first (`src/shape/useSealedApplets.ts`): an id the primary vault holds can't be taken from
another vault, and a repeated id is skipped and counted. The vault the note is in is the applet's `here`, the only vault
it reaches; the card names it, and it is part of the grant's key (the same note path in another vault asks again). A note whose manifest isn't valid is skipped and
counted. One whose needs can't be granted still gets its tile, and opening it shows "This applet can't open" with the
reason. Until 0.4.0 the consumer was an area's app (`Areas/<Name>/app`, shown in the area view); the areas view is
gone, and the example apps written for it ([`areas-seed/techne.html`](../areas-seed/techne.html),
[`areas-seed/unforced.html`](../areas-seed/unforced.html)) declare `area` scopes, which a drawer applet refuses.

## Contract 2: one manifest, one card, one grant

```yaml
applet:
  contract: 2
  id: arcade                         # kebab-case; a note may not take a built-in's id
  name: Arcade
  glyph: ◆                           # optional
  note: your cards and taste profile stay on the box      # optional, one line
  access:
    - door: arcade                   # a door the shell knows (doors.ts)
      ops: [home, rounds, profile, media, react, distill]   # only these ops of it
    - vault: home                    # home = your own vault · here = the vault its note is in · or a vault's name
      allow:
        - path: Journal/             # a folder (ends in /), and/or `type: <tag>`
          verbs: [create]            # read · create · update · delete
          own: true                  # only the notes it made
        - path: Taste/
          verbs: [read]
  reach: [voice]                     # voice · {room: <room id>, verbs: [read, draft]}
  search: [{what: games}]            # {what, vault?, type?, path?}: over notes, it must sit inside a read rule
  screens: [{id: home, name: Arcade}, {id: look, name: A pinned card}]   # the first is where it opens
```

That is Arcade's real manifest (`src/arcade/manifest.ts`). The words follow Parachute 1.0's grants: allow by **type**
and **verb**, `own` for "only what this grant created". A folder (`path`) is this shell's narrowing; 1.0 grants have no
word for it yet.

| File | Role |
|---|---|
| `manifest2.ts` | `parseManifest2(raw, host)`: strict parser. An unknown key, door, op or verb, a rule that names no type and no folder, a climbing or hidden-character path, a repeated vault or door, or a search offer over notes it can't read is refused, never repaired. `screenOf`, `whereWords` |
| `doors.ts` | the doors the shell knows, each op with the one shell command it reaches and the shell's words for it |
| `grant2.ts` | `resolveGrant` (manifest + this device → `Grant`), `grantLines` (the card's rows), `allowsDoor` / `allowsNote` / `allowsQuery` / `allowsReach` (the runtime's questions), `grantKey`, `grantEvents` (the Parachute 1.0 shape) |
| `port.ts` | `createAppletPort(grant, backends)`: a built-in applet's only way to a door, a vault, the microphone or a note. Every call asks the grant |
| `GrantCard.tsx`, `grantCard.css` | the card: asks (Allow / Not now), and once allowed shows what was granted with Revoke access |
| `grants.ts` | this device's grant store: subject → grant key, code hash, when allowed, when it ends |
| `src/shape/AppletGate.tsx` | a built-in on contract 2: the card until allowed, then the applet with its port |
| `planned2.ts` | Calendar's and To Post's contract 2 manifests, written and tested, not in use |

**The grant.** `resolveGrant` turns `home` and `here` into vault names and checks that each room exists on this
device. The result, a `Grant`, is the one value the card shows, the tap allows and the runtime checks. Its key is the
SHA-256 of the canonical grant (and, for a note, the note's path); the store keeps the key the owner allowed, so a
manifest that resolves to anything else (a new release that asks for more or less, another home vault) shows the card
again. A grant lasts a year (`GRANT_DAYS`, Parachute 1.0's lean for the longest grant) and then the card comes back. A
record whose expiry can't be read counts as expired. The name is not in the key: a rename alone asks for nothing new.

**The card** (`GrantCard.tsx`) is drawn by the shell, outside any frame, and names exactly what is granted, one row per
place: a door's reads on one row and what it changes on the next, each vault rule, each room, the microphone. Rows that
change something, reach a room or read outside a sealed applet's own folder are marked. Every sentence is the shell's (a
door's and an op's words come from `doors.ts`). What a note supplies is shown as data inside those sentences: a sealed
applet's name, quoted and marked as unverified (its glyph is not shown on the card: a note could pick a tick or a
padlock), and the folder paths it asks for, as written (a path is a plain folder
ending in `/`, with no hidden characters, but it can hold words: read the row's path as the note's, not the shell's). Under the rows it says "Nothing else", when the grant ends, and a fingerprint (the key's first eight
digits) that changes whenever the access does. Only a real tap allows (`isTrusted`). Once allowed, a built-in's frame
has an **Access** button that shows the same card with **Revoke access**.

**At runtime** a built-in applet gets one thing from the shell: its port. `port.door(door, op, args)`,
`port.vault.query / note / create`, `port.open(vault, path)` and `port.need("voice")` each ask the grant first and throw
`not_granted` (the grant has no such door, vault or reach) or `out_of_scope` (it has, but not this op, note or folder)
before anything reaches a shell command. A read is judged on the note that comes back (its real path and tags), a note
outside the grant reads as absent, a list's rows from outside are dropped, and every path a new note could land on
(alternates too) must be inside a create rule. A note is checked and written from one copy. A note's path that isn't plain (a `..`, empty or absolute segment, a backslash, a percent-encoded dot or slash) is
refused whatever the rule, a type-only rule included; a list's `pathPrefix` is held to its folder rule and each row is
judged as a note. `own` covers only the notes the shell's writer reports this port made (by id or path); the path that was
asked for is never taken on trust. Today's writer (the journal's) can't name the note a save made, so it reports none:
an `own` rule lets an applet add notes and read none of them back, until the save command returns the note's id.
The grant is asked again when the shell answers: a revoke, an expiry or leaving the applet refuses every new
call, and a call that was in flight gets nothing back (a write already handed to the shell's writer is not undone). A
grant that runs out while an applet is open (built-in or sealed) brings the card back then. A rooms list that changes nothing the grant
names leaves the running applet alone.

The shell's writer behind `create` is the journal's, which saves to the journal's own vault (Journal settings). The
port's backend asks the app core where the journal is kept at every write, never from a copy, and adds the note only
when that is the vault the grant named; otherwise it refuses and says so. `port.vault.writable(vault, path)` asks the
same without writing, and the Arcade asks it before the microphone opens, so nothing is recorded that would then be
refused. Limits, stated plainly: the check and the save are two calls to the app core, not one (closing that needs the
save command itself to take the expected vault); it compares the vault's name, not the hub; and an entry queued while
offline is sent to wherever the journal is kept when it is sent, as every journal entry is.

**What the boundary is, and isn't.** A built-in applet is code in the app's own bundle, covered by the release
signature, in the same JavaScript realm as the shell. The port is a boundary of construction, not of isolation: it
holds because the applet's folder is written with no other way out, and a test keeps it so. `scripts/appletV2.test.ts`
fails the build if anything under `src/arcade/` imports Tauri, names a shell command, reaches the network, opens the
microphone, touches the grant store, or imports a shell module that isn't on its short list (the port's types, the
shell's recorder, the journal's pure path maker), and it checks that those listed modules hold no command either. What
that does not cover: the check reads source text, one import deep, so it is a guard against drift, not a proof; the
Arcade shares the page's `localStorage` (where grants are kept) and globals with the shell; and the microphone is
opened by the shell's recorder, which the Arcade calls after `port.need("voice")` (asked, not enforced by the
recorder). It does not stop hostile code that someone compiles in on purpose; the frame is the boundary for code the
release doesn't vouch for. A sealed applet on contract 2 is compiled to the frame's needs and held by the same
`session.ts` and `router.ts` as contract 1, so its boundary is the frame. A sealed manifest may hold only `vault: here`,
rules of `{path, verbs}` with verbs from `read`, `create` and `update`, and rooms; a door, `delete`, `own`, a type rule,
`voice` or another vault is refused with the reason, and the note is not listed. Each verb becomes a need on that folder
(`vault.read`, `vault.create`, `vault.update`); contract 1 can't ask for the two writes. **The frame's writes**
(`modules/vault.ts`): `POST /api/notes {path, content}` adds a note whose path is plain and inside a create folder, and
`PATCH /api/notes/:idOrPath {content, if_updated_at}` replaces the content of a note inside an update folder, at the
revision the applet read (a stale one is `409 conflict`). Both are judged on the note as it is read at that moment, never
on the ref asked for. A write sets content only: tags, metadata, links, a move or `force` are `400`; a note that is HTML
or tagged `applet` (any applet's code) is never changed; a path ending in `.html` is refused; a note the applet can't
read is `404` (no existence oracle) and one it reads but may not change is `403`. Nothing is written once the session
has ended. The shell's writers are the app core's `vault_create` and `vault_save` on the applet's own vault; a write drops
the path listings so the next list shows it. A vault fetch needs a read rule, so an applet that writes also reads.
The card's row for a folder says every verb ("Read, add and change notes in Recipes/") and is marked, and its closing line
says it can't delete or change notes anywhere else.

**Not signed yet.** The grant is a record on this device (`localStorage`, `uni.interface.grants.v2`), as contract 1's
was. `grantEvents(grant, expires)` builds the same grant in the shape Parachute 1.0 proposes for an owner-signed event
(one per vault: `d`, `vault` and `expiration` tags; content `{v:1, grantee:{kind:"applet", id, author}, allow:[{type,
verbs, own?}], deny_markers}`), with folder-only rules listed apart as `shellOnly`. Nothing signs, stores or sends
those events: the event kinds are not fixed. Until the vault enforces grants, only the shell holds an applet to its
card; a script with a vault token is not held by it.

**Not migrated yet.** Calendar and To Post still call shell commands directly and ask for nothing. Their manifests are
in `planned2.ts`. Moving them needs, beyond a port of their calls: the shell's `update` writer behind the port (To
Post's approve, edit and drop), a `links` reach for opening a posted link outside the app, and for Calendar its
offline snapshot behind the port. Mail and Messages (doors with their own sessions) have no contract 2 manifest.

## Contract 1 and the sealed frame

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
| `modules/vault.ts` | a REST subset of surface-client's `VaultClient` over the frame: reads, and a contract 2 grant's two writes |
| `modules/chat.ts`, `note.ts`, `theme.ts` | `chat.recent` / `chat.draft`, `note.open`, `theme.get` |
| `modules/frameFetch.ts` | the one adapter that knows the `pfr` wire shape (swap for the published `createFrameFetch`/`serveFrameFetch`) |
| `kits/` | `frameKit.ts` (the code injected into the frame) and the bundled `VaultClient` |
| `srcdoc.ts`, `frame.tsx` | the srcdoc builder and the sealed frame host |
| `consent.tsx`, `GrantCard.tsx` | host-rendered suggestion bar and the grant card |
| `selftest/` | the in-app sandbox self-test and the platform gate |

## The contract 1 manifest

In the applet note's metadata (contract 2's single manifest is above; a note carries one or the other, never
`contract: 2` with an `interface:` beside it):

```yaml
applet:
  contract: 1
  id: seeds                         # unique; not a built-in's id, except a placeholder's (recipes)
  name: Seeds
  kind: vault
  where: ...                        # where its data lives, in the words applets.ts checks
  searches: [...]
interface:
  contract: 1
  needs:
    - vault.read: Seeds/            # a folder prefix ending in "/"
    - chat.read: <room id>          # a room this device has
    - chat.draft: <room id>
```

- A drawer applet has no area and no room of its own, so every scope is explicit. No `interface` key (whose
  default needs are all `area`), or the symbolic `area` scope anywhere, is refused with a screen that says why;
  so is a `chat.*` need whose room this device doesn't have. The parser (`manifest.ts`) still knows `area` and
  `interface.layout`, from the area host; the drawer uses neither.
- Invalid manifests (unknown capability, `..`, `%`, backslash, no trailing `/`, > 12 needs, wrong contract
  version) never run; the applet shows "This applet can't open" with the reason.
- The grant is keyed by the note id, the SHA-256 of what the needs **resolve to** (folder prefixes and room
  ids) plus the note's path, and the SHA-256 of the app HTML. A different resolution or a moved note asks
  again. An **HTML-only** change runs, and the host shows an "updated since you allowed it" line with an
  **Accept** button in the applet's bar (the frame cannot draw it). The line stays, across restarts, until the
  user taps Accept; only then is the new HTML hash stored.
- Scopes and `note.open` refs may not contain any invisible character (the same classifier as drafts,
  below, including tag characters).

## Chat from an applet

An applet never draws chat and has no room beside it. With `chat.read` it can read a named room's recent
messages (`chat.recent`); with `chat.draft`, *Add to draft* on its suggestion puts the text in that room's
composer. With chat off in the active profile, no room is the applet's to read. The drawer host pushes no
live `chat.message` events (the area view did); `uni.chat.onMessage(cb)` still exists in the kit for a host
that does.

## Consent

1. **First open: the grant card** (`GrantCard.tsx`, outside the frame; the same card contract 2 uses). One row per
   place: *uni vault · Read notes in Seeds/*, *#garden · Read recent messages and suggest drafts (you decide what is
   added; nothing is sent)*. Every sentence is the host's; the only text from the note is the applet's name, quoted and
   marked as unverified. **Allow** stores the grant, for a year; **Not now** shows the default view and is not
   remembered. A grant stored before the card existed has no end date and stays as it was.
2. **While running: suggestion bar** (`consent.tsx`, outside the frame). `chat.draft` and `note.open`
   only create a *pending suggestion*: "Seeds suggests a draft for #garden: … [Add to draft] [Dismiss]".
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
3. **Stop, revoke, restore.** The applet's bar has **Stop** (unmounts the frame) and **Revoke access**
   (forgets the grant; the next open asks again). Both clear pending suggestions, and a call that finishes after the frame is gone adds none. A stopped applet shows **Open <Name>**. An applet starts
   only on a tap in the current process (its tile in the drawer, **Allow**, or **Open**): an applet tab restored
   from the last launch never starts by itself, so a faulty applet cannot freeze Uni on every launch.

## Wire protocol

Frame → host, one of two envelopes; the host answers on the same `id`.

```
{uni:1, id, ns, method, params?}                 → {uni:1, id, result} | {uni:1, id, error:{code, message}}
{pfr:1, channel:"vault", id, method, path, headers, body}
                                                 → {pfr:1, channel:"vault", id, status, statusText, headers, body}
host → frame events:  {uni:1, event:"ready"|"theme"|"chat.message", data}
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

**Vault REST subset** (compatible with surface-client's `VaultClient`; GET, plus the two writes below for a grant that names them):

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
- With a contract 2 write grant only: `POST /api/notes {path, content}` → 201, and `PATCH /api/notes/:idOrPath
  {content, if_updated_at}` → 200 (rules above). A frame-fetch body is at most 7 KB (of the 8 KB request). Anything else
  (PUT, DELETE, another route) is 405.

Scope is judged on the **note that comes back** (its `path` must be strictly inside a granted prefix),
whatever key it was looked up by, so ids, search hits and tags cannot leak a note from outside the grant.
Out-of-scope reads are 404, not 403, so the vault has no existence oracle.

Errors (`error.code`): `bad_request`, `bad_version`, `bad_params`, `too_large`, `unknown_namespace`,
`unknown_method`, `not_granted`, `out_of_scope`, `rate_limited`, `too_many_pending`, `failed`.

## Kits (`window.uni`, frozen)

```js
const ctx = await uni.ready();                 // {contract:1, applet:{id, name}, theme} (an area's app got area:{...})
const notes = await uni.vault.queryNotes({ pathPrefix: "Seeds/", limit: 12 });
const note = await uni.vault.getNote("Seeds/Plan");             // null when out of scope
const { messages } = await uni.chat.recent(12);
const off = uni.chat.onMessage((m) => { /* {id, author, content, created_at, room}; needs chat.read */ });
await uni.chat.draft("text");                  // → pending suggestion; the user taps in the host
await uni.note.open("Seeds/Plan");             // → pending suggestion
uni.theme.on((t) => { /* host colours; --text, --accent… are also set on <html> */ });
```

`uni.VaultClient` is surface-client's real `VaultClient` (about 20 KB minified, bundled into every
srcdoc by the `virtual:uni-vault-client` Vite plugin); `uni.vault` is one pointed at `uni.frameFetch`.
`uni.vault.createNote({path, content})` and `uni.vault.updateNote(id, {content, if_updated_at})` work for a contract 2
write grant; every other mutating method is answered 405. `uni.frameFetch(url, init)` is the
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
  message limiter cannot help; there is no in-process fix. Mitigations shipped: the grant card says so,
  **Stop app** and **Revoke access** exist, and a restored tab never auto-starts its app. A frozen host
  cannot be tapped, so recovery is force-quit and, on relaunch, not opening the applet. **Out-of-process
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
**not** run. The applet shows the grant card again with a host-rendered line, "This applet's code changed since you
allowed it. On this device applets can reach the network through WebRTC, so only code you've approved runs.", and
**Allow this version** / **Not now**. Nothing runs until **Allow this version** stores the new hash. A
never-approved app gets the first-open card, which in this mode drops the "sealed frame" and "can't reach the
internet" sentences for the host line "On this device applets can reach the network through WebRTC, so this applet is only as
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

### Host CSP trade-off and guards (T-77b)

The host CSP is `frame-src about:` only: `dangerousDisableAssetCspModification: ["script-src"]` stops Tauri adding
`'self'` and inline-script hashes, because a `srcdoc` frame inherits the embedder's policy and its inline scripts
would otherwise be blocked. The cost: the host has **no `script-src`**, and `withGlobalTauri` is on, so any HTML sink
in `src/` would be script execution with the full Tauri command surface. Guard: `scripts/htmlSinks.test.ts` (part of
`npm test`) fails on `dangerouslySetInnerHTML`, `.innerHTML =`, `insertAdjacentHTML`, `document.write`, `rehype-raw`,
`allowDangerousHtml` or a `highlight=` prop anywhere in `src/` (`@openparachute/surface-render` renders `highlight`
output as HTML). There is no allowlist entry; add one only with a written justification in that file.

On Linux the webkit `ipc` message handler is removed (`close_ipc_handler`, any new window must call it) and the
self-test pass is keyed on app version, user agent and the wry/Tauri versions (`webview_runtime`). If `ipc://` ever
fails, Tauri's postMessage fallback throws and invokes stay dead; Uni then shows "Uni lost its connection to the app
core. Restart Uni." (`src/ipcLost.ts`).

On Android wry registers its init scripts for every frame and exposes `window.ipc` to every frame, and Tauri sends
every invoke on Android through `window.ipc.postMessage`, so a sealed frame could call any command (T-79). The app
ships its own `RustWebView.kt` / `Ipc.kt` / `MainFrameOnly.kt` (`src-tauri/gen/android/app/src/main/java/org/unforced/uni`):
init scripts only for `http(s)://tauri.localhost` and behind a `window.top === window` guard, and `window.ipc`
is a WebMessageListener for the same origins that drops anything not from the main frame. `build.rs` fails an
Android build on any wry other than 0.55.1, because the two Kotlin files are copies of that version's templates.
`tauri android dev` (dev server origin) is not covered.
