# REPORT: Steer, don't chat (T-122 build)

Branch `feat/steer` from d9cfe67 (0.1.43). Four commits, nothing pushed, merged or built as an APK.

```
2bab4fa tokens: Field Book tokens at :root, bridge deleted, shared widgets read them
0e263dd steer core: change-mark diff, Running/Drafts parsing, placeholder; run + draft loads
54d5cae steer: node page = room's state; steering bar + Log strip replace talk bar + ledger
ad59632 steer: Playwright spec + shots
```

## What changed

1. **Tokens at `:root`** (`tree.css`, light + dark). The `.tree-home` bridge (`--bg/--surface/--text/--text-soft/--muted/--line/--accent` re-pointed at `--th-*`) is deleted. The shared widgets in `areas.css` (task rows, task sheet, undo bar, talk bar, work heads) now read `--th-*` directly, so they look the same inside and outside the tree home. Buttons that settings/pairing also use (`.pairing-secondary`, `.suggestion-go`) and the journal/vault/notes/chat styles are untouched. Screenshots of journal, settings and the Uni chat still render (`__shots__/steer/surface-*`).
2. **Node page is the room's state** (Rooms layout). Header: crumbs, title, room door + "this node's context window" (only when the node owns its room; held nodes show "held by #x"), counts line, lede. Below it, two columns on wide (a container query on the scrolling page, so it also works in the narrower 1280 panel): left **Needs you** (Now/Soon/Someday, inline Open on decisions), **Moved this week**, rooms-below updates, Inside; right **Running**, **Drafts**, **Tasks**, project note. Phone stacks them. Data is still the one tree-wide task load (`whereCore`).
3. **Steering bar** (`SteerBar`) replaces the talk bar and the ledger on the node page: mic (hold to talk, same press logic, extracted to `useHoldTalk` and shared with `TalkBar`), a line, Steer. The placeholder names the room: `Steer ATLAS (#atlas/build)…`, `Steer Atlas Institute (held by #atlas)…`, `About T-07…`. Sending uses the existing `talk.sendText` path (no new write path). Hidden when chat is null.
4. **Show the effect** (`useSteerEffect` + `steerCore.diffMarks`). After a steer it stores `{steerId, room, at}` and freezes the task/draft list as the baseline, then polls through the page's existing refresh every 10 s for 3 min (18 polls). Any task or draft written after `at` whose due/state/priority/next/owner (drafts: status) differs from the baseline gets the sap left rule and "changed just now · was Tue 10-13". A new item reads "added just now"; an item that left the live list is not marked. Marks stay until the node changes. No reordering, one 200 ms fade, nothing loops.
5. **Running and Drafts** from real notes, read with the tree-wide load (`vaultTasks.loadTagged("run" | "draft")`), filtered to the node's subtree, rendered only when non-empty. Run fields as the T-118 ledger: `node task what by state started updated result`; draft fields `node|task status`. Both are in the fixture.
6. **Log strip** at the foot: `Log · #atlas/build · N messages today · last HH:MM`. It opens upward over the page with the app's own room pane (`roomFor(...).render`, so reactions, threads and attachments are the real ones) restyled as slips: no avatars, ruled entry, mono author and time, Aaron's slip boxed. The composer is hidden in the Log because the steering bar is the input. Close, the strip again, Escape, or Android back closes it. "Open as tab" in its header opens the room tab.
7. **Flow**: "Open #room" (header and task sheet) opens the Log. The sheet's "Open in #room" sets `about T-07` at the top of the Log and `About T-07…` in the bar. Reaching and leaving the conversation is one tap each way and never leaves the node page. A room other than this page's (a task in a child node with its own room) still opens as a tab.

## Files

