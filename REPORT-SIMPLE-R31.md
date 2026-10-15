# REPORT: Simple first, round 31 (T-145 r31): an ask is current because its record says so, not because chat is quiet

Commits on `feat/simple` (none pushed; `journal.rs`, `hub.rs`, `journalCore.ts` untouched; `src/approvals.ts` and `scripts/approvals.test.ts` still untracked and untouched): the r31 code and specs commit, then this report. In `~/Code/uni-tasks` (its own repo, committed there, not pushed): `tasks.py confirm`, `run start --channel/--message-ref`, `test_confirm.py`.

## 1. P1: the chat scan is gone; the record decides
- **Current** = the newer of `asked_at` and `confirmed_at` is within 3 days and not in the future (`confirmationOf(task, now)`, `currentAt`, `askStamp` in `simpleCore.ts`). A future stamp past 5 minutes of skew is passed over for the other stamp and only used when it is all there is (it then reads "future", a recheck). Nothing else promotes or demotes an ask.
- **Cancelled or superseded** = the note's own state: `done` and `archived` (already not live), a `superseded_by` field (new: `Task.supersededBy`, read by `wouldNeedYou`, so it is in no list, no count and not in the recheck list), and `dropped`: `dropped` is not a task state in `tasks.py` (`STATES` is open, doing, waiting, done, archived), so `parseTask` already refuses a note with it and the app lists nothing for it. Never read from chat.
- **Deleted, not flagged:** `useConfirm.ts` (the room reads, caches, `get_members`, the 4 s give-up), `chatAbout`, `checkInResult`, `quotes`/`QUOTE_WORDS`, `ANNOUNCE_GRACE_MS`, `requestKeys`/`KEY_STOP`/`isApprovalRequest`, `chatMovedOn`/`movedOnText`, `Gate`/`gateOf`, `needsRead`, `CONFIRM_WAIT_MS`, `checkInCue`, `couldntRead`, `checkingRoom`, `checkingAsks`, the `pending` confirmation state, `NeedsFeed.checking`, `Resolved.hit/failed`, the sheet's "Couldn't read #room · Retry" and "Checking #room…" lines, the `openroom` primary, `onRecheckRoom`, and their CSS. `AreasSurface` now resolves confirmation with one `useMemo` over the task list.
- Reasons in the list: only "asked Oct 11" (the date of the newer of the two stamps: `parseTask` sets `asked` to it) or "no date". "chat since in #room" and "couldn't read #room" no longer exist. "Check in #room first" stays as the sheet's primary for an unconfirmed ask (it opens the room with the step in a banner; it reads nothing).
- **Codex P2-2 (cold launch) is removed with it.** Classification no longer takes the room roster, Uni's key or any read, so a fresh app home and a warm one cannot differ. Test: `simpleR31.test.ts` "the same stored request classifies the same on a cold home and a warm one" (same ids in rows and recheck, in either order; `confirmationOf` takes only the task and the time). Real app: `r31-cold-wide` (fresh app home, no priming walk) and `r31-warm-wide` give identical Needs-you data: Uni panel 1 row + "Show 12 more", "1 request needs confirming across all rooms", work view count 13, the same recheck row.
- The P1's two cases cannot reach the decision: `r31.simple.spec.ts` "chat cannot cancel or revive an ask" posts "Cancel T-801: <the whole ask>" from Uni and talk about an old ask; the quoted ask stays a row, the old one stays a recheck, a `superseded_by`/`done` ask is in neither list, an old ask with a recent `confirmed_at` is a row.

