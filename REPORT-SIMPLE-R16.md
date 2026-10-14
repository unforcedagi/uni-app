# REPORT: Simple first, round 16 (T-124 r16): Needs you appears at once and stays honest, short windows keep the chat

This round works on `feat/simple` from c504f0f. It adds eight commits plus this report, and nothing is pushed:
- `dacf636` A task's state change carries the revision Aaron saw. Rust test of the exact arguments.
- `763dc00` The main round: tasks publish on their own, the saved list, "Still loading · Retry", the guarded sheet, the title cleaner, "Decide:" rows, the owner rule, 4-line actions, the short-viewport strip.
- `fc9718f` The r16 specs, and r12–r15 specs moved to the r16 rules.
- `6ac08bd` The test-only slow threshold is compiled out of release builds.
- `2266117` Fixes the real-app walk surfaced (below).
- `0bbd81b` The strip's sheet starts under the room's header; Escape closes it from the window.
- `e61d650` Corrects a wrong claim in `0bbd81b`'s comment and message (see Escape under Watch).
- `04f8cb8` A refused value from the sheet says so in words. Areas specs follow the r16 rules. The slow-load spec runs only in the test-hooks build.

Across `src`, `src-tauri` and `crates`: 16 files, about 560 lines added, 174 removed. New: `src/areas/savedTasks.ts`.

**Real app:** debug builds with `--features custom-protocol`, frontend built with plain `vite build` into `/tmp/r16-dist` (checked: no `__T76_MOCK`, `__slowMs` or `__tagDelay`), pointed at with `TAURI_CONFIG`. Scratch hub, signed in as uni-reviewer.
- **Binaries:** `uni-app-tauri-r16` from `6ac08bd`, `r16b` from `2266117`, `r16c` from `0bbd81b`. `e61d650` changes only a comment, and `04f8cb8` only the wording of one failure notice, so no walk ran on a build of them.
- **Walks on one app home (`t124-apphome-r16w`), in this order:**
  1. `r16-worker-cold`, `r16-worker`, then `r16-worker-load`: `driver-r12.js` exactly as specified, on `r16`. The load run started `nice -n 19 stress-ng --cpu 2 --timeout 120s` 3 s before launch; the whole walk ran inside it.
  2. `r16-worker-extra`: my `driver-r16-extra.js` at the default size, on `r16c` (first run on `r16`, re-run after the fixes).
  3. `r16-worker-800x600`, `-740x360`, `-920x360`: my `driver-r16-narrow.js` through r15's `walk.sh` copy with `WALK_SIZE`, on `r16c`.
- **Extra runs on throwaway homes** (deleted by `walk.sh`): `r16-worker-cold-load` (cold, under full-priority `stress-ng --cpu 4`), `r16-keyprobe` (what keys reach the page), and the launch-timing runs (below).
- `~/.hermes/cache/scratch/t124-apphome-r16w` is removed. No `t124-apphome-*` folder is left.
- I started stress-ng myself and it stopped: the first exited on its timeout, the second I killed. `pgrep stress-ng` finds nothing.
- **The drivers only look.** They never send, answer, press "Say it", "I did this" or Archive, and never open the Journal or a private area. The key probe typed one "x" into the Uni composer of the throwaway home and cleared it; it was never sent.

## P1s

