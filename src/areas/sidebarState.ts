// The room tree's own state, per device (T-124 r7): which areas are folded, how wide the sidebar is, whether it is hidden.
// Pure helpers (unit-tested in scripts/navtree.test.ts) and two tiny localStorage-backed hooks.
import { useCallback, useEffect, useState } from "react";

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

export type FoldRow = { path: string; depth: number };

/** Whether row `i` has children (the next row is deeper). */
export const hasKids = (rows: readonly FoldRow[], i: number): boolean => i + 1 < rows.length && rows[i + 1].depth > rows[i].depth;

/** The paths from the top to `selected` (exclusive): the rows that must be open for it to show. */
export function ancestorsOf(rows: readonly FoldRow[], selected: string | undefined): string[] {
  const i = rows.findIndex((r) => r.path === selected);
  if (i < 0) return [];
  const out: string[] = [];
  let d = rows[i].depth;
  for (let j = i - 1; j >= 0 && d > 0; j--) if (rows[j].depth < d) { out.push(rows[j].path); d = rows[j].depth; }
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

const read = <T,>(key: string, parse: (raw: string | null) => T): T => { try { return parse(localStorage.getItem(key)); } catch { return parse(null); } };
const write = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* this session only */ } };

export function useFolds(): [Folds, (path: string, open: boolean) => void, (paths: readonly string[]) => void] {
  const [folds, setFolds] = useState<Folds>(() => read(FOLDS_KEY, parseFolds));
  const set = useCallback((path: string, open: boolean) => setFolds((f) => { const n = { ...f, [path]: open }; write(FOLDS_KEY, n); return n; }), []);
  /** Open these (a room was opened from elsewhere): only the ones the user had folded change. */
  const reveal = useCallback((paths: readonly string[]) => setFolds((f) => {
    if (!paths.some((p) => f[p] === false)) return f;
    const n = { ...f }; for (const p of paths) if (n[p] === false) n[p] = true;
    write(FOLDS_KEY, n); return n;
  }), []);
  return [folds, set, reveal];
}

export function useSidebar(): [SidebarState, (s: Partial<SidebarState>) => void] {
  const [state, setState] = useState<SidebarState>(() => read(SIDEBAR_KEY, parseSidebar));
  const update = useCallback((s: Partial<SidebarState>) => setState((c) => { const n = { ...c, ...s, width: clampWidth(s.width ?? c.width) }; write(SIDEBAR_KEY, n); return n; }), []);
  useEffect(() => { document.documentElement.style.setProperty("--th-nav-w", `${state.hidden ? 0 : state.width}px`); }, [state]);
  return [state, update];
}
