# REPORT: Simple first, round 21 (T-124 r21): the whole action shows, a failed check never looks like a pass, and status claims only what's true

This round works on `feat/simple` from `62ec946`. It adds ten commits plus this report. Nothing is pushed.

- `e47cd06` **The main round.** It covers:
  - the whole action on every row;
  - decision rows that lead with the question while they're checked;
  - P1-1 (a failed check invalidates a cached ok);
  - P1-2 (the factual records line);
  - one button per row (Codex 10);
  - no "›" on rows or link rows;
  - the 800×600 sheet margin.
- `0258b70` **Codex 6:** the Journal has one menu per entry.
- `8ef1708` **Codex 9:** a quiet chat while the conversation opens.
- `9771164` **Codex 8:** an area app's states (absent, opening, failed, ready) are kept apart.
- `04f61e6` **Codex 5:** For you is read-only.
- `c4c53b8` **Codex 7, part:** a slow note, and a failed search, recover in words.
- `ed1c006` **Codex 3, part:** Recent is kept in short drawers.
- `be46006` **Codex 4:** one owner for Escape (pairing over Settings, `SurfaceModal`).
- `d4c8305` and `2281ae0` **Found in the real app:**
  - the folded strip showed step 1 as the whole job;
  - a cold launch showed a private area's task as an ordinary row.

Across `src`: 18 files, about 357 lines added and 135 removed. New tests are `scripts/simpleR21.test.ts` (4 checks) and the `r21` block in `scripts/browser/simple.spec.ts` (15 specs, most run on three projects). One spec was added to `interface.spec.ts` and one assertion to `rail.spec.ts`.

## The whole action shows
**Done.**

**What a row holds** (`rowAction` and `actionOf` in `simpleCore.ts`):
- The action runs from the verb to the sentence's end, with all its objects and recipients. A question carried on by the next one ("…browser share? And keep logged-in sessions…?") counts as one ask.
- Only context after the action goes to the sheet:
  - a ";" clause that isn't another step ("; Eileen signs off…", "; fill the opening…");
  - a spaced dash;
  - "because…".
