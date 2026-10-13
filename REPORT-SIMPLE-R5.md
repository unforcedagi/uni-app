# REPORT: Simple first, round 5 (T-124 r5)

Fixes from the r4 critics, on `feat/simple` from 23728ce. Nothing pushed. Design unchanged.

## Per item
1. **Decision shows its whole question.** A decision's title no longer clamps (tasks keep 2 lines). With `options[]` the inline buttons stay; with none there is no "Decide" button: the row opens the item and ends in a quiet "›". Fewer items instead of clipped text: `needsFit(window height)` shows 3 (≥820px), 2 (≥640), else 1, then the "All of … work →" link. Side panel only reads the viewport height; the strip uses the same rule.
2. **Running fits.** At most 2 running rows; the rest become "+N more running" inside the footer link (same button, so it opens the full page). The panel body scrolls above the sticky footer. Spec at 1280x720 scrolls to the end and checks no row sits under the footer.
3. **COhere's channel in the header.** Cause: r4 only stripped the channel off the *viewed* node when a descendant claimed its room. Viewing COhere, the ancestor Boulder (channel = COhere's room id) still counted as sharing the room, so `own` was false and the header door was hidden. `roomView` now strips a claimed-below channel from every node on the chain. Unit test in `treehome.test.ts`: COhere owns its room and its slash is `boulder/cohere` while Boulder's channel names it.
4. **Markers as chips.** `src/chatMarkers.ts` `splitMarkers` pulls `[done|decision|blocked|active T-NN]` off the start or end of a message (several allowed; mid-text ones stay); `MessageBody` renders each as a small muted chip ("done · T-124"). Text otherwise unchanged. `scripts/chatMarkers.test.ts` (none, trailing line, same line, leading, several, mid-text, marker only), added to `npm test`. Not covered by a browser spec.
5. **Orange dot = needs you.** The tree/rail/strip dots are driven only by needs-you. The one other dot (the old Rooms rail's "Unread rooms") used the same orange (`--turquoise` = `--th-sap`); it is now a muted hollow ring. Unread room names were already bold.

## Tests
- `tsc --noEmit` clean. `npm test` passes.
- Playwright: simple 92 passed (7 skipped, desktop-only on phone), roomsnav 30, treehome 24, nested 6, rail 18, sidebar 14, chatoptional 6, areas 330 (10 skipped). No separate steer config exists; steer specs run inside simple/areas.
- `screens`: 6 passed, **phone-landscape still fails** (same as r2–r4; can't find the "Rooms" button at that viewport). Unrelated, left.
- Specs changed: the 1280x720 needs list now expects 2 (was 3); the decision-title spec asserts no clip instead of a 2-line clamp; a new spec covers option-less decisions and Running above the footer.
- Shots refreshed by the runs (`__shots__/simple`, `roomsnav`, `nested`, `t86`). Walk screenshots under `uni-sketches` not regenerated.

## Not done
- Not run in the real app or against real vault data. The COhere cause is from the code and fixture shape, not the real Boulder note.
- `stands` wording is T-125 data, untouched.
