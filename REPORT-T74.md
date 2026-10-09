# T-74 report: the interface contract (replaces area bridge v0)

Branch `feat/interface-contract` off `fae2f3a`, 8 commits, not pushed. Full reference: `docs/interfaces.md`.
Red tests first: commit `caf10a6` is 47 failing unit checks, before any contract code existed.

## What was built

A modular contract in `src/interface/` (no imports from `App.tsx`; imports only `node:`-free TS, so it can be lifted into a package). Area apps are its first consumer. The old bridge (`bridge.ts`, `areaApi.ts`, `AreaFrame.tsx`, `frameGuard.ts`) is deleted.

```
frame (uni.* kits) ─postMessage─▶ frame.tsx ─▶ session.ts ─▶ router.ts ─▶ modules/{vault,chat,note,theme}
                                   limits       grant+scope        chat.draft / note.open ─▶ suggestions.ts ─▶ consent.tsx (host tap)
```

## File map

| Path | Role |
|---|---|
| `src/interface/contract.ts` | version, namespaces, capabilities, error codes, limits, `parseEnvelope`, `RateLimiter`, `inScope`, `safePrefix` |
| `manifest.ts` | parse `interface:` metadata, default needs, resolve `area`, order-independent hash, plain-words description |
| `grants.ts` | grant store keyed by note id + needs hash, injectable storage, session fallback |
| `router.ts` | `createRouter(modules)`; own-property method lookup; grant, validate, scopeCheck, run |
| `session.ts` | per-frame pump: 60 msgs/10 s counting every message, 8 pending, silent when over, `close()` |
| `suggestions.ts` | pending suggestions (max 3, de-duplicated); only `accept()` acts |
| `modules/vault.ts` | read-only VaultClient REST subset; scope judged on the returned note's path |
| `modules/frameFetch.ts` | the only file that knows the `pfr` wire shape (swap for the published package) |
| `modules/chat.ts`, `note.ts`, `theme.ts` | `chat.recent`, `chat.draft`, `note.open`, `theme.get` |
| `kits/frameKit.ts`, `kits/index.ts`, `kits/vaultClientEntry.ts` | in-frame `window.uni`; the bundled surface-client `VaultClient` (Vite plugin `virtual:uni-vault-client` in `vite.config.ts`) |
| `srcdoc.ts`, `frame.tsx`, `frameFonts.ts` | srcdoc builder (CSP meta first), sealed frame host, host fonts (italic 500 added) |
| `consent.tsx`, `grantPrompt.tsx` | host-rendered suggestion bar and first-open grant prompt (outside the frame, trusted-click only) |
| `selftest/` | `probe.ts`, `ProbeFrame.tsx`, `SelfTest.tsx`, `gate.ts`, hooks (moved from `src/areas/`) |
| `src/areas/AreaView.tsx` | wires modules, grant, suggestion store and frame for an area; `areasCore.ts` is now parsing only |
| `areas-seed/techne.html`, `unforced.html` | rewritten on `uni.ready()`, `uni.vault.queryNotes`, `uni.chat`, `uni.note` |
| `docs/interfaces.md` | replaces `areas-seed/README.md`: contract, manifest, kits, consent, sealing per platform |
| `src-tauri/src/lib.rs`, `Cargo.toml` | `disable_webrtc()` on Linux (WebKitGTK `enable-webrtc` and `enable-media-stream` off) |
| `scripts/hostile/` | review 1 and 2 harnesses ported to the new code, README |

## Contract reference (short)

- Envelopes: `{uni:1, id, ns, method, params?}` and `{pfr:1, channel:"vault", id, method, path, headers, body}`; events `{uni:1, event, data}` (`ready`, `theme`).
- Methods: `vault.fetch` (via `pfr`), `chat.recent {limit≤30}`, `chat.draft {text≤2000, room?}`, `note.open {ref}`, `theme.get`.
- Capabilities in the manifest: `vault.read`, `chat.read`, `chat.draft`; scopes are a folder prefix, a room id, or `area`.
- Error codes: `bad_request bad_version bad_params too_large unknown_namespace unknown_method not_granted out_of_scope rate_limited too_many_pending failed`.
- Vault REST: `GET /api/vault`, `GET /api/notes?path_prefix&tag&search&limit&id&path&include_content`, `GET /api/notes/:idOrPath`; everything else 405. Out-of-scope note reads are 404 (no existence oracle), out-of-scope `path_prefix` is 403.

