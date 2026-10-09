# T-80 report: Areas become a life OS view (Today + living area pages)

Worker: Sonnet 5.5, 2026-10-09. Branch `feat/life-os` off e24a6d1, committed, not pushed, no vault writes. APK **0.1.31 (1001031)** built and `adb install -r`'d to the Daylight (firstInstallTime 2026-09-23 unchanged, nothing uninstalled). The Daylight was asleep behind the keyguard (`mWakefulness=Asleep`, Uni the resumed activity but not visible) when I installed, so Aaron was not using it.

## What changed
1. **Fast load.** New Rust `vault_query(vault, tag, include_content, limit)` (`uni-core` `query_tagged` + `tag_query_args`, one `query-notes` call with `tag`). `useAreas` now makes three parallel tag queries (`area`, `area-brief`, `area-today`) instead of `vault_paths` (~4,800 notes) plus a `vault_note` per area. Result is saved to localStorage (`uni.areas.cache.v1`, versioned, corrupt/oversized/quota-safe) and painted synchronously on the next mount, then refreshed. A failed refresh keeps the cached view and shows the error. `window.__areasTiming` records `cacheMs`/`freshMs`. `vault_paths` is now used only by the sealed apps' vault bridge (10 s cache, unchanged).
2. **Loop removed.** The area page no longer has "Open note" (it opened the page you were on).
3. **Rooms.** `metadata.channel` lists become room chips (`#Techne`, `#Cohere`) in the side chat and in the phone sheet; the room view, the "Open #room" button and Ask Uni follow the pick (`pickRoom`).
4. **Brief page.** Default area page renders the Brief natively: Now, Needs you (with count), Moving, People, Recent, Quiet, Suggested next. Wikilinks open the note in the app's vault view, web links open outside, "updated 3h ago" from `generated_at`/`updatedAt`. No Brief: "Uni hasn't written this area's brief yet" plus "Ask Uni to write it" (draft only; an area with no room says so instead).
5. **Ask Uni** on every Needs you / Moving / Suggested next item (and on Today's needs): drafts `@Uni <Area>: ... "<item>" (source: <paths>)` into the room composer via `appendDraft`/`composeInRoom`/`room.compose`; opens the phone sheet; never sends (tests assert zero `post_message`).
6. **Today.** Areas home is "Today": "Needs you today" (Today note, ranked; falls back to the briefs when the note is missing/empty), then foreground cards (Now line, "N need you", freshness), background areas in a collapsed `<details>`. Sealed apps are an **App tab** on areas that have one (Brief is default). Rail/tab label stays "Areas".

Ranking (`rankNeeds`): overdue, due today, within 3 days, within 7 days, then the rest; foreground area first inside a tier; writer's order last. Dates read as `YYYY-MM-DD` or `Oct 12`.

## Security behaviour (T-74..T-79) unchanged
Grant keys, sandbox, gate, self-test, focus-theft guard, suggestion store, stop/revoke, and `isTrusted` checks are untouched. Behaviour differences that follow from the tab model, with tests updated: the app note is found by `vault_note` on `Areas/<Name>/app` (then `.../app.html`) instead of the path listing and is only fetched when the gate is open; opening an area no longer starts its app; the trusted press on the App tab starts it (unless the user stopped/revoked it in that view, then "Open <name> app" stays). A restored tab still never starts an app by itself.

## Tests (red first)
- Unit `scripts/lifeos.test.ts` (15 checks: brief/Today parsing, ranking, fallback, freshness, Ask drafts, cache, `pickRoom`, wiring) was written and run red (module not found) before `briefCore.ts`/`areasCache.ts` existed; Rust `tag_query_is_one_bounded_request...` was written first but I did not run it red (the function did not compile yet), green now.
- Playwright `scripts/browser/lifeos.spec.ts` (22 tests x phone/desktop) was written after the UI code, **not run red**. Existing specs were changed where behaviour changed on purpose (new `openAreasHome`/`openAreaPage` helpers; Today heading; collapsed background; App tab; "Open note" removed; listing-cache test now asserts the home never lists the vault).
- Gates: `tsc --noEmit` ok; `npm test` exit 0 (0 FAIL); `cargo check` (src-tauri) ok; `cargo test -p uni-core --lib tag_query` ok. Playwright areas config (phone + desktop): see the last line of this section.

Playwright areas config, phone + desktop, final run: **235 passed, 7 skipped, 0 failed** (the 7 skips are pre-existing desktop-only/phone-only guards).

## Load timings
**On the Daylight: not measured.** The device was asleep behind the keyguard (I did not unlock it). With the page `hidden` CDP `Runtime.evaluate` works but `requestAnimationFrame`/`Page.captureScreenshot` do not run, and the app process was in Doze: its Rust resolver failed (`hub unreachable ... dns error`) on three attempts, while `adb shell ping uni-1.taildf9ce2.ts.net` resolved at 33 ms. So there are no real `vault_query` timings, no device cache-paint number and **no CDP screenshots of Today/Techne** (`~/.hermes/cache/scratch/t80/` holds only the scripts `cdp.mjs`, `time.mjs`). 0.1.31 installed, launched and its JS ran (`document.title` "Uni", `http://tauri.localhost/`).
To finish: unlock the Daylight, open Uni, then `adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>` and run `node t80/time.mjs <ws>` (times 3 runs of the three tag queries against the old `vault_paths`) and `node t80/cdp.mjs <ws> warm shots` (reload, open Areas, read `__areasTiming`, screenshot Today and Techne).

In Chromium (Playwright, fixture, not the device): with a seeded cache and a 300 ms network, `__areasTiming` = `{fromCache:true, cacheMs:6, freshMs:305}`; the cache test asserts the cached Now line is visible within 500 ms of tapping Areas while the network takes 1.8 s. Tag queries are 3 calls in parallel; the old path was 10 sequential `vault_paths` pages plus 6 `vault_note`.

## Not verified / limits
- Real Brief/Today notes: not available to me (the writer repo `~/Code/area-briefs` had no output; vault mirror had no `Areas/*/Brief`). Parsing is built against the design note and the writer's prompt; fixtures mimic that. Check once real notes exist, especially the `**Area**` prefix on Today's needs and `[[Path|Title]]` links.
- Real `vault_note` by path `Areas/<Name>/app` against the live hub is unverified (fixture and old code used ids). I added an `app.html` fallback. If real html notes only resolve by id, the App tab will be missing on the device.
- `vault_query` against the live hub (tag inheritance, `include_metadata`) unverified; only the argument shape is unit-tested.
- Phone sheet: when Ask Uni lands while the room is still opening, the sheet will not pop open (the draft still goes to the room).
- Today's Ask Uni opens the area's room in a new tab with the draft (existing `composeInRoom`), not an inline composer.
- `src-tauri/gen/schemas/*` were touched by the build and reverted, not committed.