## 2. Line-5 items
- **Folded summary:** one element, `Where this stands · Oct 14, #cohere`, which opens the summary (`summaryLine`, `Stands`). No "Last written … :" paragraph above it, no "Read", no colon with nothing after it. A long summary uses the same line (it was "What it said" under the same orphan label). A whole short summary keeps its "Last written Oct 14 by #cohere:" label because text follows it. Older than 2 days: `Where this stands · Oct 12 (3 days old)` (the room is left out then, as in your example; it is the panel's own room). Seen in the app: 800×600 COhere (`b1-cohere-panel.png`, folded below the footer) and the Uni panel's recheck-open state (line "Where this stands · Oct 12 (3 days old)"). Wide shows the whole summary with its label, because it fits.
- **One date on a row:** overdue says only "was due Oct 13" (row, sheet and the work view); not overdue keeps its asked date, with an upcoming due date beside it (nothing contradicts there). This is narrower than "else the asked date": a future due date is still shown. Tell me if you want it dropped too.
- **One count:** the row says the list's own total, "10 labels in all", never what happened to be left out ("and 9 more" / "and 8 more" depended on width and height). It appears whenever fewer than all items are drawn, with the list's noun. Same in Uni's panel, COhere's panel, the work view, 1280, 800×600, 740×360 (walk data, below). "Show N more" = count − rows shown, checked in the app: Uni at 1280 shows 1 row, "Show 12 more", work view count 13; at 800×600, 3 rows + "Show 10 more" = 13.
- **"skip if already done":** the stored text is task **T-101** `Tasks/T-101 Tell Christian the BVSD letter is sent, if not done…` (node `Projects/Civic`, state waiting, owner aaron). Its `next`: "Reply to Christian in your existing thread that the BVSD letter went out Oct 2 (skip if already done)." Found in the scratch hub11 copy (`scripts/fixtures/hub11-asks.json`), not the live vault. The room that owns it (#civic) can rewrite it. I did not change stored text.
- **Old summary:** see above (the data is left as it is).

## 3. P2-8: a waiting run's destination
- `tasks.py run start --channel <id> --message-ref <event id>` (documented in `--help` and the `state.py` header) stores `channel` and `message_ref` on the run note; both optional, absent when not given. Tests in `test_confirm.py` (4).
- The app reads exactly those: `Run.channel` (`channel`), `Run.message` (`message_ref`). The guessed `message` and `ref` fallbacks are gone. A run opens its room by `channel` id; with no `channel` it is matched by its `room` name exactly; with neither it is its node's room. An id or name that is not among the rooms: the row says "Room not found" (in place of its state) and a tap opens nothing. It says so only once the rooms are in and not empty.
- Verified in the Playwright mock (`r31.simple.spec.ts` "3:"): a good channel id opens that room at `message_ref` with the composer focused whatever its `room` name says; an unknown id shows "Room not found" and the app stays where it was. **Not** verified against a real waiting run: the scratch hub has none, and no producer writes `channel` yet (the rooms that start runs have to pass `--channel`).

## 4. `tasks.py confirm`
`tasks.py confirm T-NN [--note "..."]`: stamps `confirmed_at` (ISO, UTC, e.g. `2026-10-15T12:34:56+00:00`) with a PATCH guarded by `if_updated_at` (the revision it read; a changed note is a CONFLICT, exit 3, nothing written); refuses unless the state is open, doing or waiting. `--note` is kept as `confirmed_note` (300 characters). `asked_at` is untouched. Tests in `test_confirm.py` (7) use the existing `Fake` vault; the live vault was not touched.

**Schema for you to add to the live `task` tag** (`update_tag`, without `replace_fields`, so the existing fields stay):
```json
{"name": "task", "fields": {
  "confirmed_at": {"type": "date", "description": "When a room or Aaron last checked this ask is still wanted (tasks.py confirm). With asked_at, the app counts an ask as current for 3 days."},
  "confirmed_note": {"type": "string", "description": "One line on what was checked."},
  "superseded_by": {"type": "string", "description": "The task (T-NN) or note that replaces this one; a superseded ask is not owed."}
}}
```
Caveat: `confirmed_at` is written with a time of day, like `asked_at` (which the tag does not declare). If the live `date` type accepts only `YYYY-MM-DD`, the stamp will be a schema error (422): then declare it `string`, or tell me and I stamp the day only. `confirmed_note` and `superseded_by` are optional; the app reads `superseded_by` only.

## Gates
- `tsc --noEmit`: clean.
- `npm test`: exit 0, 401 `ok` lines (R22–R30 files lost the chat-scan checks listed below; `simpleR31.test.ts` is new, 10 checks, and is in the `npm test` chain).
- `uv run --with pytest pytest -q` in `~/Code/uni-tasks`: **133 passed** (122 + 11).
- Simple Playwright (`npx playwright test --config playwright.simple.config.ts`, three projects), last full run on the final head: **653 passed, 107 skipped, 2 failed**: the same two `[mac]` r19 tests that failed in r30's last run (`a sheet's text is cut by one rule at every size`, `in a short window the sheet's primary action and "I did this" stay in view`: a 30 s click timeout in `unfoldAll`; each passes alone, 12/12 on `--repeat-each=6`, and at r30's head). Tracked `__shots__` PNGs were rewritten by the runs and restored; none committed.
- `cargo test`: not run, no Rust changed.
- **Mutation check:** the pre-r31 chat-scan code (HEAD `895a659` sources) with the new specs in a throwaway worktree (removed after): `simpleR31.test.ts` cannot even import it; Playwright `[mac]` r31 + r29: **6 of the 12** specs fail, among them the two P1 specs ("chat cannot cancel or revive an ask" and r29's "chat can neither cancel nor revive": the quoted ask is demoted to a recheck), the one-line summary, the single date, the single count and the channel-id run.

### Specs removed or rewritten (they tested the removed behaviour)
Unit: R22 `chatMovedOn`; R23 moved-on cue; R24 four `chatAbout`/`isApprovalRequest` checks; R25 three-state Check in; R26 lookup states; R27 seven confirmation/lookup checks; R28 five (rewritten as R31 equivalents: feed, day-only stamp, `taskIdOf` is still covered by the waiting-run checks; the announcement grace removed); R29 four announcement checks; R30 six (reasons, `quotes`, grace). Browser: r28 "held back (Checking…)" and "chat does not answer"; r29 two announcement specs (replaced by one record-decides spec); r30 "grace", "couldn't read" and the "chat since" reason (the list test now checks that "T-901 is off" in chat changes nothing); simple.spec: the "couldn't read / Retry" halves of five specs, "search-focus the first related message", "chat moved on" reasons (now "Asked Oct 6 · not confirmed since"), "and N more" → "N labels in all" helpers, "What it said" → the one line. Tests that need an unconfirmed ask now give it an old `asked_at` explicitly.

## The real-app walk (r30's pattern, `~/.hermes/cache/scratch/r31/build.sh main`, driver `driver-r31.js`)
Debug build with `--features custom-protocol`, scratch hub `t124-scratch-hub11` on 127.0.0.1:19390 (read-only: I did not start, stop or write it), the reviewer key, an app home of my own (`t124-apphome-r31w`, removed after; no apps left running). Looks only. Runs under `/home/uni/Code/uni-sketches/t124/walk/runs/`:

| Shot (run / file) | What it shows |
|---|---|
| `r31-warm-wide/a1-uni-panel.png` | Uni's panel: T-113 row with 2 of 10 labels and "10 labels in all", **"COhere · was due Oct 13"** (one date), "Show 12 more", "1 request needs confirming across all rooms", the whole summary with its date |
| `r31-warm-wide/b1-cohere-panel.png` | COhere's panel: the same row, "10 labels in all", "was due Oct 13"; the summary whole |
| `r31-warm-wide/a2-uni-recheck-open.png`, `a3-recheck-sheet.png` | the confirm list with its reason "asked Oct 13 · in Boulder Votes"; its sheet "Asked Oct 13 · not confirmed since", "Answer anyway" after it, "Check in #Uni first" |
| `r31-warm-wide/b3-t113-sheet.png` | task sheet: "Was due Oct 13" as its one date, 10 labels under the heading |
| `r31-cold-wide/*` | the fresh-home walk, same data as warm (the Cold = warm check) |
| `r31-warm-800x600/b1-cohere-panel.png` | COhere at 800×600: T-113 "10 labels in all", "was due Oct 13", the one line **"Where this stands · Oct 14, #cohere"** below the footer (nothing above it, no "Read") |
| `r31-warm-800x600/a1-uni-panel.png`, `a2-uni-recheck-open.png` | Uni at 800×600: 3 rows, "Show 10 more", 13 in the work view; the summary as "Where this stands · Oct 12 (3 days old)" while the list is open |
| `r31-warm-740x360/b1-cohere-panel.png`, `b2-t113-row.png`, `a1-uni-panel.png`, `a3-recheck-sheet.png`, `b3-t113-sheet.png` | the same at 740×360: "10 labels in all", one date, the confirm list and its sheet |

The waiting-run row's "Room not found" and the `channel` id path are not in these shots (no such run on the hub); they are in the Playwright spec only.

## Unverified
- A real waiting run with `channel` / `message_ref` (no producer passes them yet); `tasks.py confirm` against the live vault (fake vault only); the live `date` type accepting a time of day (see §4).
- The app cannot know a task was cancelled in chat: it now relies on rooms closing, superseding (`superseded_by`) or re-confirming the task note. An ask nobody confirms leaves Needs you after 3 days into "N requests need confirming", by design.
- `r31-warm-wide` was run once; both cold and warm gave the same data on the hub's 13 live asks, which is a check of this build, not a proof for every roster.

## Noted, not done (P2 3–7)
Back's three meanings (3); narrow startup shows the desktop frame first (4); Journal's false empty claim and raw pairing errors (5); changing vaults drops the room shell (6); Journal/area-app navigation grammar (7). None touched.
