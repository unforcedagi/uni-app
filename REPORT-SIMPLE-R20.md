# REPORT: Simple first, round 20 (T-124 r20): rows say the action within two lines, nothing is owed until it's known, and Uni's tidying stays Uni's

This round works on `feat/simple` from `543c558`. It adds six commits plus this report. Nothing is pushed.
- `3cfdba8` **The main round.** It covers:
  - rows built from the action;
  - a missing note is unresolved;
  - decisions get the dependency contract and aren't owed until they're read;
  - checking covers the whole queue;
  - Uni's tidying is one quiet line;
  - the sheet's footer is its last child;
  - 800×600 lands on the chat.
- `a1c6089` **Subtitles and specs.** A subtitle's place shows whole beside the due cue, or not at all. The specs move to the r20 rules and gain an `r20` block.
- `0f4eafe` **Two P2s:** one decision presentation (Codex 7) and one project identity (Codex 6).
- `d622e45` **Codex 5, part:** the narrow companion's sheet joins the shell's overlay stack.
- `53b8a51` and `293e184` **Found in the real app:**
  - the tidy titles and the checking rows' title lines read raw ("Decision (default yes): … feature 4, the");
  - a long host broke onto a third line at 236 px;
  - the COhere row still carried "The rest is in its note ›".

Across `src`: 10 files, about 457 lines added and 177 removed. New tests are `scripts/simpleR20.test.ts` (9 checks) and the `r20` block in `scripts/browser/simple.spec.ts` (11 specs, some run at two sizes).

## Rows: the action survives the cut
**Done.**

**How a row's line is built** (`rowAction`, `verbPhrase`, `firstClause` in `simpleCore.ts`):
- The row leads with the step's first clause. It is cut at the first ";", spaced dash, " then ", ": " or sentence end that comes after the verb phrase. A cut that lands inside "(…)" backs up to before the bracket.
- What follows the clause moves to the sheet, which keeps the whole step as its heading.
- A leading date label ("Wed 10-14:", "10-05 09:04:") is never the lead. It becomes the due cue, or the subtitle when the task has no due date.
- A label that asks ("Production go: …") counts as an action, so the Haiku gateway row now leads with what is asked.
- The verb phrase is the verb, or two joined ("Edit and send", "Approve or change"), plus a particle ("Look at", "Reply to") and its object. The object runs up to the first preposition, joining word, bracket or comma.

**The cut** (`WordClamp`, new `keep`):
- Rows are two lines in the companion and the work view alike.
- When the action still doesn't fit, the cut falls inside the object, never inside the verb phrase.

**Subtitles** (`rowSubParts`): a subtitle is where the row belongs, plus the due cue.
- "Where" is the task's title only when it is short (≤ 40 characters), whole, and doesn't repeat the action. Otherwise it is the area, when the row is shown outside it.
- A long title or a cut one ("Companion Today redesign…") is never a subtitle.
- "Where" shows whole beside the cue or not at all. A cut "SOW…" is as vague as the titles the brief drops.
- The due cue is never cut. A due date of today reads "due today".

**Specs** use real scratch steps (no private areas). The r20 spec puts the four Sonnet cuts on `Projects/ATLAS` at the side panel's 236 px:
- the Woven Web handoff ("…then talk…");
- COhere opens Oct 15 ("…say go on prod…");
- Edit and send the ATLAS follow-up ("…Michael…");
- Tell Uni who pays ("…crypto…").

For each, the spec asserts that the rendered lead is at most two lines, starts with the whole verb phrase, and never shows the part after the first clause. COhere reads "Say go on prod deploy of #38 + #58" under "COhere opens Oct 15 · due today". The unit test checks nine real steps' verb phrases and actions.

**Real app** (final binary, `r20-worker-extra`, 1280×720, all leads measured):
- **Uni's panel:**
  - "Look at cohere-signup-staging on phone" · "COhere · was due Oct 13"
  - "Say go on prod deploy of #38 + #58" · "COhere opens Oct 15 · due today"
  - "Edit and send the ATLAS follow-up to Mark…" · "ATLAS"

  Each is two lines, then "15 more ›".