## Review findings and how each is handled

| Finding | Fix | Evidence |
|---|---|---|
| R2 P1-A WebRTC via `srcdoc` child | Self-test check `webrtcChild` runs in a probe-created child; constructible ⇒ fail. README no longer claims the neutraliser seals it. WebKitGTK set off explicitly. | self-test fails on a webview with WebRTC (Chromium and WebKit); real UDP listener sees 0 datagrams on a webview without WebRTC; **documented known limit** test shows both Chromium and Playwright WebKit leak over UDP when the gate is forced open |
| R2 P1-B self-test passes without host CSP | `navVerdict` needs a host-observed `frame-src` violation; added a navigate-during-parse stage | e2e: no host CSP ⇒ all four nav checks fail, nothing stored; unit: `navVerdict({violation:false, loads:2}) === false` |
| R2 P2-C gesture heuristic / focus stealing | Removed all gesture inference. `chat.draft`/`note.open` are pending suggestions; only a tap on host UI acts | e2e focus-stealing app: no tab opened, no composer write, pending capped at 3, 0 `post_message` |
| R2 P2-D tripwire false positive on `#anchor` | Tripwire removed. Found a second cause: in a srcdoc frame a bare `#x` link resolves against the host URL, so the browser navigates and the host CSP blocks it. The kit now scrolls in place | e2e benign `#anchor` app stays mounted; unit asserts the kit handler |
| cookie in WebKit returns `""` | pass on throw, or `""` and a write that doesn't persist | WebKit self-test passes the check; hostile app's cookie attempt judged the same way |
| R1/R2 network, nav, flood, TURN, shapes | harnesses ported to `scripts/hostile/` | ran against the new build: 0 HTTP hits in escape2/3/4 and 12 shapes; flood costs 1–100 ms; as expected `childSrcdocRtc`/`turn-leak` reach UDP on stock Chromium (see limit) |

## Tests (final run)

| Gate | Result |
|---|---|
| `tsc --noEmit` | clean |
| `npm test` | 58 ok lines, includes `interface.test.ts` (49 checks), `areasCore`, `areasR3` |
| `cargo check --offline` (src-tauri, with the WebKitGTK change) | passes (not run as a Tauri bundle) |
| Playwright Chromium `playwright.areas.config.ts` (areas + interface specs, phone + desktop) | 87 passed, 1 skipped (pre-existing skip) |
| Playwright WebKit in docker (`playwright.interface-webkit.config.ts`, Linux UA, desktop) | 43 passed, 1 skipped |
| default / rail / screens / sidebar configs | 88 / 15 / 7 / 14 passed (re-run on the final tree) |
| prod `vite build` | OK; no `__areasTest` string in the release bundle |
| mutation spot check (8 mutants of router scope, vault post-check, search filter, navVerdict, limiter, suggestion cap, grants) | 7/7 meaningful ones killed by the unit suite. One mutant (extra compose call in chat) is unobservable because `ChatDeps` has no compose, which is the structural protection |

Hostile e2e (both browsers): fetch/XHR/WebSocket/image/beacon/popup/nested frame/prefetch hints, top and parent access, Tauri globals, bridge abuse (unknown ns/method, oversize, wrong version, extra keys, long id, junk, other-area vault reads by id/path/search/prefix, traversal, POST), suggestion flood, message flood → listener saw no HTTP and no UDP, no `post_message`, no note fetched outside scope. Navigation vectors self/meta/anchor/write/parse → stopped by the host `frame-src` violation, no request reaches the network.

Screenshots (looked at): `shots/t74/{phone,desktop}-{grant-prompt,suggestion-bar,seed-techne,seed-unforced}.png` (+ self-test and areas home). `shots/` is gitignored.