### 1. Needs you shows at once
**Done.**
- **Tasks publish on their own** (`useTasks.ts`). Running and Drafts are separate reads that never hold the list. At Uni's level the task reads now start alongside the tree read (`loadTasks` takes the tree or a promise of it).
- **Saved list** (`savedTasks.ts`): kept on the device per identity and vault (`uni.tasks.saved.v1`). It is capped at 600 tasks and 500 kB, and a list over the cap is dropped rather than shown stale. At most three sign-ins are kept, and Forget clears it. A launch paints it at once with "29 as of 3:12 PM · refreshing…", and the read replaces it.
- **Bounded loading:** a read past 8 s says "Still loading what needs you · Retry", or "29 as of … · Still loading · Retry" over a saved list. Never an endless "Loading…".
- **Activity is honest** (Codex P2-5): with Running/Drafts not yet read, the work view says "Checking what's running…". When they couldn't be read it says "Couldn't check what's running · Retry", or "Running and drafts as of … · Couldn't refresh". "Nothing is moving here right now" appears only after a clean read.
- **Title reads queue four at a time**, so a room full of note links can't crowd out the task reads.
- **Cause of the r15 regression: not proven.** The task list waited for tasks, Running and Drafts together (as Codex said), and that is fixed. I didn't isolate which read was slow in r15.
- **Real app:**
  - `r16-worker-cold`: Needs you had rows on the first screen (01, before the room had loaded), and 05 opened the deploy task's sheet.
  - `r16-worker` (warm): rows at 01; 05 opened the sheet.
  - `r16-worker-load` (warm, `nice -n 19 stress-ng --cpu 2`): rows at 01, 02, 03, 04; 05 opened the sheet. Load average went 3.1 → 5.6.
  - `r16-worker-cold-load` (cold home, full-priority `stress-ng --cpu 4`): 01 showed "Still loading what needs you · Retry" in the companion and the tree. 02, 2.6 s later, had rows; 05 opened the sheet. The room's chat was still "Opening the room…" at 02: the rooms list arrives late under that load, which is the chat's read, not the tasks'.
  - **The saved list, timed** (`r16-timing-*`, a polling driver on a throwaway home: one cold run, then two warm runs). Times are from the page starting:
    - Cold (nothing saved): rows at 5.2 s.
    - Warm under `nice -n 19 stress-ng --cpu 2`: rows at **0.9 s** with "29 as of 2:23 AM · refreshing…"; the fresh read replaced them at 5.2 s.
    - Warm under full-priority `stress-ng --cpu 4`: rows at **2.6 s** with the same line (`r16-timing-warm-heavy/t1-first-rows`); fresh at 8.6 s.
    - "Loading…" never showed in the companion on a warm launch.
- **Not seen in the real app:** Retry pressed (the list loaded before I needed it).

### 2. Short windows keep the conversation
**Done.**
- **The strip folds** when the app opens on, or enters, a short viewport (under 700px tall or 900px wide), whatever was saved. The saved choice is kept, not applied there.
- **Opening it:** inline only if the room keeps its whole composer plus 40% of its height for the conversation and still has 200px to spare (`stripRoom`). Inline rows are whole; the rest sit behind "+N more", which opens the sheet.
- **Otherwise it opens as a sheet over the room:** under the room's header, so the room's name stays in sight. It is modal with a focus trap; Escape, Close or the scrim closes it. Opening an item from it replaces it, so only one sheet is ever open.
- **Real app (`r16c`):**
  - 800×600 and 740×360: COhere opened with the strip folded and the composer whole in view (740×360: composer 250–313 of 313). At 740×360 the saved choice was "open" (`"1"`), and it still started folded.
  - Opening it gave the sheet (`data-place="sheet"`), focus inside, Needs you in it, and the composer untouched underneath. Escape closed it (dispatched in the page; see Watch).
  - 920×360: the side panel is folded (48px), the composer is whole, and the work view opened.
- **Not seen in the real app:** the inline strip. It only happens on a tall phone-width window, and the Linux walks don't run one; specs cover it at 390×844. Inside the sheet, a long list scrolls, so its last row can sit at the sheet's edge until scrolled.

### 3. "I did this" and Archive require the revision Aaron saw
**Done.**
- **The writes:**
  - `vault_transition` now takes `ifUpdatedAt`.
  - `transition_note` sends `if_updated_at` with the `state_transition` in one `update-note`. The vault checks both in one conditional UPDATE (`notes.ts` in parachute-vault).
  - A state change without a revision is refused before any request.
- **Undo** is guarded by the revision the original write returned.
- **The sheet** waits for the write and closes on success. On a conflict it stays open, re-reads, shows the latest copy and says "This changed since you opened it. Nothing was saved; this is the latest."
- **Tests:**
  - Rust `transition_args_carry_the_revision_with_the_compare_and_set` checks the exact JSON for done and Undo.
  - Unit tests check the client's arguments.
  - Spec `r16 › "I did this", Archive and Undo…` covers: the args equal the row's `updatedAt`; Undo uses the returned stamp; a step rewritten by Uni with the state unchanged is refused and the sheet shows the new step; Archive against an old revision is refused.
