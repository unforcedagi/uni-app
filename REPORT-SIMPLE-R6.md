# REPORT: Simple first, round 6 (T-124 r6)

Polish on `feat/simple` from 5221146. Nothing pushed. Design unchanged.

## Per item
1. **Stands sentence** clamps at 3 lines in the panel (`.cp-stands`), full text in the tooltip. The phone strip stays one line with the full text as its tooltip (opened, the body uses the same 3-line clamp).
2. **Markers anywhere.** `splitMarkers` also lifts a line made only of markers wherever it sits (several per line fine); order is head, middle, tail. Brackets inside a sentence stay text. Tests added to `scripts/chatMarkers.test.ts`.
3. **Worker status pings.** `isWorkerStatus` (`⏳ Working — N min/s/h …`, any dash, edited variants) renders one muted line with the time; the full text is the hover title. Matcher unit-tested (positives, mid-text, no number, multi-line).
4. **No layout cuts.** "Waiting on you · …" detail lines wrap to 2 lines (no ellipsis). The footer measures itself (`FootLabel`, ResizeObserver) and drops to "All work →" when "All of X's work" doesn't fit; the long form comes back when it does.
5. **Opening mid-message.** The author/time line of a message is sticky at the top of the list, so a latest message taller than the viewport keeps its author and time visible (CSS only; scroll logic untouched).

## Tests
- `tsc --noEmit` clean. `npm test` passes. `cargo test -p uni-core --offline` passes (86 + 1 + 22).
- Playwright: simple 95 passed (8 skipped, desktop-only on phone; two new specs: status/marker/sticky author, footer label + wrap + clamp), treehome 24, roomsnav 30, nested 6, areas 330 (10 skipped).
- `screens`: 6 passed, **phone-landscape still fails** (same as r2–r5, unrelated, left).
- Fixture: `tallLast` (with `longChat`) adds a status ping and a tall newest message with a marker line.
- Shots refreshed by the runs under `scripts/browser/__shots__/simple` (new `midmessage`).

## Not done
- Not run in the real app or on real vault data. Rooms/sidebar/chatoptional/rail configs not re-run (no code in their paths changed beyond shared CSS).
- The "unclear whether sticky meta looks right over a long grouped run" case relies on the sticky line only living inside its own message.
- Uni-sketches walk shots not regenerated.