## What is unverified or not done

- **WebRTC is not sealed by us.** On a webview that has it (Chromium incl. Android WebView, macOS WKWebView, Playwright's WebKit) a hostile app leaks over UDP from a `srcdoc` child frame. The gate stays closed there only because the self-test fails. Android/Mac have no native switch yet, so live apps will stay off there until one exists.
- Linux: `disable_webrtc()` compiles, but I did not run a Tauri bundle on WebKitGTK. Whether Tauri delivers `frame-src about:` on `tauri://` responses on any platform is still unconfirmed; the self-test is the only proof per device.
- Playwright's WebKit is not WKWebView or WebKitGTK; the self-test passed there only with WebRTC simulated off.
- The Playwright "off" mode removes `RTCPeerConnection` with an init script in every frame; it simulates a WebRTC-less webview, it is not a real one.
- `tag` filters scan at most 100 in-scope notes; search results include the area's own `app` note when the query matches it (lists hide it).
- No UI to revoke a grant (`grants.revoke` exists). Grants are in `localStorage`.
- Wire protocol: `pfr` shape is my fallback because `~/Code/wt/surface-frame-transport` has no frame-fetch yet; it is confined to `modules/frameFetch.ts` and the kit's `frameFetch`.
- `uni.VaultClient` adds about 20 KB (minified) to every srcdoc; the main bundle is unchanged apart from the plugin string.
- Not reviewed independently: this needs a separate read-only SHIP/NO-SHIP review.

---

# Round 2 (T-74b): fixes for the independent review (NO-SHIP)

Review: `~/.hermes/cache/scratch/t74-review/REVIEW.md`. Unit tests (`scripts/interface.test.ts`) were written and run red first (20 failing before any source change); Playwright specs were added after the fixes landed, each mirroring the review's reproduction (`r.spec.ts` S1–S3, `amp.mjs`), so their red state against the old tree was not run separately.

## Finding → fix → test

| Finding | Fix | Test |
|---|---|---|
| **P1** `mobile_entry_point` on `disable_webrtc` | Attribute moved directly above `pub fn run()`; doc comment stays on `disable_webrtc` | unit: regex on `lib.rs` (red on HEAD's file); `cargo check --target aarch64-linux-android` passes. **That gate is not red-capable:** I ran it against HEAD's `lib.rs` and it also passed, so only the source test catches this regression |
| **P2-A** grant ignores resolution | Key = note id + SHA-256 of the RESOLVED needs (prefixes, room ids, area path) + SHA-256 of the app HTML (`grantKey`, `htmlHash`, `crypto.subtle`). Store is `uni.interface.grants.v2` (weak v1 grants are not honoured). `status()` is `none` (ask again) / `ok` / `updated`; HTML-only change runs and the area bar shows a host-rendered "updated since you allowed it" line for the session | unit: same symbolic needs in another area/room/no room give different keys; explicit scopes in another area differ; status none/ok/updated; v1 and corrupt storage = none. e2e: moved note (same id) into Atlas shows a prompt and reads nothing; stale-html grant runs with the `.area-updated` line outside the iframe |
| **P3-0** 53-bit hash | Replaced by SHA-256 (above) | unit: known SHA-256 vector, 64-hex keys |
| **P2-B** bar shows less than it inserts | `chat.draft` capped at 500; `cleanText` strips bidi, zero-width and control characters (keeps `\n` `\t`), collapses 3+ newlines; applied in the module and again in the suggestion store; the bar renders the whole text in a scrollable `pre-wrap` block. `note.open` shows the full ref | unit: cleanText cases, draft suggests cleaned text, store cleans, 501 refused. e2e: the review's hidden-payload app: payload is visible in the block, composer value equals the shown text exactly |
| **P2-C** app can freeze host | **Stop app** and **Revoke access** in the area bar; revoke also on an idle granted area; an app starts only on a tap in this process (area card, Allow, **Open <Name> app**), so a restored tab never auto-starts. `docs/interfaces.md` documents that in-process apps can freeze Uni and that out-of-process hosting is the follow-up. The grant prompt says so | e2e: stop → open → revoke → asks again, grant gone; relaunch with a running app shows the Open button and no iframe. Not fixable in-process; busy-loop behaviour is unchanged |
| **P2-D** amplification | `RateLimiter.take(now, cost)`; the session gives modules `ctx.charge(n)`; each underlying `getNote` costs a token, over budget answers 429; tag/content scans read at most 20; 10 s note cache keyed by id (cache hit free; scope still judged on the cached note); `note.open` resolve costs 1. **The Tauri commands expose no tag filter** (`vault_search` takes query + path prefix only), so the scan stays, bounded | unit: 200 tag scans over the same notes read ≤ 20; 200 distinct scans make ≤ 60 reads per window and answer 429; budget returns after the window; cache hit/expiry; scope on cached note. e2e: an app firing 200 tag queries causes ≤ 20 `vault_note` reads |
| **P3-1** unknown params ignored | `/api/notes` and `/api/notes/:id` return `400 bad_params` for parameters outside the list; `/api/vault` accepts `include_stats` only. Docs say "subset" | unit: nine unsupported params refused, supported ones pass |
| **P3-2** prompt wording, spoofing | Scopes with hidden/bidi/control characters are refused; prompt text is entirely the host's, the area name is quoted in `<q data-untrusted>` with "(a name taken from the note, not verified)"; a vault prefix outside the area's folder reads "Read notes outside this area, in …" in bold | unit + e2e (`Journal/` prefix flagged, name marked) |
| **P3-3** double-tap on Dismiss | Not changed (cosmetic; effect is bounded by the 500-char visible draft) | — |
| **P3-4** `note.open` scoped on the ref string | Obvious traversal is refused before any vault call; otherwise the ref is resolved through the vault and the **resolved path** is checked and carried in the suggestion | unit: resolver returning an out-of-scope note is refused; ids in scope now work; the hostile e2e still sees no `..`/`passwd` lookups |
| **P3-5** DNS / preconnect | Not testable here (the review's own harness could not make the hints fire without a CSP). Documented as an unsealed, unverified limit in `docs/interfaces.md`; same follow-up | unit asserts the doc line exists |

## Found while testing

Arming the frame only after the async grant key exists exposed a latent race: in WebKit the `srcdoc` document loads on mount, before the session effect runs, so its first message or the `ready` event went to nobody (9 WebKit failures, then flaky ones). Fixed in `frame.tsx`: the iframe receives its document only once the session is listening (`armed`), and a late session still gets `ready`. This also removes a way for an app's very first message to be lost.

## Gates (final tree)

| Gate | Result |
|---|---|
| `tsc --noEmit` | clean |
| `npm test` | all ok, `interface: ok` |
| prod `vite build` | OK, 0 files contain `__areasTest` |
| Playwright Chromium `playwright.areas.config.ts` | 101 passed, 1 skipped (pre-existing) |
| Playwright WebKit (docker, `playwright.interface-webkit.config.ts`) | 50 passed, 1 skipped; run twice after the `armed` fix, both clean. Two earlier runs failed 1–2 tests that differed each time, before the fix |
| default / rail / screens / sidebar configs | 88 / 15 / 7 / 14 passed (run before the final frame change; those suites do not touch the frame) |
| `cargo check` (src-tauri, Linux) | passes |
| `cargo check --target aarch64-linux-android` | passes (NDK 29.0.14206865, linker/CC env set per the tauri-android skill). Not red-capable for P1, see above |
| Mutation spot check | no budget charge, unscoped `note.open`, scan cap 100, unsanitised store: each killed; "area path out of the grant key" survived until an explicit-scope test was added, then killed |

## Still not done / unverified

- Out-of-process hosting (the only real fix for P2-C, and for the DNS channel). Recovery from a frozen host is force-quit.
- No Android or iOS build or run; the entry-point fix is checked by source and `cargo check` only.
- `src-tauri/gen/schemas` was modified by cargo and left uncommitted.
- Needs a new independent SHIP/NO-SHIP review.
