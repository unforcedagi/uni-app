# REPORT: Simple first, round 25 (T-124 r25): one action per task, summaries never contradict, an honest check-in, a fast cold start

Commits on `feat/simple`, none pushed (`fix/0146` was not merged by me; I did not touch `journal.rs`, `hub.rs` or `journalCore.ts`):
- `2a88583`: the three P1s, the Running and Ryan bugs, the sidebar bar, specs.
- `de2c1d4`: cold launch (Codex 8), startup marks, sync timings.
- `b7ea324`: vault browser failure (part of Codex 7).
- `47d0e39`: a "look at" step that starts with where or when keeps its link as the primary action.
- `33d914d`: a decision keeps its answers as the primary when the chat couldn't be read.

## P1s

| Item | What changed | Spec |
|---|---|---|
| **1. The row says `next`, never the title** | `currentStep()` is the one current step, and the row and the sheet heading both call it. A step that starts with where or when ("On your phone, look at cohereboulder.org, then forward Eileen the asks") now counts as an action. Before, it failed the verb check, so the row fell back to the cut title. The title is the quiet line under the row: whole words, at most 72 characters, never "…"; a title stored cut ("…flow (3…") loses its tail. A "look at" step led by where or when keeps its link as the primary action. | `simpleR25.test.ts` (T-113's shape, intro-phrase rule, status still no action, title forms). Browser: `r25 (Codex P2 5)` checks the row text, the quiet line, no "…", and that the sheet heading is not the title. |
| **2. An unreconcilable summary is not current** | `staleSummary()` replaces `nothingWaiting()`. When "Where this stands" says something waits on Aaron and no open Needs-you row matches it, the panel shows "This summary needs updating · from Oct 13". The stored words sit under a collapsed "What it said". A claim matches by the ids it names (#38, T-90), else by a shared distinctive word. With no open row it matches nothing. "No open request mentions this now" is gone. It applies in the side panel, the work view and the folded strip line. | Unit tests for both cases and the word rule. Browser: stale with no rows, stale beside an unrelated open row (never "No open request…"), current once a row naming #38 opens. |
| **3. Check in has three states** | `checkInResult()` gives found, failed or none. A lookup failure is never swallowed. *Found*: the cue and "Check in #room first" as the primary action. *Failed*: "Couldn't read #room · Retry". There is no cue and no Check in. "I did this" and "Say it" are secondary, and a task's primary becomes "Open #room". A decision keeps its answers as the primary. *None*: the ordinary actions. "Check in" opens the room at the matched message and shows a one-line banner over the composer, "Checking: <step>". The banner has an × and clears when the room is left. A test build flag, `VITE_CHECKIN_BLOCK=1`, makes the lookup fail (it is not in the normal build). | Unit tests for the three results and the banner text. Browser: `r25 (Codex P1 2)` runs fail → Retry → found → Check in → banner above the composer, one line, no "…" → none. |

## Bugs
- **Running rows:** `runText()` and `RunText` serve both the panel and the work view. A stored "…" or trailing colon is stripped. A run too long for two lines shows the words before its colon ("Waiting on your answer in #Uni"). The full text is the tooltip. Browser spec `r25 (Sonnet, Codex)` covers a bare colon, a stored "…", and a long run, in both views.
- **Ryan:** the row and the sheet heading read "Send Ryan the deploy-access message" (the "below" and the "(in the card)" are gone), with the message directly under the heading. The existing Ryan spec asserts both, plus that `.task-detail` is the heading's next sibling.
- **Sidebar:** the 3px `::before` bar on the active row is removed. The row keeps its card and now has a hairline.

## P2s
- **Codex 8, cold launch: done, measured.** Trace of the first cold launch, before the fix. The startup marks (`window.__uniStartup`) and `sync:` lines in `uni.log` come from this round's instrumentation. The Rust sync lines are from the app home's `uni.log`, on one real cold run:
  - identity: 172 ms.
  - Rooms discovered 26 ms into the sync (5 rooms) and written to the local store.
  - Room histories: 49 events at 76 ms, 1000 at 383 ms (the Uni room), 200 at 6.2 s (the relay is slow for that room), 29 at 7.4 s, 964 at 7.7 s.
  - Read state, archived identities and profiles took until 13.1 s.
  - The app waited for that whole sync before asking the local store for rooms, so rooms were known at 13.5 s, the composer at 13.5 s, and the first message at 14.2 s.

  The fix is in the front end: during a cold first sync (no rooms known), the app re-reads the local rooms and the open room's messages every 700 ms. The "No messages in this room yet" line is held back until that first sync ends. The cold-start numbers below show the result. With cached rooms (warm), the saved rooms, composer and messages already paint before identity (see the warm row).

  | Run (final binary) | shell | rooms | composer | first message |
  |---|---|---|---|---|
  | cold, before the fix (same code, no polling) | 157 ms | 13.5 s | 13.5 s | 14.2 s |
  | **`r25-worker-cold`** (empty home) | 142 ms | 1.20 s | 1.22 s | **1.33 s** |
  | `r25-worker` (warm, same home) | 144 ms | 0.15 s (saved) | 0.16 s | 0.27 s |
  | `r25-worker-load` (4 niced busy loops, warm home) | 157 ms | 0.16 s | 0.17 s | 0.28 s |

  I also ran one cold launch under the same busy loops on the previous build (`r25-worker-coldload`, home removed afterwards): first message 1.26 s.

  Not fixed: the sync still holds the IO gate for its 12 to 13 s, so a message sent in that window waits for the gate. The slow 200-event room at about 6 s is on the relay side. I did not reorder rooms or split the gate; that needs a Rust change to the sync.
- **Codex 7, setup and failure frame: partly done.** The Vault browser's failure is now a plain sentence, Retry, and the cause under Details, as Search and notes do. Not done: keeping the room navigation during vault setup, the pairing-from-Settings translation, the Journal and attachment utility reads.
- **Not done:** Codex 3 (one navigation model), Codex 4 (compact state is a strip), Codex 6 (Journal and area-app grammar), and the P3s.

## Suites
- `tsc --noEmit`: clean.
- `npm test`: pass (added `simpleR25.test.ts`; R20 and R24 expectations updated for the new title and "below" rules).
- `cargo test -p uni-core --offline`: 110 + 1 + 22 passed.
- Simple Playwright (3 projects, full run): **524 passed, 48 skipped, 1 failed**. The failure was `r20 › the narrow companion's sheet is a foreground surface` on `phone`. Rerun with `--repeat-each=5` it passed 5 of 5. Flaky once in 6 runs (the full run plus the 5 repeats); I did not find the cause.
- Playwright rewrote 20 tracked `__shots__` PNGs; I did not commit them.
- `scripts/approvals.test.ts` and `src/approvals.ts` were untracked WIP before I started. I left them alone and did not commit them.

## What the real app showed
Debug build with `--features custom-protocol` (`~/.hermes/cache/scratch/r25/build.sh`) on the scratch hub, final binary, one app home `r25w`. Runs and shots are in `~/Code/uni-sketches/t124/walk/runs/r25-worker-*` (`-cold`, none, `-load`, `-extra`, `-800x600`, `-740x360`, `-920x360`, and `-block-<size>` for the "couldn't check" build). I used `driver-r12.js` for the three launch walks and `driver-r25-extra.js` and `driver-r25-narrow.js` for the rest. The `walk-log.json` files hold the numbers.
- **T-113 row** (all sizes): "On your phone, look at cohereboulder.org (live now), then forward Eileen the asks listed in this task's detail". The quiet line under it is "Companion Today redesign + integrated PWA install flow · was due Oct 13 · added Oct 11", with no "…". The stored `next` has grown since the brief and now has "(live now)" in it.
- **T-113 sheet:** "2 steps": step 1 with an "Open cohereboulder.org" button, step 2 "Forward Eileen the asks listed in this task's detail". The button is the primary action on the final build; on the first build it was "I did this", which I fixed (`47d0e39`).
- **COhere summary** (all sizes): "This summary needs updating · from Oct 13", with a collapsed "What it said". Uni's own summary is not flagged.
- **Cued sheet:** "Approve or change the unforced.dev mail cutover plan": "#Uni has talked about unforced cutover since this was added", "Check in #Uni first" primary, "I did this" secondary.
- **Couldn't check:** the blocked build shows "Couldn't read #Uni · Retry" at 800×600 and 740×360 (920×360 shot taken, not inspected). It appears on the first sheet that has the room's lookup, which is a decision ("Ship the Boulder Votes AI chat?"). Its answers stay the primary and there is no cue. That shot is from the first walk (a build before the final decision-answers fix); the final-build shots are in the `-block-*` runs. The non-decision case ("Open #room" primary, "I did this" secondary) is covered only by Playwright, not by a real-app shot.
- **Running:** panel and work view show "Waiting on your answer in #Uni" without the colon, no "…", at all sizes (`z1r-running`, `z2u-work-running`). In the work view the row text is the full stored sentence. The panel at 1280×720 sits above the footer (last row bottom 586, footer top 612).
- **Ryan sheet:** heading "Send Ryan the deploy-access message (asks for Cloudflare Pages access to bouldernewtech)", message beneath, "Copy the message" primary. The real task has a parenthetical, so it is the row's words with that clause in both places; the row text is the same.
- **Active sidebar row:** "Uni" is a card with a hairline, no bar at its left edge (`z1-uni-panel.png`).
- No ellipsis in any row, sheet or Running text in the logged walks.

## What I didn't see
- The "Checking: <step>" banner in the real app. It is covered only by Playwright (above the composer, one line, no "…"). The walks never press "Check in".
- The "couldn't check" state on a task sheet (only on a decision), and no shot of it at 920×360 was inspected.
- The stale-summary and T-113 cases at 800×600, 740×360 and 920×360 were read from the logs; I inspected only some of the shots.
- The Vault browser failure state, in the real app.
- A cold start under load on the final binary: the load walk ran on the warm home, so cold-under-load is the earlier build's number.
- The hub for the scratch walks (`t124-scratch-hub7`, 127.0.0.1:19390) answered throughout. I did not start or move it. I removed `~/.hermes/cache/scratch/t124-apphome-r25w` (and the cold-under-load home), and killed only my own busy loops.

## Next
Aaron's side: nothing owed. The room owns the remaining P2s (Codex 3, 4, 6, and the rest of 7) and, if wanted, a Rust change so the first sync doesn't hold the IO gate for 13 s.
