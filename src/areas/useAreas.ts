import { clearProjectBodies } from "./projectBody";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { parseArea, parseProject, sortAreas, trustedBrief, type Area, type AreaNoteLike, type PathRow } from "./areasCore";
import { parseBrief, parseToday, type Brief, type Today } from "./briefCore";
import { deviceCache, type AreasPayload, type BriefRaw, type CacheOwner } from "./areasCache";
import { buildTree, type Tree } from "./treeCore";
import { forgetTasks } from "./useTasks";
import { createPathCache, shouldReload } from "./pathCache";

export type AreaBrief = { brief: Brief; generatedAt: string | null; updatedAt: string | null };
export type AreasData = {
  /** Every node under Uni: areas and the projects that name a parent. */
  areas: Area[];
  tree: Tree;
  /** Each node's Brief by node path. */
  briefs: Record<string, AreaBrief>;
  today: { today: Today; updatedAt: string | null; generatedAt: string | null } | null;
  /** True for device-cache data or a snapshot whose refresh failed. */
  stale: boolean;
  savedAt: number | null;
  truncated: string[];
};
export const AREA_VAULT = "uni";

/**
 * The `uni` path listing for the sealed apps' vault bridge only (it pages the whole vault, so it is cached for 10 s
 * and never runs for the Today view).
 */
export const areaPaths = createPathCache(() => invoke<PathRow[]>("vault_paths", { vault: AREA_VAULT }));

const query = (tag: string, includeContent = true) => invoke<AreaNoteLike[]>("vault_query", { vault: AREA_VAULT, tag, includeContent, limit: 200 });
/** A Brief belongs only to the node named by its path. */
const pathOwner = (n: AreaNoteLike) => /^(.+)\/Brief$/.exec((n.path ?? "").replace(/\.md$/i, ""))?.[1] ?? null;
const newest = <T extends { updatedAt?: string | null }>(a: T | undefined, b: T) => (!a || (b.updatedAt ?? "") >= (a.updatedAt ?? "") ? b : a);

/**
 * Four tag queries in parallel (areas, projects, briefs, Today) — never the whole vault, and no per-node fetches. Projects come
 * without content (only their metadata names the parent). Failed optional queries retain their previous data and mark the entire snapshot stale.
 */
export async function fetchPayload(prev: AreasPayload | null = null): Promise<AreasPayload & { refreshError: string | null }> {
  const [areas, projects, briefs, today] = await Promise.allSettled([query("area"), query("project", false), query("area-brief"), query("area-today")]);
  if (areas.status === "rejected") throw areas.reason;
  const found = areas.value.map(parseArea).filter((a): a is Area => !!a);
  const kept = projects.status === "fulfilled" ? projects.value.map(parseProject).filter((a): a is Area => !!a)
    : (prev?.areas ?? []).filter((a) => a.kind === "project");
  const parsed = sortAreas([...found, ...kept]);
  let briefRaw: Record<string, BriefRaw> = prev?.briefs ?? {};
  if (briefs.status === "fulfilled") {
    const latest: Record<string, AreaNoteLike> = {};
    for (const n of briefs.value) {
      const owner = pathOwner(n); if (!owner) continue;
      latest[owner] = newest(latest[owner], n);
    }
    // A node whose `brief` field names its own Brief (by id) uses exactly that note; a reference to anything else is ignored.
    for (const a of parsed) { const pinned = trustedBrief(a.path, a.metadata.brief, briefs.value); if (pinned) latest[a.path] = pinned; }
    briefRaw = Object.fromEntries(Object.entries(latest).map(([name, n]) => [name, { content: n.content ?? "", updatedAt: n.updatedAt ?? null, generatedAt: typeof n.metadata?.generated_at === "string" ? n.metadata.generated_at : null }]));
  }
  let todayRaw = prev?.today ?? null;
  if (today.status === "fulfilled") {
    const t = today.value.filter((n) => (n.path ?? "").replace(/\.md$/i, "") === "Areas/Today").reduce<AreaNoteLike | undefined>((best, n) => newest(best, n), undefined);
    todayRaw = t ? { content: t.content ?? "", updatedAt: t.updatedAt ?? null, generatedAt: typeof t.metadata?.generated_at === "string" ? t.metadata.generated_at : null } : null;
  }
  const results = [areas, projects, briefs, today];
  const tags = ["area", "project", "area-brief", "area-today"];
  const errors = results.flatMap((r, i) => r.status === "rejected" ? [`${tags[i]}: ${String(r.reason)}`] : []);
  const truncated = results.flatMap((r, i) => r.status === "fulfilled" ? (r.value.length >= 200 ? [tags[i]] : []) : (prev?.truncated ?? []).filter((tag) => tag === tags[i]));
  return { areas: parsed, briefs: briefRaw, today: todayRaw, truncated, refreshError: errors.length ? errors.join("; ") : null };
}

