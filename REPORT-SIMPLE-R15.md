# REPORT: Simple first, round 15 (T-124 r15): one meaning for "room", one vault per reference, rows that read whole

This round works on `feat/simple` from e94c76f. It adds seven commits plus this report, and nothing is pushed:
- `1667a32` One vault per note reference, and the note-title cache.
- `4b5b2d4` The main round: the borrowed-room heading and restore, stale counts, word-clamped action lines, Search, the shared focus trap, unavailable areas in the shell, calendar-day ages.
- `c016789` The r15 specs.
- `330c040` Specs in the other configs updated for the borrowed heading; the refresh-failure line in an r12 spec.
- `8e85954` A spec helper whose closing brace a comment had swallowed (roomsnav).
- `d4108c0` The area fixture's open helper.
- `dd726ff` Search's placeholder, shortened after the 800×600 walk showed it cut.

Across `src`, `src-tauri` and `crates`: 21 files, 410 lines added, 137 removed. New: `src/areas/focusTrap.ts`. Nothing in `src-tauri` or `crates` changed.

**Real app:** a debug build with `--features custom-protocol`, against the scratch hub, signed in as uni-reviewer.
- **The build:** I built the frontend into `/tmp/r15-dist` with plain `vite build`, outside `dist/`, because spec servers were using `dist/`. I checked it had no test hooks or `__T76_MOCK`. Then I pointed the build at it with `TAURI_CONFIG` (`frontendDist`). This was the same clean build `check-release-dist.sh` makes, in another folder.
- **Binaries:** `uni-app-tauri-r15` was built from `330c040`'s source; `src` didn't change again until `dd726ff`. `uni-app-tauri-r15b` was built from `dd726ff`.
- **Walks:** all on one set of app data (`t124-apphome-r15w`), in this order:
  1. `r15-worker-cold`, then `r15-worker`: `driver-r12.js`, run exactly as specified.
  2. `r15-worker-extra`: my `driver-r15-extra.js` at the default size. It ends on Expression, so the next walk shows where a borrowed place reopens.
  3. `r15-worker-800x600`, `r15-worker-740x360` and `r15-worker-920x360`: my `driver-r15-narrow.js`, through my copy of `walk.sh` with `WALK_SIZE` (`~/.hermes/cache/scratch/r15/walk.sh`). Each run ends on Expression for the next one.
  4. `r15-worker-800x600b`: the same narrow driver on the `dd726ff` binary, after the placeholder fix.
- **One more cold walk:** `r15-worker-cold-quiet` used a throwaway app home that `walk.sh` deleted itself. It explains the first cold walk; see Tests.
- `~/.hermes/cache/scratch/t124-apphome-r15w` has been removed. No `t124-apphome-*` folder is left.
- **The drivers only look.** They never send, answer, check anything off or press "Say it" / "I did this". Neither driver opens the Journal.

**Privacy:**
- The private area (Sadhana) was opened from inside once, in `r15-worker-extra`.
- Before it opened, the driver blurred the room, the companion, the tree, the drawer and any sheet with its own style. The video frames from that stretch are blurred.
- No screenshot was taken there and no text file was written. The log keeps only counts: `rows: 1, rowsWithRealTitles: 1, privateLinesInside: 0, blurred: true`.
- No private content is in this report, the fixtures or the specs.
- r14 already flagged r13's unblurred narrow runs (`r13-worker-800x600`, `r13-worker-740x360`). I didn't touch them; they are still there.

## P1s

### 1. Borrowed rooms: the real conversation is the heading
**Done.**
- **The heading:** for a node with no room of its own that talks in an ancestor's room or Uni's, the heading is that room ("#Uni"). The node is a quiet line under it: "Expression · no room of its own yet, talking in #Uni". The old "Conversation in #…" door is gone. A node with its own room is unchanged ("COhere", `#cohere`).
- **The companion:** it is labelled as the node's: "Where Expression stands" on the side panel, and "Expression:" before the sentence in the phone strip.
- **The work view and the area app:** these are the node's own views, so their heading is the node's name, with the same context line.
- **The `.sr` element** carries `data-node`, so specs and drivers read the place, not the heading.
- **Why the 800×600 walk opened on Expression:** r14's extra walk ended on Expression, and the app reopens to the last place.
  - Now an area tab records `borrowed` once the tree says so.
  - The app keeps the last real room opened (`uni.lastRoom.v1`): a room, a thread, Uni, or a node known to own its room.
  - A restore that lands on a borrowed node opens that room instead, else Uni (`restorePlace` in `tabs.ts`).
- **Tests:**
  - Unit tests in `tabs.test.ts`.
  - Specs `r15 › a node with no room of its own…` and `r15 › the app never reopens on a node that only borrows a room…`.
  - The held-room specs in simple, nested, ids and areaRoom were updated.
