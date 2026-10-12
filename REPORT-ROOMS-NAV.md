# REPORT: Rooms as primary navigation + "Where we are" (T-111, 0.1.42)

Branch `feat/rooms-nav` (from 8c99d05). Not pushed, not merged, no APK.

## What changed
1. **Rooms layout, the new default.** Phone: the nested room tree is the home (as before in the tree layout). Daylight/wide, portrait included: the same tree is a left column that is always visible, with the selected row marked (`aria-current`, ink bar); the right side is the selected level's panel. The octopus stage is not shown in Rooms.
   Settings → Home layout: **Rooms (new)** (default), **Map (0.1.41)** (stored id `tree`, the old map plus panel), Octopus, Classic. "Migrate only if never chosen": nothing stored now reads as Rooms; any stored `tree`/`octopus`/`classic` stands.
2. **"Where we are"**, first section of every level's panel (root = whole life, area, project): open/doing/waiting/need-you counts, "Moved this week" (live tasks changed in the last 7 days, newest 5 + "+N more"), and **Needs you** split **Now** (rows) / **Soon** (rows) / **Someday** (collapsed to a count, expandable). Rows: T-NN, title, next step, due, and the owning project when viewed from above, plus check-off (existing transition + undo).
   Rooms mode loads the whole tree's tasks once and each level takes its subtree, so the left column's counts are right whichever level is open. Other (rooms'/others') work remains below as "Other work".
3. **Morning roll-up**: the root level's Where we are is the morning view; in Rooms the Brief-text "Needs you" list is not rendered (the typed one replaces it). The brief's lede and Moving lines still show beneath it.
4. **Priority edit**: a small select on each row (Now/Soon/Someday). One `vault_patch_meta` merge `{priority}` guarded by the row's `updated_at` (same path as snooze, now a shared `patchMeta`), optimistic, conflict re-reads and says so, 5 s Undo sends the reverse merge (clears the key if the task was unsorted). No other write path.
5. Calm motion: nothing new animates except the existing 240 ms row fade. Styling reuses tree.css tokens (`.wr-*` classes).
6. **Privacy**: tasks under Relationships/Sadhana are counted but never named from above ("N more in private areas, counted not named"); at a private level no rows, only counts and "N changed, the last Xd ago". (The existing "Needs doing" list inside a private area is unchanged, as before.)

`priority` absent = unsorted, treated as soon (shown "Soon (unsorted)").

## Files
New: `src/areas/whereCore.ts`, `src/areas/WhereWeAre.tsx`, `scripts/roomsnav.test.ts`, `scripts/browser/roomsnav.spec.ts`, `playwright.roomsnav.config.ts`, this report, `scripts/browser/__shots__/roomsnav/*`.
Changed: `taskCore.ts` (Priority, `Task.priority`), `vaultTasks.ts` (`patchMeta`, `setPriority`), `useTasks.ts` (`setPriority`), `homeLayout.ts`, `TreeHome.tsx` (`RoomTree`, `TreeScreen` selected/column), `NodeWork.tsx` (`TaskList` title, `dueText` export), `AreasSurface.tsx`, `tree.css`, `package.json` (test chain + `test:roomsnav`), `areasFixture.ts` (priority on tasks, `privateTasks`, `layout: 'unset'`), `treehome.test.ts` / `treehome.spec.ts` (default is now Rooms; Map label).

## Tests (all green)
- `tsc --noEmit`: clean.
- `npm test`: pass (new `roomsnav.test.ts`: priority parse, counts, grouping, 7-day window, privacy, priority write, layout default).
- `roomsnav` (port 5632): 30 passed at 390x844, 1600x1200 and 1200x1600. Covers: tree visible on both; Boulder → COhere updates the panel; Needs you grouped by priority; Someday collapsed; priority writes once, Undo reverts (and clears for unsorted), conflict leaves the vault untouched; private area shows no titles; default layout and Settings; chat-null profile; calm motion.
- `areas` (5631): 330 passed, 10 skipped. `treehome` (5633): pass after updating the layout-switch test. `chatoptional` (5634): 6 passed.

## Screenshots
`scripts/browser/__shots__/roomsnav/`: `home`, `boulder`, `cohere`, `root`, `private`, `priority-undo`, `no-chat`, `someday-open`, each at 390x844, 1600x1200, 1200x1600, plus `-gray` variants.

## Open issues
- "Moved this week" only sees live tasks (the loader asks for open/doing/waiting), so a task finished this week doesn't appear. Including recently done needs a second query; say if you want it.
- The old `TodaySections` in the Octopus/Classic root still renders the Brief-text list; only Rooms uses the shared Where-we-are component.
- Rooms loads up to 200 live tasks at the root (existing limit); "truncated" notice is shown in Other work.
- Not run against the live vault (fixtures only); the real vault's `priority` filling was not available to me.
- Priority control is on the Where-we-are rows only, not in the task sheet or the "Other work" list.