export function toView(p: AreasPayload, stale: boolean, savedAt: number | null = null): AreasData {
  const tree = buildTree(p.areas);
  return {
    areas: [...tree.nodes.values()], tree, stale, savedAt, truncated: p.truncated ?? [],
    briefs: Object.fromEntries(Object.entries(p.briefs).map(([path, b]) => [path, { brief: parseBrief(b.content), generatedAt: b.generatedAt, updatedAt: b.updatedAt }])),
    today: p.today ? { today: parseToday(p.today.content), updatedAt: p.today.updatedAt, generatedAt: p.today.generatedAt ?? null } : null,
  };
}

// Shown immediately on reopen (from memory, else from the device), then refreshed.
let payload: AreasPayload | null = null;
let lastLoadAt: number | null = null;
let memoryOwner: string | null = null;
let savedAt: number | null = null;
let generation = 0;
let memoryStale = true;
export function forgetAreas() {
  generation++;
  payload = null; lastLoadAt = null; savedAt = null; memoryOwner = null; memoryStale = true;
  clearProjectBodies();
  forgetTasks();
  deviceCache.clear();
}
const ownerKey = (owner: CacheOwner) => JSON.stringify(owner);
const remembered = (owner: CacheOwner) => {
  const key = ownerKey(owner);
  if (memoryOwner !== key) {
    clearProjectBodies();
    forgetTasks();
    generation++;
    payload = null; lastLoadAt = null; savedAt = null; memoryOwner = key; memoryStale = true;
  }
  if (!payload) { const c = deviceCache.read(owner); if (c) { payload = c; savedAt = c.savedAt; } }
  return payload;
};

/** Load timings, kept for the device check (`window.__areasTiming`): cache paint and the network answer, in ms from mount. */
type Timing = { fromCache: boolean; cacheMs?: number; freshMs?: number };
const timing = (patch: Partial<Timing>) => { const w = window as unknown as { __areasTiming?: Timing }; w.__areasTiming = { ...(w.__areasTiming ?? { fromCache: false }), ...patch }; };

export function useAreas(identity: string | null) {
  const owner = { identity: identity ?? "", vault: AREA_VAULT };
  const [data, setData] = useState<AreasData | null>(() => { const p = remembered(owner); return p ? toView(p, memoryStale, savedAt) : null; });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!identity) return;
    remembered(owner);
    const epoch = generation;
    const t0 = performance.now();
    if (n === 0) {
      timing({ fromCache: data !== null, cacheMs: undefined, freshMs: undefined });
      if (data) requestAnimationFrame(() => timing({ cacheMs: Math.round(performance.now() - t0) }));
    }
    let live = true;
    setLoading(true); setError(null);
    lastLoadAt = Date.now();
    fetchPayload(payload).then((p) => {
      if (!live || epoch !== generation) return;
      payload = p;
      memoryStale = !!p.refreshError;
      if (!p.refreshError) { savedAt = Date.now(); deviceCache.write(p, owner); }
      setError(p.refreshError);
      if (n === 0) timing({ freshMs: Math.round(performance.now() - t0) });
      if (live) setData(toView(p, !!p.refreshError, savedAt));
    }).catch((e) => { if (live && epoch === generation) { memoryStale = true; setError(String(e)); setData((d) => d ? { ...d, stale: true } : d); } })
      .finally(() => { if (live && epoch === generation) setLoading(false); });
    return () => { live = false; };
  }, [n, identity]); // eslint-disable-line react-hooks/exhaustive-deps
  // Coming back to the app refreshes the view (at most once per 30 s); there is no manual refresh button.
  useEffect(() => {
    const visible = () => { if (document.visibilityState === "visible" && shouldReload(lastLoadAt, Date.now())) setN((x) => x + 1); };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, []);
  return { data, error, loading: !!identity && loading, signingIn: !identity };
}

// Browser regression seam, absent from production builds.
if (import.meta.env.VITE_AREAS_TESTHOOKS === "1") {
  (window as unknown as { __forgetAreas: typeof forgetAreas }).__forgetAreas = forgetAreas;
}
