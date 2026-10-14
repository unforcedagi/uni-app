# REPORT: Simple first, round 17 (T-124 r17): nothing waiting on Aaron disappears, one answer mechanism, a lighter Uni panel

This round works on `feat/simple` from 4804caf. It adds six commits plus this report, and nothing is pushed:
- `8095a56` The main round: waiting on Aaron whatever the owner, the "Say it" classifier, one answer mechanism, questions held in notes, statement decisions, the three-row Uni panel, whole-word cuts, and the P2s listed below.
- `76337bc` The r17 specs, and r7–r16 specs moved to the r17 rules. "Edit" now leads a row as an action.
- `323a6c3` The strip's sheet keeps "All of …'s work" in sight, and closing it gives focus back to the strip's line (both missed in the r16 narrow walks).
- `b47655a` A side panel too short for even its first row keeps that row behind "+N more" instead of cutting it (920×360 with the panel open).
- `d255029` That zero-row rule applies to the side panel only; the phone's inline strip keeps its first row.
- `f9580ef` A cut decision line never ends on a joining word ("…this year because ›"). The areas fixture finds the tree in Places under 400px tall.

Across `src`: 20 files, about 450 lines added and 150 removed. New: `src/decisionLinks.ts` and `scripts/simpleR17.test.ts`. Deleted: `src/approvals.ts` and `scripts/approvals.test.ts`. The `scripts` diff also carries the simple specs' regenerated fixture screenshots (`__shots__`).

**Real app:** debug builds with `--features custom-protocol`. The frontend was built with plain `vite build` into `/tmp/r17-dist`; each build was checked for no `__T76_MOCK`, `__slowMs` or `__tagDelay`. It was passed in with `--config` (`frontendDist`). Scratch hub, signed in as uni-reviewer.
- **Binaries:** `uni-app-tauri-r17` from `76337bc`, `r17b` from `323a6c3`, `r17c` from `b47655a` and `r17d` from `f9580ef`. `d255029` changes only the phone's inline strip, which no Linux walk opens, so no walk ran on a build of it alone. `r17d` includes it.
- **Walks on one app home (`t124-apphome-r17w`), in this order:**
  1. `r17-worker-cold`, `r17-worker`, then `r17-worker-load`: `driver-r12.js` exactly as specified, on `r17`. The load run started `nice -n 19 stress-ng --cpu 2 --timeout 150s` 3 s before launch, and the whole walk ran inside it.
  2. `r17-worker-extra`: my `driver-r17-extra.js` at 1280×720, on `r17`.
  3. `r17-worker-800x600`, `-740x360` and `-920x360`: my `driver-r17-narrow.js` through r15's `walk.sh` copy with `WALK_SIZE`, on `r17`. Then all three again on `r17b` (`r17b-worker-*`), and 920×360 once more on `r17c` (`r17c-worker-920x360`).
- **Extra cold runs on throwaway homes** (deleted by `walk.sh`): `r17-worker-cold2` on `r17`, and `r17d-worker-cold` on `r17d`.
- `~/.hermes/cache/scratch/t124-apphome-r17w` is removed, and no `t124-apphome-*` folder is left. stress-ng exited on its own timeout; `pgrep stress-ng` finds nothing, and no app or cage process is left.
- **The drivers only look.** They never send, answer, or press "Say it", Copy, "I did this" or Archive. They never open the Journal or a private area. The extra driver opened sheets and closed them with Escape (dispatched in the page) or Close.
- **The box was busy.** Other sessions kept the load average at 5–9 during every walk, before any stress-ng.

## P1s

