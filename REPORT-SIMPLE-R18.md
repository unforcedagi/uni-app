# REPORT: Simple first, round 18 (T-124 r18): answers from the record, questions only when the note says so, a task never contradicts its source

This round works on `feat/simple` from 6775c0a. It adds six commits plus this report. Nothing is pushed.
- `7ecdc53` **The main round.** It covers:
  - answers only from stored options, with an answer box otherwise;
  - questions only from an explicit source;
  - "Check: … is closed — still needed?";
  - the new Copy rules;
  - one shared cut;
  - the dated summary;
  - stale progress pings folded away.
- `b5f32a6` **Specs and P2s.**
  - The r7–r17 specs move to the r18 rules, and a new `r18` block is added.
  - Small print gets its small type back.
  - A source read lands even when a newer read has started.
  - Note titles are scoped per identity and cleared by Forget.
  - A failed note read offers Retry.
  - Settings' sync counts and warnings move under Developer.
- `b910291` The RegenHub spec waits up to 15 s for the source read on a loaded phone.
- `d8e511d` and `6ede4f9` **Found in the real app.** The cold walk showed Uni's panel with one row and "28 more ›" above an empty panel. The rows were measured before they had cut their own lines. They are now measured one commit later, and measured again when room frees up.
- `de3ff77` **Found by the `areas` specs.**
  - The work view had lost an area's brief.
  - The companion and the work view now share one summary: the node's `stands`, else its brief's "Now" with the brief's own time.
  - "Open in #room" stays beside "Ask Uni to draft it".

Across `src`: 15 files, about 500 lines added and 230 removed. New test files are `scripts/simpleR18.test.ts` and the `r18` block in `scripts/browser/simple.spec.ts`.

**Real app:** debug builds with `--features custom-protocol`, against the scratch hub, signed in as uni-reviewer.
- **Frontend:** built with plain `vite build` into `/tmp/r18-dist`. Each build was checked for no `__T76_MOCK`, `__slowMs` or `__tagDelay`, then passed in with `TAURI_CONFIG` (`frontendDist`).
- **Binaries** (in `~/.hermes/cache/scratch/r18/`):
  - `uni-app-tauri-r18-first` from `b910291`
  - `-r18b` from `d8e511d`
  - `-r18c` from `6ede4f9`
  - `-r18d` from `de3ff77`

**Walks**, in order:
1. **On `r18-first`, home `t124-apphome-r18w`:** `r18-first-worker-cold` (`driver-r12.js`). It found the one-row panel. The home was then deleted.
2. **On `r18b`, a fresh `r18w` home:** `r18b-worker-cold` and `r18b-worker`. The cold run still showed one row; the warm run showed three. The home was then deleted again.
3. **On `r18c`, a fresh `r18w` home, all kept on that one home in this order:**
   - `r18-worker-cold`, `r18-worker` and `r18-worker-load`, with `driver-r12.js` exactly as specified. The load run had `nice -n 19 stress-ng --cpu 2 --timeout 150s` started 3 s before launch; it ran the whole walk (47 s), then I killed my own PID.
   - `r18-worker-extra`: my `driver-r18-extra.js` at 1280×720.
   - `r18-worker-800x600`, `r18-worker-740x360` and `r18-worker-920x360`: my `driver-r18-narrow.js` through a copy of r15's `walk.sh` with `WALK_SIZE` (`~/.hermes/cache/scratch/r18/walk.sh`).
   - `r18-worker-answer`: `driver-r18-answer.js`, the one permitted write (below).
4. **On `r18d`, a throwaway home that `walk.sh` deleted:** `r18d-worker-extra`, after the last commit.

**Cleanup and what the drivers did:**
- `~/.hermes/cache/scratch/t124-apphome-r18w` is removed, and no `t124-apphome-*` folder is left. `pgrep` finds no stress-ng, cage or app process.
- The drivers only look. They never send, never press "Say it", "Ask Uni to draft it", "I did this", Copy or Archive, and never open the Journal or a private area.
- The only exception is `driver-r18-answer.js`, which typed one answer.
- Other sessions kept the load average at 4–9 throughout.

