# REPORT: Simple first, round 24 (T-124 r24): "moved on" only when it means something; the summary never contradicts Needs you

The first r24 worker stopped at 19:27 in the middle of its walks and wrote no report. The night-0146 run (`CLAUDE-TASK-NIGHT-0146.md`) finished the round: it reviewed the five r24 commits against `CLAUDE-TASK-SIMPLE-R24.md`, fixed the WIP, ran the suites and wrote this report. Per the night brief, it did not rerun the walk set (the room walks it).

Commits on `feat/simple`, none pushed:
- `fbf5e90`: the main change.
  - The moved-on cue appears only when the room's chat mentions the request, and "Check in" becomes the primary action.
  - The summary gets a quiet note when nothing waits on Aaron.
  - The "message below" row.
  - The unresolved named block.
- `9a94660`: the WIP commit from the cutover fence (Companion and spec edits). `3c6c331` and `4118e53` finished and fixed it.
- `3c6c331`:
  - the block-gap line sits outside `.task-detail`;
  - the sheet body clears the footer;
  - Running keeps whole rows;
  - For you shows no vault-document chrome.
- `4118e53`:
  - the cue needs real key words and a "say" or "approve" step;
  - "Check in" scrolls to the first matching message;
  - the summary note covers the case where no open request is the thing it says waits;
  - the block gap names its room;
  - Running is never cut in half.
- `e671f58`: WIP, the run-row clamp (uncommitted when the worker stopped).
- `5963a7c` (night): the fix for that WIP.
  - The WIP clamp used `-webkit-line-clamp`, which always draws "…" and breaks r23's no-ellipsis rule. The run row is now cut at a whole line, the way the r23 rows are.
  - A strict 1280×720 spec was added.
  - Two short-window specs were fixed: they raced the switch from side panel to strip.

## Required items

