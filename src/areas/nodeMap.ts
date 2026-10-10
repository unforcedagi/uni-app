// The node view's pure core (unit-tested in scripts/nodeMap.test.ts): a child's status mark, where the arms of the map
// go for 1..n children, and the area-slot registry's lookup. No React, no DOM.
import type { Area } from "./areasCore.ts";
import type { AreaBrief } from "./useAreas.ts";
import { childrenOf, type Tree } from "./treeCore.ts";

/** Encoded without colour: needs you = solid double ring, moving = heavy ring, quiet = dashed. */
export type Mark = "needs" | "moving" | "quiet";
const RANK: Record<Mark, number> = { quiet: 0, moving: 1, needs: 2 };
export const MARK_LABEL: Record<Mark, string> = { needs: "needs you", moving: "moving", quiet: "quiet" };

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

export type Box = { x: number; y: number; w: number; h: number };
export const overlaps = (a: Box, b: Box, pad = 0) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
export type Circle = { x: number; y: number; d: number };
export const circlesTouch = (a: Circle, b: Circle, pad = 0) => Math.hypot(a.x - b.x, a.y - b.y) < (a.d + b.d) / 2 + pad;
/** A label box against a circle (nearest point of the box to the centre). */
export function boxHitsCircle(b: Box, c: Circle): boolean {
  const nx = Math.max(b.x, Math.min(c.x, b.x + b.w)), ny = Math.max(b.y, Math.min(c.y, b.y + b.h));
  return Math.hypot(nx - c.x, ny - c.y) < c.d / 2;
}
export const circleBox = (x: number, y: number, d: number): Box => ({ x: x - d / 2, y: y - d / 2, w: d, h: d });

export type ArmIn = { mark: Mark; background: boolean; name: string; /** How many children it has (drawn as tips where they fit). */ tips?: number };
export type Arm = {
  x: number; y: number; d: number;
  /** Degrees, 0 = right, -90 = up. */
  angle: number;
  /** The name sits above (upper half) or below the node. */
  side: "t" | "b";
  label: Box;
};
export type Metrics = { w: number; h: number; narrow: boolean; cx: number; cy: number; core: number; labelW: number; labelH: number; chip: { x: number; y: number; d: number } };

/** Below this stage width the map is the phone one: smaller marks, no tips, labels short. */
export const NARROW = 560;
const NODE_D: Record<Mark, [number, number]> = { needs: [100, 58], moving: [88, 52], quiet: [76, 46] };

export function metrics(w: number, h: number, leaf = false, hasParent = false): Metrics {
  const narrow = w < NARROW;
  // A leaf has no arms to make room for: its centre may be larger (it carries the whole brief).
  const core = leaf ? (narrow ? 196 : 300) : narrow ? 148 : Math.round(Math.max(220, Math.min(320, h * 0.42, w * 0.32)));
  return {
    w, h, narrow, cx: w / 2, cy: narrow ? Math.min(h / 2 + 18, leaf || hasParent ? 180 : 210) : h / 2 + 10, core,
    labelW: narrow ? 96 : 190, labelH: narrow ? 32 : 24,
    chip: { x: w / 2, y: narrow ? 36 : 46, d: narrow ? 56 : 66 },
  };
}

/** Never under 44 px: the mark is the tap target. */
const diameter = (a: ArmIn, narrow: boolean) => Math.max(44, Math.round(NODE_D[a.mark][narrow ? 1 : 0] * (a.background ? 0.82 : 1)));
/** Rough text width of a label at the map's label size, capped at the label column. */
export const labelWidth = (name: string, m: Pick<Metrics, "narrow" | "labelW">) => Math.min(m.labelW, Math.ceil(name.length * (m.narrow ? 7 : 9.5)) + 6);

/**
 * Positions for the arms of one node. They sit on an ellipse round the centre; when the node has a parent (a chip above the
 * centre) the top is left open. Background children are smaller. Returns an empty array if the whole ring cannot fit;
 * stageLayout then uses rows below the map rather than placing overlapping children.
 */