**The one write:**
- **Decision:** the scratch decision "Mail: approve a test week, not an immediate cutover" (`01M4MKXH71BP1XGW0W7B45QZX5`).
- **What the app wrote:** typed in "Answer in your words" and pressed Answer.
- **Result** (read with sqlite in read-only mode):
  - `state` went `open → decided`.
  - `decided` = "Test week first, then cut over (r18 answer-box check, scratch copy)".
  - `decided_at` = 2026-10-14T11:14:46Z, `decided_by` = `aaron`.
- **In the app:** the sheet closed and the row left Needs you.
- **Compatibility:** these are the same three fields `tasks.py decide pick` writes. `pick` on this decision would now answer "already decided as …", and rooms read `decided` as a string either way.
- **Note:** `decided_by` is the profile's `me` (`aaron`) even though the app was signed in as uni-reviewer. That was already true before this round.

## P1s

### 1. A task never contradicts its own source
**Done.**

**The rule** (`loadSupport` in `vaultTasks.ts`, `closedBy` and `checkLine` in `simpleCore.ts`):
- A task whose step asks for answers finds where its questions come from, in this order:
  1. its own note (explicit only, see P1-3);
  2. a note its step or note links;
  3. a closed task merged into it (its metadata names it: "Merged into T-11"), on the same node.
- If that source's own metadata says `done`, `archived`, `decided` or `closed`, or it has a `superseded_by` field, the task is a **Check**.
- **Explicit state only.** No title words are read. A linked note counts as the source only when the step names it or it holds the questions. A done task merely mentioned in the task's note is not its source.
- **The row** reads `Check: “<source title>” is closed — still needed? ›`, with the task's title as one line under it. It never shows the extracted step and never claims a question list.
- **The sheet:**
  - heading: the same Check line; under it, the task's title;
  - "Its questions came from that note, and it is closed. If this still needs you, its note says what; if not, archive it.";
  - primary **Open the note** (the source, in its vault), Close, and the quiet Archive and Snooze row;
  - no "I did this", and no action-first lead;
  - the doubted step is only under Details ("Its step: …"), with a link to the task's own note.
- **Caching:** results are kept per task revision, in memory and on the device per identity, so the next launch paints them at once.

**Real app:**
- **`r18-worker-extra`, all at 1280×720:**
  - The RegenHub row is `mode: check`: "Check: “RegenHub: deployed fixes are not awaiting a merge” is closed — still needed? › RegenHub site + newsletter systems" (`z4-regenhub-row`).
  - The sheet has that heading, primary "Open the note", actions [Open the note, Close], and housekeeping [Archive, Snooze until tomorrow] (`z4b-regenhub-sheet`).
  - A dispatched Escape closed it.
- **Narrow sizes:** the same at 800×600, 740×360 and 920×360 (`m7-regenhub-sheet`). The sheet was in view, with no sideways scroll.

**Not right yet:** on a device that has never read the source, the row shows the step until the read lands. Only a second or so in the specs, but in `r18d-worker-extra` (a throwaway home) the row still read "Merge RegenHub PRs… The rest is in its note ›" when the driver looked right after the list arrived. The sheet opened from that row already said Check. After the first read the result is kept, and warm launches show Check on first paint.

**Data:** whether the PRs are actually merged was not checked. The app now shows the conflict instead of choosing a side.

### 2. No answer is inferred from punctuation
**Done.**