- **Uni's work view (18 rows):** every lead is one or two lines. Some examples:
  - "Edit and send the ATLAS follow-up to Mark and Michael from your account"
  - "Tell Uni who pays (Techne or Gitcoin Foundation) and how"
  - "Review the Woven Web handoff draft, fill the unknowns"
  - "Reply: keep or archive the 87 Tana tasks"
  - "Tell Uni how to reach the friends box"
  - "Production go: gateway deploy ($10/day cap), merge #55, BV_CHAT_ENABLED on"

  No row has a "›" and no row has inline answers.
- **COhere's panel:** "Review the Woven Web handoff draft, fill…" is cut inside the object with the verb phrase whole. "Tell Uni who pays…" has no subtitle, because its title didn't fit beside a cue.
- **Found in the real app:** before `53b8a51` the long staging host broke mid-word onto a third line. In a row, a host longer than 24 characters now reads as its first part ("cohere-signup-staging"), and the link keeps the whole address. A spec covers it.

## P1s

### 1. A missing dependency never authorizes an action
**Done.**
- A required note that can't be found is `{ kind: "missing" }`, where r19 had read past it as clear. This covers a note the step links, the `source`, or a `depends_on`.
- **Row:** "Couldn't find “Migration runbook” · Open the task".
- **Sheet:** heading "Couldn't find “Migration runbook”", a line saying why, and primary **Open the task**. There is no action lead and no "I did this".
- **Decisions** have the same contract:
  - `taskDeps` reads `source` and `depends_on` for them, and `loadChecks` checks them.
  - A closed `source` reads "Check: “Chat plan” is closed — still needed?" with no answers to tap.
  - A source still being read is not owed.
- **Question extraction stays separate:** a decision's question is read by `loadAsks`; a task's questions are read only for a step that asks for them.
- **Specs:** a missing prerequisite (`depends_on: [[Projects/Mail/Migration runbook]]`), and a decision with a closed `source`. One r19 unit assertion that said "a note that doesn't exist is an answer: ok" now says `missing`.
- **Fixture change:** the r9/r12/r15 fixture step linked a second note the fixture vault didn't have. Under the r20 rule that row was rightly "Couldn't find …", so the fixture now holds that note.
- **Real app: not seen.** No live task in the scratch copy stands on a missing note or carries `depends_on`, and no decision carries `source`.

### 2. Unknown decisions aren't owed
**Done.**
- `unknownDecision` covers three cases: a decision whose title was cut and whose note hasn't been read at this revision, one whose read failed, and one whose own dependencies are still being read.
- Such a decision is left out of `needsYou`, the count and the tree's dots. It shows as a "Checking what's needed…" row after the owed rows, with the title as words under it. It never leads with "Decide:".
- A failed read reads "Couldn't check · Retry" and is not owed either.
- A note that is read but holds no question counts as classified: it is owed, and opens to read the question.
- `loadAsks` records every read, empty ones included, at its revision.
- **Spec:** a cold list with three statement-only decisions, their reads held 5 s.
  - It shows three "Checking what's needed…" rows and the count stays at "0".
  - Atlas Institute's tree row says nothing needs you.
  - A MutationObserver from the first paint never sees "Decide:".
  - Then "Uni is tidying 3 records" appears, with the count still at 0.
- **Real app** (`r20-worker-checking`, cold home, 1280×720, and the same at 800×600):
  - At 4.8 s the work view showed six "Checking what's needed…" rows with the count at **17**: T-13, T-25, Ship the Boulder Votes AI chat, and the Benya, daily-email and texting decisions.
  - At 6.3 s the count became **18**, when one was classified as owed. The three statements went to the tidy line ("Uni is tidying 4 records" with the Mail decision).
  - "Decide:" was never on screen (`seen.decide: []`).
  - The count only ever went up as records were classified; it never held an unread decision.
  - Screenshots: `c1-checking-decisions`, `c2-classified`.

## P2s

- **Checking finishes (Codex 3): done.**
  - `pool()` runs every queue (supporting notes, questions) six at a time over the whole queue, with no cap of 40.
  - An open sheet's task is taken first (`prioritize`).
  - `taskDeps` no longer drops references after six, so nothing is silently cut and no "+N more references" line is needed.
  - **Tests:** the unit test resolves 45 dependent tasks with at most six reads at once, reads an eight-reference task in full, and reads 45 cut decisions. The spec runs 45 seeded tasks, all of which reach their step.
