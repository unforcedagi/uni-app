// Tabs (pure, unit-tested). Rooms, threads, vault notes and the Journal open
// as tabs that stay open until closed; the set and the active tab persist in
// localStorage per device. The App renders them; this module only decides.

import type { VaultRef } from "./vaultlinks.ts";

export type TabKind = "room" | "thread" | "note" | "journal";
export type Tab = { id: string; kind: TabKind; channel?: string; root?: string; note?: VaultRef; title: string };
export type TabTarget = Omit<Tab, "id">;
/** `recent`: tab ids by last activation, most recent last (drives the cap and close). */
export type Tabs = { tabs: Tab[]; active: string | null; recent: string[] };

export const MAX_TABS = 12;
export const TABS_KEY = "uni.tabs.v1";
export const EMPTY_TABS: Tabs = { tabs: [], active: null, recent: [] };

/**
 * focus:   a tab already showing this target is activated; otherwise the
 *          active tab is replaced (sidebar click, search hit).
 * new:     a tab already showing this target is activated; otherwise a new
 *          tab opens right after the active one (Cmd/Ctrl-click, long-press,
 *          note links).
 * replace: the active tab navigates in place (thread ↔ room).
 * With no tabs open, every mode opens one.
 */
export type OpenMode = "focus" | "new" | "replace";

export function sameTarget(a: TabTarget, b: TabTarget): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "journal": return true;
    case "room": return a.channel === b.channel;
    case "thread": return a.channel === b.channel && a.root === b.root;
    case "note": return !!a.note && !!b.note && a.note.vault === b.note.vault && a.note.ref === b.note.ref;
  }
}

export function activeTab(s: Tabs): Tab | null {
  return s.tabs.find((t) => t.id === s.active) ?? null;
}

function touch(recent: string[], id: string): string[] {
  return [...recent.filter((x) => x !== id), id];
}

/** Drop the least recently used inactive tabs until within the cap. */
function capped(s: Tabs): Tabs {
  let { tabs, recent } = s;
  while (tabs.length > MAX_TABS) {
    const rank = (id: string) => { const i = recent.indexOf(id); return i < 0 ? -1 : i; };
    const victim = tabs.filter((t) => t.id !== s.active).reduce((a, b) => rank(b.id) < rank(a.id) ? b : a);
    tabs = tabs.filter((t) => t.id !== victim.id);
    recent = recent.filter((x) => x !== victim.id);
  }
  return { ...s, tabs, recent };
}

export function openTab(s: Tabs, target: TabTarget, mode: OpenMode, newId: () => string): Tabs {
  const tab: Tab = { ...target, id: newId() };
  const cur = activeTab(s);
  if (mode !== "replace") {
    const existing = s.tabs.find((t) => sameTarget(t, target));
    if (existing) return focusTab(s, existing.id);
  }
  if (!cur) return capped({ tabs: [...s.tabs, tab], active: tab.id, recent: touch(s.recent, tab.id) });
  const at = s.tabs.indexOf(cur);
  if (mode === "new") {
    const tabs = [...s.tabs.slice(0, at + 1), tab, ...s.tabs.slice(at + 1)];
    return capped({ tabs, active: tab.id, recent: touch(s.recent, tab.id) });
  }
  // Replace in place: a fresh id, so per-tab state (a note's Back stack) resets.
  const tabs = s.tabs.map((t) => t.id === cur.id ? tab : t);
  return { tabs, active: tab.id, recent: touch(s.recent.filter((x) => x !== cur.id), tab.id) };
}

export function focusTab(s: Tabs, id: string): Tabs {
  if (!s.tabs.some((t) => t.id === id)) return s;
  if (s.active === id && s.recent[s.recent.length - 1] === id) return s;
  return { ...s, active: id, recent: touch(s.recent, id) };
}

