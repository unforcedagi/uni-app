# REPORT: Simple first, round 30 (T-124 r30): the words Aaron reads are the words stored, and every row can be acted on

Commits on `feat/simple` (none pushed; I did not touch `journal.rs`, `hub.rs` or `journalCore.ts`; `src/approvals.ts` and `scripts/approvals.test.ts` are still untracked and untouched):
- `9a205c4`, `8230505`, `ffdf749`, `0852377`, `c44bdf2` and the commit after `9b99f88` (a request that needs confirming and leads with its title shows its step): the code (`simpleCore.ts`, `Companion.tsx`, `NodeWork.tsx`, `WorkView.tsx`, `AreasSurface.tsx`, `steerCore.ts`, `tree.css`), `scripts/simpleR30.test.ts`, the hub11 fixture `scripts/fixtures/hub11-asks.json`, and the older unit tests moved to the new rules.
- `9b99f88`: Playwright specs: `scripts/browser/r30.simple.spec.ts` (new), the fixture's `__addRun` takes extra metadata, and older specs moved to the whole-step rule.

## 1. Where "and Me" was lost, and what else was lost with it
Not in `currentStep()` or `rowAction()`, as the critic found. **At load**, `stepText()` (`simpleCore.ts`, called from `vaultTasks.ts:181`): any `next` of 140 characters or more with no ending was taken for a step the old writer had cut (`tasks.py` used to do `[:140]`), so it dropped the last word, and "and" with it (a dangling word). T-113's step is 207 characters and ends "Me", so every surface read "…open Board, People", and the sheet added "(the note ends here)". `tasks.py` now stores up to 400 and "never cuts it silently". Now only a step of exactly what the old writer left (139 or 140 characters, no ending) is read as cut.

Two more places lost words and I fixed them in the same change, because the check you asked for (every live ask, no word missing) found them:
- **The row and the heading drew only the action's first clause**, with the rest under the heading in the sheet and nowhere on the row. T-60 lost "Also say whether journal should be Parachute's default entry type", T-129 lost "first update its numbers to the refreshed data (563 publications, 405 projects)", and **T-143 lost 4 of its 9 addresses** (it stopped at the `;`). `RowAction.text` is now the whole step (`head` is the first clause, which the verb, the steps and the link are read from). The row and the sheet's heading say the same words.
- The heading used to cut "listed in this task's detail" out of a step that pointed at a list. It keeps its words now (the list is under it).
- A closing "." and a cut mark "…" are not words and are not shown (as before).

Tests:
- `r30 › 1: T-113's real next is word for word in its row and its sheet heading at 1280×720 / 800×600 / 740×360` (the stored text from hub11, `cohereboulder.org`, ends "People and Me").
- `r30 words › every live ask of the scratch hub shows its whole stored next in its row`: the 13 asks of Aaron's on hub11 that have a step go into the mock vault and each row is checked word for word (11 of them; T-25 and T-107 name notes by id, which the mock vault doesn't hold, so those two are covered only by the unit test below).
- `simpleR30.test.ts`: the same over all 15 live asks of Aaron's on hub11 (fixture `hub11-asks.json`: owner or waiting-on Aaron, plus the open decisions; private areas left out; the 2 decisions have no step). The mutation check: with the old `stepText` rule put back, 3 of its tests fail.

## 2. "listed in detail" carries the list
`LIST_LOC` knows "in detail", "in the detail", "listed in detail" (with or without the determiner); `LIST_REF` allows up to three qualifying words and more nouns ("the new site labels": labels, lines, answers, options, names, addresses, …). `detailLists` reads a new shape: "Labels to approve (en; es written): 'A' · 'B' · 'C'. Also her call: …" (items set apart by " · ", at least three; the sentence after them is the rest). T-113's row shows its labels inline, at most two and then "and N more" (the panel lowers it to one when two don't fit whole above its footer); the sheet lists all 10 right under the heading.

## 3. The sheet is the ask
Heading (the whole step), then its steps, then the referenced items. Everything else in the detail (earlier asks, history, "Her call", background) is **one closed "Background" disclosure** (`details.task-background`). A detail the step points at ("the message below") is the ask's own words and stays visible. Spec: `r30 sheet › 3` at the three sizes (the labels follow the heading, one closed Background, nothing of "Earlier asks" or "her call" on the sheet until it is opened).

