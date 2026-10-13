# REPORT: Simple first (T-124)

Branch `feat/simple` from 0dccfd3 (0.1.44). Nothing pushed, merged or built.

Aaron's note on 0.1.44: the task-state UI was overwhelming, he kept going back to the chat rooms, the buttons under each message were not helpful. So: **chat is the primary view again**; state is a quiet companion; one look across the app.

## What changed (before → after)

| Surface | Before (0.1.44) | After |
|---|---|---|
| Opening a room | The node's state page (header, counts row, Where we are, two columns of Needs you / Moved / Running / Drafts / Tasks) with a steering bar and a Log strip | **The room's conversation**: title, `#atlas/build` in small type, the app's own message list and composer |
| State | The page itself | **Companion** (`Companion.tsx`): one sentence (first sentence of the level's lede), at most 3 needs-you (Now first, then Soon, Someday; "+N more"), running (only queued/running/stalled, only if any). Wide ≥900px: a right-hand side panel that folds to a 48px rail. Phone: a one-line strip under the title that opens downward. Fold remembered per device (`uni.companion.side.v1` open by default, `uni.companion.strip.v1` folded by default). Items open their task sheet |
| Deeper | n/a | "Everything here →" in the companion (and "+N more") opens the existing full node page (counts, Moved, Drafts, Tasks, Inside). Its "Open #room" and the sheet's "Open in #room" return to the conversation. Android back leaves it |
| Under each message | Row: React, Keep, Ask Uni, Copy text, Reply in thread, Edit, Delete | **Nothing.** A quiet ⋯ at the message's edge (shown on hover/focus with a mouse, faint on touch) opens a menu with the same actions (`role=menu`, closes on pick/Escape/outside tap; Delete keeps its two-tap confirm). Journal entries keep their own action row |
| Composer | "Steering bar" (mic, line, Steer), Log strip | The normal chat composer (attachments, voice, mentions). Placeholder names the room: `Message #atlas/build`, held node `Message #atlas` |
| Rooms list (home on phone, left column on desktop) | Stump glyphs, arch door chips, hang-tag counts, open-count rings, date line, "8 need you · 13 open" summary | Names (nested by parent, trunk and ticks kept), the room in small muted type (`#atlas/build`, `held by #atlas`), **one quiet dot** when something needs you. Title only |
| One look | Chat in forest/turquoise, Cormorant/Inter; rooms in Field Book | `App.css` base tokens (`--bg --surface --text --accent --line --mine ...`) now read the Field Book tokens (`--th-*`, light and dark), fonts are Fraunces/Quattro, avatars graphite. Chat, rooms list, journal, settings and the plain room tab are the same app. Dark checked |
| Chat off (`chat.provider null`) | Node page without bar | Unchanged in effect: no room, so the full node page is the room's view, no composer, no door |

Deleted: `SteerBar`, `LogStrip`/`logLine`, `useSteerEffect` and their CSS; `steerPlaceholder` (replaced by `chatPlaceholder`); the room tree's stump/door/tag/ring/summary/date in the list.

## Files

New: `src/areas/Companion.tsx`, `src/areas/simpleCore.ts` (`firstSentence`, `topNeeds`, `chatPlaceholder`).
Edited: `AreasSurface.tsx` (conversation layout, `full` state, companion props), `TreeHome.tsx` (`RoomTree`, `TreeScreen`), `SteerPage.tsx` (Run/Draft sections only), `AreaChat.tsx` (`render(above, placeholder?)`), `App.tsx` (⋯ menu, composer placeholder), `App.css`, `tree.css`, `areas.css` (the old Octopus/Map stage keeps its original type; its geometry test depended on it), `steerCore.ts`, `package.json`.
Specs: `steer.spec.ts` → `simple.spec.ts`, `playwright.steer.config.ts` → `playwright.simple.config.ts` (port 5711, `npm run test:simple`).

## Tests (run on the final tree)

- `tsc --noEmit` 0. `npm test` exit 0, no FAIL (`steer.test.ts` now also covers `firstSentence`, `topNeeds`, `chatPlaceholder`). `check-case-collisions.py` 0.
- Playwright, one config at a time: **simple 39 passed** (13 tests x 1440x900, 1280x800, 390x844: room opens to conversation; companion ≤1 sentence / ≤3 needs / running only active; "+N more"; fold persists across reload (side and strip); nothing under messages and the ⋯ menu holds the actions; Everything here and back; sheet "Open in #room" back; composer posts once to the room's channel; nested rooms nest and jump/back; held node; quiet rooms list; one-look shots; chat-null). roomsnav 30 passed; treehome 23 passed 3 skipped (as before); nested 6; chat-optional 6; areas 330 passed 10 skipped; composer/default config 195 passed 5 skipped (the one failure on the first run was the octopus stage geometry, fixed by keeping its fonts).
- Specs changed because the design changed: `roomsnav.spec.ts` (a room opens to the conversation, so the state-page tests first take "Everything here"; `.th-tag` → `.th-dot`), `treehome.spec.ts` (`.th-tag` → `.th-dot`), `nested.spec.ts` (held node and `#atlas/build` read from the room header and placeholder; Open #room is on the full page; no Log), `composer.spec.ts` ("Reply in thread" through the ⋯ menu).

## Shots

`scripts/browser/__shots__/simple/`: room, companion, strip-open (phone), menu, everything, rooms, journal, settings, plain-room, chat-off, light and dark at 1440x900 and 390x844 (the 1280x800 project runs the same assertions, no shots). I looked at room, strip-open, rooms, menu, everything, plain-room, journal and settings. Fixed after the first look: duplicated lede when the strip is open, per-author avatar hues, the "Sending to" line.

## Deliberately left out / known

- **The "Sending to #room · Uni is listening" line is hidden in the room view** (the placeholder names the room). The Uni mute toggle and the "notifying …" names live there, so they are only reachable in the plain room tab (Rooms panel). Say if you want the toggle back as a ⋯ item.
- Change marks after a steer (`Changed`, `diffTasks`, `marksById`) are no longer wired to anything on screen (no steer to mark); the code and its unit tests remain, cheap to delete later.
- "Moved this week", counts row, Drafts and Tasks lists exist only on the full node page (as asked); the Map/Octopus/Classic layouts are untouched except the base fonts/tokens.
- The lede is the level's first sentence as plain text (wikilinks flattened); fixture ledes are placeholders ("ATLAS.").
- Not tested in the real Tauri app or on a device. No decision/option buttons (unchanged from 0.1.44).
