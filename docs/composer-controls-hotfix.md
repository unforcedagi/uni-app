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

**Confirmed desktop edge-press cause:** global `button:active` scales to `.97` over `.2s`. On a
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
sending disable it; the current recording's Stop button stays enabled. The initial hotfix preserved Send's existing
render condition, disabled rules, and handler; the review correction below guards
the handler and disables Send throughout every non-idle recorder phase.

**Current device boundary:** Aaron's reported `+` failure is on the active MacBook, which we no longer access per his direction. A separate Mac mini WebKit browser run now reproduces the same two dead menu actions against the full published-source App; see the WebKit section below. This proves a WebKit failure mechanism and a regression fix in an isolated test environment, **not** behavior of the installed app on Aaron's MacBook. Chromium center taps passed before this WebKit fix, so its green results alone were insufficient.

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

## Physical devices and design note (historical initial investigation)

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

## Initial hotfix validation results (before independent review)

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


## Independent review correction at bc7c315

The independent read-only review returned **NO-SHIP**. With mic now beside Send,
textarea Enter still invoked `send()` without a recorder guard. It could post the
text before recording audio was available. The disabled Send button did not protect
the keyboard path, and its recording-only condition omitted starting/finishing.

The correction checks the synchronous `recordingOrigin` ref and live
`RecorderSession.phase` through `isBusy()` inside `send()`. It blocks every non-idle
phase across rooms, including startup before React commits. Send's disabled state
now follows recorder busy state. A synchronous sending ref prevents same-turn
repeated submissions and mic startup during an in-flight send. The ref is released
in `finally`. No recorder session, media, MDX, or voice architecture was changed.

Neighboring scope review also found completion using a captured `scope()`/`draft`
fallback that always matched the original send, potentially clearing a newer stored
draft or the same text in another room. Completion now checks the current draft
store and active-scope ref; stale-scope sends are rejected at entry.

New browser regressions use the full production App and actual textarea Enter.
They hold the native microphone request and native onstop callback to exercise
starting, recording, and finishing deterministically. A synthetic textarea keydown
inside the microphone request separately exercises the synchronous startup boundary;
two same-turn keydowns exercise the send lock before rerender. Native audio capture
still uses Chromium's fake media device. The tests assert zero `post_message` calls
through all recorder phases and idle completion, then exactly one explicit Enter or
Send-button submission containing the draft and audio attachment. Additional cases
cover edits during send and switching rooms during recording/send completion.
All IPC remains stubbed; no messages are posted to a relay.

At the time of this correction, Pixel QA was blocked pending unlock and Mac QA
was blocked pending access. The prior device-access evidence above was not rerun
for this correction. The later Pixel candidate 0.1.23 physical test does not
establish a Mac root cause; Mac native picker/menu reproduction remains inaccessible.
The desktop CSS edge fix is **not** a resolution of the reported physical-device
symptoms: baseline center/mobile taps already passed. No speculative pointerdown
or blur workaround was added. No push, release, install, vault edit, or secret
access was performed for this correction.

Correction validation:

- `pnpm test:composer`: **28 passed, 0 failed** (22.1 s), including all original
  20 cases plus 8 new cases across mobile and desktop Chromium.
- `pnpm typecheck`: passed (exit 0).
- `pnpm test`: all 17 test scripts passed (exit 0), including recorder, tabs,
  media, and journal tests.
- Production Vite build in the browser harness: passed; existing large-chunk warning.
- `git diff --check`: passed.

The earlier Rust/build/device results are historical initial-hotfix evidence, not
new verification of this correction. Mac native picker/menu proof remains unavailable.


## P2 re-review correction at 6b224eb

Send completion compared the stored text with the submitted string. Deleting and
retyping that same string during a held send therefore erased a new draft. Each
room/thread now has an edit revision, captured when sending and compared on
completion. Only the untouched revision is cleared, together with its bindings.
Navigation saves/restores drafts without advancing revisions, so visiting another
room does not prevent an untouched submitted draft from clearing.