- **Real app:**
  - Expression read "#Uni" over "Expression · no room of its own yet, talking in #Uni", with "Where Expression stands" and "Message #Uni" (`y3-expression`). Its work view was headed "Expression" (`y3b`). The same held at 800×600, 740×360 and 920×360 (`m3-expression`).
  - Restore: every walk that followed one ending on Expression opened on COhere, the last real room: 800×600, 740×360, 920×360 and 800×600b. None opened on Expression.
  - At 920×360 the side companion is folded (under 1100px), so it shows no label until it is opened. I didn't open it there.

### 2. One vault per reference
**Done.**
- **References:** a note reference is `{ vault, id }` (`NoteRef`). `uni:01M…` (any lowercase `vault:` prefix) names its vault. A bare id belongs to the vault the text lives in.
- **Tasks:**
  - Every task carries the vault it was read from (`Task.vault`).
  - Rows, the sheet, the work view's drafts, and a brief's or an area app's links read titles and open notes in that vault.
  - `App.tsx` opens `{ vault: r.vault, ref: r.id }` instead of a hard-coded `uni`.
- **Chat:** chips use the vault the link names.
- **Test:** `r15 › one vault per reference…`, in a non-`uni` profile (`lifeVault: 'life'`). The fixture finds each note only in its own vault.
  - The bare id is read with `vault: 'life'` and opens with `vault: 'life'`.
  - The `uni:` id is read in `uni`.
  - A read in the wrong vault would show "a note" or "not found".
- **Real app:** the scratch walks use the `uni` vault only.
  - COhere's rows had no linked notes this time (`refs.titles: 0`) and no raw ids.
  - **Not seen in the real app:** a note link in another vault.

## P2s
- **Rows read whole:** done.
  - An action line is cut by the app, not the browser (`WordClamp`). Two full lines, then "…" after the last whole word, link or note title, then More. A new width or text measures again before paint.
  - Spec `r15 › an action line wraps to two full lines and ends on a whole word…`.
  - Real app: COhere's companion showed "Say go to deploy #38 (companion) + #58…" on 2 lines, ending on `#58` (`cut: true, lines: 2`). Expression's showed "Check the FableJi Members UI and confirm whether you…".
  - In Uni's work view, all eight action lines read whole within 2 lines, including "Confirm your role in Riverside and the dates (…) so the tracker can stay current." (`y2`).
- **The work view reads like the companion:** done.
  - A decision whose whole question isn't known now shows its title's words as a preview, "…" and "Open to decide ›", the same as a question too long for a row. Never answers beside it.
  - "Open to see the question" is gone.
  - Real app: Uni's work view had `openToSee: false`. One decision there reads "2026-10-13 Ship the Boulder Votes AI chat? (preview: …" with "Open to decide ›". The other four showed their whole questions with answers.
- **Overdue cue:** already in place since r9 ("was due Oct 7", in ink, medium weight). It applies to action-led rows and the work view too, and the new spec checks the work view.
  - **Not seen in the real app:** no task in the scratch data is past due.
- **Stale counts:** done.
  - A failed refresh reads "29 as of 3:12 PM · Couldn't refresh · Retry", with the date when the read wasn't today. The count keeps the number, with the label "29 as of 3:12 PM".
  - "29+" / "at least" is only for a read that succeeded but couldn't read every page.
  - Specs: `r15 › a failed refresh says…`, plus the updated r12 and r14 specs.
  - **Not seen in the real app:** no refresh failed (`health: []` everywhere).
- **Note-title cache:** done.
  - It is keyed by vault and id, stored as `uni.noteTitles.v2`, newest 300, in memory and on the device.
  - A title kept from the last launch is read again once in the background, and again after 10 minutes on the next look or refresh. A renamed note (a new `updatedAt`) shows its new title.
  - A failed read is tried again after 30 seconds instead of being remembered for the session, and a failed re-read keeps the known title.
  - Unit tests in `navtree.test.ts`. **Not seen in the real app:** a rename.
- **740×360 first screen:** done.
  - A short window (rail hidden) opens on the room with Places in its header. The full-screen tree is only for a phone held upright. Back from a node goes to its parent there.
  - Spec `r15 › 740×360…`. Real app: the first screen was COhere's room with Places (`fullScreenTree: false`, `m1-open`).
- **Search at 800×600:** done.
  - The field shrinks with the panel. Cancel is gone (the frame has Close; Escape still closes).
  - The empty state says "Search conversations and notes. Every room and thread on this device, including edits."
  - How notes match ("Similar meaning" / "Exact words"), the vault and the folder ("Folder", not "Path prefix") are folded under "Narrow the notes". So vault ids such as `uni-1` aren't on the first screen.
  - Spec `r15 › Search at 800×600 fits its panel…`.
  - Real app at all three sizes: `panelScrollsSideways: false, fieldInside: true, cancel: false`, and no "phone", "cached", "Path prefix" or "Keyword". The first 800×600 walk showed the placeholder still cut ("…and no"). It now reads "Conversations and notes" and fits (`r15-worker-800x600b/m5-search`).