- **Scratch hub, one real write** (`~/.hermes/cache/scratch/r16/r16_probe.rs`, a temporary `uni-core` example, not committed). It created `Tasks/scratch-r16-probe`, then:
  - Rewrote its `next` (a new revision).
  - "Done" against the first revision was refused: `[conflict] … has been modified`, and the state stayed `open`.
  - Done against the latest worked; Undo with the returned stamp worked.
  - A replayed old stamp was refused; Archive with the latest worked.
  - It deleted the note, and a read then said `note not found`. No live-copy task was touched.
- **Not seen in the real app:** a conflict in the app's sheet (the walks never press "I did this").

## Rows
- **Decision rows:**
  - With the whole question known and short enough, the question sits beside its answers.
  - Too long: two full lines of whole words, then "Open to decide ›".
  - No whole question known: "Decide: <first words> ›", whole words with no hanging "the" or "who" and no "…". For example, "Decide: Uni adds Benya's missing feature 4" and "Decide: a daily calendar email to people".
  - **Real app:** Uni's work view had 0 rows ending in "…" without a way in. The two r15 examples now show whole with Yes/No (their questions are read from their notes).
- **A note that is only its heading and options** (Boulder Votes: `# Ship the Boulder Votes AI chat? (preview: …)`, then a list) now reads the heading as the question. In the real app the row is "Ship the Boulder Votes AI chat?" with its three options (`y5-uni-work`). The sheet keeps the preview link.
- **One title cleaner** (`taskTitle` in `whereCore.ts`): no id, no leading date, no "(preview: …" tail. The companion, the work view, the sheet, the stands line and the drafts all use it. A dropped preview tail means the question is read from the note before it can be answered. **Real app:** 0 raw dates and 0 "(preview" in Uni's 29 rows.
- **Owner:**
  - Needs you is owner aaron at Now/Soon, plus open decisions. A room's or Uni's task that only waits on Aaron goes to In motion as "Waiting on you".
  - **The 29 in `y2-uni-work`:** I checked them against the scratch vault (sqlite, read-only). They are 23 owner-aaron tasks, 5 decisions and 1 "Sadhana: 1 for you", and the real app counted 29 again. The vault's 5 `uni`-owned tasks were never among them. None of the room tasks in this copy waits on Aaron, so the new rule moves nothing here.
  - What reads as "Uni's drafting" is owner `aaron` in the data: T-111 "Fractal flow test…" and T-125 "Rooms write state…" (its step is "Run /restart…"). The data needs changing, not the app.
- **The deploy action:**
  - Measured in the real app at 1280×720: the panel is 272px, the text column 235px, the font Quattro 15px. That holds about 26 characters a line.
  - "Say go to deploy #38 (companion) + #58 (Today/Calendar) to production by Wed 10-14." is 84 characters and needs 4 lines, so two lines can never hold it. r15's cut after "#58" was the honest cut for 2 lines; the measurement wasn't wrong.
  - So I departed from "two lines": an action reads whole up to **4 lines**, and the panel shows fewer rows ("+N more"), as Codex asked. **Real app:** 4 lines, not cut (`y1-cohere`).
- **A step cut by the writer:** `tasks.py` keeps `next` to 140 characters (`a.next[:140]`). Three of Aaron's tasks are cut mid-phrase ("…hero wording…) in the", "…Everything else in T-125 is").
  - Such a step now ends on a whole word with "…", plus "The rest is in its note ›". The sheet says "This step was cut short when it was written. Open the note ›".
  - **Real app:** both cut rows had the way in.
  - The cap itself is in `uni-tasks`; I didn't touch it.
- **"was due":** T-113 (room:cohere, due 2026-10-13) is past due. **Real app:** "was due Oct 13" in COhere's work view, In motion (`y3-cohere-work-overdue`), and at 920×360 (`m4-work`).
  - Its cut title now reads "Companion Today redesign + integrated PWA install flow" (was "…flow (3").
  - Its state reads "Blocked", not "Waiting on blocked"; `parked` and `external` read as words too.

## Smaller
- **Sidebar bottom row:** with every area unfolded at 1280×720 and the tree scrolled to its end, the last row (Open Human Design) ends at 603 and the tree at 619, where Recent starts. It is whole (`y6-sidebar-end`). r15's cut row was the tree's scroll position, not a row hidden behind Recent. No change.