export function armLayout(items: readonly ArmIn[], m: Metrics, hasParent: boolean, reserved?: Box): Arm[] {
  const n = items.length;
  const dMax = Math.max(0, ...items.map((a) => diameter(a, m.narrow)));
  const top = hasParent ? (m.narrow ? 100 : 108) : 16, bottom = m.narrow ? 14 : 20;
  const labelRoom = m.labelH + 6;
  const widest = Math.max(0, ...items.map((a) => labelWidth(a.name, m)));
  // Room at the sides: the wider of a node and its label, plus the tips' column where tips are drawn.
  const rxMax = Math.max(40, m.w / 2 - Math.max(dMax, widest) / 2 - 6 - (tipsFit(m) && items.some((a) => (a.tips ?? 0) > 0) ? 130 : 0));
  const upAvail = m.cy - top - dMax / 2 - labelRoom, downAvail = m.h - m.cy - bottom - dMax / 2 - labelRoom;
  const ryUp = Math.max(40, upAvail), ryDown = Math.max(40, downAvail);
  const core: Circle = { x: m.cx, y: m.cy, d: m.core };
  const chip: Circle | null = hasParent ? { ...m.chip } : null;
  const placed: Arm[] = [];
  items.forEach((a, i) => {
    const angle = hasParent ? -90 + ((i + 1) * 360) / (n + 1) : -90 + (i * 360) / Math.max(n, 1) - (n > 1 ? 360 / n / 2 : 0);
    const rad = (angle * Math.PI) / 180, d = diameter(a, m.narrow);
    const lw = labelWidth(a.name, m);
    const autoSide = Math.sin(rad) < -0.25 ? "t" : "b";
    const at = (f: number, side: "t" | "b"): Arm => {
      const x = m.cx + rxMax * f * Math.cos(rad), y = m.cy + (Math.sin(rad) < 0 ? ryUp : ryDown) * f * Math.sin(rad);
      return { x, y, d, angle, side, label: { x: x - lw / 2, y: side === "t" ? y - d / 2 - 4 - m.labelH : y + d / 2 + 4, w: lw, h: m.labelH } };
    };
    const clear = (c: Arm) => {
      if ([circleBox(c.x, c.y, c.d), c.label].some((b) => b.x < 0 || b.y < 0 || b.x + b.w > m.w || b.y + b.h > m.h)) return false;
      if (reserved && (overlaps(c.label, reserved, 4) || boxHitsCircle(reserved, { x: c.x, y: c.y, d: c.d }))) return false;
      const me: Circle = { x: c.x, y: c.y, d: c.d };
      if (circlesTouch(me, core, m.narrow ? 8 : 22) || boxHitsCircle(c.label, core)) return false;
      if (chip && (circlesTouch(me, chip, 4) || boxHitsCircle(c.label, chip))) return false;
      return placed.every((o) => { const oc: Circle = { x: o.x, y: o.y, d: o.d }; return !circlesTouch(me, oc, 6) && !overlaps(c.label, o.label, 4) && !boxHitsCircle(c.label, oc) && !boxHitsCircle(o.label, me); });
    };
    // Outermost first (background children one step further out), then in: the first spot with nothing under it.
    const start = 1;
    const sides: ("t" | "b")[] = autoSide === "t" ? ["t", "b"] : ["b", "t"];
    let pick: Arm | null = null;
    for (let f = start; f >= 0.4 && !pick; f -= 0.04) for (const side of sides) { const c = at(f, side); if (clear(c)) { pick = c; break; } }
    if (!pick) return;
    placed.push(pick);
  });
  return placed.length === n ? placed : [];
}

/** If the ring cannot fit every child, use rows below the map and grow the stage to contain them. */
export function stageLayout(items: readonly ArmIn[], base: Metrics, hasParent: boolean, needsLines = 0): { m: Metrics; arms: Arm[]; compact: boolean } {
  const reserved = base.narrow && needsLines ? { x: base.w * .22, y: base.cy + base.core / 2 + 12, w: base.w * .56, h: needsLines * 19 } : undefined;
  const ring = armLayout(items, base, hasParent, reserved);
  if (ring.length === items.length) return { m: base, arms: ring, compact: false };
  const columns = Math.max(1, Math.min(items.length, Math.floor(base.w / (base.labelW + 16))));
  const cellW = base.w / columns;
  const rowH = Math.max(...items.map((a) => diameter(a, base.narrow))) + base.labelH + 18;
  const start = base.cy + base.core / 2 + (base.narrow ? 100 : 28);
  const arms = items.map((a, i): Arm => {
    const d = diameter(a, base.narrow), x = cellW * (i % columns + .5), y = start + Math.floor(i / columns) * rowH + d / 2;
    const lw = labelWidth(a.name, base);
    return { x, y, d, angle: 90, side: "b", label: { x: x - lw / 2, y: y + d / 2 + 4, w: lw, h: base.labelH } };
  });
  return { m: { ...base, h: Math.max(base.h, start + Math.ceil(items.length / columns) * rowH) }, arms, compact: true };
}

/** Small marks at the tips of an arm (a node's own children, up to three), wide stages only. */
export type Tip = { x: number; y: number; angle: number; side: "l" | "r" | "t" | "b" };
export const tipsFit = (m: Pick<Metrics, "w" | "narrow">) => !m.narrow && m.w >= 1000;
export function tipLayout(arm: Arm, count: number, m: Metrics): Tip[] {
  if (!tipsFit(m) || count < 1) return [];
  const k = Math.min(count, 3), step = k < 3 ? 17 : 13;
  const rx = m.w / 2 - 28, ry = m.h / 2 - 30;
  return Array.from({ length: k }, (_, j) => {
    const angle = arm.angle + (j - (k - 1) / 2) * step, rad = (angle * Math.PI) / 180;
    const c = Math.cos(rad), s = Math.sin(rad);
    return { x: m.cx + rx * c, y: m.cy + ry * s, angle, side: c > 0.35 ? "r" : c < -0.35 ? "l" : s > 0 ? "b" : "t" };
  });
}

/** The area-slot registry: an area (by node path) may register a component for its own region of the node view. */
export type SlotProps = { node: Area };
export type SlotComponent = (props: SlotProps) => unknown;
export function slotFor<T>(registry: Readonly<Record<string, T>>, path: string): T | null {
  return Object.prototype.hasOwnProperty.call(registry, path) ? registry[path] : null;
}

/** What is alive at a node: Needs you first, then Moving (plain text; the centre of the map and its count line). */
export type Alive = { has: boolean; needs: string[]; moving: string[] };
export const NO_ALIVE: Alive = { has: false, needs: [], moving: [] };
export function aliveOf(entry: Pick<AreaBrief, "brief"> | null | undefined): Alive {
  if (!entry || !entry.brief.present.length) return NO_ALIVE;
  return { has: true, needs: entry.brief.needsYou.map((i) => i.text), moving: entry.brief.moving.map((i) => i.text) };
}
/** The centre shows at most `max` lines, Needs you before Moving. */
export function centreLines(a: Alive, max: number): { kind: "needs" | "moving"; text: string }[] {
  return [...a.needs.map((text) => ({ kind: "needs" as const, text })), ...a.moving.map((text) => ({ kind: "moving" as const, text }))].slice(0, max);
}
