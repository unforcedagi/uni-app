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
/** The latest distinct places before this one, newest first (at most five), for the sidebar's Recent list. */
export function recent(h: History, max = RECENT_SHOWN): TabTarget[] {
  const out: TabTarget[] = [];
  const cur = h.entries[h.index];
  for (let i = h.entries.length - 1; i >= 0 && out.length < max; i--) {
    const e = h.entries[i];
    // The same name is the same place to the reader (Uni opened as a room before the tree loaded, then as the node): never list the current place or one twice.
    if ((cur && (sameTarget(cur, e) || cur.title === e.title)) || out.some((o) => sameTarget(o, e) || o.title === e.title)) continue;
    out.push(e);
  }
  return out;
}
