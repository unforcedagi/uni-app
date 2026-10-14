# REPORT: Simple first, round 13 (T-124 r13): one work view, honest decisions, Needs you that adds up, narrow windows

This round works on `feat/simple` from f0d4260. It adds four commits plus this report, and nothing is pushed:
- `d660a36` identity: tells "no key" apart from "couldn't read the key" (Rust).
- `0c47776` the main round: one feed and one count, the work view in the room shell, the live sheet, the drawer below 900px, Back order, and the P2s.
- `9099f6c` fixes that the real-app walk surfaced.
- `72f7888` a spec fix (screens).

**Real app:** a debug build with `--features custom-protocol`, run against the scratch hub, signed in as uni-reviewer. Every walk below ran on the final binary, built from `72f7888`, on one fresh set of app data.
- `r13-worker-cold`, then `r13-worker`, with `driver-r12.js`, run exactly as specified.
- `r13-worker-extra` with my own `driver-r13-extra.js`, which covers the work view and its Back paths, the one count, a decision whose question can't be resolved, and Settings.
- `r13-worker-800x600` and `r13-worker-740x360` with my own `driver-r13-narrow.js`. My copy of `walk.sh` is at `~/.hermes/cache/scratch/r13/walk.sh`. It adds `WALK_SIZE`, which sets cage's headless output with `wlr-randr` (installed this round with `pacman -S wlr-randr`). `randr.log` in each run shows the mode was applied.
- `r13-worker-keyerror`: a copy of `launch.sh` with `UNI_NSEC` set to an invalid value, on its own throwaway app home. The script removed that home afterwards.
- Cleanup: `~/.hermes/cache/scratch/t124-apphome-r13w` has been removed.
- PNGs: `~/Code/uni-sketches/t124/walk/runs/r13-worker*/`. The drivers (looking only, they never send, answer or check anything off) are in the walk directory. Nothing was ever clicked on an answer, on "Say it", or on "I did this".

Earlier walks this round, on an older build, found three bugs that are now fixed (see "Found by the walk").

## Code
Across `src`, `src-tauri` and `crates`: 629 lines added, 635 removed, in 25 files.
- **Deleted:** `WhereWeAre.tsx` (the census, the Now/Soon/Someday buckets and the priority selects on each row), `SteerPage.tsx`, `Changed.tsx`, `treeAlive.ts`, `nodeMap.ts` and its test.
- **Also removed:** the work page's `TaskList`; TreeHome's level panel, alive, updates, inside and door pieces; `updatesBelow`; `rootNeeds`.
- **New:** `WorkView.tsx` (58 lines).

## P1s

### 1. No answer without the whole question
**Done.**
- **Where answers appear:** they are drawn only where `decisionAsk` has the whole question, in the companion, the sheet and the work view. All three use the same `DecisionAnswer`, and all three use `NeedRow` for their rows.
- **A cut question in the sheet:** the sheet first reads the note itself (`loadAsks` for that one task) and shows "Reading the question…". If no whole question turns up, it reads "The question is in its note" with "Open the note to read the question ›", and offers no buttons at all.
- **A new hole, found in real data:** one decision's "question" had been read from the first line of its note, which was one of its own options ("- Add key and test live on preview first"). `askFromContent` now skips list lines. Asks kept on the device that are list lines are dropped.
- **Real app:**
  - `x5-cut-sheet`: that decision, in Uni's work view, reads "Open to see the question ›". Its sheet reads "The question is in its note" with the open-note link. The walk logged 0 answer buttons.
  - `x3-cohere-work`: three whole questions with Yes/No, and the walk logged zero rows with answers beside a cut title.

### 2. Needs you adds up everywhere
**Done.**
- **One feed:** `needsFeed` (in `simpleCore.ts`) is the one list. It uses the one rule, `needsYou`: Now, Soon and open decisions, never Someday.
- **The companion and Uni's panel:** the companion shows the whole feed. Uni's panel (`uniPanel`) shows Uni's own items, then three from the areas, then "+N in areas ›", which opens Uni's work view.
- **The dots:** `needsByRow` counts each item on its node's row, or on its nearest ancestor's row when the node has no row, so the dots under a level add up to that level's feed.
- **The work view:** its "Needs you N" is the same feed's total. Someday is its own folded "Later" section and is never counted.
- **Private items:**
  - "counted but not named (private)" is gone.
  - From above, a private area reads "A private item in Sadhana · open ›" (or "2 private items in …"), counts toward the total, and opens that area.
  - At the private area's own level each item is its own row, "A private item here · open ›", which opens the task's note. Titles are still never shown.
  - Private items that are not Needs you are left out of In motion and Later, with one line saying how many and where to look.
- **Real app (`r13-worker-extra` log):**
  - Uni: the panel showed 3 rows, 1 private item and "+25 in areas" (29). The dots added up to 29 and the work view said "Needs you 29".
  - COhere: the panel showed 6 once "+4 more" was opened, the dots added up to 6, and the work view said 6.