- **Steps.** "A, then B", "A; then B" and "A and then B" are two steps. "…; listen to 2 Jacobs clips first" is a step done first.
- **The forms a row tries, best first** (`forms`):
  1. the whole action;
  2. the same without its brackets (dates, examples, a note's title);
  3. for more than one step, "2 steps: A, then …".

  The row shows the first form that fits **three lines** (`ACTION_LINES = 3`), measured before paint and again on resize (`WordClamp`'s new `alts`).
- **The last resort.** If no form fits, the last one is cut, but never inside its first clause. "Edit and send the ATLAS follow-up to Mark and Michael from your account" is kept whole whatever the width.
- **The sheet** lists a multi-step action numbered under "2 steps". The rest of the step (its date) stays in the sheet.

**Specs** (`r21` block) use the five required titles, at 236 px (the side panel and the narrowed work view) and full width. For each, the spec asserts:
- three lines at most, and not cut;
- the whole object is in the rendered text:
  - ATLAS: "to Mark and Michael from your account";
  - Woven Web: "…fill the unknowns" plus "then talk with Eileen yourself", or "2 steps: …, then …";
  - cohere-signup-staging: both steps, or "2 steps: …";
  - Tell Uni who pays: "and how: crypto or ACH/Stripe, plus Woven Web's legal details";
  - COhere opens Oct 15: "Say go on prod deploy of #38 + #58".

A second spec checks the numbered "2 steps" sheet.

**Real app** (final binary `2281ae0`, `r21-worker-extra` at 1280×720, measured by the driver):
- **Uni's work view (18 rows):** every row's form is `0` (whole), at one or two lines, and none is cut. Some examples:
  - "Edit and send the ATLAS follow-up to Mark and Michael from your account"
  - "Look at cohere-signup-staging on phone, then forward #cohere's 'For Eileen' block (posted 10-13)"
  - "Review the Woven Web handoff draft, fill the unknowns, then talk with Eileen yourself"
  - "Tell Uni who pays (Techne or Gitcoin Foundation) and how: crypto or ACH/Stripe, plus Woven Web's legal details"
  - "Production go: gateway deploy ($10/day cap), merge #55, BV_CHAT_ENABLED on; listen to 2 Jacobs clips first"
- **Uni's panel (236 px):**
  - "2 steps: Look at cohere-signup-staging on phone, then …" (3 lines)
  - "Say go on prod deploy of #38 + #58" (2)
  - "Edit and send the ATLAS follow-up to Mark and Michael from your account" (3)
  - then "Show 15 more".
- **COhere's panel (236 px):**
  - "2 steps: Look at cohere-signup-staging on phone, then …"
  - "Say go on prod deploy of #38 + #58"
  - "Tell Uni who pays and how: crypto or ACH/Stripe, plus Woven Web's legal details" (brackets dropped)
  - "2 steps: Review the Woven Web handoff draft, fill the unknowns, then …"

  None is cut.
- **At 800×600, 740×360 and 920×360,** Uni's and COhere's companion sheets showed every row whole (form `0`): the ATLAS row, the staging row with both steps, who pays and Woven Web. The work views were whole too.
- **The staging sheet:** heading "2 steps", then "Look at cohere-signup-staging.unforced.workers.dev on phone" and "Forward #cohere's 'For Eileen' block (posted 10-13)".

**Decision rows lead with the question.** A decision or task being checked leads with its question or title, with "Checking…" as a quiet italic line under it. It still isn't counted until it is classified.

Real app (`r21-worker-checking`, fresh homes, at 1280×720, 800×600, 740×360 and 920×360). In all four runs:
- **While checking:** "Ship the Boulder Votes AI chat?", "Uni adds Benya's missing feature 4", "A daily calendar email to people" and "Texting is not recommended for this year because carrier" each showed with "Checking…" under it. The count read 17.
- **Never seen:** "Decide:" or "Checking…" as a title (`seen.decide: []`, `seen.checkingTitle: []`).
- **The classified state** (r20 never showed it): within 12.0–12.7 s of launch, no row was still checking. The count was 18, with "Ship the Boulder Votes AI chat?" now an owed row. The line read "4 records need rewording by their rooms". Screenshots: `c1-checking-decisions` and `c2-classified` per run.

## P1s

### 1. A failed check never leaves an old instruction actionable
**Done.**
- `checkOf`: a failure newer than the last good check gives `unavailable`, whatever the cached record says.
- `loadChecks` drops the device's kept record on a failed read, so the next launch doesn't paint it either.
- Retry turns a failed check into "checking" (`retryState`), never back into the old ok.
- **Row:** the title, then "Couldn't check · Retry". The row's one button retries and opens the sheet. There is no action lead.
- **Sheet:** no "I did this" and no action in the heading.
- **Tests:**
  - The unit test runs ok → failed refresh → unavailable, and checks that the device forgets the ok.
  - The spec runs ok → a failed refresh (`__noteFails`): the action is gone, there's no "I did this", and a still-failing Retry never brings the old ok back. A good read restores it.
  - r19's unit assertion "a newer failure doesn't hide a good record" encoded the defect; it now asserts `unavailable`.
- **Real app: not seen.** No read failed in any walk, and the walks don't write to the scratch data.

### 2. Status claims only what's true
**Done.**
- **The line:** "4 records need rewording by their rooms" (one record: "1 record needs rewording by its room"), in the same quiet style. It has no action, no "›" and no rows.
- **Opened:** a read-only list of titles.
- **Wording removed:** the sheet's "Uni is tidying it: it will come back as one clear request, or be closed" now reads "It needs rewording by its room as one clear request, or closing." Its status reads "Needs rewording by its room: not a request yet".
- Nothing starts a repair from the app.
- **Real app:** "4 records need rewording by their rooms". Opened, it listed "Mail: approve a test week, not an immediate cutover", "Uni adds Benya's missing feature 4", "A daily calendar email to people" and "Texting is not recommended for this year because carrier", with 0 buttons and 0 "›".

## Required fixes

### No "›" on any row or link row
**Done.**
- "Sadhana: 1 for you" has no arrow.
- "N more ›" and "+N more ›" now read "Show N more".
- Uni's upkeep fold draws "+" (and "–" when open), like the Later fold.
- "Answer in Needs you ›" under a chat message lost its arrow.
- A row's "Answer N questions ›" and "Open the note to answer ›" are now quiet lines inside the row.

**Real app:** every row in every walk counted 0 "›". The panel read "Show 15 more", the private line "Sadhana: 1 for you", and the upkeep summary's glyph `"+"`.

**The "›" glyphs left in `src`, none on a row:**

| Where | Why it stays |
|---|---|
| Breadcrumb separators (`TreeHome.tsx`) | A path separator, not a link row |
| The collapsed sidebar's "Show the sidebar" button and the companion's hide chevron | Icon buttons |
| The room header's "App ›" button | A header button |
| Setup's "Ask Uni to set it up ›" | A button |
| Inside the task sheet: "Open the note to read the question ›", "Open the note ›", "From <source> ›", "Open the note to answer ›", "This task's note ›", "Say it in #room ›", "<destination> ›" | Inline links and buttons in the sheet |

### The 800×600 sheet has a bottom margin and its border is visible
**Done.**
- Above 600 px wide, the sheet floats with a 12 px margin and its whole border and radius.
- An upright phone keeps the sheet that rises from the bottom edge.

**Spec:** 800×600, bottom ≥ 8 px from the edge, border-bottom > 0.

**Real app, ATLAS sheet** (r20 ran off the bottom edge):

| Size | Margin, top and bottom | Border-bottom | Radius |
|---|---|---|---|
| 800×600 | 33 px | 2 px | 18 px |
| 740×360 | 19 px | 2 px | 18 px |
| 920×360 | 19 px | 2 px | 18 px |

Archive and Snooze sat above the footer at each size. Screenshot: `r21-worker-800x600/n4-sheet.png`.

### One target per visible request (Codex 10)
**Done.**
- Every Needs-you row (action, decision, checking, check, missing, tidy, private) is one `<button>` that opens its sheet.
- Inside the row, links are words (the address is in the tooltip) and linked notes are titles, not buttons. The step under a title, "Answer N questions" and "Couldn't check · Retry" are quiet lines inside the button.
- Links and notes open from the sheet.

**Spec:** in the Techne work view, every row has exactly one focusable element, a non-nested button, and Enter opens the sheet.

**Real app:** every row in every walk had `targets: 1, nested: 0`.

## P2s
- **Codex 6, the Journal: done.**
  - "✦ Pass to Uni" and "Share to…" under every entry are gone. Each entry has one "⋯" menu, as a chat message does: Pass to Uni, then "Share to a room…" with the rooms.
  - Spec with three fictional entries.
  - **Real app: not walked.** The walks never open the Journal.
- **Codex 9, cold launch: done.**
  - While the conversation opens, the chat column is a quiet chat: a muted "Opening the conversation…" and the composer's line greyed with its placeholder. It's never a status panel.
  - Past 8 s it reads "Still opening the conversation · Retry". Retry reopens the room, or re-reads the rooms list when the room isn't known yet.
  - `.sr-chat` carries `data-chat="waiting|open"` for measuring. Spec with `roomsDelay`.
  - **Real app:** in the cold decision walks, the chat read "Opening the conversation…" from about 0.4 s until the driver left for the work view (about 0.9 s).
  - In the driver-r12 cold run (below), everything loaded slowly, and the 9 s shot read "Still opening the conversation · Retry" beside "Still loading what needs you · Retry". At least it didn't read as a frozen status line.
- **Codex 8, area apps: done.**
  - Looking for an app is `loading`, `absent` ("not found"), `failed` (any other error) or `ready`.
  - A failed look keeps "App" in the header. It opens to "Couldn't check for this area's app: <reason>." with Retry.
  - An invalid manifest no longer shows "Opening this area's app…" beside "was not opened".
  - Specs are in `interface.spec.ts` (areas config). **Real app: not walked.**
- **Codex 5, For you: done.**
  - For you opens without Edit, New note or Copy markdown. "Open as a note" reveals them.
  - `rail.spec.ts` asserts it. **Real app: not walked.**
- **Codex 7, recovery: part.**
  - A note still opening after 8 s says "Still opening this note." with Retry and "Back to …".
  - A failed search says "Couldn't search messages just now. Retry" and "Couldn't reach your vault just now. Retry", with the raw error under Details.
  - **Not done:**
    - a vault without a pack still replaces the room shell (`LifeOsSurface`);
    - sign-in pairing still shows raw exception text.
- **Codex 3, home and Back: part.**
  - Recent is kept in a short Places drawer (under 500 px tall) as one line of places under the tree. A spec at 740×360 picks a place from it.
  - **Not done:**
    - an upright phone still launches on the tree;
    - there are no "Up to …" labels;
    - Journal's and Vault's Back still return to Uni.
- **Codex 4, dialogs: done** for the two named exceptions.
  - Pairing's native dialog registers in the dialog stack, so Escape cancels pairing first and Settings stays open (spec). A second Escape closes Settings.
  - `SurfaceModal` (New note, confirmations) now uses `openDialog` rather than its own focus code.
  - One loss: Tab no longer reaches the recording pill's Stop from inside a prompt. The pill stays live for the mouse.
  - **Real app: not walked.** Pairing isn't available on Linux.
- **Not done:**
  - Codex 11 (P3: upkeep out of the timeline, "Working on T-124");
  - Codex 12 (P3: type, icons, motion);
  - the remove list (`ChatLayout`, `parseLayout`, orphan styles).

## Found in the real app
1. **The folded strip showed step 1 as the whole job** (`r21a`, 800×600): "Needs you · 18: Look at cohere-signup-staging.unforced.workers.dev on phone…".
   - One line can't hold every action, so a two-step action now says "2 steps: Look at cohere-signup-staging on phone, then …".
   - A long host reads as its first part, and brackets are left to the row.
   - Spec added. In the final runs all three sizes read "Needs you · N: 2 steps: Look at cohere-signup-staging on phone, then …".
2. **A private area's task showed as an ordinary row on a cold launch** (`r21a-worker-checking-800x600`). Before the areas were read, Uni's work view listed a Sadhana task by its action, with "Sadhana" under it. Its words are not quoted here; they are in that run's local walk log, as they are in r20's.
   - **Why:** privacy was read only from the areas tree. The same leak is in r20's `r20-worker-checking` log, so it predates this round.
   - **The fix:** privacy is now read from the task tree until the areas are, and nothing is listed while neither is known.
   - **Spec:** the areas held 6 s; a MutationObserver never sees the private item's words. With the fix reverted, the spec fails.
   - In the final cold runs at all four sizes, the only Sadhana row was "Sadhana: 1 for you".

## Real-app check
1. **Builds:** debug with `--features custom-protocol`.
   - The frontend was built with plain `vite build` into `/tmp/r21-dist`. Each build was checked for no `__T76_MOCK`, `__slowMs`, `__tagDelay`, `__noteDelay`, `__noteFails`, `__seedTasks`, `__journal`, `__searchFails` or `__pairAvailable`.
   - Binaries are in `~/.hermes/cache/scratch/r21/`: `uni-app-tauri-r21a` (`e47cd06` + Codex 6/9/8) and `uni-app-tauri-r21` (`2281ae0`, final).
2. **Final set** (`r21-walks.sh`, scratch hub `:19390`):
   - `r21-worker-cold`, `r21-worker` and `r21-worker-load`, with `driver-r12.js` (`WALK_KEEP_HOME=1 WALK_HOME_NAME=r21w`). For the load run, `nice -n 19 stress-ng --cpu 2 --timeout 200s` was started 3 s before launch and killed by its own PID.
   - `r21-worker-extra` (1280×720), then `r21-worker-800x600`, `-740x360` and `-920x360` on the same home.
   - `r21-worker-checking` at 1280×720, 800×600, 740×360 and 920×360, on throwaway homes.
   - Drivers are in `walk/drivers-r21/`, assembled into `walk/driver-r21-{extra,narrow,cold}.js`. They only look. They never send, and never press "Say it", "I did this", Archive or an answer. They never open the Journal or a private area. Journal entries are blurred by the driver's own style.
3. **driver-r12 results:**
   - The warm and load runs reached all nine shots. The warm run's only miss was "area collapse controls", as in r18–r20; the load run missed nothing.
   - **The cold run was slow.** At 9 s and 15 s the tree was empty, the companion read "Loading…" ("Still loading what needs you · Retry" at 9 s) and the chat "Opening the conversation…", then "Loading messages…". It missed COhere, atlas/teach and the Recent check.
     - The first set (`r21a-worker-cold`) did the same, and so did r20's first set.
     - The machine's load average was 7–9 from other sessions throughout.
     - The four cold decision walks on fresh homes loaded their lists in 8–9 s.
     - I didn't find a cause in the app.
     - The privacy gate in `2281ae0` isn't it. The task list is only read after the task tree (`loadTasks` awaits it), so the gate never holds a list that has arrived. The sidebar's areas list, which the gate doesn't touch, was empty too.
4. **The first set** (`runs/r21a-*`) is kept. Both found-in-app bugs came from it.
5. **No writes** to the scratch data. The task steps used in tests were read from a read-only copy of the scratch vault database.
6. **Cleanup:** `~/.hermes/cache/scratch/t124-apphome-r21w` and `-r21c` are removed (`walk.sh` and the script). `pgrep` shows no stress-ng, cage or app process of mine.

**Not seen in the real app:**
- "Couldn't check · Retry", and the P1-1 invalidation (no read failed);
- "Couldn't find …" (no live record has a missing note);
- the Journal's menu, For you's read-only bar, area-app failure, pairing over Settings, a slow note and a failed search (not walked);
- "Still opening the conversation · Retry" on a warm launch;
- a row that needed the last-resort cut (none in the scratch data did).

## Tests
- **tsc:** clean.
- **`npm test`:** passes, including `scripts/simpleR21.test.ts` (4 checks).
- **`cargo test -p uni-core --offline`:** 90, 1 and 22 pass.
- **Playwright `simple`:** 466 passed, 0 failed, 44 skipped on `2281ae0`.
- **Other configs:**

  | Config | Result |
  |---|---|
  | areas | 250 pass, 2 skipped (with the new Codex 8 spec) |
  | roomsnav | 27 pass |
  | nested | 6 |
  | chatoptional | 6 |
  | screens | 7 |
  | rail | 18 (with the For you assertion) |
  | sidebar | 14 |
  | default | 422 pass, 13 fail, 47 skipped |

- **The default config's 13 failures:**
  - 10 are the known `vault-links` ones (5 × 2 projects).
  - 2 are the roomsnav private-line spec, which still expected "Sadhana: 1 for you ›". I moved it to the no-"›" rule after the run. It then passed in the roomsnav config (27/27) and in the default config's two projects.
  - 1 is `composer.spec.ts` "T81 permanent error stops automatic retries: storage failure" (desktop). It passed when re-run alone on all its projects (6/6). I read it as a flake under the machine's load, but haven't proved it.
- **Not run:** `lifeos-vault`, `interface-webkit` and `webkit`.
- **Specs moved to r21 rules:**
  - two-line actions → whole actions within three lines (r7, r10, r15, r16, r20);
  - a row's links, notes, "Answer N questions" and Retry are inside its one button (r9, r15, r18, r19);
  - "+N more ›" / "N more ›" → "Show N more";
  - "Sadhana: 1 for you" has no arrow;
  - "Checking what's needed…" is no longer a row's title (r19, r20);
  - "Uni is tidying N records" → "N records need rewording by their rooms";
  - a two-step step's sheet is "2 steps" (r12).

## Watch
- **"2 steps: A, then …" not "2 steps: A ›…".** The task asked for "2 steps: A ›…" and also for no "›" on any row, so the form ends "then …".
- **";" clauses go to the sheet.** "Edit and send the ATLAS follow-up…; fill the opening, sign-off and next-review date" leads with the sending; "fill the opening…" is the sheet's. COhere's "; yes/no on add-only DB migration" is also only in its sheet. If either should be on the row, the rule would treat a ";" clause that starts with a verb or "yes/no" as a step, and those rows would read "2 steps: …".
- **The 236 px panel drops brackets first.** "Tell Uni who pays and how: crypto or ACH/Stripe, plus Woven Web's legal details" loses "(Techne or Gitcoin Foundation)" there, though the work view keeps it.
- **A row's Retry is the row's tap.** "Couldn't check · Retry" is a line inside the one button, which retries and opens the sheet. That keeps one target per row.
- **The companion waits for privacy.** It says "Loading…" until the task tree or the areas are read. If both reads fail, it stays on the load-health line.
- **Data work for the rooms:** the four records to reword are still the decisions Uni wrote as statements on 10-06.