All draft setters were reviewed: textarea changes, Mention insertion/selection,
Ask Uni replacement, and the existing asynchronous transcript draft insertion use
the revision helper. The latter is only draft bookkeeping; recording, transcription,
and media behavior are unchanged. Ask Uni also stores its replacement bindings
synchronously. Successful clearing resets the active binding ref as well as state.
No sidebar, MDX, media, or voice behavior changes were made.

Before the fix, the targeted production-App suite had **4 passes and 4 failures**:
identical replacement in the active room and identical replacement restored after
room navigation failed on both desktop and mobile Chromium. Different replacement
and untouched-draft navigation cases passed. The tests hold mocked `post_message`,
exercise same-turn duplicate Enter, replace text and picked mentions, restore
room drafts, verify settled mention bindings and recipients, and explicitly send
the surviving draft. No live `post_message` occurs.

Mac remains the reported failing device and is inaccessible for native picker/menu
reproduction. Pixel candidate 0.1.23 was physically tested, as recorded in the task
handoff; it is not evidence of Mac root cause. No device access was retried for this
P2 correction, and no push, release, or install was performed.

P2 validation:

- `pnpm test:composer`: **34 passed, 0 failed** (30.0 s).
- `pnpm typecheck`: passed.
- `pnpm test`: all 17 test scripts passed.
- Production Vite build in the browser harness: passed; existing large-chunk warning.
- `git diff --check`: passed.

## WebKit menu root cause and isolated regression (2026-10-01)

After Aaron stopped active-Mac access, we first reran the Linux Chromium suite (34/34); it still could not reproduce centered menu clicks. Linux Playwright WebKit downloaded but could not launch with this host's ICU/libxml/flite versions. We then used the **retired Mac mini only as an isolated WebKit test runner**, copying a clean archive of candidate `6b224eb` into `~/uni-qa/composer-candidate`; it was not a source of app data or a change to Aaron's active Mac.

Playwright WebKit 26.6 on macOS 26.3, running the full production App/CSS with only Tauri IPC stubbed, failed both center actions **before** the new fix: Mention left the draft `hello ` instead of `hello @`; Attach emitted no native `filechooser`. The captured sequence was `pointerdown`/`mousedown` on the intended menu button, then `focusout` on the focused menu item with **`relatedTarget=null`**, then `pointerup`/`mouseup` on the underlying DIV/FOOTER and **no button click**. React's container `onBlur` interpreted the null related target as focus leaving and unmounted the menu on mousedown. This is distinct from the Chromium edge-hit CSS regression. The same initial WebKit run also had recorder failures because the WebKit harness lacks Chromium's fake microphone device; those do not implicate the menu fix.

A single scoped change, `onMouseDown={(e) => e.preventDefault()}` on the menu container, prevents that default WebKit blur until the button click. The existing document `pointerdown` outside dismiss, Escape handler, and keyboard focus behavior remain. The same two center tests turned green, and the final tracked `playwright.webkit.config.ts` menu-only suite passed **7/7** on the isolated mini (Mention, Attach native chooser/cancel/selection, keyboard, and held edge presses). On uni-1, `pnpm test:composer` passed **34/34**, `pnpm typecheck` and all 17 unit scripts passed. No message was sent, no active Mac access or app replacement occurred. This is WebKit engine regression proof, not an installed-app MacBook claim; release requires independent review and normal publication verification.

## Linux-only reproduction (2026-10-01)
`macOS button-focus model` tests in `composer.spec.ts` emulate the macOS WebKit rule that buttons are not mouse-focusable (an un-prevented button mousedown blurs the focused element with `relatedTarget=null`). In the Playwright 1.63 Docker image on uni-1: candidate `6b224eb` **4 failed / 4** (centered Mention left `hello `, centered Attach opened no chooser, desktop and mobile); with the `cf134de` menu fix **4/4 passed**, full suite **38/38**, typecheck and unit scripts green. No Mac was used. Native WKWebView picker behavior on Aaron's MacBook remains unobserved.