- **Bug the walk found:** on WebKitGTK, opening "+4 more" added a scrollbar. That narrowed the panel, and the resize folded the list back to two rows. Now only a new list folds it back.

### 3. "All of X's work" is a focused view inside the room shell
**Done.**
- **Shell:** the same header and crumbs, with a bar reading "‹ Back to chat · All of X's work". The work view takes the chat's place; the sidebar stays and the companion steps aside.
- **Sections:** Needs you N, then In motion (Running, Drafts, and what others hold, with a quiet "with Kevin · in progress" line), then Later (Someday, folded).
- **Gone:** the census, the count tiles, the priority selects on each row and the check-offs. Rows are the companion's `NeedRow`, so asks and links are resolved the same way. Priority moved into the sheet.
- **Kept, deliberately:** a quiet top line with the brief's lede, "Brief updated …" and "Refresh the brief" (the only place the brief's Refresh draft lives). A project's own note is kept too, folded, at the foot. Say if you want either gone.
- **Without chat** (`chat.provider` null) or with no room at all, the work view is the room's only view, and there is no "Back to chat".
- **Back order:**
  - Escape, Alt+←, the sidebar's ← and Android Back close the work view (and the drawer) before they change places.
  - A sheet is modal: Alt+arrows do nothing while it is open, and Escape closes it.
  - A note link in the sheet now closes the sheet first.
- **Real app:** `x2-uni-work` and `x3-cohere-work` show the view. The walk logged Alt+← (a real key through wtype), the sidebar's Back and "Back to chat" each returning to the COhere chat.
- **Not seen in the real app:**
  - Escape. A real Escape sent with wtype never reached the page: a keydown listener the driver put on `window` recorded nothing, while Alt+← through the same path worked. So this is a limit of the walk setup, not something I could judge in the app. Escape is covered in Chromium by the spec.
  - Android Back (no device). It is covered by specs through the back-button hook.

### 4. The task sheet is live, and its primary action is the item's own
**Done.**
- **Live:** the sheet holds the task's id and re-reads it from the list on every refresh. If the task is done, decided or snoozed elsewhere, it says "This is no longer open…" and offers only Close.
- **The task tree:** it is re-read with every refresh. A failed read keeps the last good tree, or falls back to the app's own, and says "Couldn't read where tasks belong · Retry" in the companion and above the tree. It is no longer cached as if it had been read.
- **The lead line:**
  - A `next` that starts with an action word (`actionLead`, unit-tested) is the sheet's heading, with the title under it.
  - A "Say / Reply / Tell / Answer …" step gets "Say it in #room ›" as its primary action. It fills that room's composer and never sends.
  - "I did this" is secondary. Archive and Snooze stay.
  - Priority is three buttons in the sheet (Now, Soon, Someday), with the same guarded write and Undo as before.
- **Real app (`05-needs-item`, `x7-task-sheet`):** the heading is "Say go to deploy #38 (companion) + #58 (Today/Calendar) to production by Wed 10-14.", with "COhere opens Oct 15" under it. Then the priority buttons, then "Say it in #cohere ›" as the primary action and "I did this" as secondary.
- **Not seen in the real app:**
  - A live refresh changing an open sheet (no other writer during the walk).
  - The tree-read error (the hub answered every time).

### 5. Phone landscape and short windows keep global navigation
**Done.**
- **The drawer:** below 900px the room header's left button ("Places", ☰) opens a drawer. It holds the app's places (Journal, For you, Vault, Search, Settings), Back/Forward, the tree and Recent.
- **On phones:** the drawer's rows are touch-sized. On short screens the places keep to one line.
- **The tree home:** on short screens the phone's tree home shows the same places row.
- **Breadcrumb:** the header keeps a compact one-line breadcrumb ("Uni › Boulder · #cohere").
- **The phone's `‹`:** it was replaced by the drawer button. Android Back still goes to the tree home.
- **The companion:** it keeps one choice per width class. A panel open on a wide window folds when the window crosses under 1100px, and one opened under 1100px stays open there. Specs cover both directions.
- **The `screens` spec:** phone-landscape passes (7/7).
- **Real app:**
  - 800×600 (`n2`, `n3`): the hamburger, the compact breadcrumb, the companion as a strip, and the drawer with all five places. Settings, Search and Vault each opened from the drawer (`n4-*`).
  - 740×360 (`n2`–`n6`): the rail is hidden. Every place opened from the drawer, and the Journal's "‹ Back to Uni" returned to the tree home with its places row.
- **Bug the walk found:** coming from the Journal in landscape, tapping a room opened a second tab for a place that already had one. The next rooms sync folded the duplicates together and showed the Journal instead. `openTab` now uses the place's existing tab, and `restoreTabs` maps a dropped twin to the tab it keeps (unit tests). One older tab test that expected the duplicate was changed.
- **Not seen in the real app:** the 900–1100px band (no walk at that width), and a resize crossing 1100px (the cage output size is fixed for a run).

