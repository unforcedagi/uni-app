# REPORT: Simple first, round 2 (T-124 r2)

Branch `feat/simple` from 51f013b. Nothing pushed, merged or built. Fixes for what the Sonnet and Codex critics found on the real app (r1, both NO-SHIP).

## What changed, per item

1. **Companion sentence = where things stand.** `Companion` shows the node's `metadata.stands` (first sentence, quiet relative time from `stands_at`: "2 days ago"). Read from the `node` notes through the one tree-wide load (`TaskTree.stands`, Uni's own included), else from the area's metadata. No `stands`: the newest open decision ("Waiting on a decision: …"), else the newest task change ("… is underway."), else nothing. Never a count, never the description. Code: `simpleCore.standsLine`, `quietAgo`; `taskCore.parseNodes/buildTaskTree`.
2. **Needs you: at most 3, no "+N more".** `topNeeds(where, path)` returns up to 3: open decisions whose node is this room's node first, then Now/Soon/Someday. Each item names the action (`Decide`, `Waiting on you · <next>`, or the task's `next`) and its due date. "Everything here →" stays. Decisions show their `options[]` (strings or `{label}`, up to 4) as small buttons. One tap calls `vault_decide`, one `update-note` with `state_transition {field:'state', from:'open', to:'decided'}` plus metadata `{decided, decided_at, decided_by}` (Rust `decide_note`, restricted to those three keys and to `decision` notes). A conflict shows "Already decided. Showing the latest." and re-reads. No undo for a decision.
3. **Running reads `run` notes.** `parseRuns` takes `summary`, `worker`, `started_at`, `ended_at`, `room` and the states running/done/blocked/decision/failed, and still takes the 0.1.44 fields (`what`, `by`, `started`, `updated`, queued/stalled). The panel shows `summary`; a run without one reads "Working on T-NN" or "Working on it", never the note path or a `scratch-…` slug. Running lists queued, running, stalled and blocked.
4. **Rooms open at the latest message**, every time (open and room switch). The remembered spot is no longer restored. For 1.5 s after opening, scrolls that are not the reader's own (older pages, images, fonts) re-pin to the end; wheel, touch, key or pointer input ends that. Loading older messages ends it too.
5. **Dots and badges.** A room's dot counts only tasks and decisions whose own node is that room (`ownNeeds`); parents no longer light up. The For you numeric badge is gone; only the existing "updated" dot remains.
6. **Panel width.** The side panel is 272px (was 320). It starts folded under 1100px wide; the choice is remembered per device (`uni.companion.side.v1`).
7. **Names agree.** The rooms drawer labels each room with the name of the node that owns it (`roomLabels.ts`, published by the Uni surface): "Learn Vibe Build", "ATLAS". A held row reads `held by Boulder` (the holding node), not `held by #cohere`, so "Boulder #cohere" and "COhere held by Boulder" are distinct. "Synced…" and "Signed in as…" moved from the rooms list into Settings.
8. **Back is calm.** Drawer, conversation, message, note-sheet and phone-sheet slide/rise/fade animations are removed (they no longer depend on the reduced-motion setting). Back from a child goes to its parent (crumb on desktop, ‹ on the phone) and the Buzz rooms drawer is not involved.

## Files

New: `src/areas/roomLabels.ts`. Edited: `Companion.tsx`, `simpleCore.ts`, `AreasSurface.tsx`, `TreeHome.tsx`, `treeRooms.ts` (`heldNode`), `taskCore.ts` (`options`, `stands`), `steerCore.ts`, `SteerPage.tsx`, `useTasks.ts` (`decide`), `vaultTasks.ts` (`decide`), `App.tsx`, `App.css`, `tree.css`; Rust `crates/uni-core/src/parachute.rs` (`decide_note`, `check_decide_patch`) and `src-tauri/src/lib.rs` (`vault_decide`).

## Tests

- `npx tsc --noEmit`: 0. `npm test`: exit 0, no FAIL. New unit tests in `steer.test.ts` (topNeeds with decisions, options, stands, quietAgo, run shapes) and `tasks.test.ts` (decide: happy path and conflict).
- `cargo check -p uni-core --offline`: ok. `src-tauri` was not compiled here (no `tauri build`); `vault_decide` follows `vault_transition` exactly.
- Playwright `simple` (66 = 22 x 3 viewports, 2 skipped as desktop-only): 64 passed. New or changed: stands sentence, three needs and no "+N more", decide happy path, decide conflict, own-node dots, For you without a number, panel width 250 to 290px, folded under 1100px and remembered, latest message on open, on switch and after late layout, drawer names and Settings, no animation, back. Shots refreshed in `scripts/browser/__shots__/simple/`.
- Other configs: see the table below.

| Config | Result |
|---|---|
| simple | 64 passed, 2 skipped (desktop-only) |
| roomsnav | 30 passed |
| treehome | 24 passed, 3 skipped (as before) |
| nested | 6 passed (after updating its drawer-name expectations) |
| chat-optional | 6 passed |
| areas | 330 passed, 10 skipped |
| rail | 18 passed (the For you number is now asserted absent) |
| sidebar | 14 passed |
| default (composer etc.) | 210 passed, 7 skipped; the three composer/treehome failures reported during the full run passed when re-run alone (8/8 and the treehome case), so I read them as load flakes |
| screens | 6 passed, **1 failed: phone-landscape** (844x390). It times out looking for the rail's Rooms button on Uni's tree screen, where the rail is hidden. It also failed in that viewport before my spec change (the r1 tree is full-screen there), but I did not run r1 to confirm it is unchanged, and I did not fix it. The Signed-in assertion moved to the Settings step. |


## Not done, and why

- The rooms drawer (Buzz room list) still exists on narrow screens and from the rail's Rooms button; I removed its animation and made its names agree rather than removing it, because the other specs and the phone flow rely on it.
- "Previous room" for Back is the parent room or the tree, not a history stack.
- The decision buttons write the option's label as `decided`; I did not verify against the live vault schema (not touched, per the rules).
- Not run in the real Tauri app or on a device; the `src-tauri` crate was not compiled.