## 4. Requests needing confirmation
- The line is **"N requests need confirming in this room"** (any room but Uni's) or **"… across all rooms"** (Uni's own room, whose feed is everything). The panel and the work view of the same room say the same. *Deviation:* I did not label every "All of X's work" "across all rooms" as the brief says: a room's work view counts that room and what is under it, so that label would be false there. Say if you want it literal.
- Each list row shows its reason in a few words: "chat since in #cohere", "couldn't read #cohere", "asked Oct 11" (an old, future or undated record), "no room". A request that leads with its title (its step is a status) shows the step whole under the title. The whole row is one button; it has no "Answer anyway".
- The sheet: "Asked Oct 13 · chat since in #cohere" (or "· not confirmed since", "· no room"; "Couldn't read #cohere · Retry"), and **"Answer anyway" right after it**, in the body (it is no longer in the footer).
- Specs: `r30 confirming` ×3 (reasons and no "Answer anyway" on rows; scope across all rooms / in this room; couldn't read); older specs moved.

## 5. The announcement grace, narrowed
`chatAbout` takes the ask's stored `next` (`RequestKeys.next`). A Uni message is skipped when it quotes at least **6 consecutive words** of the stored `next` **and** (inside the 10 minutes) names the task's T-NN. After the window a Uni message that quotes 6+ words of the current `next` is a reminder and doesn't unconfirm (no T-NN needed). Everything else counts as before: Aaron's messages, other keys, Uni's messages that quote nothing, and any message when Uni's key in the room isn't known. All four cases are specced in the browser (`r30 grace`: g1 announcement skipped, g2 cancellation in the window unconfirms, g3 reminder two hours on doesn't, g4 other talk two hours on does) and in `simpleR30.test.ts`.

## 6. Waiting-run rows are actionable
A waiting run is a row (`li.cp-run.cp-run-waiting` with one `button.cp-need`). The whole row opens the run's room (the run's `room`, else its node's steward room), at the run's message when it has one (`Run.message`, from `message_ref`, `message` or `ref` in the run note), with the composer focused and nothing written. Spec: `r30 waiting runs` ×2 (from Uni's work view to Techne at the message, composer focused; the panel's row with no message). **The run note's field for the message is my guess** (the scratch hub has no waiting run to read one from); the rooms that write runs should say what it is called.

## 7. The summary is never cut by the panel edge
In the side panel and the compact panel, once the panel has been still for a moment: if the summary is cut by the bottom edge or the footer, it becomes its date line with "Read"; if even that would be cut, it sits **below "All of X's work"**; if it later has room to spare (about 76px), it is tried whole again (twice at most). Also: a "Running" heading never stands alone above the footer, and the panel keeps the rows that fit whole above its footer, the first always (before: at least two, which pushed the quiet line and the summary under the footer). Spec: `r30 summary` at 1280×720, 1280×600, 800×600, 740×360 and 920×360; with the fold turned off it fails at 1280×600 and 800×600.

