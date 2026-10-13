// Back and Forward over the places visited (pure, unit-tested in scripts/navtree.test.ts). One entry per place: a room (as its node), Uni,
// the Journal, a thread. A note or a vault browser opens over a place and has its own Back, so it is never an entry.
import type { Tab, TabTarget } from "./tabs.ts";
import { isSurface, sameTarget } from "./tabs.ts";

export type History = { entries: TabTarget[]; index: number };
export const EMPTY_HISTORY: History = { entries: [], index: -1 };
export const MAX_HISTORY = 50;
export const RECENT_SHOWN = 5;

const strip = (t: TabTarget | Tab): TabTarget => { const { id: _id, ...rest } = t as Tab; return rest; };

/** Visit a place. Going where you already are changes nothing; going somewhere new drops what was ahead of you. */
export function visit(h: History, target: TabTarget | Tab): History {
  if (!isSurface(target)) return h;
  const t = strip(target);
  const cur = h.entries[h.index];
  if (cur && sameTarget(cur, t)) return cur.channel === t.channel && cur.title === t.title ? h : { ...h, entries: h.entries.map((e, i) => (i === h.index ? t : e)) };
  const entries = [...h.entries.slice(0, h.index + 1), t].slice(-MAX_HISTORY);
  return { entries, index: entries.length - 1 };
}
export const canBack = (h: History): boolean => h.index > 0;
export const canForward = (h: History): boolean => h.index >= 0 && h.index < h.entries.length - 1;
export const step = (h: History, by: -1 | 1): { history: History; target: TabTarget } | null => {
  const i = h.index + by;
  return i < 0 || i >= h.entries.length ? null : { history: { ...h, index: i }, target: h.entries[i] };
};
/** A place's identity (r12): Uni, an area or project by path, a room by id, a thread by its root. Never its name: two projects may share one. */
export function placeKey(t: TabTarget): string {
  switch (t.kind) {
    case "areas": return "uni";
    case "area": return `area:${t.path ?? ""}`;
    case "thread": return `thread:${t.channel ?? ""}:${t.root ?? ""}`;
    case "room": return `room:${t.channel ?? ""}`;
    default: return t.kind;
  }
}

/**
 * The latest distinct places before this one, newest first (at most five), for the sidebar's Recent list. Places are told apart by
 * `keyOf` (by default `placeKey`; the app maps a room a node owns to that node, so Uni opened as its room before the tree loaded is Uni).
 */
export function recent(h: History, max = RECENT_SHOWN, keyOf: (t: TabTarget) => string = placeKey): TabTarget[] {
  const out: TabTarget[] = [];
  const cur = h.entries[h.index];
  const seen = new Set<string>(cur ? [keyOf(cur)] : []);
  for (let i = h.entries.length - 1; i >= 0 && out.length < max; i--) {
    const e = h.entries[i];
    const k = keyOf(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}
