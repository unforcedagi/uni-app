// Tabs (pure, unit-tested). Places (Uni, All, the Journal, Mail…) and vault notes open
// as tabs; the set and the active tab persist in localStorage per device. The App renders
// them; this module only decides. T-335 one surface: a room is never a tab of its own. It is
// in focus over All, and the All tab carries which (`channel`, and `root` for a thread).

import type { VaultRef } from "./vaultlinks.ts";

export type TabKind = "note" | "journal" | "vault" | "areas" | "area" | "mail" | "calendar" | "messages" | "posts" | "all" | "arcade";
/** `channel` on the `all` tab is the room in focus over All (`root`: a thread of it; `path`: the place it is open for, when the room is one
 *  that place borrows). An `area` tab is a node's work, for a vault without rooms. */
export type Tab = { id: string; kind: TabKind; channel?: string; root?: string; note?: VaultRef; vault?: string; /** `area`: the node's note path (an `Areas/<Name>` area, or a project under one). */ path?: string; title: string };
export type TabTarget = Omit<Tab, "id">;
/** `recent`: tab ids by last activation, most recent last (drives the cap and close). */
export type Tabs = { tabs: Tab[]; active: string | null; recent: string[] };

export const MAX_TABS = 12;
/** 0.1.46: no tab strip; the saved set is the surface you were on (v2). The v1 key is read once, for its active surface. */
export const TABS_KEY = "uni.tabs.v2";
export const LEGACY_TABS_KEY = "uni.tabs.v1";
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
    case "journal": case "areas": case "mail": case "calendar": case "messages": case "all": case "arcade": return true;
    case "area": return a.path === b.path;
    // T-335: the To post queue, all of it or one area's
    case "posts": return (a.path ?? "") === (b.path ?? "");
    case "vault": return a.vault === b.vault;
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
  } else if (cur) {
    // A place that already has a tab (Uni, an area beside the Journal): close this tab and use that one. Two tabs for one place would be
    // folded into one on the next restore, and the active one could be the one dropped (r13: a room opened from the tree came back as the Journal).
    const existing = s.tabs.find((t) => t.id !== cur.id && sameTarget(t, target));
    if (existing) return focusTab({ tabs: s.tabs.filter((t) => t.id !== cur.id), active: s.active, recent: s.recent.filter((x) => x !== cur.id) }, existing.id);
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

export function navigateNoteTab(s: Tabs, id: string, note: VaultRef, title: string): Tabs {
  return updateTab(s, id, { note, title });
}

export function recordingTabCanClose(id: string, originTabId: string | null): boolean {
  return originTabId !== id;
}

export function serializeTabs(s: Tabs): string {
  return JSON.stringify({ v: 1, tabs: s.tabs, active: s.active, recent: s.recent });
}

const KINDS: TabKind[] = ["note", "journal", "vault", "areas", "area", "mail", "calendar", "messages", "posts", "all", "arcade"];
const str = (x: unknown): x is string => typeof x === "string" && x.length > 0;

function validTab(x: unknown): Tab | null {
  if (!x || typeof x !== "object") return null;
  const t = x as Record<string, unknown>;
  if (!str(t.id)) return null;
  // T-335 one surface: a room or a thread saved by an older version is that room in focus over All
  if ((t.kind === "room" || t.kind === "thread") && str(t.channel)) return { id: t.id, kind: "all", title: "Uni", channel: t.channel, ...(t.kind === "thread" && str(t.root) ? { root: t.root } : {}) };
  if (!KINDS.includes(t.kind as TabKind)) return null;
  const title = typeof t.title === "string" ? t.title : "";
  const kind = t.kind as TabKind;
  if (kind === "journal") return { id: t.id, kind, title: title || "Journal" };
  if (kind === "mail") return { id: t.id, kind, title: "Mail" };
  if (kind === "calendar") return { id: t.id, kind, title: "Calendar" };
  if (kind === "messages") return { id: t.id, kind, title: "Messages" };
  if (kind === "all") return { id: t.id, kind, title: "Uni", ...(str(t.channel) ? { channel: t.channel, ...(str(t.root) ? { root: t.root } : {}), ...(typeof t.path === "string" && /^[^/.][^/]*(\/[^/.][^/]*)*$/.test(t.path) && t.path.length <= 300 ? { path: t.path } : {}) } : {}) };
  if (kind === "arcade") return { id: t.id, kind, title: "Arcade" };
  if (kind === "posts") return { id: t.id, kind, title: "To post", ...(typeof t.path === "string" && /^[^/.][^/]*(\/[^/.][^/]*)*$/.test(t.path) && t.path.length <= 300 ? { path: t.path } : {}) };
  // The areas tab is Uni's home (saved tabs from before were titled "Areas").
  // (T-335: Uni's own level with its room is gone; Uni is its home)
  if (kind === "areas") return { id: t.id, kind, title: "Uni" };
  if (kind === "area") return typeof t.path === "string" && /^[^/.][^/]*(\/[^/.][^/]*)*$/.test(t.path) && t.path.length <= 300 ? { id: t.id, kind, path: t.path, title: title || t.path.split("/").pop()!, ...(str(t.channel) ? { channel: t.channel } : {}) } : null;
  if (kind === "vault") return str(t.vault) ? { id: t.id, kind, vault: t.vault, title: title || t.vault } : null;
  if (kind === "note") {
    const n = t.note as Record<string, unknown> | undefined;
    if (!n || !str(n.vault) || !str(n.ref)) return null;
    return { id: t.id, kind, note: { hub: typeof n.hub === "string" ? n.hub : null, vault: n.vault, ref: n.ref, ...(n.recover === true ? { recover: true } : {}) }, title };
  }
  return null;
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
  /** A tab dropped as the twin of an earlier one stands for that one (it may be the active tab). */
  const twin = new Map<string, string>();
  const tabs: Tab[] = [];
  const isLegacy = (x: unknown) => !!x && typeof x === "object" && ((x as { kind?: unknown }).kind === "room" || (x as { kind?: unknown }).kind === "thread");
  const rawTab = (id: unknown) => d.tabs.find((x) => !!x && typeof x === "object" && (x as { id?: unknown }).id === id);
  const activeRaw = rawTab(d.active) as { kind?: unknown } | undefined;
  const recentIds = Array.isArray(d.recent) ? d.recent.filter((x): x is string => typeof x === "string") : [];
  const keepLegacy = isLegacy(activeRaw) ? d.active : !activeRaw || activeRaw.kind === "note" || activeRaw.kind === "vault" ? [...recentIds].reverse().find((id) => isLegacy(rawTab(id))) : undefined;
  for (const x of d.tabs) {
    let t = validTab(x);
    if (!t || seen.has(t.id)) continue;
    // T-335: of an older version's room tabs, only the place's own is the room All keeps in focus: the active one, or under a note the latest
    if (isLegacy(x) && t.id !== keepLegacy) t = { id: t.id, kind: "all", title: "Uni" };
    const same = tabs.find((o) => sameTarget(o, t));
    // T-335: two saved rooms (an older version's tabs) are one All; the one that was active is the room it keeps in focus
    if (same && same.kind === "all" && t.id === d.active && t.channel && rooms.has(t.channel)) tabs[tabs.indexOf(same)] = { ...t, id: same.id };
    if (same) { twin.set(t.id, same.id); continue; }
    seen.add(t.id);
    // A place whose room has gone keeps its tab; only the room is dropped (All with a room gone from focus is All).
    tabs.push(t.channel && !rooms.has(t.channel) ? { id: t.id, kind: t.kind, title: t.title, ...(t.path && t.kind !== "all" ? { path: t.path } : {}) } : t);
  }
  const recentRaw = Array.isArray(d.recent) ? d.recent.filter((x): x is string => typeof x === "string").map((x) => twin.get(x) ?? x).filter((x) => seen.has(x)) : [];
  const recent = [...new Set(recentRaw)];
  const wanted = typeof d.active === "string" ? twin.get(d.active) ?? d.active : null;
  let active = wanted && seen.has(wanted) ? wanted : null;
  if (!active) active = recent[recent.length - 1] ?? tabs[0]?.id ?? null;
  return capped({ tabs, active, recent: active ? touch(recent, active) : recent });
}

/** Kinds that are a place you can be (Uni, All with a room in focus, the Journal…). A note or a vault browser is something opened over one. */
export const isSurface = (t: Pick<Tab, "kind">): boolean => t.kind !== "note" && t.kind !== "vault";

/** What to save: the surfaces only, so a note or a vault browser is never what the app reopens to. T-335: All only with a room in focus (the
 *  room the app reopens to); All alone is never where the app opens. */
export function persistable(s: Tabs): Tabs {
  const tabs = s.tabs.filter((t) => isSurface(t) && (t.kind !== "all" || !!t.channel));
  const ids = new Set(tabs.map((t) => t.id));
  const recent = s.recent.filter((id) => ids.has(id));
  const active = s.active && ids.has(s.active) ? s.active : recent[recent.length - 1] ?? tabs[0]?.id ?? null;
  return { tabs, active, recent };
}

/** `uni.tabs.v1` (0.1.45 and earlier kept a strip of tabs): ignore the set, open the one that was active, when it is a surface. */
export function migrateLegacyTabs(raw: string | null, roomIds: Iterable<string>): Tabs {
  const old = restoreTabs(raw, roomIds);
  const cur = activeTab(old);
  const hit = cur && isSurface(cur) ? cur : [...old.recent].reverse().map((id) => old.tabs.find((t) => t.id === id)).find((t) => !!t && isSurface(t)) ?? null;
  return hit ? { tabs: [hit], active: hit.id, recent: [hit.id] } : EMPTY_TABS;
}

// ── T-294: the Uni side's last place ───────────────────────────────────────────────────────────────────────────────────
// Uni's rooms and the utilities beside them (Messages, Mail, Calendar, the Journal) are sides of one app: going to one and coming back finds
// the other where it was left. Uni's side is kept here: its last place, and the spot in that place's conversation when it wasn't at the newest.

export const UNI_PLACE_KEY = "uni.place.v1";
/** A place on Uni's side: Uni, an area's work, All (with a room in focus or not). */
export const isUniSide = (t: Pick<Tab, "kind">): boolean => t.kind === "areas" || t.kind === "area" || t.kind === "all";
/** The conversation a place shows, as the App names it (`channel|root`); none without a room. */
export const viewOf = (t: Pick<Tab, "channel" | "root">): string | null => t.channel ? `${t.channel}|${t.root ?? null}` : null;
/** Where the reader was: the first message in sight, how far below the list's top it starts, and how many messages were loaded then. */
export type ReturnSpot = { view: string; ref: string; offset: number; limit: number };
export type UniPlace = { target: TabTarget; spot: ReturnSpot | null };

export function serializeUniPlace(t: Tab | TabTarget, spot: ReturnSpot | null): string {
  const { id: _id, ...target } = t as Tab;
  return JSON.stringify({ v: 1, target, spot: spot && spot.view === viewOf(target) ? { view: spot.view, ref: spot.ref, offset: spot.offset, limit: spot.limit } : null });
}

/** The saved place, if it is still a place on Uni's side (a room that is gone is dropped, as a saved tab's is); its spot only if it is that place's own. */
export function readUniPlace(raw: string | null, roomIds: Iterable<string>): UniPlace | null {
  if (!raw) return null;
  let data: { target?: unknown; spot?: unknown };
  try { data = JSON.parse(raw); } catch { return null; }
  if (!data || typeof data !== "object" || !data.target || typeof data.target !== "object") return null;
  const hit = activeTab(restoreTabs(JSON.stringify({ v: 1, tabs: [{ ...data.target, id: "place" }], active: "place", recent: [] }), roomIds));
  if (!hit || !isUniSide(hit)) return null;
  const { id: _id, ...target } = hit;
  const s = data.spot as Partial<ReturnSpot> | null | undefined;
  const spot = s && typeof s === "object" && s.view === viewOf(target) && typeof s.ref === "string" && s.ref.length > 0 && s.ref.length <= 200
    && typeof s.offset === "number" && Number.isFinite(s.offset) && Number.isInteger(s.limit) && s.limit! > 0 && s.limit! <= 10_000
    ? { view: s.view, ref: s.ref, offset: s.offset, limit: s.limit! } : null;
  return { target, spot };
}