## Suites
- `tsc --noEmit`: clean. `npm test`: pass (421 `ok` lines; new `simpleR30.test.ts`). `cargo test -p uni-core --offline`: 119 + 1 + 22 passed (1 ignored; no Rust changed).
- Simple Playwright, three projects (`npx playwright test --config playwright.simple.config.ts`), last full run on the final head: **653 passed, 107 skipped, 2 failed**; the two are `[mac]` r19 `a sheet's text is cut by one rule at every size` and `in a short window the sheet's primary action and "I did this" stay in view` (the known room-tree-doesn't-appear-in-30 s flake: `openRoom` times out). Counts: both tests, `--repeat-each=5` on all projects: my head 5 of 30 failed (all phone), base `26f3e1c` 2 of 30; both tests alone on phone, `--repeat-each=5`: my head 10 of 10 pass, base 9 of 10. I read it as load-sensitive, not a regression, but it is not proved.
- I moved about 25 older specs to the new rules (whole step on the row and in the heading, "N requests need confirming", "Answer anyway" in the sheet, the row's `Open` is `.cp-rc-open`, a waiting run's state is inside its button, a Needs-you panel keeps "at least one" whole row).
- Playwright rewrote tracked `__shots__` PNGs each run; I restored them and committed none.

## What the real app showed
Debug build with `--features custom-protocol` (`~/.hermes/cache/scratch/r30/build.sh main`; no test flag). Scratch hub `t124-scratch-hub11` on 127.0.0.1:19390 answered (read through the app's own commands, read-only); I did not start or move it. App home `r30w` (removed; checked). Drivers: `driver-r30.js` (walk), `driver-r30-dump.js` (the read-only dump behind the fixture). Nothing was pressed but Close, the need-confirming line, "Background" and rows' own open. Runs and shots: `~/Code/uni-sketches/t124/walk/runs/r30-worker-main-{wide,800x600,740x360,920x360}` and `r30-playwright`.

**A cold app home reads rooms before it knows Uni's key** (the first walk on a fresh home had T-113 unconfirmed "chat since in #cohere" because Uni's announcement wasn't skipped); a thrown-away first walk (`r30-prime`) warms the home and every shot below is the warm one. That is the R29 caveat and it is still true.

| Required shot | File |
|---|---|
| T-113's row ending "…People and Me", labels inline | `wide/a1-uni-panel.png` (Uni's panel, first row, "Already registered? Sign in" and "and 9 more"), `wide/b2-t113-row.png` (COhere's panel, two labels and "and 8 more") |
| T-113's sheet ending "…People and Me", labels right under it | `wide/b3-t113-sheet.png` |
| The Background disclosure | closed `wide/b4-t113-background-closed.png`, open `wide/b5-t113-background-open.png` |
| "need confirming" in the panel and in All-work, with scope | `wide/a1-uni-panel.png` ("across all rooms"), `wide/a4-uni-work.png` and `a5-uni-work-recheck.png` (All of Uni's work), `wide/b1-cohere-panel.png` ("in this room") |
| A list row with its reason | `wide/a2-uni-recheck-open.png` (chat since in #Uni / #cohere, asked Oct 13 · in Boulder Votes) |
| The sheet with "Answer anyway" after the reason | `wide/a3-recheck-sheet.png` ("Asked Oct 13 · not confirmed since", then "Answer anyway") |
| A waiting-run row opening its room | **Playwright mock** (the hub has no waiting run): `r30-playwright/w1-uni-panel-waiting-run.png`, `w2-room-opened-composer-focused.png` (the room at the message, the composer focused) |
| The summary whole at 1280×720 | `wide/a1-uni-panel.png` (whole, dated, below Needs you), `wide/b1-cohere-panel.png` |
| The summary at the three narrow sizes | `{800x600,740x360,920x360}/a1b-uni-summary-scrolled.png`, `b1s-cohere-summary-scrolled.png` (the panel scrolled to its end) |

`walk-log.json` has the measurements: `cutByEdge: false` for every summary at rest at every size, T-113's row and heading `…People and Me`, `itemsRightAfterHeading: true`, a closed Background, no "Earlier asks" on the sheet, "Answer anyway" after the reason line and not in the footer. One snapshot says `cutByEdge: true` (`uniSummaryOpen` at 800×600): the need-confirming list had just been opened and scrolled; it is mid-scroll, not at rest.

## Things the critics should know
- T-113 on this data: in the **cold** walk it is "chat since in #cohere", and in the warm ones it is confirmed. I infer (I did not trace the messages) that a cold read doesn't know Uni's key, so Uni's own messages in #cohere count; the room's 3:58 message "I re-wrote T-65 and T-113 … ends '…open Board, People and Me'" quotes only 5 words, so by the new rule it would count too if it were not skipped some other way. A room that wants an ask confirmed after it has talked should rewrite it (a new `asked_at`) or announce it with six words of the step.
- P1-1 is narrowed, not solved: confirmation is still inferred from chat. The real fix (each request revision confirmed by its owning room, with the announcement message as its proof) is not built; a message in #Uni names T-145 for it.
- The summary folds when the whole text wouldn't fit even with room around it (COhere's is seven lines at 236px): "Read" there is not a sign of a short panel.
- In the side panel, rows now show fewer when whole steps are tall: Uni's panel at 1280×720 shows one whole row, "Show 9 more", the quiet line and the summary, with no scrollbar; before it showed two rows and cut the quiet line under the footer.
- Not done: Codex P2-2 (Back), P2-4 (narrow startup), P2-5 (Journal and area apps), P2-6 (vault setup), P2-7 (empty and failure states), P3-9, P3-10.

## Next
Aaron's side: nothing owed. The owner of the run ledger (T-118): name of the field a waiting run keeps its message ref in. Rooms: announce a rewritten ask with six consecutive words of its step, and give it a fresh `asked_at`.