### 6. An identity read failure is not shown as "unpaired"
**Done.**
- **Rust:** `uni_core::key_status()` returns `Err` when a key may exist but couldn't be read (an unreadable env key, or a keyring that answered with an error) and `Ok(None)` only when there is none. `identity_status` uses it. Unit test: `key_status_tells_none_from_unreadable`.
- **App:** shows "Couldn't read your key · Retry", never the pairing screen.
- **Real app:** `r13-worker-keyerror/k1-key-error.png` shows "Couldn't read your key · Retry", and the driver found no pairing input.
- **Not seen:** a keyring that actually errors (no macOS here) and an Android keystore failure.

## P2s
- **Cold chat:** done. A known room with no messages yet reads "Loading messages…". A failed first read reads "Couldn't load messages · Retry". Real app, cold `01`: "Loading messages…" under the Uni header.
- **Modal keyboard:** done (see P1 3).
- **Settings and setup wording:**
  - Done: the sandbox self-test and the notes hub moved into a folded "Developer" section (`x1-settings`, `x1b`).
  - Done: Search says "Your notes are searched too, by meaning or by keyword." The Journal says "transcribing…". Sync says "Connecting…" and sends say "Message sent".
  - Done: with no areas yet, Uni says "Tell Uni here what you want to look after…".
  - Not done: "Uni (version unknown)" still shows in Settings.
- **Chat's top mask:** done. The fade is gone; a hairline under the header marks the edge.
- **Channel names:**
  - Done: `roomSlug` now returns the channel's real name, so the tree, the header, the placeholder, Other rooms and "Open in #…" all agree.
  - Watch: the scratch data's Uni channel is named "Uni", so it now reads "#Uni" where it used to read "#uni".
  - Not done: "Conversation in #boulder" for a project that borrows its parent's chat. The placeholder still names the room.
- **Sidebar chevrons:** a chevron was already drawn only when a row has children. COhere does have children (COhere 2026 and Woven Web are under it in `x3`). Its tooltip now says "Show what is inside COhere (2)".

## Tests
- `tsc --noEmit` is clean.
- `npm test` passes, with new unit tests for `needsFeed`, `uniPanel`, `needsByRow`, `privateLabel`, `actionLead`, `sayText`, `privateRoot`, list-line asks and one tab per place.
- `cargo test -p uni-core --offline`: 88, 1 and 22 pass.
- Playwright `simple`: 227 passed, 0 failed (phone-only cases skipped). New specs:
  - no answers without the whole question, in the work view and the sheet;
  - one count across the panel, the dots and the work view, with Someday apart and private rows;
  - the work view in the shell;
  - Back closing the work view first (Escape, Alt+←, the sidebar's ←, Android Back), with Alt+← held while a sheet is open;
  - the live sheet on refresh, including closed elsewhere;
  - "Say it" filling the composer with no send, and priority in the sheet;
  - the drawer below 900px with Settings reachable;
  - phone landscape: places from a room, the Journal and back;
  - the identity read error;
  - the cold chat line;
  - the companion folding when the window narrows.
- Other configs:

  | Config | Result |
  |---|---|
  | areas | 256 pass |
  | roomsnav | 27 pass (rewritten for the work view, the sheet's priority and private rows) |
  | rail | 18 pass |
  | sidebar | 14 pass |
  | chatoptional | 6 pass |
  | nested | 6 pass |
  | screens | 7/7 pass, phone-landscape included |
  | default (composer and others) | 268 pass, 11 fail |

  The 11 failures in the default run:
  - 10 are `vault-links`. **It is known failing, as at baseline.**
  - 1 is `composer.spec.ts:263` on mobile. Its setup timed out while I was running the `screens` config at the same time, which rebuilds `dist/` under the running server. Run alone, `composer.spec.ts` gives 88 passed, 2 skipped, 0 failed.
- `lifeos-vault` was not run (it needs a scratch vault and failed at baseline).

## Not done
These are from the Codex review and outside this task:
- Markdown tables are still raw text in the chat.
- A raw `uni:<ULID>` chip and "decision · T-135" chips still show in messages (`09-left`).
- Companion option buttons are 32px tall.
- Settings still shows "version unknown".

## Watch
- On phones, the room header's ☰ (the drawer) replaces the old ‹. The tree home is still the phone's home, and Android Back goes there.
- The places row in the drawer repeats the rail on phones in portrait, where the rail is also visible. I kept it so that the drawer is the same at every size under 900px.
- `actionLead` is a list of action words, so a step that starts with an uncommon verb won't lead. It is never wrong in the other direction: a status ("Waiting on Kevin") or a noun phrase ("Check-in PR by Oct 12") doesn't lead.