**What changed:**
- `answerChoices(options)` takes only the stored options, each written back as stored.
- Yes and No appear only when the stored options are exactly yes and no.
- `tasks.py decide new` has no `kind: binary` field (it requires at least two `--options`). So there is no binary flag to read, and none was invented.
- **Deleted:** the r17 statement builder ("Agree (skip texting)" / `agree: skip texting`, "Go ahead"/"Skip it", "Agree"/"Disagree").
- **A decision with no options:**
  - The row reads **"Your call: <question> ›"** (in the companion, cut to whole words when long) and has no buttons.
  - The sheet has a one-line answer box, **"Answer in your words"** (max 500 characters, uni-core's limit), with an **Answer** button that stays disabled until something is typed.
  - The answer goes through the same `vault_decide` compare-and-set as a tap, guarded by the revision shown. A conflict keeps the sheet open with the question and the reason.
- **Read, not run:** `tasks.py decide pick`, `state.py pick` and uni-core `check_decide_patch`. The stored shape (`decided`, `decided_at`, `decided_by`) is unchanged.

**Real app:**
- **Uni's work view (`r18-worker-extra`):**
  - Four "Your call" rows: the texting statement, the mail decision, and the two "Decision (default yes / needs your yes)" proposals.
  - Zero Yes/No rows.
  - Answer buttons only on "Ship the Boulder Votes AI chat?", with its three stored options.
- **The texting sheet** (`z3b-texting-sheet`, and `m6-texting` at all three narrow sizes):
  - heading: the whole statement;
  - "Your call:" above it;
  - the box "Answer in your words", with Answer disabled while empty;
  - no option buttons.
- **The Boulder Votes sheet** shows its three stored options and no box (`z9-options-sheet`; also `m9-options-sheet` at 800×600 and 740×360).
- **Not seen:** the Boulder Votes sheet at 920×360. That room's side panel was folded there, and the driver doesn't unfold it.
- **The write:** see the one write above.

### 3. "Answer N questions" only from an explicit source
**Done.**

**The rule:**
- Questions come only from:
  - a structured `questions` field on the note; or
  - the list under a Markdown heading that contains "Question".
- No first numbered list, and no list that merely has the right count.
- Each item is kept whole, with its indented continuation lines and nested items.
- The lookup carries `{vault, id}`: `parachute:<ULID>` is read in `parachute`, while a bare id or `[[Path]]` is read in the task's own vault.
- When the source holds a different count from the step, or nothing explicit is found, the row and the sheet say **"Open the note to answer ›"** and claim no list.

**Real app:** no task in the scratch copy has an explicit question list. RegenHub (the only "answer N questions" task in Needs you) is now a Check. So "Answer N questions" was not seen in the real app this round, and neither was "Open the note to answer". Only the specs show them.

## Rows and companion

### Whole-word cuts everywhere
**Done.** `cutWords` in `simpleCore.ts` is now the one text cut.
- `firstWords`, `wholeWords`, `stepText` and `askPreview` go through it.
- It never adds a second "…": "hero wording…)" stays as it is.
- It never ends on a hanging word or a separator, now including "·".
- On-screen clamps (`WordClamp`) use its word list, and now cover:
  - the companion's summary (it was a CSS clamp that cut inside words);
  - the strip's folded line (a browser ellipsis before);
  - all small print.
- The sheet's subtitle is cut to whole words, with the whole title under Details.

**Real app:**
- **Summaries:**
  - 1280×720: "…COhere deployment…" (`stands.cut: true, midWord: false`).
  - Folded strip line at 800×600 and 740×360: "Deploying app phases 38/58 to production by Wed 10-14; D2 Ecology redesign underway…" and "…COhere deployment (Wed)…". One line each, cut on whole words.
  - Learn Vibe Build: "…final brief (T-121)…" (`r18-worker-load/06`).
- **Double ellipses:** the driver's check found none, in the panel or in Uni's work view.

### Uni's companion: exactly 3 rows and one "N more ›"
**Done** on the side panel. The per-row More is gone from every companion, and a row opens its sheet. In the companion, an action is at most 3 lines and a step at most 1.

**Real app:**
- Uni's panel showed 3 rows and "26 more ›" (tooltip "Includes 1 item in a private area"), with 0 per-row More, in:
  - `r18-worker-cold/01`, `r18-worker/01` and `r18-worker-load/01`;
  - `r18-worker-extra/z1`;
  - the 800×600 and 740×360 strip sheets (`m3-uni-summary`).
- **920×360 with the panel open:** "29 more ›" and no row. It is 313 px tall, so no row fits whole, and r17's no-sliver rule applies.
- The phone's inline strip keeps r16's rule (the rows that fit beside the conversation). The spec allows it fewer than 3.
- **Before the fix:** the first two cold runs (`r18-first-worker-cold`, `r18b-worker-cold`) showed 1 row and "28 more ›" over an empty panel. That is fixed in `6ede4f9`.

### Small print is one line at most
**Done.** The line under a row (`cp-under`, `cp-meta`) is one line of whole words, with the whole text in its `title`.

**"Tell Christian":**
- The note's first paragraph (the "Letter context · Dated correction…" wall) now sits under Details in the sheet.
- **Real app:** `tellRow.underLines: 1`. The sheet's Details holds the paragraph (`z5-tell-christian`).

### Copy copies something useful
**Done.**

**For a step toward a person:**
- **A stored message** (`message`, or a `draft` field holding text) **or a draft note** for the task (tag `draft`, its `task` field) → the primary is **"Copy the message"**, which copies that text.
- **No message** → the primary is **"Ask Uni to draft it"**. It types "Please draft the message for T-NN (<title>): <step>" in the owning room's composer, without sending. Nothing copies the bare instruction.
- **A link is the primary** only from:
  - the task's `link` or `url` field (a web or `mailto:` address); or
  - a `mailto:` written in the step.
- A bare address or a URL inside the instruction is no longer a destination.

**Real app:**
- **"Tell Christian…":** primary "Ask Uni to draft it", then "I did this" and Close. No Copy (`z5-tell-christian`; `m8-tell-christian` at all three sizes).
- **Not seen in the real app:** "Copy the message". No scratch task stores a `message`/`draft` field or a `draft` note with a `task` field.
- T-101's note does contain a quoted forward ("Forward: “Hi Christian — …”"). That is free text, so it is not read as the message.

### Where this stands carries its date
**Done.** `standsHeading` gives "Where this stands · 2 days ago" once the summary is older than today. One wording and one timestamp source are used by:
- the side panel's top;
- the strip's open line and its sheet;
- the work view's heading.

The summary is the node's `stands`, else its brief's "Now" with the brief's time, else the newest change it names. The brief's separate "Brief updated 16h ago" is gone.

**Real app:**
- Uni: "Where this stands · 2 days ago" on the panel (`z1`), with the same heading and sentence at the top of Uni's work view (`z2-uni-work`).
- The same at 800×600 and 740×360 (`m3-uni-summary`, `m2b-cohere-open`), and in Learn Vibe Build and Boulder Votes ("Where Boulder Votes stands · 2 days ago").
- **Not seen in the real app:** a summary taken from a brief. Every scratch node the walks opened has `stands`.

### No stale progress line at the top of a chat
**Done.**
- **How these are tagged:** worker pings are matched by `isWorkerStatus` ("⏳ Working — N min …"). A message has only its first `ts` and an `edited` flag; the relay keeps no edit time.
- **The rule** (`staleStatus`): a ping older than an hour is folded into **"Earlier progress update · <date> ›"**, a closed `<details>` that shows the ping when opened. The one exception: a ping that was edited and is still the room's newest message may be a live worker editing it in place, so it stays a status line.

**Real app:**
- Learn Vibe Build's top now reads "Monday, Oct 12 · Earlier progress update Oct 12, 12:29 PM ›" (`z10-lvb-status`). Three of Monday's pings are folded and none shows as a live status line.
- The driver's "workingVisible: true" is a false positive: WebKit reports a box for text inside a closed `<details>`. The screenshot shows it hidden.

## P2
- **Codex 9, note titles: done.**
  - Titles are kept per signed-in identity (`uni.noteTitles.v3:<identity>`), keyed by vault and note inside.
  - Forget clears every identity's kept titles.
  - A failed read keeps the last known title, marked: dotted, with the tooltip "Couldn't read this note just now; this is its last known title". It is read again after 30 s.
  - A cleared title is read again for the new identity.
- **Codex 8, recovery: done for linked notes.** A failed note read says "Couldn't open this note just now" with **Retry** and "Back to …". The technical reason and "Open in Parachute ↗" are under Details. Setup inside the shell is **not** done.
- **Codex 10, maintenance: partly done.**
  - Settings now says "Up to date" / "Up to date, except a few rooms" / "Offline · showing what this device saved".
  - The saved-message count and per-room warnings are under Developer.
  - The duplicate "Copy markdown" in the note footer is gone.
  - **Not done:** For you's identity, and area apps' own surfaces.
- **Not done:**
  - Codex 4 (one meaning for Back and Recent);
  - Codex 5 (one dialog contract: focus trap, inert background, Esc, focus return for Search, Settings and Vault);
  - Codex 11 (less chrome in short windows; the chat is still about 169 px tall at 920×360);
  - the P3s.
- **Codex line 5 also named "Fractal flow test"** as an incomplete action. Nothing was changed for it; it is data.

## Tests
- **tsc:** clean.
- **`npm test`:** passes. It includes the new `scripts/simpleR18.test.ts`, which covers:
  - the RegenHub shape → Check, and explicit state only;
  - no Yes/No from punctuation, and stored values;
  - the answer box's text and its single guarded `vault_decide`;
  - numbered plan ≠ questions, a wrapped item whole, a count mismatch → unclear, and a `parachute:` id read in `parachute`;
  - the `link`/`message` fields and "no destination from words";
  - `standsHeading`, `staleStatus`, and one ellipsis.

  r17 unit tests that asserted the removed rules now assert the r18 ones.
- **`cargo test -p uni-core --offline`:** 90, 1 and 22 pass.
- **Playwright `simple`: 344 passed, 0 failed, 40 skipped** on `de3ff77`. The new `r18` block runs on mac, mac-small and phone:
  - the contradicting source (row, sheet, Open the note, no "I did this");
  - no punctuation answers ("Which opening hours should we publish?");
  - the answer box's revision-guarded write and its conflict;
  - explicit questions only, a wrapped item, and a vault-prefixed id;
  - three rows with no per-row More, and one-line small print;
  - the dated summary on the companion and the work view;
  - stale progress lines.

  The Copy semantics spec is the reworked r17 "Say it" spec: a stored message, `mailto:` and a `link` field lead; a bare address or URL doesn't; otherwise "Ask Uni to draft it". The r7–r17 specs were moved to r18 rules: More checks now run in the work view at a panel's width, and optionless decisions are "Your call" with the box.
- **Other configs:**

  | Config | Result |
  |---|---|
  | roomsnav | 27 pass |
  | screens | 7 pass |
  | nested | 6 pass |
  | chatoptional | 6 pass |
  | rail | 18 pass |
  | sidebar | 14 pass |
  | areas | 248 pass, 2 skipped (on `de3ff77`) |
  | default | 341 pass, 14 fail, 43 skipped (before `de3ff77`) |

  - **areas:** the first run had 8 failures; the work view had lost a brief, which `de3ff77` fixed.
  - **default:** the 14 failures were the 10 known `vault-links` ones and 4 `ids` ones. `ids` re-run after the fix: 14 pass. I did not re-run all of `default` after `de3ff77`.
- **`vault-links` is known failing** (5 tests × 2 projects).
- `lifeos-vault`, `interface-webkit` and `webkit` were not run.

## Watch
- **First sight of a Check.** See P1-1: on a device that has never read the source, the row shows its step until the read lands. A "checking…" state would need a timeout so it can't hang forever; I didn't add one.
- **Answers in words reach rooms as plain `decided` strings.** Anything that compared `decided` with an option list (only `tasks.py pick`, for its own input) is unaffected.
- **Proposals ("Decision (default yes): …") no longer get "Go ahead"/"Skip it".** They are "Your call" with the box, because nothing on them is stored as an option. If Uni wants one-tap answers, it should write `options` with `tasks.py decide new`.
- **The Mail decision in the scratch copy is now decided** by this round's one write. The next walk's Uni count is 28, not 29.
