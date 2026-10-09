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
