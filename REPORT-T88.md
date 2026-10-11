# T-88: ID references and fractal stewardship in the app (0.1.39 work)

On top of 370b940, branch `feat/life-os`. Not pushed. `src-tauri/gen/schemas` not committed.

## What changed
- **`refs.ts` (new):** one reference reader (`refKey`: id, path, `[[link]]`, extension and slashes tolerated) and `pathResolver` (id or path or link → node path). The app still navigates and displays by path; ids are resolved at the edges, so a vault holding paths, ids or both builds the same tree.
- **Trees:** `treeCore.buildTree` and `taskCore.buildTaskTree` resolve each node's `parent` through the resolver (missing, self, archived-parent and cycle handling unchanged). `TaskTree.rootRefs` makes a task whose `node` is the Uni root's id (or path) count for ROOT. `treeCore.ancestry` is the cycle-safe chain used for stewardship.
- **Subtree query:** `near` is anchored at the node's id when the tree knows it, else the path (no Rust change; the path validator already allows ids). The two-query fallback already filtered on `node in [ids + paths]`.
- **Brief trust:** briefs are still found by path only. `areasCore.trustedBrief` additionally accepts a node's `brief` reference (id, path or link) only if it resolves to a note whose path is `<node path>/Brief` (`Areas/Today` for the root); it then pins that note over duplicates. Any other reference is ignored.
- **Stewardship (`talkCore.steward`):** node's own room, else the nearest ancestor's, else #Uni. Own room = a known channel id first, then the `room` name, so a renamed room (#civics → #boulder, channel `9f5dd143-…`) keeps resolving; an unknown room is skipped. Used for the hold-to-talk and one-line text target, "Open in #room" on the task sheet, and a new line on each node page ("Room #x" / "Stewarded by #x"). A node that names its room only by `room` now also opens that room's chat.
- **Room dot:** a project arm with its own room gets a small dot (and ", room #x" in its aria-label, before the open count).
- Rule 3 (`[done]` closes only the owning room's tasks) is server-side (relay hook); nothing in the app to change.

## Tests
- `scripts/ids.test.ts` (new, in `npm test`): ref matching, mixed id/path/link tree, root by id, archived/missing/self/cycle parents, id-anchored near and id+path fallback filter, steward (own, inherited, #Uni, missing room skipped, channel id beats name, rename, cyclic tree terminates), brief-by-id trust rule.
- `scripts/browser/ids.spec.ts` (new, in the areas config): fixture options `ids` and `boulder` (ids for parent/node/brief, root task left as a path, Boulder area whose metadata says #civics, a Boulder project without a room). Covers one-request and two-query paths, stewardship lines, dot, and "Open in #boulder".
- Updated for the new behaviour: `tasks.spec.ts` (near anchored at the id), `lifeos.spec.ts:330` (arm label has the room), `tasks.test.ts` (id anchor).
- Screenshots: `scripts/browser/__shots__/t88/` — uni, boulder, pilot-own-room, inherited-steward; 1600×1200 and 390×844, colour and gray.

## Final totals
- `npx tsc --noEmit`: clean. `npm test`: exit 0, 388 `ok`.
- `cargo test -p uni-core`: 85 + 1 + 22 passed.
- Areas config: the full run gave 326 passed, 10 skipped, 4 failed; the 4 were the two assertions above that I then updated, and those four tests pass on a targeted re-run. I did not re-run the whole areas config after that fix.
- Composer spec: 125 passed, 3 skipped, 0 failed (includes nodeview). Rail config: 18 passed.

## Gaps
- Nothing was run against the live vault; the fixture imitates the id forms. The data worker's real ids, `room` values and the Boulder note were not available.
- A `node` field written as a `[[link]]` is read, but the two-query fallback filter cannot match that form in the vault (only ids and paths).
- Stage arms and the node page show a room dot/steward only from rooms the app already lists (`get_rooms`); a room that exists in the vault metadata but not on the relay shows nothing and falls through to the ancestor.
- The tree is still keyed by path internally (with id resolution at the edges), not by note id, so a renamed or moved node changes its key until the next reload.
- Root brief by id is supported by `trustedBrief` but the Today note is still located by path.
- The data worker's spec note (`Projects/uni-app/How the fractal organizes and self-contains`) was not readable here; rules were taken from the task file.
