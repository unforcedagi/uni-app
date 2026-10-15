# T-140 fix pass (two P2s from the Codex review of 0.1.47)

## What changed
1. **Legacy parent chains** (`src/areas/nodeLinks.ts`). `linkGraph` now also returns `chain` and `scope`. A node with no `links` of its own still goes up its legacy `parent` (project or area), cycles broken at the smallest path as in 0.1.46. Once a node has `links`, links rule.
   - `chain` is the way up for rooms and privacy: `Tree.chain` feeds `ancestry` (so `roomView` inherits `#cohere` for Woven Web), and `TaskTree.parent` is now the chain.
   - `scope` is the task subtree: the display children, plus legacy-parent children, plus a project that lists another project the other doesn't list back (Woven Web lists COhere, so it sits under COhere). `TaskTree.children` is the scope, and `Tree.scope` serves `claimedBelow`. `subtreePaths` and `tasksUnder` follow it.
   - The display stays flat: `Tree.parent` and `children` are unchanged (Woven Web under Boulder, Back goes to the area).
2. **Fallback task tree** (`src/areas/AreasSurface.tsx`): the fallback nodes now carry `links` and `kind`.

## Tests (`scripts/links.test.ts`, 6 new, 1 expectation updated)
- Parent-only Boulder → COhere → Woven Web: the room is #cohere, COhere's subtree has Woven Web, Boulder's has all.
- The same three with links only: the same subtrees.
- With links, a legacy parent is ignored.
- Fallback nodes keep links and kind, so a linked project's tasks stay in the area feed and counts.
- 0.1.46 equivalence: the old logic is copied into the test, and every node's room (target, own, heldNode) and subtree match on one parent-only fixture.
- The cycle-safety test now expects `ancestry(P3)` = P3, P1, A1. The legacy chain through P1 shows up, as in 0.1.46.

## Gates
- `tsc --noEmit`: clean.
- `npm test`: all suites pass, with 0 FAIL lines (`links.test.ts` has 17 ok).
- `playwright simple`: 667 passed, 107 skipped. The rewritten `__shots__` were restored.
- I did not run 0.1.46 against the live vault; the equivalence test uses a fixture.
