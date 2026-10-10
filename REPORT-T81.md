# T-81 — durable voice delivery when Buzz is unreachable

Failed voice notes remain in the composer as **Not sent — will retry**. They retry
on startup, `online`, and `visibilitychange` when visible, and after 15 seconds,
30 seconds, 1 minute, 2 minutes, then every 5 minutes while the app is open.
Manual Retry and Remove remain available. Each trigger uses the existing
`voiceJobs` guard and serialized delivery queue. Pending retry timers are cleared
when a job starts, a clip is removed/delivered, or the component unmounts.

The existing owner/relay-scoped IndexedDB outbox and idempotent delivery path are
preserved: retries reuse uploaded media and the signed event; confirmed delivery
removes the clip. Retry attempts are counted per clip for the current app session;
a restart attempts delivery immediately and begins a fresh backoff sequence.

`src/netError.ts` is the single pure connection-error mapper, including restored
errors. It maps the requested Rust request/DNS/connect/timeout/reset strings to:
“Can't reach Buzz. Is Tailscale on? Your voice note is saved and will send when
you're back online.” Other error text remains unchanged.

## Test-first evidence

Before implementation:

- `node --experimental-strip-types scripts/voiceRetry.test.ts` failed because the
  required helper modules did not exist (`ERR_MODULE_NOT_FOUND`).
- `npx playwright test --config playwright.config.ts scripts/browser/composer.spec.ts -g T81`
  failed on **both mobile and desktop**, expecting “Not sent — will retry” and
  receiving “Failed: Error: upload failed: error sending request: connect”.

The regression mock fails `media_upload` twice across a reload, then succeeds.
It checks the saved label and friendly error, restoration and automatic retry,
repeated `online` events, exactly one total `post_message`, and an empty tray.
An additional paused-clock browser test checks every backoff interval and repeated
foreground/online triggers. Existing tests still cover manual Retry, removal,
scoping, durable storage failures, and reuse of media/signed events.

## Validation

- `npx tsc --noEmit` — passed.
- `npm test` — passed, including the new backoff/error mapping unit tests.
- `npx playwright test --config playwright.config.ts scripts/browser/composer.spec.ts`
  — **82 passed, 2 intentionally skipped**, mobile and desktop.
- Focused regression checks using the default config with its already-running
  preview server — **8 passed** (both T-81 scenarios, restart signed-event reuse,
  and storage-failure/manual Retry).
- `git diff --check` — passed.

- `AREAS_TEST_PORT=54613 npx playwright test --config playwright.areas.config.ts`
  — **281 passed, 7 intentionally skipped** (clean run after composer). Early browser runs revealed
legacy label expectations and timing assumptions; those assertions now wait for
confirmed delivery and use a paused clock. Browser configs build into the same
`dist`, so the final Areas verification runs after composer to preserve its
`VITE_AREAS_TESTHOOKS` build.

No Docker operations or unrelated process termination. Existing
`src-tauri/gen/schemas` changes are excluded from the commit. No push.
