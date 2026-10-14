# REPORT: Simple first, round 12 (T-124 r12): one app, not four

This round works on `feat/simple` from 473b618. It adds five commits plus this report, and nothing is pushed.

**Real app:** a debug build with `--features custom-protocol`, run against the scratch hub.
- Walks: `r12-worker-cold`, then `r12-worker` on the same app data, run as specified with `driver-r12.js`.
- Extra walk: I wrote `driver-r12-extra.js` (in the walk directory). It covers Settings, a thread, an Other room, a decision sheet and the work page, and it never answers a decision. I ran it as `r12-worker-extra` on the same data before deleting it.
- Cleanup: `~/.hermes/cache/scratch/t124-apphome-r12w` has been removed.
- PNGs: `~/Code/uni-sketches/t124/walk/runs/r12-worker{-cold,,-extra}/`.
- What I looked at: every warm PNG except 02, 03, 06 and 07; the cold 01, 04, 05, 06, 08 and 09 (from the first cold walk, before the last rebuild); and all four extra PNGs.

## Code removed
Across `src`, `src-tauri` and `crates`, 1529 lines were removed and 734 added (36 files).

Deleted files:
- `BriefView.tsx`, `NodeStage.tsx`, `HomeLayoutSetting.tsx`, `areaSlots.tsx`, `roomNesting.ts`.
- `treehome.spec.ts` with its config, and `nodeview.spec.ts`.

Code gutted:
- `nodeMap.ts`: the map layout code (−142).
- `TodayView.tsx`: the Today page.
- The talk bar: `TalkBar`, `RecentMessages`, `useHoldTalk`.
- `NeedsBlock`, `Ledger`, `RoomBlock`.
- Ask-Uni and keep-as-note handoffs: `handoffText`, `messageLink`, `toUni`, `keepVoice`.
- Reaction creation: `react`, `toggleLocal`, quick reactions, and the Tauri `react` command.
- Reply-to, `stewardLine`, the plain conversation header, the destination line.
- About 250 lines of CSS that only these used.

## 1. Delete, don't fix
**Done.**
- **Layouts:**
  - The picker, the `homeLayout` branches and the map are gone.
  - `migrateHomeLayout()` runs once in `main.tsx` and drops any saved `uni.home.layout.v1`. There is a unit test and a spec that boots with a saved `tree` choice.
  - Room resolution no longer reads a mode.
  - Real app: `x1-settings` shows Settings with no Home layout section.
- **Rooms drawer:**
  - The rail's Rooms button and the avatar list are gone.
  - Vault and Search are now on the phone's rail; a spec checks 6 visible buttons.
  - Rooms no node owns sit under a folded "Other rooms" group at the foot of the tree, and open in the same shell: header, chat and a companion that says "Not filed under an area yet." This is covered by the simple and rail specs.
  - Threads open inside their room's shell with "‹ Back to the room" and "Thread · N replies" (simple spec, composer spec).
  - **Not seen in the real app:** the uni-reviewer account has no room without a node (the extra walk logged that there is no Other rooms group), and the Uni room had no message with replies. I did not see either one live.
- **Message menu:**
  - It holds Copy, plus Edit and Delete on your own messages.
  - It is now a plain group of buttons, not `role="menu"`.
  - Existing reactions still show, read-only.
  - I also removed "Reply in thread" and "Reply", since the task listed only Copy, Edit and Delete. Existing threads still open from their reply count, but there is no longer a way to start a new thread from the app. Say if you want that back.

## 2. One decision control everywhere
**Done.**
- `DecisionAnswer` (the options, or Yes/No) is used by:
  - the companion,
  - the task sheet,
  - both lists on the work page.
- Each writes `decided` through `vault_decide`.
- "Mark decided" and the decision check-offs are gone, and `act()` refuses to close a decision.
- A spec answers a decision from the sheet: it checks for exactly one `vault_decide` with the option and zero `vault_transition` calls.
- In the real app (`x5-decision-sheet`), the sheet shows "DECISION (DEFAULT YES) · IN COHERE 2026", then "Your call:", then the whole question, then Yes/No. Nothing was clicked.
- In `x6-work`, the work page has 3 answer groups and 0 decision check-offs (logged by the driver).
- Rows show the whole question, unclamped and sentence-cased, with its buttons. The rest of the list goes behind "+N more ›" (`04-cohere`: the Benya question is whole with Yes/No, then "+4 more ›").
- "Open to decide" is gone. A question known nowhere reads "Open to see the question ›" with no fragment, and its sheet offers "Open the note". This is covered by a spec; I saw no such row in the real app.
- The sheet focuses its first action, never an answer, so Enter cannot decide by accident.

## 3. Needs you you can trust
**Done.**
- **Load state:**
  - `useTasks` now passes `error`, `refreshing`, `lastOk` and `complete` to the companion and the tree.
  - A failed first load says "Couldn't load. Retry".
  - A failed refresh keeps the rows and adds "Couldn't refresh (as of …) · Retry".
  - The tree shows matching lines. A spec covers both cases and Retry.
  - These states were not seen in the real app; the hub answered every time.