| Item | Done | Spec |
|---|---|---|
| **P1 "moved on" means something.** The cue shows only for a room-directed request or an approval ("Say …", "Approve …", go/no-go, a decision), and only when chat after the request names its task id, a `#NN` number, or 2 or more distinctive words of `next`. The cue reads "#room has talked about X since this was asked/added". "Check in #room first" is the one primary action on every sheet that shows the cue, staging included; "Say it", "I did this" and "Copy" become secondary. "Check in" opens the room scrolled to the first matching message, which is marked. | yes | `simpleR24.test.ts`: the no-cue, id, two-words, approval-only and substring cases. Browser specs (`simple.spec.ts`, r23 block): unrelated chat gives no cue; matching chat gives the cue plus "Check in" as the one primary, for a room-directed request (Techne) and for a "look at … then say go" staging-shaped task. "Check in" lands on `.message.search-focus`. |
| **P1 the summary never contradicts Needs you.** When "Where this stands" says something waits on Aaron and the node has no open Needs-you item, a quiet line goes under it: "Nothing is waiting on you here now · this summary is from <date>". The stored text is never rewritten. An extension: when other items are open but none of them names the ids the summary cites (#38, T-90), the line reads "No open request mentions this now · …". | yes | `simpleR24.test.ts` (both lines, and none when an open request names the id). Browser: `r24 (Codex 1)`. The stored text stays, and the line disappears once a request naming #38 opens. |
| **"Message below" row.** The row reads "Send Ryan the deploy-access message (in the card)". | yes | unit `belowInCard`; browser row text in `r23 › …Ryan…`. |
| **A step that names a block.** Inline text shows only if it came from that block; otherwise "Open #room to find the 'For Eileen' block". | yes | unit `unresolvedBlock`; browser `a step that names a block…` (wrong block hidden, right block shown). |
| **Panel footer at 1280×720.** The last Running row sits fully above the footer. | yes | Existing spec (±20 px). New night spec `r24 (Sonnet): at 1280×720…`: 0.5 px tolerance, unscrolled, a long run is 2 whole lines with no line-clamp, and its full words are in the tooltip. A probe confirmed the spec exercised the long-run branch (2 runs shown). |
| **Short windows.** The sheet's Status and Due lines scroll fully above the footer. | yes | `a short window…` (Facts above the footer, in the viewport) and `r24: a decision sheet in a short window…` at 740×360 and 920×360. |

## P2s
- **Done:** Codex 5, For you is not an editable vault document. The note view hides the metadata line, tags, backlinks and the Parachute footer unless the user chooses "Open as a note". Specced in `rail.spec.ts`.
- **Codex 8, cold launch:** not measured tonight (see below). The first worker's numbers are below.
- **Not done:**
  - Codex 3, one navigation model;
  - Codex 4, compact state is not a browsing workflow;
  - Codex 6, Journal and area apps use the room grammar;
  - Codex 7, setup and recovery keep the common frame.

## Suites (night run, at `5963a7c`)
- `tsc --noEmit`: clean.
- `npm test`: pass.
- `cargo test -p uni-core --offline`: 90 + 1 + 22 passed.
- Simple Playwright (`playwright.simple.config.ts`, 3 projects): **514 passed, 47 skipped, 0 failed.**
  - The first full run had 1 failure: `r23 › a short window` on the 1440 project.
  - Rerun with `--repeat-each=3`, the two short-window specs failed 1 time in 18 at `e671f58` with its CSS, and 6 times in 18 with the new clamp. The cause was in the spec, not the app: after `setViewportSize(…, 360)`, `openCompanion` checked for `.cp.strip` before the side panel had switched to the strip.
  - Both specs now wait for `.cp.strip`. Result: 32 of 32 passed with `--repeat-each=4`, including the new Running spec.
- `vault-links` is not part of these suites. It was known to fail before and was not rerun tonight.

## What the real app showed (the first worker's walks, 19:20–19:28, a build from 19:19, so `4118e53` without the run-row clamp)
Logs are in `~/Code/uni-sketches/t124/walk/runs/r24-worker-*`. These are its numbers; I read them and did not rerun them.
- **Cue count:** 2 of the 15 non-private Needs-you sheets in Uni's work view show the cue, at all 4 sizes (1280×673, 800×600, 740×360, 920×360). Round 23 had 12 of 16. Both cues are in #Uni and both lead with "Check in #Uni first":
  - "#Uni has talked about unforced cutover since this was added";
  - "#Uni has talked about tasks parachute since this was added".
- **COhere's 3 sheets:** no cue.
- **The staging sheet:** not in the scratch data (T-90 is closed), so the walks could not show it. That case is covered only by the browser spec.
- **COhere summary:** after "More", the stored text is whole ("…prod waits on Aaron's Wed 10-14 go for #38, #58, #62.") with the line "No open request mentions this now · this summary is from Oct 13".
- **Ryan row:** "Send Ryan the deploy-access message (in the card) (asks for Cloudflare Pages access to bouldernewtech)" at every size. The sheet's heading still says "…message below" (the brief asked only for the row). The sheet shows the message, and its primary action is "Copy the message".
- **Running at 1280×673:** 1 run; last row bottom at 546, footer top at 612, not clipped.
- **Cold launch** (`cold-timing.json`, launch to first chat message):
  - `r24-worker-cold` (empty app home): 15.8 s (shell at 251 ms, composer at 14.6 s);
  - `r24-worker` (warm, same home): 471 ms;
  - `r24-worker-load` (under stress-ng): every file is empty. The worker stopped during that run, so **there is no number under load.**
- Tonight's cold launch was **not measured**: the scratch hub is down (below), and the measurement needs it.

## Not seen
- The scratch hub `t124-scratch-hub6` (127.0.0.1:19390) was **not running** tonight: nothing listens on the port and there is no unit. Per the rules I did not start or move a hub. So no walk ran, and no cold launch was timed, at `5963a7c`.
- The run-row clamp (`5963a7c`) is seen only in Playwright, not in the real app.
- I removed the leftover `~/.hermes/cache/scratch/t124-apphome-r24w`. Nothing held it open.
