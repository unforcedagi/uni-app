# T-80b follow-up

- Archived/done areas and projects are excluded from the visible tree; dormant and other non-foreground nodes use the collapsed Background group. Cached metadata follows the same visibility rule.
- Android Back and the page Back share the parent-navigation callback, including project → area → Uni.
- The landing tab mounts immediately, allowing the owner-scoped device cache to paint while room and tag queries are pending. Room loading attaches the Uni chat afterward; Journal preferences and saved tabs remain supported.
- Lean project queries use metadata.summary for card/page purpose. Opening a project lazily reads its Markdown body, cached by identity, note ID, and revision; Forget clears that cache. Loading and read failures are visible.
- The existing project-query fallback retains previous projects and marks the snapshot as “couldn't refresh”; regression tests now cover this.
- Uni home has the quiet routing line beneath the room layout.

Validation: parser regressions were demonstrated red before implementation and then green. `npx tsc --noEmit` and `npm test` passed. The life-OS Playwright tests passed (77 passed, 1 viewport-specific skip). `AREAS_TEST_PORT=1447 npx playwright test --config playwright.areas.config.ts --workers=4` passed: 273 passed, 7 viewport-specific skips. Port 1435 was occupied. An earlier full run overlapped a bundle rebuild and had a boot timeout; it was interrupted and superseded by the clean final run.

No Docker changes, no unrelated processes stopped, and no push.