- **Uni's tidying stays Uni's (Codex 8): done.**
  - "Ask Uni to fix this record" and `tidyRequest` are gone, so no `tasks.py` text is typed anywhere.
  - The work view has one quiet line, "Uni is tidying N records". Tapping it lists the titles, read-only.
  - Nothing in it counts, and it has no "›", buttons or rows to act on.
  - A tidy record's sheet, if reached another way, says "Uni is tidying it" and offers only Open the note and Close.
  - **Real app:** "Uni is tidying 4 records", opened to "Mail: approve a test week, not an immediate cutover", "Uni adds Benya's missing feature 4", "A daily calendar email to people" and "Texting is not recommended for this year because carrier". It had 0 buttons and 0 "›". Before `53b8a51` these titles read raw.
- **No "›" on any decision or tidy row: done.** `.cp-go` is gone from rows, and "Open to decide" has no arrow. In the real app, every decision and tidy row had 0 arrows in the panel and in the work view at all four sizes.
- **800×600 opens on the chat: done.**
  - The tree is a full-screen home only on an upright phone (under 600 px wide). Everywhere else, launch and room changes land on the chat, and Places is the header's drawer.
  - **Specs:** 800×600 and 740×360. Each checks that it opens on Uni's chat, that Places opens the drawer, and that Techne picked there lands on its chat with the drawer closed.
  - **Real app:** at 800×600, `n1-open` is Uni's chat with "Needs you · 18: Look at cohere-signup-staging.unforced.workers.dev on phone". The drawer opened, and Techne landed on its chat. At 740×360 and 920×360 the app restored the last room, COhere, on its chat.
- **The sheet foot fits: done.**
  - The footer is now the sheet's last child, sitting on its bottom edge. Archive and "Snooze until tomorrow" sit in the scrolling body above it.
  - **Specs:** at 740×360 and 920×360, scrolled to the end, Snooze's bottom is at or above the footer's top, and I did this and Close are fully in view.
  - **Real app (scrolled to the end):**

    | Size | Snooze | Footer | Footer is last child |
    |---|---|---|---|
    | 740×360 | y 162–198 | 256–313 | yes |
    | 920×360 | y 141–177 | 235–292 | yes |
    | 800×600 | y 276–312 | 370–553 | yes |

    At each size Snooze sits above the footer.
- **As many as fit:**
  - **Codex 7, one decision presentation: done.**
    - A decision row is its question; its answers are only in its sheet's footer.
    - Ten older specs now answer from the sheet.
    - **Real app:** Boulder Votes' row had 0 options. Its sheet held all three, inside the sheet and unclipped, at 1280×720, 800×600, 740×360 and 920×360.
  - **Codex 6, one project identity: done.**
    - A node's name is the heading in chat, work and app; the room it talks in is a line under it ("Chat in #Uni · no room of its own yet"); the composer keeps "Message #Uni".
    - The areaRoom, ids, nested and simple specs are moved to this rule.
    - **Real app:** Boulder Votes showed heading "Boulder Votes", context "Chat in #Uni · no room of its own yet", placeholder "Message #Uni".
  - **Codex 5, dialog contract: part.** The narrow companion's sheet is in the shell's overlay stack, so Alt+←, the sidebar's ← and Android Back close it first. Spec at 740×360.
    - **Not done:** pairing's native dialog inside Settings, and `SurfaceModal`'s own focus code.
  - **Codex 4, home and return: part.** 800×600 restores the conversation, as above.
    - **Not done:** an upright phone still launches on the tree; there are no "Up to …" labels; Recent in short drawers is unchanged.
  - **Not done:**
    - Codex 9 (For you, Journal and the utility frame);
    - Codex 10 (recovery for setup without a pack, Search errors, and area-app discovery);
    - Codex 11 and 12 (P3: upkeep out of the timeline, icons and motion).

## Real-app check
1. **Builds:** debug with `--features custom-protocol`.
   - The frontend was built with plain `vite build` into `/tmp/r20-dist`. Each build was checked for no `__T76_MOCK`, `__slowMs`, `__tagDelay`, `__noteDelay`, `__noteFails` or `__seedTasks`.
   - It was passed in with `--config {"build":{"beforeBuildCommand":"","frontendDist":"/tmp/r20-dist"}}`.
   - Binaries are in `~/.hermes/cache/scratch/r20/`: `-r20a` (`d622e45`), `-r20b` (`53b8a51`), and `uni-app-tauri-r20` (`293e184`, final).
