# T-75 report: an area includes its room

Branch `feat/area-room` off `7e332ba` (T-74c). Not pushed. Reference: `docs/interfaces.md`, section "The area includes its room".
Tests first: `scripts/areaRoom.test.ts` was written and ran red (16 of 16 failing) before any code.

## What was built
- **Area view = interface + the app's real room view.** The room's message list and composer were lifted out of `App.tsx` into `roomPane(room, above)`, and both the room tab and the area use it: same send path, same drafts, same signer. The area tab now carries `channel`; `AreasSurface` tells `App` the area's room (`onRoom`), and `App` loads that room as it does for a room tab.
- **Desktop (>= 900 px):** side by side with a draggable, keyboard-operable divider (`role=separator`), width persisted (`uni.area.chatWidth.v1`), clamped to 60% / a usable minimum. The frame ignores the pointer while dragging.
- **Phone:** the interface is full screen; chat is a pull-up sheet (`AreaChat.tsx`): peek bar with the last message and an unread count, tap or drag, composer reachable when open, inert and hidden when down.
- **Manifest hint** `interface.layout.chat: side|sheet|hidden`, parsed in `manifest.ts`; unknown values, wrong types and `__proto__` tricks give the default; it is not a need and does not change the grant key.
- **Live push:** `chatPush.ts` (`pushChatMessage`): needs `chat.read` for that room, cleans with `stripHidden`, same 4000/80 caps, costs a request-bucket token (`session.push`), nothing when closed. History present when the area opened is not pushed (`createSeen`, also ignores older pages loaded later). Kit: `uni.chat.onMessage(cb)` returns an unsubscribe; a throwing callback does not stop the others.
- **Suggestion bar** sits directly above the chat composer (slot `above`); *Add to draft* fills that composer (focus, appended after an existing draft). With `hidden` the bar stays above the interface and Add to draft opens the room as before. A suggestion opens a lowered sheet.
- **Zoom:** "Open #room" in the area bar; no room -> "This area has no room yet".
- **Seed apps:** Techne has a "Latest from #techne" card plus a live pulse, layout `side`; Unforced has a live feed and counters, layout `sheet`. Their manifests are in `areas-seed/manifests.json` (publish them as the app note's metadata); the test fixture reads the same file.

## Decisions worth knowing
- `navigate()` no longer overwrites the stored draft when it re-enters the scope that is already open (a second tab on one room). Without that, "Add to draft" with a hidden chat lost its text.
- The area bar's old "Open room" button moved to the bar as "Open #room"; the default area view drops its "Recent in room" block when a chat pane is shown (the chat is the recent messages).
- The room's placeholder still reads "Message Uni…" (existing text in the shared composer).
- `.area-view` and the split use `overflow: clip`: the message list calls `scrollIntoView` also while the sheet is down, and an `overflow: hidden` box scrolled the whole view away (found in a screenshot).
- Touched outside the area code: `src/interface/{frame.tsx (onSession), session.ts (push), manifest.ts, modules/chatPush.ts (new), kits/frameKit.ts}`, `src/tabs.ts` (channel on area tabs), `App.tsx` (pane extraction, area room sync, rail `aria-current`).

## Tests and gates
| Gate | Result |
|---|---|
| `tsc --noEmit` | clean |
| `npm test` | all ok; new `areaRoom: ok` |
| `vite build` | OK |
| Playwright Chromium `playwright.areas.config.ts` (phone + desktop) | 150 passed, 4 skipped (phone-only / desktop-only specs) |
| Playwright WebKit docker `playwright.interface-webkit.config.ts` (desktop) | 74 passed, 3 skipped (phone-only) |
| default / rail / screens / sidebar configs | 88 passed 2 skipped / 15 / 7 / 14 passed |
| `cargo check` (src-tauri, Linux) | passes |

New e2e (`scripts/browser/areaRoom.spec.ts`): side by side + divider drag, keyboard and persistence; phone sheet peek, unread, expand, drag; hint wins (sheet on desktop, hidden, unknown); no-room text; send through the area composer; zoom keeps the draft; restore after reload; live card update; Unforced feed; other room not pushed; no `chat.read` no push; cleaning; burst bounded to 60; suggestion above composer; hidden layout fallback. Existing specs changed where behaviour changed by design: a suggestion no longer opens a room tab, the default view's recent block moved into the chat, and on a phone a suggestion raises the sheet (tests lower it before touching the interface: `lowerSheet`).

Screenshots: `shots/t75/` (phone + desktop, light + dark: techne, unforced, default, sheet peek/open, suggestion, live, divider). Looked at them; the first phone shots showed the sheet scrolled away, which led to the `overflow: clip` fix.

## Not done / caveats
- WebKit run is desktop only (the config has one desktop project); the phone sheet is verified on Chromium mobile emulation, not on a device or WebKit mobile.
- Drag uses pointer events; touch drag was exercised via mouse events in emulation only.
- Messages edited or deleted after arrival are not re-pushed; only new refs are.
- Needs an independent SHIP/NO-SHIP review.

---

# Round 2 (T-75b): review fixes and rebase

Review: `~/.hermes/cache/scratch/t75-review/REVIEW.md` (NO-SHIP on P1-1). Branch `feat/area-room`, rebased onto `feat/interface-contract` 5dddb18 (T-74 rounds 4-6: approved-code mode, honest prompt/chip, `grantedUnder`). Not pushed.

## Rebase
Conflicts in `AreaView.tsx`, `AreasSurface.tsx`, `areasFixture.ts`; both behaviours kept. `AreaView` takes `mode` (the gate mode) and `room`; the chat layout is a separate `layout` value. The Approved-code chip, the run-notice (`decision === "run-notice"`) and the approved-code GrantPrompt are intact, and now sit inside the chat layout. Gates were green on the rebased commit before the fixes began.

## P1-1 focus theft: what the review proposed does not work, and what does
The review's fix 1 (`inert` on the frame) **does not stop a frame from focusing itself**. I measured it (Chromium, sandboxed srcdoc frame, a 5 ms thief calling `input.focus()` and `window.focus()` against a host textarea, 26 keys typed):

| Host measure | Keys that reached the textarea |
|---|---|
| none / `inert` on the iframe / `visibility:hidden` / `content-visibility:hidden` / `allow="focus-without-user-activation 'none'"` | 0 of 26 (thief heard all 26) |
| `display:none` | 26 of 26 against `input.focus()`, but 0 against `window.focus()` |

So no parent-side switch prevents `window.focus()` from a child frame; I found no way to guarantee zero keys to a determined frame on the web platform. Taking focus back from a blur handler is also racy: with a 20 ms thief the composer lost roughly 1 key in 10 and the frame heard them.

What is built (`ChatLayout` in `AreaView.tsx`):
- While focus is in the chat composer (side pane, or the sheet body), the frame is `inert` and a transparent `.area-catcher` sits over the interface. A press on it drops the guard (`flushSync`) and focuses the frame, so the app receives keys again. The first press on the app after typing in the chat is spent on this hand-over, by design. The same applies to the phone sheet; with the sheet lowered the guard is off (the composer is inert and hidden).
- When the frame takes the keyboard (window `blur`), the host retakes it in the same task (`window.focus(); composer.focus()`), and again on the next tick.
- If the frame does that **a second time** while the user is typing, the app is **stopped** (same as Stop app) and the default view says: "This app kept taking the keyboard from the chat while you typed, so it was stopped." Open app starts it again.

Residual, said plainly: keys typed in the few milliseconds around the first theft can still reach the frame, because the browser routes keys before the host can reclaim focus. A person needs longer than that to press a first key after clicking the composer, and the app is stopped before they do. A frame that steals once and then stops, or at most once per time the composer is focused, is not stopped. This is mitigation, not a guarantee. The hard guarantee would need the composer outside the webview that hosts the frame.

e2e (red first, `areaRoom.spec.ts` "focus stays in the chat"; phone and desktop):
1. A thief app (focus loop every 5 ms; it reports every key it hears through the host as a vault search): composer holds the full string, the host saw no key from the app, the frame is gone and the notice shows.
2. A polite app logging keys: composer holds the full string, frame log empty; press on the app, type, the frame logs it, and the composer keeps its text.
Red state observed before the fix: composer held `"m"`, the frame heard the rest.

## P2-1 suggestions with no room
`aboveMain={chatShown && room ? null : above}`: the bar sits above the interface whenever there is no room or the room is still opening. e2e: an area with no channel and an app calling `uni.note.open` shows one visible suggestion. (Fixture: `apps[].channel`, `''` = no room.)

## P3
- **P3-1:** `createSeen` no longer has a timestamp floor. It judges by position: anything listed before the first message recorded at baseline is an older page. New messages are ordered by `ts` only for output order. Unit tests for both review cases (clock behind; far-future ts) plus the empty-room first message.
- **P3-4:** `chat.recent` uses `stripHidden` on content and author with the same caps as `pushChatMessage`. Unit test.
- **P3-3:** at <=400 px the area bar is one row (Back, `Open #room`, a menu button "App controls" with Stop app / Revoke access, status mark hidden). e2e at 360 px: bar height <= 60 px, no overflow, Stop works from the menu. `interface.spec.ts` opens the menu when it is visible before clicking Stop/Revoke.
- **P3-5:** on desktop (side layout) the frame is labelled "App" and the chat pane "Chat, drawn by Uni". e2e.
- **P3-2** (a push can land before the frame's kit listens): left as is. Small and self-correcting, as the review says.

## Gates
| Gate | Result |
|---|---|
| `tsc --noEmit` | clean |
| `npm test` | all ok, including `areaRoom: ok` (new: position-based seen, chat.recent cleaning) |
| Playwright Chromium `playwright.areas.config.ts` (phone + desktop) | 190 passed, 6 skipped, 0 failed |
| Playwright WebKit docker `playwright.interface-webkit.config.ts` (desktop) | 94 passed, 4 skipped, 0 failed |

Notes: the worktree's `node_modules` is a symlink, so the docker run mounts it at `/uni-app-areas/node_modules`. The two Playwright configs both build into `dist`, so they must not run at the same time (a concurrent run gave spurious WebKit failures; discarded). The new focus e2e were repeated 4x per project without a flake.

Needs another independent SHIP/NO-SHIP review, in particular of the P1-1 trade-off above.
