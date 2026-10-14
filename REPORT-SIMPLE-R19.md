# REPORT: Simple first, round 19 (T-124 r19): nothing asserts an action it hasn't checked, sources stay fresh, records that aren't requests are Uni's to tidy

This round works on `feat/simple` from `ff50b14`. It adds six commits plus this report. Nothing is pushed.
- `732693f` **The main round.** It covers:
  - explicit dependencies and "Checking what's needed…";
  - checks kept by source revision with an expiry, and "Couldn't check · Retry";
  - the tidy classifier and "Uni needs to tidy these (N)";
  - option buttons that wrap;
  - no stray "›" in the companion;
  - the sticky sheet footer;
  - the 920×360 strip;
  - one dialog contract;
  - Back closing a sheet;
  - the note-title race.
- `a3bab12` **P2s:**
  - upkeep messages fold away, and Live errors stay out of Settings (Codex 10);
  - work-view rows open their sheet, with no in-place More (Codex 7);
  - bounded waits with Retry (Codex 9, part).

  The r7–r18 specs are moved to the r19 rules.
- `387315a` and `cbd81ef` **Found in the real app:**
  - a link in a step had left a gap ("Look at  on phone") in the sheet heading and the folded strip line;
  - `#cohere's 'For Eileen' block` made a step read as a message for the room;
  - a decision's answers scrolled behind the footer at 740×360;
  - a record to tidy said "Status: Needs your decision";
  - Forget now clears the device's kept checks and questions.
- `2418f7e` **A check is kept by when its reads began.** An older read that finishes last can no longer overwrite a newer check. The unused r18 per-task support fields are dropped.
- `bc915fc` **The sticky-footer spec waits for the sheet's slide-in.** The default config animates it.

Across `src`: 14 files, about 555 lines added and 195 removed. New tests are `scripts/simpleR19.test.ts` (15 checks) and the `r19` block in `scripts/browser/simple.spec.ts` (16 specs).

**Data note:** the refreshed scratch copy changes Needs you a lot.
- RegenHub (T-11) is now `room:boulder`'s, so it is no longer in Aaron's Needs you.
- The "Fractal flow test" (T-111) and the T-125 "Run /restart…" records are now `done`.
- The Mail decision is open again; the backup predates r18's one write.

So the tidy group in the real app holds four option-less decisions. No outline or machinery tasks are live in the copy. Those two shapes are covered by unit tests and specs that use the records' real titles.

## P1s

### 1. Never assert an unchecked action
**Done.**

**Dependencies are explicit** (`taskDeps` in `simpleCore.ts`). A task stands on:
- every note its step links (`uni:<ULID>`, a bare id, `[[Path]]`);
- its `source` field, when that names a note;
- its `depends_on` (or `blocked_by`) notes;
- its own note, for a step that asks for answers, unless a structured `questions` field already holds them.

Some things are deliberately not dependencies:
- **Provenance strings** such as `source: "Aaron/Tasks#T-21"` or `"tasks.py new"` name no note. 65 of the 66 live tasks carry one.
- **Links in `detail`** are context. They are read only when the task asks for questions, as in r18.

No step is matched against "answer N questions" to decide any of this.

**The rule** (`checkOf`, used by every surface):
- While a task's notes are not read, the row says **"Checking what's needed…"** with the task's title under it.
- Its sheet has that heading, "Reading the notes this stands on before saying what it needs.", and the primary **Open the note**.
- There is no action lead, no "I did this", and no step, even under Details.
- The same holds on a fresh device: nothing is cached there, so the first list paints "Checking…".
- A task that stands on no note shows its step at once.

Once read, a task is one of these:
- clear: its step leads;
- a Check (r18);
- **"Waits on “…” first"**, when a `depends_on` note is still open;
- its question list, or "Open the note to answer".

**Specs:**
- A delayed source read: a MutationObserver confirms the step is never on screen before the read lands. The row and the sheet say Checking, then the step leads.
- A fresh device that is seeded before boot.

