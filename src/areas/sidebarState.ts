// The room tree's own state, per device (T-124 r7): which areas are folded, how wide the sidebar is, whether it is hidden.
// Pure helpers (unit-tested in scripts/navtree.test.ts) and two tiny localStorage-backed hooks.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { NavRecent } from "../navContext.ts";
import { parseView, VIEW_KEY, type SidebarView } from "./viewsCore.ts";

export const SIDEBAR_KEY = "uni.sidebar.v1";
export const FOLDS_KEY = "uni.tree.folds.v1";
export const SIDEBAR_DEFAULT = 220;
export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 360;

export type SidebarState = { width: number; hidden: boolean };
export const clampWidth = (w: number): number => (Number.isFinite(w) ? Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(w))) : SIDEBAR_DEFAULT);

export function parseSidebar(raw: string | null): SidebarState {
  try {
    const v = raw ? JSON.parse(raw) : null;
    if (v && typeof v === "object") return { width: clampWidth(typeof v.width === "number" ? v.width : SIDEBAR_DEFAULT), hidden: v.hidden === true };
  } catch { /* fall through */ }
  return { width: SIDEBAR_DEFAULT, hidden: false };
}

/** Folds the user chose: path -> open (true) or folded (false). A path with no entry takes the default: folded, unless the open room is inside it. */
export type Folds = Record<string, boolean>;
export function parseFolds(raw: string | null): Folds {
  try {
    const v = raw ? JSON.parse(raw) : null;
    if (v && typeof v === "object" && !Array.isArray(v)) return Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "boolean")) as Folds;
  } catch { /* fall through */ }
  return {};
}

/** `key`: the row's identity when one node has several rows (a project linked to two areas); absent, the path. */
export type FoldRow = { path: string; depth: number; key?: string };

/** Whether row `i` has children (the next row is deeper). */
export const hasKids = (rows: readonly FoldRow[], i: number): boolean => i + 1 < rows.length && rows[i + 1].depth > rows[i].depth;

/** The areas and projects above `selected`, nearest first: the rows that must be open for it to show (Uni, the top row, is always open). */
export function ancestorsOf(rows: readonly FoldRow[], selected: string | undefined): string[] {
  const out: string[] = [];
  // a node shown under two areas opens both, so each row that highlights is visible
  rows.forEach((r, i) => {
    if (r.path !== selected) return;
    let d = r.depth;
    for (let j = i - 1; j >= 0 && d > 0; j--) if (rows[j].depth < d) { if (rows[j].depth > 0 && !out.includes(rows[j].path)) out.push(rows[j].path); d = rows[j].depth; }
  });
  return out;
}

/** Whether the row at `path` shows its children: the user's choice, else only when the open room is inside it. The Uni row (depth 0) is always open. */
export function isOpen(rows: readonly FoldRow[], folds: Folds, selected: string | undefined, path: string): boolean {
  const row = rows.find((r) => r.path === path);
  if (!row || row.depth === 0) return true;
  return folds[path] ?? ancestorsOf(rows, selected).includes(path);
}

/** The rows to draw: a row is hidden while any ancestor is folded. */
export function visibleRows<T extends FoldRow>(rows: readonly T[], folds: Folds, selected: string | undefined): T[] {
  const out: T[] = [];
  let hideBelow = Infinity;
  rows.forEach((r, i) => {
    if (r.depth > hideBelow) return;
    hideBelow = Infinity;
    out.push(r);
    if (hasKids(rows, i) && !isOpen(rows, folds, selected, r.path)) hideBelow = r.depth;
  });
  return out;
}

/** Rooms under a folded row that need the user, so the fold never hides a dot: the row's own count plus every descendant's. */
export function rolledNeeds(rows: readonly FoldRow[], needs: ReadonlyMap<string, number>, i: number): number {
  let n = needs.get(rows[i].path) ?? 0;
  for (let j = i + 1; j < rows.length && rows[j].depth > rows[i].depth; j++) n += needs.get(rows[j].path) ?? 0;
  return n;
}


/** Recent's height with five places: the tree is "tight" when its rows would not fit beside that, and Recent then keeps to three. */
export const RECENT_FULL_PX = 124;

/**
 * The recent places as the sidebar shows them (pure): the app's list (never the place you are in, each place once, told apart by id), at most
 * `max`. A name two shown places share (or the open place's) says where each sits: its parent in the tree, or "Other rooms".
 */
export function recentLabels(recent: readonly NavRecent[], rows: readonly (FoldRow & { name: string })[], here: string | null, max: number): { r: NavRecent; label: string }[] {
  const shown = recent.slice(0, max);
  const k = (t: string) => t.trim().toLowerCase();
  const count = new Map<string, number>();
  for (const t of [...shown.map((r) => r.title), ...(here ? [here] : [])]) count.set(k(t), (count.get(k(t)) ?? 0) + 1);
  const parentOf = (path: string) => {
    const i = rows.findIndex((r) => r.path === path);
    for (let j = i - 1; i > 0 && j >= 0; j--) if (rows[j].depth < rows[i].depth) return rows[j].name;
    return null;
  };
  return shown.map((r) => {
    const where = (count.get(k(r.title)) ?? 0) > 1 ? (r.path ? parentOf(r.path) : r.room ? "Other rooms" : null) : null;
    return { r, label: where ? `${r.title} · ${where}` : r.title };
  });
}

const read = <T,>(key: string, parse: (raw: string | null) => T): T => { try { return parse(localStorage.getItem(key)); } catch { return parse(null); } };
const write = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* this session only */ } };

export function useFolds(): [Folds, (path: string, open: boolean) => void, (paths: readonly string[]) => void] {
  const [saved, setSaved] = useState<Folds>(() => read(FOLDS_KEY, parseFolds));
  // Areas opened only to show the current room: in memory, replaced at every navigation, never written to the device.
  const [revealed, setRevealed] = useState<readonly string[]>([]);
  const set = useCallback((path: string, open: boolean) => {
    setRevealed((r) => (r.includes(path) ? r.filter((p) => p !== path) : r));
    setSaved((f) => { const n = { ...f, [path]: open }; write(FOLDS_KEY, n); return n; });
  }, []);
  /** The areas above the open room: the ones the user had folded show it for now, and fold again when the room is left. */
  const reveal = useCallback((paths: readonly string[]) => setRevealed(paths.length ? [...paths] : []), []);
  // an area folded by default (no choice saved) that holds the open room is open anyway (`isOpen`); a group with no such rule ("Other rooms") needs it said
  const folds = useMemo(() => { const n = { ...saved }; for (const p of revealed) if (n[p] !== true) n[p] = true; return n; }, [saved, revealed]);
  return [folds, set, reveal];
}

export function useSidebar(): [SidebarState, (s: Partial<SidebarState>) => void] {
  const [state, setState] = useState<SidebarState>(() => read(SIDEBAR_KEY, parseSidebar));
  const update = useCallback((s: Partial<SidebarState>) => setState((c) => { const n = { ...c, ...s, width: clampWidth(s.width ?? c.width) }; write(SIDEBAR_KEY, n); return n; }), []);
  useEffect(() => { document.documentElement.style.setProperty("--th-nav-w", `${state.hidden ? 34 : state.width}px`); }, [state]);
  return [state, update];
}

/** Rooms / Projects / Areas, remembered per device. */
export function useSidebarView(): [SidebarView, (v: SidebarView) => void] {
  const [view, setView] = useState<SidebarView>(() => read(VIEW_KEY, parseView));
  const set = useCallback((v: SidebarView) => { setView(v); write(VIEW_KEY, v); }, []);
  return [view, set];
}
