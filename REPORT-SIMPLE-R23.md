# REPORT: Simple first, round 23 (T-124 r23): honest request dates, an approval that can't outlive its moment, and no ellipsis left

This round works on `feat/simple` from `879fc16`. It adds ten commits plus this report. Nothing is pushed.

- `fdc5fea` **The main round.** It covers:
  - P1: "asked" means asked;
  - P1: a moved-on approval leads with "Check in #room first";
  - no ellipsis in Needs you, sheets or the summary;
  - a step's `detail` is shown in its sheet;
  - and the three bugs: the sheet's footer, the freshness line, and Recent.
- `c9408c6` No "…" in a decision's preview. The old specs move to the r23 rules.
- `7ee9235` Only a *sending* step that points at words it doesn't carry asks the room for them. Adds the r23 specs.
- `87700d0` **Codex 8:** Ctrl+W acts on the foreground, and macOS Cmd+W is left to the native menu. Also removes the orphan styles (remove list).
- `a17f35f` **Found in the real app:** a detail's `[[links]]` are links, and the summary keeps "#38".
- `3db4f8c` A row names the room that stewards it, as its sheet does. A task with a draft note isn't asked for.
- `1d5af5a` **Found in the real app:** a row's clamps never draw "…".
- `758adf0` **Found in the real app:** the asked date and the moved-on cue lead the sheet.
- `b18303a` Spec updates.

Across `src` and `src-tauri`: 10 files, about 233 lines added and 82 removed. New tests:
- `scripts/simpleR23.test.ts` (5 checks);
- the `r23` block in `scripts/browser/simple.spec.ts` (8 specs, on three projects; three of them are wide-only).

## Scratch data, as the real app shows it now (refreshed 13:49)
- **T-90 is gone.** No "Say go on prod deploy of #38 + #58" row appears in any walk, from Uni's work view or from COhere's room.
- **17 requests** are in Uni's work view, plus the private count line.
- **COhere's own "Where this stands" note** still reads "…prod waits on Aaron's Wed 10-14 go for #38, #58, #62". That is the node's `stands` field in the vault, which #cohere hasn't rewritten since T-90 closed. The app shows it as stored. At 236 px it shows only the clause before the ";", and "More" shows the rest.

## P1: "asked" must mean asked (Codex 2)
**Done.**

**What the writer records** (read only, from `~/Code/uni-tasks/tasks.py`):
- `tasks.py new` writes `created` (a date).
- No time is recorded when `next` changes: `set --next` writes only `next`.
- There is no `asked_at` or `next_at`.
- Decisions carry an `asked` field (indexed in the vault).

**The rule** (`requestDate`, `askedLine` and `chatMovedOn` in `simpleCore.ts`; parsed in `taskCore.ts`):
1. An explicit request time (`asked`, `asked_at` or `next_at`) reads "asked Oct 6".
2. Otherwise the date the task was added reads "added Oct 11": the task's `created` field, else the note's `createdAt`.
3. Neither known: no date.
4. **`updatedAt` is never used.** A rebalance or a priority change leaves the date as it was.

**The moved-on cue uses the same date and the same word:** "Chat has moved on since this was added" (or "…asked"). A date with no time counts from the end of that day.

**Specs:**
- `r23 › "asked" means asked`: "asked Oct 6" from an `asked` field, "added Oct 6" from `createdAt`, and a rebalance (new `updatedAt` and priority) keeps "added Oct 6". It also checks the sheet's "Added Oct 6" and its cue.
- The unit test covers each field's order and the rebalance.

**Real app** (every walk, every size): 15 of the 16 non-private rows read "added …" and one decision reads "asked Oct 13" (its `asked` field).
- **Most rows read "added Oct 10", and that is accurate.** These tasks were migrated into `uni` at 2026-10-11T04:35Z, which is the evening of Oct 10 in Mountain time. They carry no `created` field, so the note's `createdAt` is the only date there is.
- Tasks written by `tasks.py new` read their own day: staging "added Oct 11", ATLAS "added Oct 12", the gateway and migration tasks "added Oct 13".

## P1: an approval request can't outlive its moment (Codex 1)
**Done.**
- **When a sheet shows "Chat has moved on"** and its request is said in a room ("Say it in #room"):
  - "Check in #room first" is the one primary action. It opens the chat and types nothing.
  - "Say it in #room ›" stays, as a secondary button.
- **A fresh request** keeps "Say it" as its primary.
- **Not done:** binding to a `release` or `revision` field. Neither exists in the records, so I didn't invent one.
- **Spec** `r23 › an approval can't outlive its moment` checks both cases: one primary, Say it not primary, Check in opens the chat with an empty composer.