**Real app (final binary, cold home `r19-worker-checking`, 1280×720):**
- The list arrived 4.9 s after launch. Two rows read **"Checking what's needed…"**:
  - "Self-hosted mail: approved 10-02" (T-13, whose step links the cutover plan);
  - "Pope's AI encyclical…" (T-25, whose step links its draft).
- The driver opened T-13's sheet 0.3 s later, while it was still checking. The sheet showed:
  - heading "Checking what's needed…";
  - primary "Open the note", with the actions [Open the note, Close];
  - no "I did this".
- After the reads, T-13 led with "Approve or change the unforced.dev mail cutover plan (Cutover plan — unforced.dev)".
- The same at 800×600 (`r19-worker-checking-800x600`).

**This was not simulated.** My driver tried to delay `vault_note` reads, but the app's IPC `invoke` is read-only (`writable: false, configurable: false`), so the delay never attached (`delayed: 0` in the log). The "Checking" rows are the real cold timing on this vault. Screenshots: `c1-checking-row`, `c2-checking-sheet`, `c3-checked`.

### 2. Source assessments don't go stale
**Done.**

**The record.** Each check (`CheckRecord`) keeps:
- the `{vault, id, revision}` of every note it read;
- when its reads began (`at`);
- the task revision it was made for (a rewritten task may stand on other notes).

It is no longer keyed by the task's revision alone.

**Revalidation:**
- Every list read reads every Needs-you task's notes again (at most 40, six at a time).
- Each outcome lands as soon as it is read, so one slow note doesn't hold the others back.
- A read that began earlier never overwrites one that began later.

**Expiry and failure:**
- **Expiry** (`CHECK_TTL`, 30 min) is checked at render. A check past it reads "Checking…" again, or "Couldn't check" if the last read failed.
- **Unavailable:** a read that fails, other than "not found", throws `Unavailable`. The row shows its title and **"Couldn't check · Retry"**, and the sheet says the same, with no "I did this".
- **Distinct from ambiguous:** a failure is never cached as a result and never becomes `unclear` ("Open the note to answer", which means read but ambiguous). A good record that is still in time stays shown through a failed revalidation.
- **Retry** (on the row or the sheet) clears the failure, so the row reads "Checking…" again, and reads the list and its sources again.

**Storage:**
- Kept per identity on the device (`uni.checks.v1:<identity|vault>`), so a warm launch paints the last check while revalidating.
- **Forget** removes these, r18's `uni.support.v1` and the `uni.asks.v2` caches.

**Tests:**
- Unit tests: the source closes while the task is unchanged; a failure then recovery; expiry; a rewritten task; per-task landing; an older read finishing last; `depends_on` open, then done.
- Specs: the source closes on the next refresh while the task's `updatedAt` stays the same; a read fails ("Couldn't check · Retry"), then Retry recovers.

**Real app:** the failure path was not seen, because no read failed. Revalidation was not observed directly either: no scratch source changed during the walks, and I did not write to the scratch data. The specs cover both.

### 3. Records that aren't real requests are Uni's to tidy
**Done.**

**The classifier** (`tidyReason`) is conservative, and when unsure it returns null, so the item stays in Needs you. It flags four shapes:
- **outline:** a label that asks nothing, then two or more ";" parts, none of which starts with an action ("Fractal flow test: real work…; nested room names; app refresh for the tree");
- **machinery:** "Run /<command>…", or a literal `[done|blocked|decision]` marker list ("Run /restart … loads the uni-relay hook…");
- **status:** a step that says it is over ("Superseded: …", "Done: …") on an open record;
- **proposal:** a decision with no stored options whose whole question has no "?". A "?" inside a quote doesn't count ("were you there?"). A request to decide does ("Decide the venue", "Which…").

It never flags these, all checked against the live step shapes:
- T-90's "Wed 10-14: say go…";
- T-130's "Production go: …" (the label asks);
- a cut decision title whose question isn't read yet;
- a decision with options;
- a partial record.

**Where they go:**
- They leave Needs you, its count and the tree's dots (`needsYou` excludes them).
- In the work view they sit in a quiet, folded **"Uni needs to tidy these (N)"**, after In motion. Each row is its title with one line of why, such as "States a proposal, asks nothing".
- An item in another private area is never listed by title; it counts in that area's "not listed here" line.

