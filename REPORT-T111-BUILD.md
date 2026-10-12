# T-111 build: the tree home

Branch `feat/tree-home` (from feat/life-os 063a7de, 0.1.39). Not pushed. The live vault was never touched: every test runs against the mocked Tauri layer in `areasFixture.ts`.

## What it is
The recommended blend from `uni-sketches/t111-app`:

- **Wide (≥ 900 px, Daylight and tablets): A.** The octopus map (`NodeStage`, unchanged apart from a restyle) on the left, the *level panel* on the right (beside it in landscape, under it in portrait). Tap an arm and it zooms to that node; the breadcrumb or the parent chip goes back up.
- **Phone (< 900 px): B.** The home is a **room tree**: `uni`, then every area and project indented by depth with a trunk and branch ticks, a stump (rings = depth, fill = state), a door (the room) and a needs-you tag. A row opens the level; **Back (‹ Rooms) or Android back returns to the tree.** The `uni` row opens Uni's own level.
- **The level panel is C's page**, in calm document order: what is alive (lede + moving) → needs you → updates from the rooms below → projects/areas inside → project note (folded) → the other tasks (You / Rooms / Others, the app's own `TaskList`) → the room (ledger of slips) with the composer pinned under it.
- **Rooms as paths.** A node's room shows as a slash path built from the tree (`boulder/cohere`, `techne/cohere`); a node with no room of its own shows a dashed door, `held by #boulder`. A room an ancestor also uses is held, not nested twice. `room_status: archived|missing` skips that room and uses `room_fallback` (a room name or id); with no fallback the nearest ancestor holds it.
- **Talk goes to the steward room** (own, else the ancestor's, else #Uni): the same `TalkBar`, voice outbox and `sendText` path as 0.1.39. For a held project the bar says `to #boulder` and posts to the area's room.
- **Calm.** No animation of its own. The only transition is the map's existing zoom (`NodeStage`, 300 ms total, ease-out); `prefers-reduced-motion` plays none. Check-off keeps the existing 5 s undo with CAS (`state_transition`, reverse on undo, guarded snooze).
- **Setting.** Settings → Home layout: **Tree (new)** (default) · **Octopus (0.1.39)** · **Classic** (the page without a map: brief, an Inside list, the work). Stored in `localStorage` (`uni.home.layout.v1`), live, no reload. Octopus is the 0.1.39 code path, untouched.
- **Visual language.** `LANGUAGE.md` / `language.css` landed during the run; `src/areas/tree.css` adopts it (tokens as `--th-*` on `.tree-home`, fonts self-hosted in `src/areas/fonts/`): stump, hang-tag, door, sap, trunk, slip, seal, growth rings behind the map. Everything is shape-coded; the only hue is the sap ochre. Dark scheme gets inverted tokens. To restyle, change the token block at the top of `tree.css`.

## Where
| | |
|---|---|
| `src/areas/homeLayout.ts` | setting store + `useHomeLayout`, `useWide` |
| `src/areas/treeRooms.ts` | pure: `roomView` (slash, held-by, fallback, steward target), `updatesBelow`, `treeRows`, privacy rule |
| `src/areas/treeAlive.ts` | pure: the alive block (brief, Today, or derived for a project with no brief) |
| `src/areas/TreeHome.tsx` | `TreeScreen`, `LevelPanel`, sections, `RoomDoor`, `Stump`, `Tag`, `Ledger` |
| `src/areas/tree.css` | the one stylesheet |
| `src/areas/HomeLayoutSetting.tsx` | Settings control |
| `src/areas/AreasSurface.tsx`, `AreaView.tsx`, `App.tsx` | wiring: a `tree` slot in `AreaView` (keeps the App tab and grants), the steward rule via `roomView` in tree mode, Android back from Uni's level on a phone |
| `scripts/treehome.test.ts` (in `npm test`), `scripts/browser/treehome.spec.ts`, `playwright.treehome.config.ts` (`npm run test:treehome`) | tests |
| `scripts/browser/areasFixture.ts` | new options `layout` (default `octopus`, so every older spec runs the old home), `underBoulder`, `ricki` |

## Tests (all run on this branch)
- `tsc --noEmit`: clean.
- `npm test`: green (10 new unit checks in `treehome.test.ts`: slash names, held-by, archived fallback with and without `room_fallback`, updates from below incl. private areas, phone rows, alive derivation, layout parse). One earlier red, `vaultlinks` "40k-char line took 2019ms", was a timing assert under load (another suite was running); green on rerun.
- `treehome.spec.ts` (3 viewports: 390×844, 1600×1200, 1200×1600): **24 passed, 3 skipped by design** (phone-only and map-only tests skip where they don't apply). Covers: tree renders at all three sizes without overflow, pinned composer; zoom Uni → Boulder → COhere 2026 and back (breadcrumb and parent chip; phone: back to tree and Android back); check-off + undo (CAS pair) + the five seconds running out; composer posts to `ch-cohere` for COhere, to the Boulder channel for the held Civic Calendar, to `ch-unf` for the archived-room project Ricki; archived room → fallback; private areas show no task titles on rows and no room text; reduced motion plays nothing, motion allowed gives only ≤ 300 ms single-iteration animations and nothing loops; layout switch Tree → Octopus → Classic → Tree and persistence across reload.
- Existing suites, same code: `playwright.areas.config.ts` **330 passed, 10 skipped, 0 failed**. The composer/default config (`playwright.config.ts`, which also picks up nodeview and treehome on its `mobile` project) **140 passed, 5 skipped, 1 failed**: `nodeview.spec.ts` "no animation loops anywhere" (mobile) saw no zoom animation while the machine was loaded by another suite; **it passed on rerun (13/13 nodeview)**. It is a timing flake in an old spec, not caused by this change (the fixture runs it on the octopus layout).

## Screenshots
`scripts/browser/__shots__/t111/` (colour and `-gray`, each at 390×844, 1600×1200, 1200×1600): `root`, `boulder`, `cohere`, `held`, `archived`, `undo` (level views; on the phone `tree` is the room tree, `root` also is). I looked at them and iterated in three passes:
1. Portrait: the map's tip labels (children of children) collided with arm labels in the short stage → tips off in the tree home (the panel lists what is inside). The first shot was taken scrolled → scroll to top before shooting. The room line repeated "Room #Uni" next to the door when the room is the node's own → only said for held nodes. The folded project note had no affordance → a +/– mark.
2. Phone: the back button and breadcrumbs were two rows → one row; the undo bar covered the pinned composer on both layouts → sits above it; crumbs had uneven padding.
3. Faint growth rings behind the map (the language's "ground"), toned down so they don't compete with the arms.

## Known gaps
- **"N updates" is "an update".** The rooms below show their latest line if they posted in the last 24 h (from the room list's `last_ts`/`last_message`); there is no per-room message count without fetching every room, so it never says "3 updates from boulder/cohere". Private areas (Relationships, Sadhana and anything under them) show "Active · 2h" with no text.
- **Task titles:** rows, the phone tree and the updates never show them for private areas. The level panel lists tasks exactly as 0.1.39 did (same `TaskList`); the derived "Moving" lines for a project with no brief use non-Aaron task titles but skip private areas.
- **Truncation:** the tree and tasks still stop at 200 (the 0.1.39 notices show).
- **Classic** is my reading of "Classic": the old page minus the map, with an Inside list. There was no earlier "classic" home in the code to restore; say if you meant something else.
- **Held projects are destinations** (a row/arm like any node), not only reachable through the parent. Open question 2 of the prototype stays Aaron's.
- **Seed Uni level on the phone:** the `uni` row opens it; it is remembered in memory only (a restart opens the tree).
- Not done: the sap "rises once when an update lands" animation (the language has it; I kept motion to the one zoom); the grayscale pass is by screenshot filter, not on the Daylight itself; no real-device check (Daylight, Android): hold-to-talk is the 0.1.39 component, tested here with the fake media stream only.
- The old `uni-router-rule` line and the app header bar are hidden on the tree page; the App tab (sealed apps) still brings the header and the side chat back when an area has an app.