### 1. Work waiting on Aaron never disappears
**Done in code and specs. The scratch copy has no such case.**
- **The rule** (`needsYou`, `isMine` and the new `waitsOnMe` in `simpleCore.ts`):
  - A task whose `waiting_on` names Aaron (`aaron`, `Aaron`, `@aaron`, `person:aaron`) is in Needs you whatever its owner, at Now or Soon.
  - Its row leads with what it asks of him (its `next`, even when that isn't an action verb: "Your OK on the draft").
  - Under the row is a quiet context line: "From #atlas/teach · Canvas Week 7 brief draft" or "From Uni · …".
  - The tree dot lights, because the dots use the same rule.
  - The sheet says "Task of #atlas/teach" under Status.
- **The r16 rule still holds.** Uni's or a room's own drafting that waits on no one is not in Needs you. Someday stays in Later for everyone, including these tasks.
- **Specs:** `r17 › work waiting on Aaron…` covers a room-owned and a Uni-owned task (row, context line, work view, sheet, dot). There are unit tests for every owner and spelling. The r16 spec that said the opposite now checks the r17 rule.
- **The scratch copy, read only** (sqlite on `t124-vault/.../vault.db`, live tasks and decisions grouped by `waiting_on` and `owner`):
  - All 29 tasks with `waiting_on: aaron` are owned by `aaron`.
  - No other spelling appears, and no note uses `waitingOn`.
  - **No task owned by anyone else waits on Aaron in this copy.** I didn't create one.
- **Real app:** `r17-worker-extra` found no "From …" context line and nothing "Waiting on you" in In motion, as the data predicts. **Not seen in the real app:** a row of this kind. Only the specs show it.

### 2. "Say it in #room" only when the message is for the room
**Done.**
- **One classifier,** `stepAudience(next, room)`, decides who a step's words are for.
- **For the room** ("Say it in #room ›"):
  - "Say go…", "Say yes…", "Say 'ship it'…"
  - "Tell Uni…", "Tell the room…", "Ask Uni to…"
  - "Reply: …" / "Reply 'publish'…"
  - A step that names this room ("…in #woven-web").
  - The composer gets only the words to say. A step asking a question ("Say whether to build…") opens the composer with nothing in it, and an existing draft is left alone (`appendDraft` with no text).
- **For a person outside the room:**
  - "Tell Christian…", "Reply to jonbo…", "Email/Call/Text…", "Send Ryan…", "Forward to Benya…", "Edit and send the draft to Mark…", "Say thanks to Mark…".
  - The sheet leads with the action text.
  - Its primary is the task's own link when it carries one ("Email ricki@… ›" as `mailto:`, or "Open example.org ›"); otherwise it is **Copy**. Never a room prefill.
- **Neither:** "Draft the forward…" and "Confirm scope with Kevin" are plain tasks, where "I did this" is the primary.
- **Unit tests** use real titles from the scratch copy, none from a private area:
  - "Tell Christian the BVSD letter is sent, if not done…"
  - "Send: the invite to Lucian and Benjamin…"
  - "Forward to Benya + Eileen: …"
  - "Send Lucian the 9 questions"
  - "Send the ATLAS Oct 12 follow-up email"
  - The deploy and Woven Web next steps (both COhere/Woven Web, not private)
- **Spec:** `r17 › "Say it in #room" only for the room…` checks Tell Christian (Copy, no "Say it"), an email address (its link), "Say go…" (fills the composer, sends nothing) and "Reply to Kevin…" (Copy).
- **Real app (`r17-worker-extra`):**
  - T-101 "Tell Christian…": the heading is the action, the primary is **Copy**, and there is no "Say it" (`z5-tell-christian`).
  - T-90 deploy: the primary is **"Say it in #cohere ›"** (`z7-deploy-sheet`; the warm and load walks' 05 show the same).
  - Nothing was pressed.

### 3. One answer mechanism
**Done.**
- **Deleted:** the parsed approval buttons under chat messages, their component-memory `answered` state, `answerApproval`, `src/approvals.ts`, its test and its CSS. A Hermes approval prompt is now an ordinary message, answered by typing.
- **New:** a message that names an open decision shows one quiet underlined line, **"Answer in Needs you ›"**, which opens that decision's sheet (`decisionLinks.ts`). A message names a decision through:
  - a `[decision T-NN]` marker matching the decision's title id, or its `task` field (the Boulder Votes decision has `task: T-130`, now read as `forTask`);
  - or the decision's own note id in the text.
  - Nothing else links. Private-area decisions are never linked.
- **Spec:** `r17 › one answer mechanism…` arrives an approval prompt (no buttons) and a `[decision T-140]` message (one link, no answers in the chat). The link opens the sheet, which carries the decision's options.
- **Real app:** 0 approval groups and 0 approval buttons in Uni's and COhere's chat (`r17-worker-extra`, `z8-cohere-chat`). **Not seen in the real app:** an "Answer in Needs you ›" link. No visible message in the scratch rooms named an open decision.

## Rows

### Questions held in notes
**Done.**
- **On the row:** a step that asks for answers ("answer the nine operational/editorial questions…", "Answer the 7 … questions") gets **"Answer 9 questions ›"**, in place of "The rest is in its note".
- **In the sheet:** the questions show as a numbered list under "Answer 9 questions", read in the task's own vault in this order:
  1. its note (the first list under a "Questions" heading, else the first numbered list, else a list of exactly the count the step names);
  2. a note it links (`uni:<id>`, `[[Path]]`, a bare id);
  3. a closed task on the same node whose metadata says "Merged into T-11".
- When the list came from another note, "From <note> ›" opens it. When nothing is found, the sheet says so and offers the note.
- **RegenHub in the scratch copy:** T-11's own note has no list. The nine questions are a 9-item list in T-93, which is closed and marked "Merged into T-11 (same RegenHub asks…)". T-26's and T-27's questions are under "Questions for Aaron" in the notes their bodies link.
- **Real app:**
  - At 1280×720, the RegenHub row says "Answer 9 questions ›" (`z4-regenhub-row`).
  - Its sheet lists all **9**, numbered, with "From RegenHub: deployed fixes are not awaiting a merge ›" (`z4b`, `z4c`).
  - The same 9 showed at 800×600, 740×360 and 920×360 (`m7-regenhub-sheet`). There the sheet scrolls and its top is in view.
  - Escape (dispatched) closed it.
- **Watch:** finding the questions through "Merged into T-11" fits this data; a task that loses its questions some other way won't find them.

### Ambiguous Yes/No
**Done.** One rule decides a decision's answers (`answerChoices`); the row, the work view and the sheet all use it:
- Stored options first.
- Plain Yes/No **only beside a sentence ending in "?"**.
- Otherwise answers built from the statement:
  - "X is not recommended…" gives **"Agree (skip X)"** and **"Disagree"**.
  - "X is recommended" gives "Agree (X)" and "Disagree".
  - A proposal ("Decision (default yes)", "(needs your yes)", "Say no to skip it") gives **"Go ahead"** and **"Skip it"**.
  - The written value says what was chosen: `agree: skip texting`, `disagree`, or `yes`/`no` for proposals.
- When nothing can be built, the row shows the whole statement with **"Open to decide ›"** and no buttons. The sheet then offers "Agree" and "Disagree" beside the statement.
- **Real app (Uni's work view):**
  - Texting shows **"Agree (skip texting)" / "Disagree"** (`z3-texting`; the same at all three narrow sizes).
  - Benya's feature and the calendar email show "Go ahead" / "Skip it".
  - Mail ("approve a test week, not an immediate cutover") shows "Open to decide ›". Its sheet, opened and not answered, shows "Agree" / "Disagree" (`z3b-mail-sheet`).
  - The driver counted **0 rows with Yes/No beside a sentence that doesn't end in "?"**.

### The Uni panel is lighter
**Done.**
- **The panel:** at most 3 rows (Uni's own first, then the areas by urgency), then one **"N more ›"** that opens the work view.
- **Removed:** the "Sadhana: 1 for you" line, "+25 in areas" and the separate "+2 more". Private items are folded into N, and the link's tooltip says "Includes 1 item in a private area".
- **The work view** keeps the full list, with the private area's one line.
- **Real app:** at 1280×720 the panel shows 2 whole rows (the third doesn't fit) and "27 more ›", with that tooltip, no private line and no "in areas" (`z1-uni-panel`, and 01 of the warm and load walks). Uni's work view shows 29, as before.

### Mid-sentence cuts
**Done.**
- **A cut action** ends on a whole word with "…": never on a colon or comma, and never on a hanging word ("the", "and", "to", and now "because", "while", "until"…).
- **A cut "Decide:" line** drops a joining word the same way. The cold walk's 04 had shown "Decide: texting is not recommended for this year because ›"; it now reads "…for this year".
- **Real app:** "Edit and send the draft to Mark and Michael: Oct 12 follow-up email draft" reads whole at 1280×720 (`z6-mark-michael`).
- **Not seen in the real app:** the fixed "Decide:" line. In `r17d-worker-cold` the questions were read before 04, so the row showed whole with its answers. A unit test covers the line.

## P2
- **Responsive navigation doesn't duplicate itself (Codex 4): done.** Places shows the app's places only while the rail is hidden, and the tree only where the sidebar isn't. Real app: at 800×600 the drawer holds the tree, with no app places and the rail on screen. At 740×360 and 920×360 it holds both, with the rail hidden and no sidebar.
- **920×360 (Sonnet): done as asked.** Below 400px tall the sidebar folds into the Places drawer. Real app at 920×360: no sidebar, and the chat is 872px wide (648px with the side panel open). **Watch:** the chat's height is still about 169px (81–250). Folding the sidebar gives width, not height; the header and composer take the rest.
- **Housekeeping is quieter (Codex 7): done.** Archive and Snooze are a small underlined row under the real action and Close. A decision's answer now waits for its write. On failure the sheet stays open with the question and the reason. Real app: see `z5`, `z7` and the warm walk's 05.
- **No maintenance language on ordinary surfaces (Codex 10): partly.**
  - "Self-improvement review: …" notes show as one muted line (real app: COhere, `z8`).
  - "Refresh the brief" now reads "Ask Uni to update this summary".
  - Settings says "Areas and projects vault".
  - Not done: the cached-message counts and sync warnings in Settings, and labelling the companion's sentence as a dated summary.
- **Sign-in pairing names a real destination (Codex 11): done.** "On the other device, open Uni's sign-in screen, then scan this code or paste the link there." The Buzz and keystore lines moved under "More about signing in".
- **"Details" no longer hugs the sheet's bottom (Sonnet): done.** More space below it.
- **From the r16 narrow walks: fixed.** The strip's sheet keeps "All of …'s work" in sight at its foot. Closing it gives focus back to the strip's line. Real app on `r17b`: 800×600 and 740×360 reach the work view with `focusBackOnLine: true` and no misses (on `r17`, both still missed "All of work").
- **Found in the walks: fixed.** At 920×360 with the side panel open, the first row was cut at the panel's foot (`r17b-worker-920x360/m1-open`). On `r17c` it waits behind "+6 more ›".
- **Not done:** Codex 5 (Back and phone launch), 6 (one overlay and modal contract), 8 (setup and recovery inside the shell), 9 (the title cache scoped by identity), and the P3s.

## Tests
- tsc is clean.
- `npm test` passes, with the new `scripts/simpleR17.test.ts`. It covers waiting on Aaron, the classifier with scratch-copy titles, question counts and lists, the three ways questions are found (with a fake vault), statement answers, the chat's decision lookup, the panel's count and tooltip, maintenance lines and joining words. Four r13–r16 unit tests were moved to the r17 rules.
- `cargo test -p uni-core --offline`: 90, 1 and 22 pass.
- **Playwright `simple`: 329 passed, 0 failed, 40 skipped**, on `f9580ef`. The new `r17` specs run on mac, mac-small and phone:
  - waiting on Aaron regardless of owner
  - the "Say it" classifier
  - no approval buttons in chat, and the decision link
  - inline questions, from the note and from a linked note
  - statement decisions
  - the 3-row Uni panel
  - whole-word cuts
  - the strip sheet's footer and focus
  - 920×360 with the panel open (checked to fail on the old code)
- r7–r16 specs were moved to the r17 rules:
  - the work view as the way past the panel's rows;
  - "Go ahead"/"Skip it" for proposals and "Open to decide" for statements;
  - the drawer without app places while the rail shows;
  - the tree in Places under 400px tall;
  - the RegenHub cut step now says "Answer 9 questions", so the cut-step spec uses another 140-character step.
- Other configs:

  | Config | Result |
  |---|---|
  | roomsnav | 27 pass |
  | screens | 7 pass |
  | nested | 6 pass |
  | chatoptional | 6 pass |
  | rail | 18 pass |
  | sidebar | 14 pass |
  | areas | 248 pass, 2 skipped (after `f9580ef`) |
  | default | 335 pass, 10 fail, 43 skipped (on `d255029`) |

  - **areas, first run:** 2 failures, one spec at 1280×380 on phone and desktop. It expected the sidebar, which now folds under 400px tall. The fixture was fixed in `f9580ef`, and the re-run is the row above.
  - **default:** all 10 failures are `vault-links`.
- **`vault-links` is known failing** (its 5 tests on mobile and desktop).
- `lifeos-vault`, `interface-webkit` and `webkit` were not run.

## Watch
- **Cold launch:** in `r17-worker-cold` the tree and Needs you were still loading at 01–03 ("Still loading what needs you · Retry"). The load average was about 8.8 from other sessions' work. A second cold launch a few minutes later (`r17-worker-cold2`) had the areas and Needs you at 01, and so did `r17d-worker-cold`.
  - I made no change to what loads at start, so I read the first run as the box's load. That is inferred, not proven.
  - The warm and load walks had rows at 01.
  - Every cold run misses "area collapse controls": on a fresh home every area starts folded, so there is nothing to collapse. r16's cold run missed it too.
- **Escape in the walks:** the r16 report said the harness never delivers Escape. In `r17-worker-800x600` a real Escape (`wtype`) did close the strip's sheet. At 740×360, and in every `r17b` run, only a dispatched key did. I don't know why it differs.
- **The questions' sources:** finding RegenHub's questions depends on T-93's "Merged into T-11" note. If Uni writes the nine into T-11's own note (a list under "Questions"), the app reads them from there first.
- **"Say it" with no words** (a question to answer, a step naming the room) opens the room's composer with nothing added. The person's action "Copy" copies the step's own words, links included.
- **Choice values:** a statement's answer is written as `agree: skip texting` or `disagree`, and a proposal's as `yes`/`no`. Whatever reads `decided` for statements will see the new words.