New: `src/areas/steerCore.ts`, `SteerPage.tsx` (SteerBar, LogStrip, RunSection, DraftSection, `useSteerEffect`), `Changed.tsx`, `scripts/steer.test.ts`, `scripts/browser/steer.spec.ts`, `playwright.steer.config.ts` (port 5711), `npm run test:steer`.
Edited: `AreasSurface.tsx`, `WhereWeAre.tsx` (now `WhereCounts` / `MovedBlock` / `NeedsYou`), `NodeWork.tsx` (`useHoldTalk`, marks on task rows), `TreeHome.tsx` (`RoomLine context`), `useTasks.ts`, `vaultTasks.ts`, `tree.css`, `areas.css`, `package.json`, `areasFixture.ts` (`steer` option, `window.__setDue`).

## Tests (all run on the final tree)

- `tsc --noEmit` 0; `npm test` exit 0, no FAIL (adds `steer.test.ts`: 11 checks: diff incl. skew-free baseline, no-op writes, several fields, new/gone items, drafts, runs, placeholder); `check-case-collisions.py` 0.
- Playwright: roomsnav 30 passed; treehome 24 passed, 3 skipped (as before); nested 6; chat-optional 6; areas 330 passed, 10 skipped; composer 185 passed, 5 skipped; **steer 21 passed** (3 viewports x 7 tests): state visible with two columns, held node, steer posts once to #atlas/build's id then `__setDue` shows "changed just now · was Tue 10-13" on T-07 only and clears on reopen, Log opens/closes/Escape, Open #room opens the Log not a tab and "Open as tab" works, sheet to "About T-07" and the line goes out as `About T-07: …`, chat-null hides bar, Log and door.
- Existing specs changed because the design changed: `roomsnav.spec.ts` (`where` is now the whole state page since the counts moved to the header and Needs you/Moved to the left column; "Where we are" is the first header section; dropped the "All of it" lede assertion; the private-level title check is scoped to the left column), `nested.spec.ts` (Open #room opens the Log, tab via "Open as tab"), `lifeos.spec.ts` (tag queries are six, not four: `run` and `draft` are two more tree-wide queries, still no per-node fetch; a visibility refresh holds six pending queries).

## Shots

`scripts/browser/__shots__/steer/` (state, held, changed, log, chat-off at 1440x900, 1280x800, 390x844; `surface-*` = journal, settings, Uni chat, rooms at 1280x800 for the regression look). I looked at 1440x900 state/changed/log and 1280 state and 390 state/log; I tightened the counts line to one compact row after the first look so the state starts above the fold. The tracked shot churn from other specs was reverted, not committed.

## Real vs placeholder

Real: everything above is wired to the live data paths (tasks, `run`/`draft` notes, room messages, the existing send/voice path). Fixture-only: the ATLAS tasks, run and draft notes, build-room messages, `__setDue`.
Not built / open:
- **Decisions are read-only** (row + Open to the sheet). There is no existing decision-with-options write path (a decision only has `open -> decided`), so no option buttons.
- **No undo of a steer** (the prototype had it); this build shows the effect, it cannot revert it.
- **Clock skew**: marks use `updatedAt > at - 30 s` (`SKEW_MS`) because the vault's clock and the Mac's differ; the frozen baseline already excludes older changes. The unit diff itself is strict `> at`.
- **Baseline staleness**: the baseline is the last load before the steer, so a change by someone else in the 30 s before it, not yet loaded, would be marked. A refresh at steer time would close this; not done.
- Running's "by" is shown through `ownerLabel`; `result` opens as a note by path/id. Runs older than done are not pruned.
- A private node hides its runs/drafts; at a private level the Tasks column still lists that level's own tasks as before (unchanged behaviour).
- About-mode prefixes the line with `About T-07: ` (my choice, so the room knows).
- `screens.spec.ts` writes into `/home/uni/Code/uni-sketches/t43/audit` (hard-coded); running it for the regression look overwrote that dir's `laptop-*.png`.
- Not tested on device or in the real Tauri app; the Daylight (Android) feel of the docked bar and the Log overlay is unverified.