2. **Final set** (`r20-walks.sh`, on `293e184`, scratch hub `:19390`):
   - `r20-worker-cold`, `r20-worker` and `r20-worker-load`, with `driver-r12.js` as specified (`WALK_KEEP_HOME=1 WALK_HOME_NAME=r20w`). For the load run, `nice -n 19 stress-ng --cpu 2 --timeout 200s` was started 3 s before launch and killed (my own PID) when the walk ended.
   - `r20-worker-extra` (1280×720), then `r20-worker-800x600`, `-740x360` and `-920x360` (via r19's `walk.sh` copy with `WALK_SIZE`), all on the same home.
   - Then `r20-worker-checking` and `-checking-800x600`, on throwaway homes that `walk.sh` deleted.
   - Drivers are in `walk/drivers-r20/`, assembled into `walk/driver-r20-{extra,narrow,cold}.js`. They only look: they never send, never press Say it, I did this, Archive or an answer, and never open the Journal or a private area.
3. **driver-r12 results:**
   - All three reached all nine shots. The cold run's only miss was "area collapse controls", the same as r18 and r19.
   - **Cold `01-open`:** Uni's panel already had its three whole-action rows and "15 more ›". The chat still read "Opening the room…" at 9 s (r19's cold run did not); it was open by the second shot. I didn't find the cause. Other sessions had the machine at a load average of about 6–8 throughout.
   - **The first set (`r20a-*`):** its cold run took over 15 s to load the tree and the room. It missed COhere and atlas/teach, and its warm and load runs were clean. I re-ran the whole set twice after fixes, and both later cold runs were normal. I read this as machine load, but I haven't proved it.
4. **Earlier sets** are kept as `runs/r20a-*` and `runs/r20b-*`. The found-in-app bugs above came from them.
5. **No writes** to the scratch data.
6. **Cleanup:** `~/.hermes/cache/scratch/t124-apphome-r20w` and `-r20c` are removed. `pgrep` shows no stress-ng, cage or app process of mine.

**Not seen in the real app:**
- "Couldn't find … · Open the task" (no live record has a missing note);
- a decision with `source` or `depends_on`;
- "Couldn't check · Retry" (no read failed);
- the narrow companion sheet's Back (specced only).

## Tests
- **tsc:** clean.
- **`npm test`:** passes, including `scripts/simpleR20.test.ts` (9 checks).
- **`cargo test -p uni-core --offline`:** 90, 1 and 22 pass.
- **Playwright `simple`:** 423 passed, 0 failed, 42 skipped on `293e184`.
- **Other configs:**

  | Config | Result |
  |---|---|
  | areas | 248 pass |
  | roomsnav | 27 |
  | nested | 6 |
  | chatoptional | 6 |
  | screens | 7 |
  | rail | 18 |
  | sidebar | 14 |
  | default | 397 pass, 10 fail, 45 skipped |

  The default config's 10 failures are the known `vault-links` ones (5 × 2 projects).
- **Not run:** `lifeos-vault`, `interface-webkit` and `webkit`.
- **Specs moved to r20 rules:**
  - no "›" on rows;
  - two-line actions (the r15 four-line spec);
  - the row has no "The rest is in its note" (the sheet says it);
  - decisions are answered in the sheet (r7, r12, r13, r16, r18 and r19 answer specs);
  - a borrowed room's heading is the node;
  - the tidy line replaces "Uni needs to tidy these (N)";
  - Tab's last stop is the footer's Close;
  - housekeeping is in the body, not the footer.

## Watch
- **The count can rise on a cold launch.** It never includes an unread decision, so on a cold launch the number rises when one is classified as owed (17 → 18 in the real app, about 1.5 s later). Nothing ever disappears from it.
- **Rows show less of the step.** "Pick a quiet window to cut core over to …" and "OK the migration windows (…)" have no clause break, so they are cut inside the object at two lines; their sheets carry the whole step.
- **A "where" that doesn't fit is dropped.** In the 236 px panel, "Tell Uni who pays…" shows no subtitle, because "$10k COhere sponsorship invoice draft" didn't fit whole. If Aaron misses that context, the alternative is to show the area there.
- **Data work for the rooms:** the tidy records are still the four decisions Uni wrote as statements on 10-06. Rewriting them with `tasks.py decide new --options`, or closing them, would empty the line.