- **Paging:**
  - `vault_query` and `vault_query_meta` now take an `offset` (Rust: `query_tagged_at`, `query_by_metadata_at`, plus a test).
  - The app reads 200 at a time and only treats the list as whole after a short page.
  - It stops after 2000 notes, or when a page adds nothing new (a vault that ignores `offset`), and says so.
  - A spec puts 230 tasks before Kevin's and checks for the page with offset 200.
  - Not done: the per-node subtree query still stops at 200. The room shell doesn't use it, because it reads the whole tree once.
- **Dots:**
  - The dots and the companion now share one rule (`needsYou`: Now, Soon and open decisions, owned by or waiting on you; never Someday).
  - A folded area's dot is a ring titled "Something inside needs you". There is a spec, and the real app shows the rings on Atlas, Boulder and Unforced Development in `01`.
  - Unforced Development no longer gets a solid dot for a Someday task.
  - Private items are counted, not named: "1 more needs you here, counted but not named (private)" (`01`).
- **Uni's panel:** it shows Uni's own items plus the three most urgent from the areas. Real app `01`: two rows, then "+1 more ›" for the third, which didn't fit. That is not the "+25". The rest is under "All of Uni's work".
- **Sheet:**
  - The heading is the action without its id, with the linked next step under it.
  - Ids, hashes and "via api" are gone.
  - "Details" holds "Task T-NN" and "Last changed by you / Uni, <time>". "you" means this app's own writes; "Uni" means a write through MCP; otherwise no name is shown. This is an inference, not a mapping of writer ids.
  - Real app `05`: "TASK · IN COHERE 2026 / COhere opens Oct 15 / next step / Status", with Details closed.

## 4. Smaller
- **Stands:** the sentence is kept whole, clamped to 3 lines in CSS, with a real "More" button. The cold `text-01` has the full Uni sentence in the page, and the screen shows "More".
- **Empty-room flash:** "No messages in this room yet" now appears only after the store answers. Cold `01` showed the Uni room with nothing rather than the empty text, and no walk text contains it. The COhere warm-launch case wasn't reproduced, because this walk opens on Uni.
- **Recent:**
  - It dedupes by place id; a room a node owns counts as that node.
  - Where names collide, it shows "Name · Parent" (spec with two "Workshop" projects).
  - It shows at most 3 when the tree overflows, and is no longer a fixed 124px block (spec).
  - Real app `08`/`09`: Recent shows two places.
- **Uni listening:** the switch still does something. It decides whether your messages notify Uni, so I kept it as a small "Uni listening / Uni muted" switch in the compose row, shown when Uni is in the room. The spec checks that a muted send has no recipients. It is visible in every real-app PNG.

## Walk steps 08 and 09
- 08: Atlas, folded by hand, is revealed when Learn Vibe Build opens from Recent.
- 09: leaving for Uni folds it back (`aria-expanded=false`, no miss logged).

Both hold in the cold and warm runs. Step 03 on cold logs "no area disclosure controls found" because every area starts folded on fresh data.

## Problems the spec rewrite found (fixed)
- In an area's App tab, "Open room" and a suggestion's "Add to draft" did nothing once the room was the same place. They now switch to the Room tab, which was renamed from "Brief".
- On a phone, going back to the tree during a voice recording was blocked ("Stop the recording before replacing its tab"). A recording's tab is now never replaced.
- If the areas couldn't be read, Other rooms never appeared. Uni's own level also said nothing on a failed load or while signing in. All three are fixed.
- The task sheet sat under the phone's rail.

## Tests
- `tsc --noEmit` is clean.
- `npm test` passes (278 checks).
- `cargo test -p uni-core --offline`: 87, 1 and 22 tests pass.
- Playwright `simple`: 196 passed, 0 failed, 35 skipped (phone-only skips). New specs cover:
  - the layout migration;
  - Other rooms in the shell;
  - threads in the shell;
  - the decision answer path in the sheet;
  - the work page having no check-offs;
  - load error and Retry;
  - paging past 200;
  - dots matching Needs you;
  - Uni's panel;
  - the sheet's Details;
  - Recent ids and parents;
  - Recent kept to 3;
  - the Uni switch.
- Other configs, rewritten where the UI still exists and deleted where it doesn't:

  | Config | Result |
  |---|---|
  | areas | 189 pass |
  | composer + default | 249 pass |
  | rail | 18 pass |
  | sidebar | 14 pass |
  | chatoptional | 6 pass |
  | nested | 6 pass |
  | roomsnav | 27 pass |
  | screens | 6/7 pass |

  Two baseline failures now pass: `ids` stewardship and composer voice navigation.
- **Known failing:**
  - `vault-links` (10, as at baseline).
  - The phone-landscape `screens` project. Deleting the drawer doesn't fix it: with the rail hidden, the room shell has no way to the navigation panel. That is round 13's narrow and keyboard work.
  - `lifeos-vault` was not run; it needs a scratch vault and failed at baseline.

## Watch
- On a phone, a saved Uni tab reopens on the room tree. That is the phone's home, but r11's specs had assumed the Uni room.
- The work page's "need you" count still includes Someday. That page is round 13's.
- The chat still shows Markdown tables as raw text (an r11 critic note, not in this round).