**The sheet:**
- The reason ("This states a proposal but asks you nothing…"), and the status "Uni's to tidy: not a clear request yet".
- Primary **"Ask Uni to fix this record"**. It types a request in the owning room's composer and doesn't send it. For example: "Please fix decision “Mail: approve a test week, not an immediate cutover”: it states a proposal but asks me nothing. Add the question and its options (tasks.py decide new), or close it if it no longer needs me."
- Then Open the note, Close and Snooze.
- No answers, no answer box, and no "I did this".

**Fixtures** use real titles from the refreshed copy (T-111, T-125, T-118, the Mail, daily-email, Benya and texting decisions). Steps are written in the same shapes, never copied from a note's body.

**Real app** (final binary, `r19-worker-extra` and every narrow size):
- Uni's Needs you shows 18. **"Uni needs to tidy these (4)"** holds the Mail, Benya, daily-email and texting decisions, each "States a proposal, asks nothing" (`z3-tidy-group`).
- The Mail sheet's actions are [Ask Uni to fix this record, Open the note, Close], plus Snooze. It has no answers and no "I did this" (`z4-tidy-sheet`). Not pressed.
- **On a cold list** the three cut-title decisions (Benya, daily email, texting) first show in Needs you as "Decide: … ›". Their question isn't read yet, so the classifier is unsure. They move to the tidy group once the question lands. This is visible in `c1-checking-row`; see Watch.

## App bugs from the Sonnet critic

### Decision option buttons wrap inside the panel
**Done.** `.cp-opt` wraps (`white-space: normal`, `overflow-wrap: anywhere`) inside a wrapping row, at every width.

**Real app:**
- **Boulder Votes' side panel at 1280×720 (`z6-options-panel`):** "Add key and test live on preview first" and "Ship to production after live test" each wrap onto 2–3 lines. Their right edge is 1262 against the panel's 1280, and none is clipped.
- **In the sheet at 800×600, 740×360 and 920×360 (`n5-options-sheet`):** all three options are inside the sheet, unclipped.
- **Answers in the sheet's sticky footer:** a decision's answers now sit in the footer, its primary action. The first r19 build had them scroll behind the footer at 740×360; that is fixed in `cbd81ef`.

### COhere's "Your call" rows lose the stray "›"
**Done.** In the companion, no row draws its own "›"; the whole row opens its sheet. The work view keeps "›" on rows that only open.

**Real app:** COhere's panel had `go: 0` and Uni's panel had `go: 0` (`z7-cohere-panel`, `z1-uni-panel`). COhere has no "Your call" rows any more: its three option-less statements are now tidy records.

### One rule for cutting sheet text
**Done.**
- The heading is always whole.
- A link in it reads as its host. That was found in the real app: "Look at  on phone" became "Look at cohere-signup-staging.unforced.workers.dev on phone".
- The subtitle is the shared whole-word cut at 96 characters at every size.
- The whole title is under Details.
- There is no CSS clamp in the sheet.

**Spec:** the same sheet at 1440×900, 800×600 and 740×360 has identical heading and subtitle text.

**Real app:** the T-101 sheet at 800×600, 740×360 and 920×360 had the identical heading ("Reply to Christian in your existing thread that the BVSD letter went out Oct 2 (skip if already done).") and subtitle ("Tell Christian the BVSD letter is sent, if not done…").

### Sticky footer in short windows
**Done.**
- The sheet's actions are a footer (`position: sticky; bottom: 0`) with the text scrolling above it.
- Under 520 px tall it is one compact wrapping row (40 px buttons).
- The sheet is never taller than the window.

**Real app at 740×360** (`n4-sheet-footer`, `n4b-sheet-scrolled`):
- "Ask Uni to draft it", "I did this" and Close sit on one row at y 229–269 of a 313 px viewport.
- Scrolled to Details, they sit at 125–165, still in view.
- The same at 920×360 and 800×600.

