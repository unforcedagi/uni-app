# Composer controls hotfix — 2026-10-01

Scope: `fix/composer-controls`, baseline `3dd878a95dd2fb472d6f4351446d15f64cad95a1`.
No media/MDX implementation, identity, live messaging, publishing, or walk-and-talk changes.

## Reproduction and causal evidence

The Playwright harness loads the **full App and production CSS**, without extracting or
reimplementing ComposerMenu. Only Tauri IPC is stubbed. Chromium uses 390×844 with
`hasTouch`/`isMobile`, and 1280×900 desktop. Actions use touchscreen taps, CDP
`Input.dispatchTouchEvent` down/up, mouse down/up, or keyboard input. No menu action
is invoked by JavaScript `.click()`. File input activation remains the production code.

Before production edits, the completed baseline suite had **12 passes / 4 failures**:

- Both viewport projects failed mic coexistence after entering text.
- Desktop edge presses failed Mention and Attach (1 px inside the left edge,
  halfway down the item, hold 250 ms).
- Center taps/clicks, mobile edge touches, and keyboard actions passed.
- Both projects emitted two native `filechooser` events for center Attach activation;
  selection populated pending attachments, and an empty selection preserved the draft.

`composer-hotfix-evidence/baseline.json` contains the actual captured baseline event
orders and state for all 16 cases, including the one-variable probe. Earlier harness
setup failures (missing Chromium, incomplete Tauri metadata, a second CDP session
not receiving Playwright's intercepted chooser event) are excluded from these counts.
The corrected chooser assertion uses Playwright's native `filechooser` event.

**Confirmed menu cause:** global `button:active` scales to `.97` over `.2s`. On a
mouse edge press the item shrinks away from the pointer. Event order is:

1. Initial `elementFromPoint` = intended menu button.
2. `pointerdown` and `mousedown` = intended button.
3. At 250 ms, `elementFromPoint` = menu DIV; menu remains mounted, activation true.
4. `pointerup`, `mouseup`, and `click` = menu DIV.
5. Draft unchanged, picker absent, menu still open; Attach emits no chooser event.

Changing **only** `.compose-menu button:active:not(:disabled) { transform: none; }`
in the browser makes both failing desktop cases pass. This distinguishes hit-testing
from blur/unmount (menu stayed mounted, no intervening focusout) and activation loss
(activation remained true; the button never received click). No overlay was involved.
The same scoped rule is the production fix. Focus, synchronous attach activation,
and keyboard handling remain intact.

**Confirmed mic cause:** the render conditional chose Send *instead of* mic whenever
text or a pending attachment existed. Mic now renders directly before Send regardless
of draft/attachments. Starting/finishing recording, recording in another scope, and
sending disable it; the current recording's Stop button stays enabled. Send's existing
render condition, disabled rules, and handler are preserved.

**Limit:** the reported Pixel menu failure itself was not reproduced. Chromium center
and mobile edge taps passed even before the fix. The desktop hit-testing failure is
proven; it must not be presented as proof of the Pixel's cause or its resolution.
No speculative blur or user-activation workaround was added.

## Regression suite

Run `pnpm exec playwright install chromium` once, then `pnpm test:composer`.
The test runner builds the app and starts its own local Vite preview server. `test-results/` contains per-test
`event-order.json` and failure traces; generated artifacts are ignored by Git.

Coverage includes native chooser events, activation at the real file input click,
selection/cancellation, Mention caret/focus/picker, keyboard navigation/Escape,
center and edge pointer/touch input, text and attachment mic/Send coexistence,
record/stop with both text and attachment, and Send payload/busy/completion behavior.
The baseline interaction suite ran against Vite dev before production edits.
The final suite uses the production bundle: development React StrictMode's effect
replay disposes the existing RecorderSession permanently, so dev-mode recording
checks cannot exercise shipped recorder behavior. That pre-existing development-only
recorder lifecycle issue is outside this hotfix.
Recording tests use Chromium's fake media device; they do not use a physical mic.
IPC stubs intercept every call, including post_message; no live messages are sent.

## Physical devices and design note

Commands actually run:

```
adb devices -l
adb -s adb-29231FDH200F2L-c5p2OU._adb-tls-connect._tcp shell dumpsys window
adb -s adb-29231FDH200F2L-c5p2OU._adb-tls-connect._tcp shell dumpsys trust
ssh -o BatchMode=yes -o ConnectTimeout=5 unforced@100.75.49.42 true
```

Pixel 7 is connected, but `mCurrentFocus=NotificationShade`,
`mDreamingLockscreen=true`, and `deviceLocked=1`/`trustState=UNTRUSTED`.
A separate-package harness cannot provide the requested normal touch/picker activity
proof while the device is locked without user unlock or bypassing keyguard. No APK
was installed, overwritten, or removed; no unlock/bypass was attempted. Android
physical-device verification is **blocked/unverified**, not browser device proof.

Mac SSH returned `Permission denied (publickey,password,keyboard-interactive)`.
No credentials were changed or borrowed. macOS verification is **unverified**.

Reading `uni:Projects/uni-app/Composer controls hotfix 2026-10-01` through Parachute
returned `UNAUTHORIZED: This app connection requires reauthentication`.
The repository task and `docs/release.md` were read; the external design note remains
unread because of that connection blocker.

## Validation results

- Before production edits: **12 passed, 4 failed** (16 Chromium cases).
- After the scoped fix: **16 passed, 0 failed** on the same interaction suite.
- Final production-bundle suite, including recording and Send: **20 passed, 0 failed**.
- `pnpm typecheck`: passed.
- `pnpm test`: all 17 test scripts passed.
- `pnpm build:vite`: passed (existing large-chunk warning).
- `cargo test -q -p uni-core`: 79 unit + 1 integration + 22 additional tests passed;
  zero failures (102 total).
- `cargo check -q -p uni-app-tauri`: passed (exit 0).
- `python3 scripts/check-case-collisions.py`: `Case-insensitive paths: OK`.
- `git diff --check`: passed.

`composer-hotfix-evidence/green.json` preserves final native chooser and desktop
edge-press event evidence. Full event logs are regenerated by `pnpm test:composer`.
