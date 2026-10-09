# T-80b report: the app opens to Uni; areas are a tree

Worker: Sonnet 5.5, 2026-10-09. Branch `feat/life-os`, committed (f2af16e + a follow-up), not pushed.

## What was built
- **Home = Uni.** The app opens to Uni's page: `Needs you`, then `Moved` (from `Areas/Today`), the Uni chat attached as the room (id `1b667c1f-...`, falling back to the room named Uni), then area cards. It is the same `AreaView`/`BriefView` component as an area page, applied to a synthetic root node (`rootNode`, path ""). `TodayView.tsx` now only exports the Today sections and the card grid.
- **Tree** (`src/areas/treeCore.ts`, pure). Nodes are the root, area notes, and project notes (tag `project`, `metadata.parent`). Parents are validated: a missing parent or self-parent means top level; cycles are broken at the smallest path. Children sort foreground first. Rooms: `rooms` = `channels` minus rooms a child claims (view only; the note and the app grant keys still use `channels`). Breadcrumb `Uni › Techne › COhere 2026`, Back goes to the parent.
- **Load.** Four parallel tag queries (`area`, `project` without content, `area-brief`, `area-today`); briefs keyed by node path (`<path>/Brief`). Cached on the device (`uni.areas.cache.v2`). No per-node fetch (only the background sealed-app lookup by path).
- **Freshness / Refresh.** "updated 3h ago" from `generated_at` (Uni: Today's). `Refresh` puts `@Uni Please refresh <name>'s brief (<path>/Brief)...` into that node's room composer (Uni: Areas/Today). Draft only; tests assert zero `post_message`.
- **Navigation.** Rail "Uni" opens the home (the separate "Areas" rail button is removed; the full Uni room is still under Rooms). The tab is titled Uni; Uni and project tabs keep their room (`tabs.ts` now accepts a channel on the Uni tab and deeper area paths). First launch with no Uni room opens the first room as before. On short landscape screens, where the rail is hidden, the Uni page has a "Rooms" button.
- Kept: cache-first load, room switchers, Ask Uni drafts, App tab, approved-code gate (no change to `interface/`).
- **Vault:** created `Projects/COhere/COhere 2026` (id 01M4H9J44X55YHNES7FNW8MPYT), tag `project`, `parent: Areas/Techne`, `channel: 98197466-...`. It did not exist. Techne's own note is untouched; #cohere is hidden from Techne only in the app's view.

## Tests
- Unit (`scripts/lifeos.test.ts`, 8 new): parent parsing, project parsing, tree build, missing parent / self-parent, cycles (broken at smallest path, every node has exactly one parent), multiple rooms and claimed rooms, duplicate paths, root node, refresh drafts. `tabs.test.ts` gained the Uni-tab/project-path cases. `npm test`: 0 FAIL. `tsc --noEmit` clean. Written together with the code rather than red first.
- Playwright areas config (phone + desktop): last full run 247 passed / 2 failed / 7 skipped; the 2 (a `Back to` count on Uni home) were fixed by a CSS specificity change and the lifeos spec re-run passed 53/53 afterwards. Rail 15/15, screens 7/7, sidebar 14/14, default composer config 88/88 (after seeding a Uni-room tab in those fixtures, since the app now lands on Uni's home; rail count 6 -> 5; `lifeos.spec` added to the default config's ignore list, it belongs to the areas config). I did not re-run the full areas config after the final CSS fix, only lifeos.spec.
- Not run: `playwright.webkit`, `interface-webkit`, `cargo check` (no Rust changes).

## Device timings (Daylight, debug 0.1.32, versionCode 1001032)
Installed with `adb install -r` (firstInstallTime unchanged). The device was asleep behind the secure keyguard the whole time, so Aaron was not using it.
- Cold start (force-stop, launch, cache present): launch to DevTools socket 1.4 s; launch to Uni home cards in the DOM **3.3 s** (3 runs: 3.24, 3.37, 3.26).
- Warm reload (page reload in a running app): cards in the DOM after **1.1, 1.4, 1.7, 2.1, 2.9 s** (rising over the run; not understood).
- Fresh network data: **1.6-2.0 s** warm, **3.6 s** first request after clearing the cache (4 queries). The earlier target of <1.5 s is **not met**; the <100 ms cache paint is **not met either** end to end, because the page waits on room loading before it restores the tab and renders. The cache itself paints synchronously once the page mounts.
- To get DNS working the app was put on the doze whitelist temporarily (`cmd deviceidle whitelist +/-org.unforced.uni`); removed afterwards.

## Screenshots
**Not from the device.** Android's keyguard kept the WebView `visible:false`, so `Page.captureScreenshot` and `adb screencap` cannot show the app (I did not try to bypass the lock). `~/.hermes/cache/scratch/t80b/` (and `shots/t80b/`) hold Chromium screenshots of the same build against the fixture, phone 390x844 and desktop: `*-uni-home.png`, `*-techne.png` (COhere card under "Inside Techne"), `*-cohere.png` (project page with breadcrumb and its own room), `*-refresh-draft.png`. These are not the Daylight's e-ink rendering.

## Gaps
- **The device ran the first 0.1.32 build.** After the last commit (short-screen Rooms button, first-room fallback) I rebuilt the APK, but the Daylight dropped off wireless ADB before I could reinstall. The rebuilt APK is at `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk` (0.1.32 / 1001032). Timings above predate it; the diff does not touch loading.
- No device screenshots (see above); no real Brief/Today check on device. Whether `Areas/Today` and `Areas/*/Brief` exist in the live vault was not checked.
- The `project` tag has 69 notes in the live vault (~90 KB of metadata per load, none with a parent except the new one); the query is capped at 200, so past that a project could be dropped. A server-side `metadata.parent exists` filter would fix it but I could not verify the hub supports it.
- Project children appear as cards on their parent; a project with the same name as an area is distinguished only by path.
- Android system Back from an area goes to Uni home (not up one level).
- If Refresh/Ask Uni is tapped before the node's room has loaded, the draft falls back to opening that room in a new tab (existing behaviour).
- The Uni chat is a pull-up sheet on phones; the Uni page's "room" for the Daylight has not been looked at.