### 920×360: a folded companion says what's waiting
**Done.**
- A wide window too short for the sidebar (under 400 px tall) now uses the strip, folded, instead of a side panel squeezed beside the room.
- Any folded strip whose room has requests reads **"Needs you · N: <first request>"**, taking the first row that is not still being checked.
- The stands sentence shows when the strip is opened.

**Real app at 920×360** (`n1-open`, `n2-uni-strip`):
- COhere: "Needs you · 4: Look at cohere-signup-staging.unforced.workers.dev on phone, then forward #cohere's 'For Eileen'…"
- Uni: "Needs you · 18: …"

Both are one line. The same line appears at 800×600 and 740×360.

## P2
- **Codex 4 (Back): partly done.** History Back (Alt+←, the sidebar's ←) now closes the open sheet first, as Android Back and Escape do, then follows visits. Before, it did nothing behind a sheet; the r13 spec is moved to this rule.
  - **Not done:** "Up to …" naming for hierarchy moves, upright-phone launch on the directory, and Recent in short windows.
- **Codex 5 (one dialog contract): done.** `openDialog` in `focusTrap.ts` is used by the task sheet, the companion's sheet, Places and the utility panels (Search, Settings, Vault).
  - **What it does:** focus moves in, Tab wraps inside, everything around is `inert` (the rail and the panel scrim are kept live for the utility panels), and Escape goes to the top dialog only, before any other handler. Focus returns to the opener.
  - **Real app:** Settings opened as `role=dialog` with focus inside and the room inert. Escape closed it, focus went back to the rail's Settings button, and no `inert` was left. The task sheet showed `inert: 3–4` while open and `0` after Escape (`z8-settings`).
  - **The utility panels are now `role=dialog`.** One r15 spec moved from `complementary` to `dialog`.
- **Codex 7 (one expansion model): done.** Work-view rows no longer open in place (More/Less removed); a row, or its step's words, opens its sheet as the companion's do. The r7, r10 and r15 More specs now assert the sheet.
- **Codex 9 (recovery): partly done.**
  - "Opening vault…" and the first key check are bounded: after 8 s they read "Still opening “x”. Retry · Back to Uni's vault" and "Still checking your key · Retry".
  - **Not done:** setup for a vault without a pack still replaces the room rather than sitting inside the shell.
- **Codex 10 (maintenance): done for chat and Settings.**
  - Self-improvement reviews, usage-guard and cron-job messages of any length fold into one closed "Uni's upkeep · time ›" line. The real Uni room had 35 of them, all folded, with no bubbles (`z9-upkeep`).
  - Settings no longer appends a raw `Live unavailable: <error>`. It says "Live updates paused" and logs the reason.
  - **Not done:** For you's identity.
- **Codex 11 (title race): done.** Each title read carries a generation. An identity switch or Forget bumps it, so a read still queued is never sent and an answer in flight is dropped. No spec: the race needs the Tauri IPC (`noteRefs.tsx`).
- **Codex 8 (rail destinations share a frame): not done.**

## Real-app check
1. **Builds**, all debug with `--features custom-protocol`:
   - The frontend was built with plain `vite build` into `/tmp/r19-dist`. Each build was checked for no `__T76_MOCK`, `__slowMs`, `__tagDelay`, `__noteDelay`, `__noteFails` or `__seedTasks`, then passed in with `TAURI_CONFIG` (`frontendDist`).
   - Binaries are in `~/.hermes/cache/scratch/r19/`: `-r19` (`a3bab12`), `-r19b` (`387315a`), and `-r19c` (`bc915fc`, final).
2. **Final set, on `-r19c`, all on one home `t124-apphome-r19w`, in order:**
   - `r19-worker-cold`, `r19-worker` and `r19-worker-load`, with `driver-r12.js` exactly as specified (`WALK_KEEP_HOME=1 WALK_HOME_NAME=r19w`). For the load run, `nice -n 19 stress-ng --cpu 2 --timeout 150s` was started 3 s before launch and killed (my own PID) when the walk ended.
   - `r19-worker-extra` at 1280×720, with `driver-r19-extra.js`.
   - `r19-worker-800x600`, `-740x360` and `-920x360`, with `driver-r19-narrow.js` through r18's `walk.sh` copy (`WALK_SIZE`).
   - Then `r19-worker-checking` (1280×720) and `r19-worker-checking-800x600`, with `driver-r19-slow.js`, on throwaway homes that `walk.sh` deleted.
3. **Earlier sets** on `-r19` and `-r19b` are kept as `runs/r19a-*` and `runs/r19b-*`. Their screenshots are where the found-in-app bugs above came from.
4. **What the drivers did:** they only look. They never send, never press "Say it", "Ask Uni to draft it", "Ask Uni to fix this record", "I did this", Copy, Archive or an answer, and never open the Journal or a private area. Driver sources are in `walk/drivers-r19/`.
5. **No writes:** none to the scratch data this round.
6. **Cleanup:** `~/.hermes/cache/scratch/t124-apphome-r19w` is removed, and no `t124-apphome-*` folder is left. `pgrep` shows no stress-ng, cage or app process of mine.

**What the final `driver-r12` walks showed:**
- **All three walks** reached all nine shots. The cold run's only miss was "area collapse controls", because the cold tree had no area open yet; r18's cold run had the same miss.
- **Cold `01-open`:** Uni's panel already had 3 rows and "15 more ›", with the dated heading ("Where this stands · 2 days ago"). Its first row read "Look at cohere-signup-staging.unforced.workers.dev on phone…", with the host kept.
- **Cold, warm and load `05-needs-item`:** the T-113 sheet opened from COhere's panel.
  - Its heading keeps the link's host.
  - Its primary is "I did this". On `-r19b` it was "Say it in #cohere", because `#cohere's 'For Eileen' block` read as the room; fixed in `387315a`.
  - The footer is sticky, with Close.
- **The same under load.** In Learn Vibe Build (`06`) Monday's notes are folded as "Uni's upkeep · 7:52 PM ›".
- **`08`/`09`:** Atlas is revealed for Recent, then folds back.

**Not seen in the real app:**
- "Couldn't check · Retry" (no read failed);
- a source closing during a walk;
- "Waits on … first" (no task has `depends_on`);
- the outline, machinery and status tidy shapes (no live record has them);
- "Answer N questions";
- the answer box (no live option-less decision asks a question).

The specs cover each of these.

## Tests
- **tsc:** clean.
- **`npm test`:** passes, including `scripts/simpleR19.test.ts` (15 checks).
- **`cargo test -p uni-core --offline`:** 90, 1 and 22 pass.
- **Playwright `simple`:** 384 passed, 0 failed, 42 skipped on `cbd81ef`. The `r19` block was re-run on `bc915fc`: 49 passed, 5 skipped (phone-only or wide-only skips).
- **Other configs:**

  | Config | Result |
  |---|---|
  | areas | 248 pass, 2 skipped |
  | roomsnav | 27 pass |
  | nested | 6 pass |
  | chatoptional | 6 pass |
  | screens | 7 pass |
  | rail | 18 pass |
  | sidebar | 14 pass |
  | default | 369 pass, 12 fail, 45 skipped |

  - **default:** 10 of the 12 failures are the known `vault-links` ones (5 × 2 projects). The other 2 were my new sticky-footer spec, which measured the sheet mid-slide (this config doesn't reduce motion). It now waits for the animation, and passes on both default projects (`bc915fc`).
- **Not run:** `lifeos-vault`, `interface-webkit` and `webkit`.

## Watch
- **Cold lists move rows once.** A cut decision title is "Decide: …" in Needs you until its question is read. If that question asks nothing, the row then moves to the tidy group, and the count drops: in the real app, three rows on a cold launch. This follows "when unsure, keep it in Needs you". If it reads as jumpy, the alternative is to hold such rows as "Checking…".
- **Every list refresh re-reads the supporting notes** of the Needs-you rows that have them (two notes in the scratch copy, at most 40). That is the price of never reusing a stale check.
- **The tidy records in the copy are all decisions** that Uni wrote as statements on 10-06. Asking Uni to rewrite them with `tasks.py decide new --options`, or to close them, would empty the group. That is data work for the rooms, not done here.
