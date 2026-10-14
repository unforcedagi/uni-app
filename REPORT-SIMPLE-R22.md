# REPORT: Simple first, round 22 (T-124 r22): rows say the whole job, a request shows its age, and the sheet says it once

This round works on `feat/simple` from `6d3b563`. It adds eleven commits plus this report. Nothing is pushed.

- `d4dabf1` **The main round.** It covers:
  - rows say the whole job (both critics);
  - private areas show the action, not the content;
  - P1: a request shows its age, with a cue when the chat has moved on;
  - Codex 7: the sheet says the request once.
- `1eeb4d5` **Codex 6:** no "Close Tab" in the macOS menu.
- `1b7be17` **Codex 5 and 9, part:** pairing failures in words; a quiet scrim; "asked Oct 13", never "yesterday".
- `604f01c` **Codex 2, part:** Journal's and the Vault's Back return to where they were opened from.
- `ac4fbf9` The small print keeps where a row belongs (the date part may wrap). The old specs move to the r22 rules, and the r22 specs are added.
- `2896028`, reverted by `f88292d`: Codex 10, part (an unpinned companion footer in short windows). **Found in the real app:** it hid "All of X's work" below the fold.
- `3cd98bb` Removes the dead "2 steps: A, then …" form and WordClamp's shorter-form fallback.
- `3ae104f` The r20 unit test moves to the r22 rule.
- `d10a469` **Found in the real app:** a wrapped date line started with " · ".
- `6a4f78e` The r17 spec reads a wrapped date line.

Across `src` and `src-tauri`: 13 files, about 221 lines added and 115 removed. New tests:
- `scripts/simpleR22.test.ts` (5 checks);
- the `r22` block in `scripts/browser/simple.spec.ts` (4 specs, on three projects);
- an assertion in each of r20's and r21's "whole action" specs.

## Rows say the whole job (both critics)
**Done.**

**The rule** (`actionOf`, `rowForm` in `simpleCore.ts`; `ActionLine` in `Companion.tsx`):
- **One form.** A row shows the whole action: every step ("A, then B") and every verb phrase.
  - There is no line clamp on the action, no "2 steps: A, then …" and no ellipsis.
  - `WordClamp`'s shorter-form fallback and `stepsLine` are gone.
- **A ";" clause that leads with a work verb is the user's too**, so it stays on the row. ATLAS now reads "Edit and send the ATLAS follow-up to Mark and Michael from your account; fill the opening, sign-off and next-review date".
  - A clause that doesn't lead with a work verb is context and goes to the sheet. Examples: "; Eileen signs off…" and "; yes/no on add-only DB…".
- **Past 160 characters** (links counted as their hosts), an action is shortened with words: first its brackets, then each link becomes "the link". No live action is that long today.
- **The folded strip's one line** says step 1 and how many steps there are: "Needs you · 18: Look at cohere-signup-staging on phone (step 1 of 2)". It never ends on "then …".
- **The companion shows fewer rows to make room:**
  - the side panel keeps at least two rows, then "Show N more";
  - the phone's inline strip keeps at least one, as before.

**Specs:**
- `r22 › rows say the whole job` runs at full width and at 236 px, for staging, Woven Web, ATLAS, who pays and COhere.
  - Each verb phrase is asserted in the rendered row, including "fill the opening, sign-off and next-review date" and "then talk with Eileen yourself".
  - It also asserts no "…" or "then …", no line clamp and no overflow.
  - In the side panel it asserts at least two rows, then "Show N more".
- The unit test asserts the same for each real step.
- The r21 strip spec now expects "(step 1 of 2)".

