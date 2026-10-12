// What is alive at a level (pure, unit-tested in scripts/treehome.test.ts): the brief's own lines where the node has a Brief, else the
// derivation the T-111 prototype used for a project: its summary, the lines of the nearest ancestor's brief that name it, and the work
// the rooms are doing on it (tasks that are not Aaron's). Uni's own level reads from Today. Private areas never get task-derived lines.
import type { Area } from "./areasCore.ts";
import { ancestry, ROOT, type Tree } from "./treeCore.ts";
import type { BriefItem, Inline } from "./briefCore.ts";
import type { AreaBrief } from "./useAreas.ts";
import { groupOf, type Task } from "./taskCore.ts";
import { activeProfile } from "./profile.ts";
import { isPrivateNode } from "./treeRooms.ts";

/** The room an owner string names (`room:cohere`), or null: a vault without room owners (roomOwnerPrefix null) has none. */
const roomOwnerName = (owner: string): string | null => { const p = activeProfile().roomOwnerPrefix; return p && owner.startsWith(p) ? owner.slice(p.length) : null; };

export type AliveLine = BriefItem & { /** Where a derived line comes from ("from Boulder's brief", "in #cohere"). */ note?: string };
export type LevelAlive = { now: string; nowTokens: Inline[] | null; needs: AliveLine[]; moving: AliveLine[]; derived: boolean; hasBrief: boolean };

const plainLine = (text: string, note?: string): AliveLine => ({ text, tokens: [{ t: "text", text }], ...(note ? { note } : {}) });
const keyOf = (name: string) => name.toLowerCase().replace(/\s+20\d\d$/, "");
const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length <= n ? t : t.slice(0, n).replace(/\s+\S*$/, "").replace(/[,;:.\s]+$/, "") + "…"; };
/** The first `n` sentences. */
export const sentences = (s: string, n: number): string => clip((s.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [s]).slice(0, n).join(" "), 320);

export function levelAlive(a: {
  tree: Tree; path: string; node: Area; entry: AreaBrief | null; briefs: Record<string, AreaBrief>; tasks: readonly Task[];
  /** Uni's level: the ranked needs and what moved, from Today. */
  root?: { needs: BriefItem[]; moved: BriefItem[]; areas: number; needing: number } | null;
}): LevelAlive {
  const { tree, path, node, entry } = a;
  if (path === ROOT && a.root) {
    const r = a.root;
    const now = r.needs.length ? `${r.needing} of ${r.areas} areas need you.${r.moved.length ? ` ${r.moved.length} moved since yesterday.` : ""}` : r.moved.length ? `Nothing needs you. ${r.moved.length} moved since yesterday.` : "";
    return { now, nowTokens: null, needs: r.needs, moving: r.moved, derived: false, hasBrief: r.needs.length > 0 || r.moved.length > 0 };
  }
  const b = entry?.brief;
  if (b && b.present.length) {
    return { now: b.now, nowTokens: b.nowTokens.length ? b.nowTokens : null, needs: b.needsYou, moving: b.moving, derived: false, hasBrief: true };
  }
  // No Brief note: say what is known. The summary, what the nearest ancestor's brief says about this node, and the rooms' work.
  const up = ancestry(tree, path).slice(1).map((n) => ({ n, e: a.briefs[n.path] })).find((x) => x.e?.brief.present.length);
  const key = keyOf(node.name);
  const hit = (items: readonly BriefItem[]) => items.filter((i) => i.text.toLowerCase().includes(key));
  const from = up ? `from ${up.n.name}'s brief` : undefined;
  const needs: AliveLine[] = up ? hit(up.e!.brief.needsYou).slice(0, 3).map((i) => ({ ...i, note: from })) : [];
  const moving: AliveLine[] = up ? hit(up.e!.brief.moving).slice(0, 2).map((i) => ({ ...i, note: from })) : [];
  if (!isPrivateNode(tree, path)) {
    for (const t of a.tasks.filter((t) => groupOf(t) !== "you").slice(0, 4)) moving.push(plainLine(clip(t.title, 140), roomOwnerName(t.owner) ? `in #${roomOwnerName(t.owner)}` : t.owner === "uni" ? "Uni" : undefined));
  }
  const now = node.purpose ? sentences(node.purpose, 2) : "";
  return { now, nowTokens: null, needs, moving, derived: true, hasBrief: !!(now || needs.length || moving.length) };
}