/** The tab that becomes active when `id` closes (the most recently used other tab). */
export function nextAfterClose(s: Tabs, id: string): Tab | null {
  if (s.active !== id) return activeTab(s);
  const rest = s.tabs.filter((t) => t.id !== id);
  for (let i = s.recent.length - 1; i >= 0; i--) {
    const hit = rest.find((t) => t.id === s.recent[i]);
    if (hit) return hit;
  }
  // Never activated since restore: the right-hand neighbour, else the left.
  const at = s.tabs.findIndex((t) => t.id === id);
  return rest[Math.min(at, rest.length - 1)] ?? null;
}

export function closeTab(s: Tabs, id: string): Tabs {
  if (!s.tabs.some((t) => t.id === id)) return s;
  const next = nextAfterClose(s, id);
  return {
    tabs: s.tabs.filter((t) => t.id !== id),
    active: next?.id ?? null,
    recent: next ? touch(s.recent.filter((x) => x !== id), next.id) : s.recent.filter((x) => x !== id),
  };
}

export function updateTab(s: Tabs, id: string, patch: Partial<TabTarget>): Tabs {
  let changed = false;
  const tabs = s.tabs.map((t) => {
    if (t.id !== id) return t;
    const u = { ...t, ...patch };
    changed = JSON.stringify(u) !== JSON.stringify(t);
    return u;
  });
  return changed ? { ...s, tabs } : s;
}

/** Cmd/Ctrl-1…8 pick that tab; 9 picks the last (browser convention). */
export function tabForDigit(s: Tabs, digit: number): Tab | null {
  if (digit < 1 || digit > 9 || !s.tabs.length) return null;
  return digit === 9 ? s.tabs[s.tabs.length - 1] : s.tabs[digit - 1] ?? null;
}

export function serializeTabs(s: Tabs): string {
  return JSON.stringify({ v: 1, tabs: s.tabs, active: s.active, recent: s.recent });
}

const KINDS: TabKind[] = ["room", "thread", "note", "journal"];
const str = (x: unknown): x is string => typeof x === "string" && x.length > 0;

function validTab(x: unknown): Tab | null {
  if (!x || typeof x !== "object") return null;
  const t = x as Record<string, unknown>;
  if (!str(t.id) || !KINDS.includes(t.kind as TabKind)) return null;
  const title = typeof t.title === "string" ? t.title : "";
  const kind = t.kind as TabKind;
  if (kind === "journal") return { id: t.id, kind, title: title || "Journal" };
  if (kind === "note") {
    const n = t.note as Record<string, unknown> | undefined;
    if (!n || !str(n.vault) || !str(n.ref)) return null;
    return { id: t.id, kind, note: { hub: typeof n.hub === "string" ? n.hub : null, vault: n.vault, ref: n.ref }, title };
  }
  if (!str(t.channel)) return null;
  if (kind === "thread") return str(t.root) ? { id: t.id, kind, channel: t.channel, root: t.root, title } : null;
  return { id: t.id, kind, channel: t.channel, title };
}

/** Parse saved tabs; tabs for rooms that no longer exist are dropped silently. */
export function restoreTabs(raw: string | null, roomIds: Iterable<string>): Tabs {
  if (!raw) return EMPTY_TABS;
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return EMPTY_TABS; }
  if (!data || typeof data !== "object" || !Array.isArray((data as { tabs?: unknown }).tabs)) return EMPTY_TABS;
  const d = data as { tabs: unknown[]; active?: unknown; recent?: unknown };
  const rooms = new Set(roomIds);
  const seen = new Set<string>();
  const tabs: Tab[] = [];
  for (const x of d.tabs) {
    const t = validTab(x);
    if (!t || seen.has(t.id)) continue;
    if ((t.kind === "room" || t.kind === "thread") && !rooms.has(t.channel!)) continue;
    if (tabs.some((o) => sameTarget(o, t))) continue;
    seen.add(t.id);
    tabs.push(t);
  }
  const recentRaw = Array.isArray(d.recent) ? d.recent.filter((x): x is string => typeof x === "string" && seen.has(x)) : [];
  const recent = [...new Set(recentRaw)];
  let active = typeof d.active === "string" && seen.has(d.active) ? d.active : null;
  if (!active) active = recent[recent.length - 1] ?? tabs[0]?.id ?? null;
  return capped({ tabs, active, recent: active ? touch(recent, active) : recent });
}