- **Task sheet:** done.
  - One focus trap (`focusTrap.ts`) for the sheet and the drawer. It skips anything inside a closed `<details>` (its summary excepted), hidden or inert. It reads the open state itself, because WebKitGTK gives closed content a size.
  - Opening Details scrolls it into view. A spacer at the sheet's end replaces the bottom padding that WebKit leaves out of a scrolling box.
  - Spec `r15 › the task sheet's Tab wraps…`.
  - Real app: 18 Tab / Shift+Tab presses, 0 on a hidden Details control and 0 outside the sheet. Details opened and scrolled to the end, the last line was 36px above the sheet's edge (`y5-sheet-details`). In r14 it sat on the edge.
- **Empty or unavailable area:** done.
  - An area that no longer exists, or areas that couldn't be read, now show inside the room shell: the tree (or Places), a heading, and Retry (on an error), Back and Open Uni.
  - A vault without the pack offers "Ask Uni to set it up ›" (Uni's composer, filled in, never sent), Retry and "Back to Uni's vault".
  - Spec `r15 › an area that no longer exists…`. **Not seen in the real app:** neither case happens in the scratch data.
- **"Where this stands" age:** done.
  - Ages count calendar days on the local clock, so "yesterday" is the day before today, not 24 hours ago.
  - A bare date (`2026-10-13`) is that local day. It was UTC midnight, which is the evening before here and was the likely source of the flip.
  - Unit tests in `steer.test.ts`.
  - Real app: COhere and Expression both said "2 days ago" at the same moment. I didn't find a room that disagreed, but I didn't look across every room.

## Tests
- tsc is clean.
- `npm test` passes, with new unit tests for vault-qualified refs, the title cache, restore and calendar-day ages.
- `cargo test -p uni-core --offline`: 89, 1 and 22 pass.
- Playwright `simple`: **281 passed, 0 failed, 37 skipped** (phone-only or wide-only cases), on `dd726ff`. New `r15` specs, each run on mac, mac-small and phone:
  - the borrowed heading;
  - restore;
  - a vault-qualified link in a non-`uni` profile;
  - the 2-line word clamp;
  - stale-count wording and overdue;
  - 740×360;
  - Search at 800×600;
  - the sheet's focus ring and Details at 720px tall;
  - an area that no longer exists.
- Other configs:

  | Config | Result |
  |---|---|
  | roomsnav | 27 pass |
  | screens | 7 pass |
  | nested | 6 pass |
  | chatoptional | 6 pass |
  | rail | 18 pass |
  | sidebar | 14 pass |
  | areas | 242 pass, 6 fail, 2 skipped (see below) |
  | default (composer and others) | 304 pass, 11 fail, 39 skipped |

  - roomsnav ran after `8e85954`, which fixed the helper. The others ran on `330c040`.
  - The 6 areas failures were the old heading check in the fixture's open helper. After `d4108c0` those 6 pass. I didn't re-run the whole areas config.
- **`vault-links` is known failing.** 10 of the 11 default failures are its 5 tests on mobile and desktop.
- The 11th, `composer › Held send across room navigation… replace=false` on mobile, timed out once in the full run. It passed 12 of 12 on three re-runs on its own, so it is flaky under load, not new.
- `lifeos-vault` was not run (it needs a scratch vault). `interface-webkit` and `webkit` were not run.
- **The first cold walk:** `r15-worker-cold` stayed on "Loading…" in the companion for the whole walk. The rooms list also arrived late, so COhere showed "Opening the room…" and the walk found no row to open.
  - The areas spec suite (two Chromium workers plus Vite builds) was running at the same time.
  - A second cold walk with nothing else running (`r15-worker-cold-quiet`, same binary but for the placeholder) loaded as r14 did, with rows and questions in place by the COhere step.
  - My reading is that CPU load caused it. That is inferred, not proven.

## Not done
- Codex P3s: shared icons and type across surfaces, 44px answer targets in lists, and moving Archive/Snooze behind a menu.
- Codex P2-8: the drawer still repeats the rail's places at 800px, and the Journal still goes "Back to Uni" rather than to the previous place.

## Watch
- **The phone strip on a short window:** at 740×360, a strip left open (the choice is remembered per device) takes most of the 313px. The conversation starts below the fold (`r15-worker-740x360/m1-open`). Starting the strip folded on rail-hidden windows would fix it, but it is not done.
- **Restore:** a node visited only before r15 has no `borrowed` flag, so it is kept until it is opened once.
- **Previews:** a cut title as a preview can end oddly, like "… (preview: …" in the Boulder Votes decision. The words are the title's own.
- **Note titles:** they are re-read in the background once per launch and every 10 minutes. That is about one `vault_note` per linked note per 10 minutes.
- **The word clamp:** it measures each action line before paint. A row with a very long single token (a URL label) still breaks it inside the token, as the browser's `overflow-wrap` does.