**Real app** (final binary `f88292d`, `r22-worker-extra` at 1280×720 and the narrow walks). In every row, `ellipsis: false` and `cut: false`.
- **Uni's work view (18 rows), the same at every size:**
  - "Look at cohere-signup-staging on phone, then forward #cohere's 'For Eileen' block (posted 10-13)"
  - "Edit and send the ATLAS follow-up to Mark and Michael from your account; fill the opening, sign-off and next-review date"
  - "Review the Woven Web handoff draft, fill the unknowns, then talk with Eileen yourself"
  - "Tell Uni who pays (Techne or Gitcoin Foundation) and how: crypto or ACH/Stripe, plus Woven Web's legal details"
- **Uni's side panel (236 px):** the staging row whole (4 lines), "Say go on prod deploy of #38 + #58", then "Show 16 more". Screenshot `z1-uni-panel`.
- **COhere's side panel:** staging, Say go, and who pays (with its brackets), then "Show 1 more". Woven Web is behind "Show 1 more". Screenshot `z7-cohere-panel`.
- **At 800×600, 740×360 and 920×360:**
  - Uni's companion sheet showed staging, Say go and ATLAS whole, then "Show 15 more".
  - COhere's companion sheet showed staging, Say go, who pays and Woven Web, all whole.
  - The folded line read "(step 1 of 2)" at every size.
  - Screenshots: `n2-uni-companion`, `n2r-uni-rows-*`, `n6-cohere-companion`, `n6r-cohere-rows-*`, `n3b-atlas-row`, `n3c-staging-row`, `n3e-woven-row` (the work-view row shots are at 800×600).
- **At 740×360 and 920×360,** COhere's companion sheet shows one row above its pinned "All of COhere's work" footer; the rest scroll (`n6r-cohere-rows-2`). See Codex 10 below.

### Private areas show the action, not the content
**Done.**
- **Each private item is its own row** in Uni's companion and work view (`privateAction`, `PrivateRow`).
  - When its step is a short work imperative (one step, a work verb, at most 7 words and 48 characters, no link, no date label), the row is "In Sadhana: <verb and object>", for example "In Sadhana: Book the dentist".
  - Everything else counts in one plain row: "In Sadhana: 1 thing for you · open Sadhana" ("2 more things" beside shown actions). That covers decisions, steps with no work verb and anything longer.
- **Both rows open the area,** where the items are ordinary rows with their sheets. The sheet's private handling is unchanged.
- **Specs.** Fixtures use made-up placeholders only:
  - `r22 › private areas show the action` shows "In Sadhana: Book the placeholder appointment" and "In Sadhana: 2 more things for you · open Sadhana".
  - A MutationObserver never sees the personal placeholder's words.
  - The unit test covers both cases and each "personal" reason.
- **Real app:** the one live Sadhana item is longer than a short imperative, so every walk showed "In Sadhana: 1 thing for you · open Sadhana" and no private words.
  - I checked by matching the item's own words against every r22 log and text file, without printing them: 0 hits.
  - The screenshots (`z3c-private-row`, `n3f-private-row`) show only that line, so they are kept.
  - Uni's 236 px panel still folds private items into "Show 16 more", as in r17.

## P1: a request shows its age (Codex 1)
**Done.**
- **Every Needs-you row** says when it was asked, from the record's last change, in its small print: "COhere opens Oct 15 · due today · asked Oct 13". Today reads "asked today"; any other day is a date, never "yesterday".
  - Where the row belongs is never pushed out for the date: in a narrow panel the date part wraps to a second line, starting with its words.
- **The sheet** says "Asked Oct 13" under the request.
- **When the room's last message is more than a day newer** than the request (the rooms list's `last_ts`), the sheet adds "Chat has moved on since this was asked · open the chat". "open the chat" goes to the room.
- Nothing is hidden and nothing guesses at meaning: the request, its action and "Say it in #cohere ›" stay.
- **Specs:** `r22 › a request shows its age` covers "asked Oct 6" on a row and its sheet, the cue when the chat is newer, no cue on a fresh request, and "open the chat".

