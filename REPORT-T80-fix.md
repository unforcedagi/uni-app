# T-80 review fixes

Implemented on top of T-80b on `feat/life-os`; the Uni home, area/project tree, room routing, and draft-only Refresh behavior are preserved.

## Changes

- The existing v2 device cache now requires an owner stamp containing the identity public key and vault. Reads reject a different identity, a different vault, an empty identity, or an ownerless cache. The in-memory snapshot is scoped to the same owner.
- Forget device key clears v1 and v2 cache keys, the in-memory payload, saved timestamp, owner, and refresh debounce timestamp. A generation guard and unmount guard discard late network answers. Areas mount with the current identity in their React key.
- Today, area, and project pages (including their App tabs) display a quiet saved-copy status while refreshing or after failure. Failed refreshes include the error and the original saved time when available. Optional query failures preserve previous values, mark the result stale, and do not write or re-stamp the device cache. An area-query failure also labels the retained snapshot stale.
- Queries remain four bounded tag queries. Any result reaching the 200-note limit displays a visible “showing first 200 notes; more may exist” notice naming the affected tags. This notice is retained in the cache. Pagination was deliberately not added; the task permits a visible limit notice.
- Path-owned Brief notes take priority over metadata-only fallback notes, regardless of the fallback note's newer timestamp. Newest still decides between notes of equal ownership priority.

## Red evidence

The tests were added before implementation and executed against the original code:

- Unit cache-owner mismatch and forget-wiring tests failed (`/tmp/t80-unit-red.log`).
- Browser cache-refresh status, area failure on an area page, optional briefs/Today failure status, and the 200-note notice failed (`/tmp/t80-red.log`, five failures).
- A stronger cross-account test with the area query failing showed account A's saved content under account B. The brief precedence test received `STRAY BRIEF` instead of the real path-owned brief (`/tmp/t80-red2.log`, two failures).
- The end-to-end forget/re-pair test failed because v1/v2 cache keys remained after forgetting (`/tmp/t80-forget-red.log`). The fixed test continues through mocked pairing as B, with B offline, and checks that no A area or Today need paints from memory.

## Validation

- `npx tsc --noEmit`: passed, including a final run after implementation changes.
- `npm test`: passed; the strengthened ownerless/legacy cache assertions also passed in a subsequent targeted unit run.
- `PATH=$HOME/.cargo/bin:$PATH cargo test -p uni-core`: passed (81 unit tests, 1 integration test, 22 voice-outbox integration tests; no doc tests).
- Full `playwright.areas.config.ts` suites: passed — 259 passed, 7 existing platform-specific skips, 0 failures (6.2 minutes), across areas, interface, areaRoom, and lifeos on phone and desktop.

The browser configuration is imported unchanged through a temporary wrapper that changes only the server/base URL from port 1435 to 1436, because a separate review was using 1435. It retains all four suites and both phone/desktop projects. The wrapper was removed before commit.

Not run: real-device Android/WebView validation, production vault/network tests, or deployment. Browser identity/pairing and vault responses are mocked. No push is requested or performed; generated Tauri schemas are excluded from the commit.

## T-80 re-review (review2)

- Removed metadata ownership entirely. Briefs match only `<node path>/Brief` (with the existing `.md` normalization); Today continues to match only `Areas/Today`. Added a unit test that loads a real Techne node with only a stray metadata-tagged Brief and verifies that Techne has no Brief, and that a metadata-only Today is ignored.
- Preserved freshness across background refreshes and in-memory remounts. Device-cache snapshots and failed refreshes remain stale; starting a refresh does not turn a fresh snapshot into a saved copy.
- Added a deferred browser test that calls the real `forgetAreas()` while all four queries are pending, keeps the hook mounted, then verifies that the late answers neither render Techne nor repopulate device storage. The existing generation guard already passed this test. The callable seam is compiled only into the browser test build.
- Exposed the hook's unresolved identity state and displayed neutral “Signing in…” text on Uni and missing-node pages. The browser fixture delays both `get_identity` and the initial `refresh` identity response to exercise this state.

Test-first evidence: the new payload unit test failed on the metadata-only Techne Brief before the fix. The browser tests failed on fresh data showing a saved-copy label and on missing “Signing in…” text before the fixes; the race test passed against the existing guard. Logs: `/tmp/t80-review2-red.log` and `/tmp/t80-review2-green.log`. The first green attempt also exposed the fixture's second identity response; the fixture was corrected before the full suite.

Validation: `npx tsc --noEmit` and `npm test` passed. The strengthened payload unit test also passed independently. Full browser results are recorded below. No Docker commands, unrelated process termination, deployment, or push were performed.

- `AREAS_TEST_PORT=1447 npx playwright test --config playwright.areas.config.ts`: passed all four suites on phone and desktop — **279 passed, 7 existing skips, 0 failures** (4.2 minutes). All three new browser regressions passed on both projects. Full log: `/tmp/t80-review2-browser.log`.
