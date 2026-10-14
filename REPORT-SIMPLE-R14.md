# REPORT: Simple first, round 14 (T-124 r14): Needs you that is complete, current and explicit at the edges

This round works on `feat/simple` from 43e9d34. It adds eight commits plus this report, and nothing is pushed:
- `adc9c58` Rust: deciding needs the revision whose question was read.
- `48a7b2e` The main round: questions keyed by revision, previews that never unlock answers, one load-health line, private areas, action-first rows.
- `8937231` Places whenever the rail is hidden, the drawer as a dialog, one utility-panel frame, plainer wording, tables and note titles in chat, the app version.
- `f99366a` The area app as a view inside the room shell, plus the new specs.
- `6805803` Area-app specs, dead side-chat CSS removed, the panel's fit fix.
- `2cff437` On phones the utility panel stops above the rail, plus spec updates.
- `bb3f205` Fixes from the real-app walk: bare note ids in chat, and `[done T-NN step]` markers.
- `9d95481` Dead CSS removed, two stale "Refresh to load it" lines, and one racy spec fixed.

Across `src`, `src-tauri` and `crates`: 29 files, 550 lines added, 559 removed. New: `LoadHealth.tsx`. Gone: `SideChat`, `ChatSheet`, `RoomChips`, `EmptyChat`, `ChatLayout` (and its focus-theft guard), the Room/App tabs, the area bar, the "Unforced / Uni" panel header, the raw-key composer field, the `.wr-*` work-page CSS and `.room.child`.