**Real app:** at every size, 12 of the 16 non-private sheets show the cue. The three room-directed ones lead with "Check in #… first" and keep "Say it" as secondary:
- "Tell Uni how to reach the friends box…" ("Check in #Uni first")
- "Reply: keep or archive the 87 Tana tasks…" ("Check in #Uni first")
- "Tell Uni who pays…" ("Check in #cohere first")

The other cued sheets aren't said in a room ("I did this", "Copy the message"), so their primary is unchanged.

Screenshots: `z2m-checkin` (1280×720), `n4m-checkin` (800×600, 740×360, 920×360) and `n4m-movedon`. Nothing was pressed.

## Text: no ellipsis
**Done in Needs you, sheets and the summary.**
- **A step stored cut short** (the writer's 140 characters) is shown as stored: the partial last word goes, and there is no "…". The sheet's apology is now "(the note ends here · open the note)", where "open the note" opens it.
  - Real app: the gateway task (T-130) shows that line, with no "…".
- **"Where this stands":**
  - Raw ids go: run numbers, hashes and long links, including a bracket that holds one. "(run 38456928492 green)" is gone.
  - Then the whole sentence shows when it fits 3 lines. Otherwise the summary shows the longest form that ends on a clause (";", ":", a spaced dash or a sentence end), and "More" shows all of it.
  - Real app, at 236 px: Uni's reads "Coordinates five areas with cascading approvals due this week." and COhere's reads "Staging has the D2 one-app with Eileen's copy, photos and Spanish."
  - At 800×600, 740×360 and 920×360 both are whole on 2 lines.
  - `rawId: false` and `ellipsis: false` everywhere.
- **The summary keeps "#38".** It used to strip every "#", so the line read "go for 38, 58, 62". Only a heading's "#" goes now. Found in the r23b walk.
- **Rows:**
  - `WordClamp` never draws "…".
  - A decision preview is whole sentences or whole words.
  - A row's CSS clamps (title, step under a title, small print) are a height of `--lines` lines, not `-webkit-line-clamp`, which always draws "…".
  - Found in the r23b walk: the gateway row's step ended "(paste the same key…".
- **Specs:**
  - `r23 › no ellipsis`: a 140-character cut step, its row and its sheet, and the "(the note ends here · open the note)" line.
  - Unit tests cover the raw-id stripping (run number, hash, long link) and the clause forms.
  - The r10 summary spec, r16's preview, r17's "cut action" and the navtree preview test move to the r23 rule.
- **Real app:** every row and every scanned sheet has `ellipsis: false`, at every size.
- **Left:**
  - the progress words "Checking…" and "Saving…";
  - `refName`'s short id for a missing note ("uni:01M3ZK2R6A…"), which shows only when a note a task stands on is missing (none live).

## Text: "…message below" with nothing below
**Done.**
- **A task's `detail` is now read and shown in its sheet,** under the request: paragraphs as stored, `[[links]]` as links and ids as notes.
- **When the detail quotes the message** ("Send this to Ryan: 'Hey Ryan, …'"), that quote is what "Copy the message" copies. It is the primary.
- **A sending step that points at words it doesn't carry** ("Send … the message below", "Send the draft") with no `detail`, `message`, `draft` field, draft note or note link reads "Ask #room for the message" ("…for the draft"). The room is the one that stewards the node, on the row and in the sheet. The sheet's primary is "Ask in #room ›", which types a request in that room's composer and never sends it.
- **Only sending steps count** (send, forward, paste, post, share, email). The first version also rewrote "Your OK on the draft" and "Edit the draft, …", whose drafts exist elsewhere; the full spec run caught it (`7ee9235`).
- **Specs:**
  - `r23 › "…message below"`: the detail shown, "Copy the message" primary and no "Ask Uni to draft it"; with nothing stored, "Ask #techne for the message" on the row, the sheet's heading and "Ask in #techne ›".
  - The r19 fixture with T-95 and no message now expects the "Ask #… for the message" row.

**Real app, the Ryan row (T-95), at every size:**
- The row reads "Send Ryan the deploy-access message below (asks for Cloudflare Pages access to bouldernewtech)" with "Boulder New Tech · added Oct 10".
- The sheet shows the stored message and its draft links. "Copy the message" is primary.
- Screenshots `z2r-ryan-row`, `z2s-ryan-sheet`, `n3r-ryan-row` and `n3s-ryan-sheet`. Nothing was copied or pressed.
- No live row hits the "Ask #room for the message" case.

## Bugs
- **The sheet's footer never covers its body (920×360, 740×360). Done.**
  - The sheet is a column: its body scrolls in its own region (`.task-body`), and the footer sits under it instead of being sticky over it.
  - The asked date and the moved-on cue are the first line under the sheet's kind. Found in r23b at 740×360: the cue sat at the bottom of the body, half clipped.
  - **Spec** `r23 › a short window` at both sizes: the cue is whole in view above the footer, the body ends where the footer starts, and scrolled to its end, the body's last line is above the footer.
  - **Real app:** the "Check in" sheet's cue is at the top (y = 47 against a footer at 189, at 360 px tall) at 740×360 and 920×360.
  - The walk's `underFoot` check flagged one sheet at 800×600 (the gateway's "(the note ends here…)" line). That is a rectangle test that doesn't know the body clips: the line is below the body's visible region, not drawn under the footer. The screenshot `n4m-*` and the spec show the body ending at the footer.