**Real app.** T-90's sheet read the following, from Uni's work view and from COhere's room, at 1280×720, 800×600, 740×360 and 920×360:
- "Say go on prod deploy of #38 + #58"
- "Eileen signs off the copy/photos before/after (posting today); yes/no on add-only DB…"
- "Asked Oct 13 · Chat has moved on since this was asked · open the chat"

Screenshots: `z2d-t90-sheet`, `z7b-t90-sheet`, `n4-t90-sheet`, `n7-t90-sheet-cohere`.

**Not what the task expected: "asked Oct 13", not "Oct 11".** In the scratch copy, T-90 was created on 10-11 but its step was last rewritten on 10-13 at 17:00 UTC (version 12 of 13; read from a read-only copy of the scratch database, since deleted). The record's last change is the only time the app has, so it says Oct 13. Every other live row also reads "asked Oct 13", because the board was rebalanced that day.

The staging sheet also shows the cue: its record dates from 10-13 too, and #cohere has messages since.

## P2s required (Codex)
### The sheet says the request once (Codex 7)
**Done.**
- **The action is the body,** said once:
  - the steps, numbered under "2 steps";
  - otherwise the action as the heading;
  - then any context after it (COhere's "Eileen signs off…").
- **Removed:** the title line under the action and the repeated step with its links.
- **The record's title** is in Details: "Task T-90: COhere opens Oct 15". A check, a wait or a missing note still names its title, because there it is the subject.
- **A link in a step is a button in that step:** "Open cohere-signup-staging".
  - For a look/open/view/check/try/read step, that button is the primary action and "I did this" is secondary.
  - A "Say …" request keeps "Say it in #room ›" as its primary.
- **Spec** `r22 › the sheet says the request once`:
  - "Forward #cohere" appears once and the title only in Details;
  - the Open button in step 1 is the one primary, and "I did this" isn't;
  - Open calls `open_link` and writes nothing.

**Real app,** at every size: the staging sheet's heading is "2 steps". Then:
1. "Look at cohere-signup-staging.unforced.workers.dev on phone", with an "Open cohere-signup-staging" button (`primary: true`).
2. "Forward #cohere's 'For Eileen' block (posted 10-13)"

After the steps: "Asked Oct 13 · Chat has moved on…". "I did this" is not primary, and the record "Task T-113: …" is in Details. Screenshots `z2c-staging-sheet`, `n2s-staging-sheet` and `n5-staging-sheet`. Nothing was pressed.

### No "Close Tab" in the macOS menu (Codex 6)
**Done.**
- `install_tab_menu` is removed from `src-tauri/src/lib.rs`. macOS keeps its default menu, where File and Window say "Close Window" (Cmd+W), and that is what Cmd+W does there.
- The `uni://close-tab` listener and the unused `tabForDigit` helper (and its test) are gone.
- On Linux and Windows, Ctrl+W still closes a note or vault view.
- **Not seen:** this is macOS-only code, and I can't build or run macOS here. The Linux build compiles.

## P2s: as many as fit
- **Codex 2, Back, part: done.**
  - Journal's and the Vault's Back return to the place they were opened from ("Back to ATLAS", "← ATLAS"), not always to Uni.
  - The origin is kept for the session; a utility reopened at launch returns to Uni.
  - The r13 spec now walks ATLAS → Journal → "Back to ATLAS".
  - **Not done:** an upright phone still launches on the tree, and there are no "Up to …" labels.
- **Codex 5, the frame at the edges, part: done.**
  - A failed pairing says what happened in words (`pairingFailure` in `src/pairingCore.ts`), with the raw error under Details. Unit-tested.
  - **Not done:** a vault without a pack still replaces the room shell (`LifeOsSurface`).
  - Pairing isn't available on Linux, so this wasn't walked.
- **Codex 9, the scrim, part: done.** The task sheet and the companion sheet use a quiet dark scrim in both themes; the ink colour used to wash a dark screen bright. Type, icons and motion are **not done**.
- **Codex 10, the narrow companion: tried and reverted.**
  - Unpinning "All of X's work" in short windows gave the rows the height. But in the real app at 740×360 and 920×360 the footer then sat below the fold, and the walk couldn't find it.
  - Reverted in `f88292d`. The footer stays pinned, and one row shows above it in COhere's sheet at 360 px tall.
- **Not done:**
  - Codex 3 (cold launch);
  - Codex 4 (For you and Journal in the room grammar);
  - Codex 8 (upkeep and "records" bookkeeping in daily surfaces);
  - the remove list (`ChatLayout`, `parseLayout`, orphan styles).

  On Codex 3: today's cold runs were mixed (below). I didn't instrument the launch.

## Found in the real app
1. **A wrapped date line started with " · "** (`r22c-worker-extra`, 236 px panel): it read "COhere / · was due Oct 13 · asked Oct 13".
   - The row now measures whether its date part wrapped and drops the separator, with no flip-flop.
   - The spec asserts no leading "·" on a wrapped line.
2. **"All of X's work" below the fold** (`r22e-worker-740x360` and `-920x360`): this came from my own Codex 10 change, and the walk missed "All of work". I reverted the change.
3. **The small print dropped where a row belongs for the date** (`r22b-worker-extra`): Uni's panel read "was due Oct 13 · asked Oct 13" with no "COhere". Fixed in `ac4fbf9` (the date part wraps), before the final set.

## Real-app check
1. **Builds:** debug with `--features custom-protocol`.
   - The frontend was built with plain `vite build` into `/tmp/r22-dist`, with `TAURI_CONFIG` pointing `frontendDist` at it.
   - Each build was checked for no `__T76_MOCK`, `__slowMs`, `__tagDelay`, `__noteDelay`, `__noteFails`, `__seedTasks`, `__journal`, `__searchFails` or `__pairAvailable`.
   - Binaries are in `~/.hermes/cache/scratch/r22/`: `uni-app-tauri-r22` (final, `f88292d`), plus `-r22a` to `-r22e` from the earlier sets (their commits are in `r22*.commit`).
2. **Final set** (`r22-walks.sh`, scratch hub `:19390`):
   - `driver-r12.js` three times on one home (`WALK_KEEP_HOME=1 WALK_HOME_NAME=r22w`): `r22-worker-cold`, `r22-worker`, then `r22-worker-load`.
   - The load run had `nice -n 19 stress-ng --cpu 2 --timeout 200s`, started 3 s before launch and killed by its own PID.
   - Then `r22-worker-extra` (1280×720), then `r22-worker-800x600`, `-740x360` and `-920x360` on the same home.
   - Drivers are `walk/driver-r22-{extra,narrow}.js`, assembled from `walk/drivers-r22/`. They only look: they open sheets, and never press "Say it", "I did this", Open, Archive or an answer. They never open the Journal or a private area.
   - A private row's words are logged only when it is the count line, and a screenshot is taken only when no private action row is on screen.
3. **driver-r12 results:**
   - **Warm run:** all nine shots. The only miss was "area collapse controls", as in r18–r21.
   - **Load run:** all nine shots, no misses.
   - **Cold run: slow, as in r21.** It missed COhere, atlas/teach and the Recent check: the driver raced ahead in 22 s while the list was still loading ("Opening the conversation…", "Loading…").
     - The load average was 12–13 throughout, from other sessions' Chromium and workerd.
     - Three earlier cold runs today on the same scratch data (`r22b`, `r22c`, `r22d`) reached every shot. I didn't find a cause in the app.
4. **Earlier sets are kept:** `runs/r22a-*` to `r22e-*`. Found-in-app items 1–3 came from them.
5. **No writes** to the scratch data.
6. **Cleanup:**
   - `~/.hermes/cache/scratch/t124-apphome-r22w` is removed (`ls` shows no `t124-apphome-r22*`).
   - `pgrep` shows no stress-ng, cage or app process of mine.
   - The read-only DB copy in `/tmp` is deleted.

**What the real app showed, per required item:**

| Item | Seen |
|---|---|
| COhere and Uni companions with whole two-step rows | Yes, at 1280×720 (side panel) and at 800×600, 740×360 and 920×360 (sheets) |
| The ATLAS row, with "fill the opening, sign-off and next-review date" | Yes, at every size |
| The private-area rows | Yes: "In Sadhana: 1 thing for you · open Sadhana" (no private words) |
| "asked …" on T-90's sheet | Yes, but "Asked Oct 13" (see the P1 note) |
| "Chat has moved on" on T-90's sheet | Yes, at every size, from Uni's work view and from COhere's room |
| The staging sheet with its Open button | Yes: "Open cohere-signup-staging" in step 1, the primary |

**Not seen in the real app:**
- an "In Sadhana: <action>" row (no live private item is a short imperative);
- a 160-character action shortened with words (no live action is that long);
- macOS's menu;
- the pairing failure words;
- the Journal's and the Vault's new Back (not walked);
- a request without the moved-on cue in a room whose chat is quiet (every live room with a request has newer messages).

## Tests
- **tsc:** clean.
- **`cargo test -p uni-core --offline`:** passes (90 + 1 + 22).
- **`npm test`:** passes, including `scripts/simpleR22.test.ts` (5 checks).
  - A first run failed one timing check in `vaultlinks.test.ts` ("40k-char shorthand line took 1682ms") while Playwright was loading the machine.
  - Every test file then passed on its own, and the whole `npm test` passed on a rerun.
- **Playwright `simple`** on `f88292d`: 476 passed, 2 failed, 44 skipped.
  - The 2 failures were r17's innerText pattern, which didn't expect a wrapped date line without " · " (mac, mac-small).
  - It was fixed in `6a4f78e` and passes on all three projects (3/3).
  - I didn't rerun the whole config after that one-line spec fix.
- **`roomsnav`:** 27 passed. **`screens`:** 7 passed.
- **Default config:** 432 passed, 11 failed, 47 skipped.
  - 10 failures are the known `vault-links` ones (5 × 2 projects).
  - 1 is r19's "a sheet's text is cut by one rule" on `mobile`: a 30 s timeout waiting for the phone tree after a viewport change, with the machine at load 12–13. Run alone it passed twice (`--repeat-each=2`). I read it as a load flake, but haven't proved it.
- **Not run:** `lifeos-vault`, `interface-webkit`, `webkit`, `rail`, `areas` and `sidebar`.

**Specs moved to r22 rules:**
- rows have no line limit, and "; fill the opening…" is on the row (r7, r10, r15, r20, r21);
- small print says "· asked Oct N", and may take a second line (r7, r15, r17, r18, r20);
- the sheet's title is in Details, with the steps' links as buttons (r12, r13, r17, r19, r20, r21);
- the private line is "In Sadhana: 1 thing for you · open Sadhana" (r13, r14, r17, r21, roomsnav);
- the folded strip reads "(step 1 of 2)" (r21);
- Journal's Back goes where it was opened from (r13, screens).

## Watch
- **"asked" is the record's last change, not when the step was set.** The board was rebalanced on 10-13, so nearly every live row says "asked Oct 13". A rewrite of the record (a priority, a rebalance) resets it. A truer date would need the hub's version history or a `next_at` field written by the rooms.
- **The moved-on cue fires on most live sheets today,** because every room with a request has newer chat. If it reads as noise, the threshold (a day) could rise, or the cue could need a message that names the task.
- **T-90 is still the data conflict Codex described:** "prod waits on Aaron's Wed 10-14 go" sits beside a chat that has moved on. That is #cohere's to fix in the record; the app now shows the age and the cue, and hides nothing.
- **A private item outside its area opens the area, not its sheet.** The task said "the sheet keeps its existing private handling", and from outside the area there was no sheet before either.
- **Codex 10 is open:** at 360 px tall the companion sheet shows one row above its pinned footer.