**Real app:** a debug build with `--features custom-protocol` (dist built clean by `check-release-dist.sh`), against the scratch hub, signed in as uni-reviewer. Every walk ran on one binary built from `bb3f205`, on one set of app data (`t124-apphome-r14w`), in this order:
- `r14-worker-cold`, then `r14-worker`: `driver-r12.js`, run exactly as specified.
- `r14-worker-extra`: my `driver-r14-extra.js`. It covers Settings, the one count, the chat, COhere's rows, decisions and work view, the task sheet, a borrowed-room header, and an area app if one exists.
- `r14-worker-800x600`, `r14-worker-740x360` and `r14-worker-920x360`: my `driver-r14-narrow.js`, through my copy of `walk.sh` (`~/.hermes/cache/scratch/r14/walk.sh`, which is r13's with `WALK_SIZE`). `randr.log` in each run shows the mode was applied. The page sees 800×553, 740×313 and 920×313, because the window title bar takes 47px.
- `9d95481` came after the walks. It only deletes unused CSS, changes two empty-state strings and fixes one spec. After it I re-ran `simple`, `screens`, `roomsnav`, `npm test` and tsc.
- `~/.hermes/cache/scratch/t124-apphome-r14w` has been removed.
- The drivers only look. They never send, answer, check anything off, allow an app, or open a private area. Nothing was clicked on an answer, on "Say it", or on "I did this".

**Privacy:**
- The scratch vault holds real journal entries.
- My first narrow walks captured them in `m5-journal` and in the frame videos. I deleted those three runs.
- The narrow driver now blurs `.journal-entry` with the walk's own style before anything is captured. The kept runs log `entriesBlurred: true`.
- **r13's narrow runs (`r13-worker-800x600`, `r13-worker-740x360`) took the same Journal step without a blur. Their `n5-journal.png`, `n6-back-home.png` and `walk.mp4` very likely show journal text.** I didn't reopen or delete them. Someone should.
- Nothing private is in this report or in the fixtures: the Sadhana tasks in specs are fixture text.

## P1s

### 1. The work view shows load health the way the companion does
**Done.**
- **One component:** `LoadHealth` (`src/areas/LoadHealth.tsx`) is used by the companion, the work view and the tree. It says:
  - "Couldn't load what needs you · Retry" when the first load fails.
  - "Couldn't refresh · Retry", with "Showing what was read at 10:02.", when a refresh fails after a first load. The rows stay.
  - "Couldn't read where tasks belong; some may be under the wrong place · Retry".
  - "More work exists than the app could read, so counts may be low · Retry".
- **Counts:** a count that might be incomplete reads "29+", with the label "at least 29". This applies after a failed refresh or an incomplete read.
- **Below 900px:** the room shows the line under its header (`.sr-health`), outside the drawer. The strip doesn't repeat it.
- **Specs:**
  - `r14 › work view: a failed refresh keeps the rows…`: rows kept, `N+`, Retry back to `N`, and the tree-read failure in the work view and the tree.
  - `…a list the app could not read whole…`: a vault that ignores `offset`.
  - `…below 900px the room says the list could not refresh outside the drawer`.
- **Real app:** no failure happened. Every walk logged `health: []`. **Not seen:** any of the four lines in the real app.

### 2. A decision's question is keyed by revision
**Done.**
- **Reads:** `loadAsks` returns each question with the note's own `updatedAt` it was read at. The task carries it as `askAt`.
- **Showing a question:** `decisionQuestion` only uses a question read at the row's revision (`askAt === updatedAt`).
- **The sheet:** it keys its own read by `id@updatedAt`. A new revision drops the old question at once. If the note it reads is newer than the list's copy, it says "This changed; reading the latest…", asks the list to re-read, and shows no answers.
- **The device cache:** it moved to `uni.asks.v2`. The r13 cache held 280-character previews, so they are never taken for a whole question.
- **The write:** `vault_decide` now requires `ifUpdatedAt`, the revision the question was shown at.
  - Rust: `decide_note(…, if_updated_at)` refuses a stale revision as `Conflict` before writing. It also sends that stamp, not a freshly read one, as `if_updated_at`.
  - The app says "This decision changed or was decided elsewhere, so your answer wasn't recorded. Showing the latest."
- **Tests:**
  - Rust `deciding_writes_with_the_revision_whose_question_was_read`: a stale stamp is a conflict with no `update-note`; a matching one sends exactly the stamp.
  - TS `tasks.test.ts` checks the exact `vault_decide` arguments, including `ifUpdatedAt`.
  - The fixture now refuses a stale `ifUpdatedAt`.
  - Spec `r14 › a question is keyed by its revision`:
    - Uni rewrites the note.
    - Answering the old question on screen is refused and nothing is recorded.
    - The re-read shows the new question.
    - A rewrite while the sheet is open replaces the question in the sheet.
    - The answer carries the new revision.
- **Real app, not seen:** a rewrite during a walk (no other writer), and any answer (never clicked).

### 3. A preview never unlocks answers
**Done.**
- **The extractor:** `askFromContent` returns the note's first paragraph, whole and never trimmed. Previews come only from `askPreview`, and always end in "…".
- **Answers:**
  - Answers show only when the whole question (the title when it isn't cut, else that paragraph at this revision) is drawn in full beside them, and it fits a row (≤ 280 characters, `ROW_ASK_MAX`).
  - A longer question shows its preview and "Open to decide ›" with no answers. The sheet shows the whole question with its answers.
  - A note that only repeats the cut title (ending in "…") is not a question.
- **Spec `r14 › a preview never unlocks answers`:** a 385-character question whose first four sentences fit 280 characters (the case r13 would have unlocked).
  - The row has a "…" preview, "Open to decide ›" and no Yes/No.
  - The sheet has the whole question with Yes/No.
  - The write's `ifUpdatedAt` is the note's revision.
- **Real app (`r14-worker-extra`):**
  - COhere's work view: three decisions, all whole and fitting, with answers (`previewsWithAnswers: 0`).
  - Uni's work view: one decision reads "Open to see the question ›" (`y3-uni-work`).
- **Not seen:** "Open to decide ›" in the real app. No decision in the scratch data has a question longer than a row ("none found").

### 4. Private areas
**Done**, with the rules as given.
- **From above** (Uni's panel, any parent level, the work view): one line per private area, "Sadhana: 1 for you ›", which opens the area. "A private item…" is gone.
  - Nothing else from a private area appears outside it: not in In motion or Later, runs, drafts, or the "where this stands" sentence. The sentence no longer draws on a private area's tasks.
  - The count and dots include them.
- **Inside the private area** (or a project in it): its items are ordinary rows with titles, actions and the task sheet. Its In motion, Later, runs and drafts show too. Another private area's items still show as one line.
- **Specs:**
  - `r14 › private areas: one line from above…; inside the area, real rows…`.
  - The r13 one-count spec.
  - `roomsnav`'s private spec.
- **Real app:** Uni's panel showed `Sadhana: 1 for you ›`. The count agreed: panel 29 (3 rows, 1 private, +25 in areas), dots 29, work view 29.
- **Not seen in the real app, on purpose:** the inside of Sadhana. I didn't open it, so its titles never reached a screenshot.

### 5. Global navigation never disappears
**Done.**
- **One rule:** `RAIL_HIDDEN_QUERY` in `homeLayout.ts`, `(max-height: 499px) and (max-width: 950px)`.
  - The App sets `.rail-off` on the shell from it, and CSS hides the rail only by that class.
  - The room shows Places when `!wide || railHidden`.
  - The phone tree home's places row also follows `railHidden`.
- **Spec `r14 › 920×360`:** no rail, Places in the header, every place; Settings opens in the panel frame. At 1000×360 the rail is back and Places is gone.
- **Real app, 920×360:** `railVisible: false`, `placesButton: true`, and the sidebar tree is still there (`m2-cohere`). The drawer had Journal, For you, Vault, Search and Settings. Settings, Search and Vault opened from it, and the Journal's "Back to Uni" returned to Uni.

## P2s
- **One action-first row:** done.
  - A step that names an action leads the row and gets 2 lines, then More. Its links and linked notes still open. The title is the quiet line under it.
  - This is the same `NeedRow` in the companion and the work view, and the sheet leads the same way.
  - Real app: `"Say go to deploy #38 (companion) + #58 (Today/Calendar) to production by Wed 10-14."`, with "COhere opens Oct 15" under it.
  - "Confirm your role in Riverside and the dates (cure/purchase window ~Nov 17, auction ~Dec 2) so the tracker can stay current." reads in full in Uni's work view (`y3`). In the companion it is 2 lines, then More.
- **The sheet:** done.
  - One primary action: "Say it in #room ›", else "I did this". Then I did this, Archive, Snooze, and a quiet "Open in #room" and Close.
  - Now/Soon/Someday are under Details.
  - Real app: `y9-task-sheet` and `y9b-task-details`. The driver's `priorityVisible: true` is wrong: closed `<details>` content still measures as visible in WebKitGTK, and the screenshot shows it hidden.
- **Project header:** done.
  - A node in a borrowed room reads "Conversation in #atlas", once.
  - Real app: Atlas Institute (`y10`). COhere shows "#cohere" once.
- **Area App:** done in code and specs.
  - "App ›" in the room header opens the app as a view inside the shell: same header and tree, "‹ Back to chat · X app", and Stop/Revoke in the bar's ⋯ menu.
  - Escape and Alt+← close it.
  - "Add to draft" fills the room's own composer and goes back to the chat.
  - The manifest's `layout.chat` hint is still parsed but changes nothing.
  - `areaRoom.spec.ts` was rewritten for this. Focus theft can't happen now, because the app and the composer are never on screen together, and a spec checks that the thief hears nothing.
  - **Not seen in the real app:** no area in the scratch vault has an app note.
- **One utility-panel frame:** done for Settings, Search and Vault.
  - Each has the destination's title and Close (`aria-label` is the destination). The "Unforced / Uni" header, its Search/Refresh/Settings buttons and the duplicate phone/landscape button rows are gone.
  - On phones the panel stops above the bottom rail, so the places stay in reach while it is open.
  - Real app: all three at all three narrow sizes, with `frameTitle` matching and `oldHeader: false`.
  - **Not done:** the Journal is still its own page with "‹ Back to Uni", not in this frame.
- **Places drawer:** done.
  - It is a `dialog`. Focus moves to the first place, Tab and Shift+Tab stay inside, and everything outside is `inert`.
  - Escape, Alt+← and Android Back close it, and focus returns to Places. The drawer's own ← still goes back a place.
  - Real app at all three sizes: focus inside ("Journal"), 24 Tab presses with 0 leaving, the room inert, real Escape closed it with focus on Places, and real Alt+← closed it, staying in COhere.
  - Escape did reach the page this time. r13 couldn't send it.
- **740×360 drawer:** done.
  - Short screens get a wider drawer (520px) and the places on one line. Recent steps aside.
  - Real app: `placesScrollSideways: false`, the places row 52px tall, and 7 tree rows fully shown (`m3-drawer`).
- **Wording:** done.
  - Task-state markers are taken out of messages, no longer shown as chips. `[done T-02 step]` is one too (the walk found it).
  - A note cited by id (`uni:01M…`, bare or in code) reads as its title, or "a note" when it can't be read. The id stays in the tooltip. Bare ids followed by words are now linked.
  - Pipe tables render.
  - The raw-public-key field is gone from the composer.
  - A thread's failed first read says "Couldn't load the thread · Retry".
  - A vault without the pack says "'x' isn't set up for Uni yet", with the CLI command under Developer.
  - Pairing leads with Uni's own steps and a plain placeholder. Buzz desktop is one note after the steps.
  - Real app: 2 tables in the Uni room, 0 raw-id chips, 0 marker chips, no raw-key field. The cited note reads "a note" (`y4`). The id doesn't resolve in the scratch vault.
- **Settings version:** done. `getVersion()`, falling back to a new `app_version` command, else just "Uni". Real app: "Uni 0.1.5" (`y1`, `m4-settings`).

## Found by the walk (fixed)
- An unresolvable cited note fell back to showing its raw id. It now reads "a note" (`bb3f205`).
- `[done T-02 step]` was shown as text in Atlas Institute (`bb3f205`).
- Removing the area tabs made the companion 47px taller, which exposed a fit error. The panel could keep one row too many and overlap the footer by 6px. It now steps down a row when it still overflows (`6805803`, found by the spec).

## Tests
- tsc is clean.
- `npm test` passes. New unit tests:
  - the whole first paragraph and previews;
  - `decisionQuestion`, by revision;
  - asks carrying their revision;
  - private rows inside the area;
  - the decide arguments;
  - tables;
  - bare note ids;
  - qualified markers.
- `cargo test -p uni-core --offline`: 89, 1 and 22 pass (one new test).
- Playwright `simple`: 254 passed, 0 failed, 37 skipped (phone-only or wide-only cases). Run on `9d95481`. New `r14` specs, each run on mac, mac-small and phone:
  - work-view refresh failure;
  - an incomplete list;
  - the line outside the drawer;
  - a preview not unlocking answers;
  - a revision change clearing the question;
  - private aggregate versus inside-area rows;
  - Places at 920×360;
  - focus inside the drawer;
  - chat note titles, tables and markers.
- Other configs:

  | Config | Result |
  |---|---|
  | screens | 7/7 (re-run on `9d95481`) |
  | roomsnav | 27 pass (re-run on `9d95481`) |
  | areas | 248 pass, 2 skipped (`areaRoom.spec.ts` rewritten for the app in the shell) |
  | rail | 18 pass |
  | sidebar | 14 pass |
  | chatoptional | 6 pass |
  | nested | 6 pass |
  | default (composer and others) | 287 pass, 10 fail, 39 skipped |

  Areas, rail, sidebar, chatoptional, nested and default ran on `bb3f205`.
- **`vault-links` is known failing.** All 10 failures in the default run are its 5 tests on mobile and desktop.
- The r7 sidebar spec raced under load. After a reload the room shell remounts once just after its first paint. r13 does too, about 25ms in; r14 takes about 100ms, so the spec's single width read sometimes caught the swap. The spec now waits for the settled width: 16/16 under load, where it had failed 6 of 16.
- `lifeos-vault` was not run (it needs a scratch vault and failed at baseline). Its heading text was updated.

## Not done
- The Journal in the utility-panel frame.
- Codex P3s:
  - Note-title cache scoping and retry. Failed reads are still remembered for the session.
  - Shared icons and type across surfaces, and answer button sizes in lists.
- Anything about the area app in the real app (no app notes in the scratch vault).

## Watch
- **Action rows:** the lead clamps at 2 lines with More, so a long step reads "…+ #58…" until More is tapped.
- **800×600:** below 900px with the rail visible, the drawer still repeats the places (kept from r13 so the drawer is the same at every size under 900px).
- **Private areas:** inside a private area its items now show by title. This is my call from the task; Aaron can overrule it.
- **Old answers:** a decision answered from a list read before a rewrite is now refused. Expect the "changed or was decided elsewhere" line more often when Uni edits questions.
- **The Rust check:** `vault_decide` now compares the stamp before writing and also sends it. A vault that rewrites `updatedAt` formats would refuse every answer. The scratch hub and the fixture agree.
