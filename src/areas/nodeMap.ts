// A node's status mark from its Brief (pure, unit-tested in scripts/nodeMap.test.ts): needs you, moving or quiet, rolled up from below.
import type { AreaBrief } from "./useAreas.ts";
import { childrenOf, type Tree } from "./treeCore.ts";

/** Encoded without colour: needs you = solid double ring, moving = heavy ring, quiet = dashed. */
export type Mark = "needs" | "moving" | "quiet";
const RANK: Record<Mark, number> = { quiet: 0, moving: 1, needs: 2 };

/** From one Brief: something needs you, else something is moving, else quiet (also when there is no Brief). */
export function markOf(entry: Pick<AreaBrief, "brief"> | null | undefined): Mark {
  if (!entry) return "quiet";
  return entry.brief.needsYou.length ? "needs" : entry.brief.moving.length ? "moving" : "quiet";
}

/** A node's mark is the strongest of its own and everything below it, so an arm shows what is waiting at its tip. Briefs match by path only. */
export function rolledMark(tree: Tree, briefs: Record<string, AreaBrief>, path: string, seen: Set<string> = new Set()): Mark {
  if (seen.has(path)) return "quiet";
  seen.add(path);
  let best = markOf(briefs[path]);
  for (const c of childrenOf(tree, path)) {
    const m = rolledMark(tree, briefs, c.path, seen);
    if (RANK[m] > RANK[best]) best = m;
  }
  return best;
}