## Tests
- tsc is clean. `npm test` passes, with new unit tests for the title cleaner, the "Decide:" line, cut steps, the owner rule, the short-room maths, the saved list's scope and cap, heading questions and state words.
- `cargo test -p uni-core --offline`: 90, 1 and 22 pass (one new test).
- Playwright `simple`: **303 passed, 0 failed, 39 skipped** (phone-only or wide-only cases), on `e61d650`. The new `r16` specs run on mac, mac-small and phone:
  - tasks before Running/Drafts, and the activity lines;
  - "Still loading · Retry", then Retry, then the saved list with its age on the next launch;
  - the short-viewport fold and sheet at 800×600 and 740×360;
  - the phone's inline strip (composer whole, 40% for the conversation, no row cut);
  - guarded "I did this", Archive and Undo;
  - the title cleaner and "Decide:" rows;
  - the cut step and the heading-only decision note;
  - owner filtering.
- r12–r15 specs were moved to the r16 rules: "Decide:" rows, 4-line actions, the owner rule, and the strip folded on a phone with its rows in the sheet.
- Other configs:

  | Config | Result |
  |---|---|
  | roomsnav | 27 pass |
  | screens | 7 pass |
  | nested | 6 pass |
  | chatoptional | 6 pass |
  | rail | 18 pass |
  | sidebar | 14 pass |
  | areas | 248 pass, 2 skipped (after `04f8cb8`) |
  | default | 318 pass, 12 fail, 40 skipped (before `04f8cb8`) |

  - **areas, first run:** 8 failures, all spec expectations from before r16, fixed in `04f8cb8`:
    - `tasks.spec` expected unguarded transition args and the old conflict notice;
    - `lifeos.spec` counted the area reads with the run/draft reads, which now start beside the tree read.
  - **default:** 10 of the 12 failures are `vault-links`. The other 2 were the new slow-load spec, which needs the test-hooks build that this config doesn't make; it now skips there. A re-run of the `r16` specs under this config: 19 pass, 3 skipped. I didn't re-run the whole default config after `04f8cb8`.

- **`vault-links` is known failing** (its 5 tests on mobile and desktop).
- `lifeos-vault`, `interface-webkit` and `webkit` were not run. `lifeosAnyVault.ts` now passes `if_updated_at` with the transition, untested.

## Not done
- Codex P2-6 (Places repeats the rail), P2-7 (Back meanings), P2-8 (Search/Settings/Vault overlays not inert), P2-9 (Archive/Snooze behind a menu; "Say it" for "Tell…" steps), P2-10 (shell around setup and discovery), P2-11 (the title cache scoped by identity), and the P3s.

## Watch
- **Escape in the walks:** the harness (cage + `wtype`) never delivers Escape to the page. The key probe saw Tab and "x" arrive, and Escape didn't. So the task sheet and the strip's sheet couldn't be closed with a real Escape in any walk.
  - `0bbd81b`'s message blames WebKitGTK; that was wrong.
  - The strip sheet's Escape is now on the window, like the drawer's. In the walk, a `keydown` dispatched in the page closed it.
  - r15's "escapeClosed: true" for the drawer may not have come from Escape either.
- **Saved list on the device:** it holds task titles and steps from Aaron's vault in the app's local storage, like the asks cache. Forget clears it.
- **Repeated status lines:** on a wide window a slow first load shows "Still loading" in both the tree column and the companion; in the tree's narrow column "· Retry" wraps to its own line. A warm launch shows three saved-copy lines at once: the areas' "Saved copy · refreshing…", the tree's "As of 2:23 AM · refreshing…" and the companion's "29 as of 2:23 AM · refreshing…" (`t1-first-rows`). One line would be calmer.
- **Inside the strip's sheet** a long list scrolls; it is a sheet, but its last row can sit at the edge until scrolled.
- **4-line actions** mean the side panel shows fewer rows at once. On COhere at 1280×720 that is the deploy task, one decision, then "+4 more ›".
- **`tasks.py`'s 140-character cap** will keep cutting steps; lifting it (or always writing the full step in the note's "**Next:**") would end the cut rows at the source.