- **One freshness line at a time. Done.**
  - Beside a room (the sidebar column), the tree no longer shows its own "As of … · refreshing…" or "Couldn't refresh". The companion, or below 900 px the room's strip, says it once.
  - Error lines that only the tree has (a tree that couldn't be read, partial pages) stay.
  - **Spec** `r23 › one freshness line`: a saved copy being read again, then exactly one "N as of … · refreshing…".
  - The r12 spec now asserts the tree doesn't repeat "Couldn't refresh".
  - **Real app:** `r23-worker-extra` caught one line, "17 as of 2:18 PM · refreshing…", in the companion only.
  - **Not reproduced:** the r22 doubled screen. The load run's refresh finished before its screenshots.
- **Recent never overlaps the area list (1280×720). Done.**
  - The tree already scrolled in its own region. Its last visible row was clipped flush against Recent's rule, which read as an overlap.
  - Now, while rows run on below, the region's last line fades out (`data-more`).
  - **Spec** `r23 › Recent never overlaps`: the region ends at or above Recent, `data-more` while scrolled up and none at the end.
  - **Real app** (`z8-recent`, every area unfolded): `wrapBottom 598`, `recentTop 598`, `overlap: false`, the tree scrolls and fades.

## P2s
- **Codex 8, keyboard close: done (Linux only).**
  - On macOS the page ignores Cmd+W, which the native menu's Close Window owns.
  - On Linux and Windows, Ctrl+W with a dialog open closes that dialog, as Escape does, and the place stays. With no dialog, it closes the note or vault view as before.
  - Spec `r23 › Ctrl+W acts on the foreground`.
  - Not seen on macOS.
- **Remove list, part: done.** The orphan styles `.th-stump`, `.th-toprow`, `.rooms-header`, `.phone-panel-tools` and `.landscape-panel-surfaces` are gone (no code used them).
  - `ChatLayout`, `parseLayout` and `layout.chat` stay: `areaRoom.test.ts` covers the manifest hint, and removing it is a contract change.
- **Not done:**
  - Codex 3: an upright phone still opens on the tree, and there are no "Up to …" labels.
  - Codex 4: cold-launch instrumentation. Today's cold run reached all nine shots (below), but nothing was measured.
  - Codex 5: For you and Journal in the room's rules.
  - Codex 6: setup and errors in the common frame.
  - Codex 7: compact state as a modal workflow.
  - Codex 9 and 10 (P3): bookkeeping in daily surfaces; type and icon vocabulary.

## Real-app check
1. **Builds:** debug with `--features custom-protocol` (`~/.hermes/cache/scratch/r23/build.sh`).
   - The frontend was built with plain `vite build` into `/tmp/r23-dist`, with `TAURI_CONFIG` pointing `frontendDist` at it.
   - Each build was checked for no `__T76_MOCK`, `__slowMs`, `__tagDelay`, `__noteDelay`, `__noteFails`, `__seedTasks`, `__journal`, `__searchFails` or `__pairAvailable`.
   - Binaries: `uni-app-tauri-r23` (final, `b18303a`), plus `-r23a` and `-r23b` (exploratory, `fdc5fea` and `c9408c6`).
2. **Final set** (`r23-walks.sh`, scratch hub `t124-scratch-hub3` on `:19390`):
   - `driver-r12.js` three times on one home (`WALK_KEEP_HOME=1 WALK_HOME_NAME=r23w`): `r23-worker-cold`, `r23-worker`, then `r23-worker-load`.
   - The load run had `nice -n 19 stress-ng --cpu 2 --timeout 200s`, started 3 s before launch and killed by its own PID.
   - Then `r23-worker-extra` (1280×720) and `r23-worker-800x600`, `-740x360` and `-920x360` on the same home.
   - Drivers are `walk/driver-r23-{extra,narrow}.js`, assembled from `walk/drivers-r23/`. They only look: they open sheets and close them. They never press "Say it", "Check in", "Ask in", "Copy the message", "I did this", Open, Archive or an answer. They never open the Journal or a private area, and they skip private rows when scanning sheets.
   - **Interrupted run:** my background job hit its 10-minute limit during the 920×360 walk and was stopped. Its partial run is kept as `runs/r23-worker-920x360-killed`. I reran 920×360 alone on the same home with the same binary (`r23-worker-920x360`), and it completed.
3. **driver-r12 results:**
   - **Cold run:** all nine shots. Its only miss was "area collapse controls", the miss r18–r22 had on warm runs.
   - **Warm and load runs:** all nine shots, no misses.
4. **Exploratory set** `runs/r23b-*` (`c9408c6`). Found-in-app items:
   - the step's `[[links]]` showed raw;
   - "#38" read "38";
   - a CSS clamp drew "…";
   - the cue sat half-clipped at the bottom of a 360 px sheet.
5. **No writes** to the scratch data. The vault was read once, from a copy in `/tmp`, to see which fields exist; the copy is deleted.
6. **Cleanup:**
   - `~/.hermes/cache/scratch/t124-apphome-r23w` is removed.
   - `pgrep` shows no stress-ng or app process of mine.
   - **Privacy check:** I searched every r23 log and text file for "Sadhana". It appears only as "In Sadhana: 1 thing for you · open Sadhana" and as the tree's area name.

**What the real app showed, per required item:**

| Item | Seen |
|---|---|
| COhere and Uni companions | Yes: side panels at 1280×720 (`z1-uni-panel`, `z7-cohere-panel`), sheets at 800×600, 740×360 and 920×360 (`n2-uni-companion`, `n6-cohere-companion`) |
| A sheet with "Chat has moved on" | Yes: 12 of 16 sheets at every size; "Check in #… first" leads on the 3 room-directed ones (`z2m-checkin`, `n4m-checkin`) |
| "Where this stands" at 1280 and 800 | Yes: shortened at a clause at 236 px (More shows it whole, `z7m-cohere-stands-more`), whole at 800 |
| The Ryan row | Yes, at every size, with its message in the sheet and "Copy the message" primary |
| Recent at 1280×720 | Yes: no overlap, the tree scrolls and fades above it (`z8-recent`) |

**Not seen in the real app:**
- the "Ask #room for the message" row (no live sending step lacks its words);
- T-90 and "Say go" (closed in live);
- the r22 doubled freshness line (the refresh finished before the load run's screenshots);
- macOS's Cmd+W;
- an explicit `asked` date on a task (only a decision has one).

## Tests
- **tsc:** clean.
- **`npm test`:** passes, including `scripts/simpleR23.test.ts` (5 checks).
- **`cargo test -p uni-core --offline`:** passes (90 + 1 + 22).
- **Playwright `simple`** on `b18303a` (the final binary's commit): 500 passed, 0 failed, 46 skipped (14.4 min).
- **`roomsnav`:** 27 passed. **`screens`:** 7 passed.
- **Not run:** the default config (where `vault-links` is known failing), `lifeos-vault`, `interface-webkit`, `webkit`, `rail`, `areas` and `sidebar`.

**Specs moved to r23 rules:**
- "asked" may be "added" (r7, r15, r17, r18, r20, r22);
- r22's age spec sets `asked` (not `updatedAt`) and uses "Check in #room first";
- the summary is shortened at a clause (r10);
- no "…" in a preview or a cut action (r16, r17);
- "(the note ends here · open the note)" (r16);
- the tree doesn't repeat the freshness line (r12);
- the sheet body scrolls in `.task-body` (r19).

## Watch
- **"added Oct 10" is on most rows** because the migration created those notes. It is the honest date, but it is the migration's day, not the day Aaron was asked.
  - A truer date needs the writer to stamp `asked_at` when it sets `next` (`tasks.py set --next`). The app reads `asked_at` and `next_at` already.
  - That change is #uni-tasks' to make, not this branch's.
- **The moved-on cue now fires on 12 of 16 sheets,** because "added Oct 10" is older than every room's chat. Only room-directed requests change their primary action. If the cue reads as noise, it could wait for an `asked_at`.
- **COhere's `stands` still says prod waits on Aaron's go.** That is #cohere's note to rewrite now that T-90 is done.
- **"Check in #Uni first" appears inside #Uni itself.** There it just closes the sheet onto the same chat.
