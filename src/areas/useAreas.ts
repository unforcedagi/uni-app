import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { parseArea, sortAreas, type Area, type AreaNoteLike, type PathRow } from "./areasCore";
import { parseBrief, parseToday, type Brief, type Today } from "./briefCore";
import { deviceCache, type AreasPayload, type BriefRaw } from "./areasCache";
import { createPathCache, shouldReload } from "./pathCache";

export type AreaBrief = { brief: Brief; generatedAt: string | null; updatedAt: string | null };
export type AreasData = {
  areas: Area[];
  /** Each area's Brief by area name. */
  briefs: Record<string, AreaBrief>;
  today: { today: Today; updatedAt: string | null } | null;
  /** True while this is what the device remembered and the network hasn't answered yet. */
  stale: boolean;
};
export const AREA_VAULT = "uni";

/**
 * The `uni` path listing for the sealed apps' vault bridge only (it pages the whole vault, so it is cached for 10 s
 * and never runs for the Today view).
 */
export const areaPaths = createPathCache(() => invoke<PathRow[]>("vault_paths", { vault: AREA_VAULT }));

const query = (tag: string) => invoke<AreaNoteLike[]>("vault_query", { vault: AREA_VAULT, tag, includeContent: true, limit: 200 });
const briefOwner = (n: AreaNoteLike) => /^Areas\/([^/]+)\/Brief$/.exec((n.path ?? "").replace(/\.md$/i, ""))?.[1] ?? (typeof n.metadata?.area === "string" ? n.metadata.area : null);
const newest = <T extends { updatedAt?: string | null }>(a: T | undefined, b: T) => (!a || (b.updatedAt ?? "") >= (a.updatedAt ?? "") ? b : a);

/** Three tag queries in parallel (areas, briefs, Today) — never the whole vault. A missing brief or Today only blanks that part. */
export async function fetchPayload(prev: AreasPayload | null = null): Promise<AreasPayload> {
  const [areas, briefs, today] = await Promise.allSettled([query("area"), query("area-brief"), query("area-today")]);
  if (areas.status === "rejected") throw areas.reason;
  const parsed = sortAreas(areas.value.map(parseArea).filter((a): a is Area => !!a));
  let briefRaw: Record<string, BriefRaw> = prev?.briefs ?? {};
  if (briefs.status === "fulfilled") {
    const latest: Record<string, AreaNoteLike> = {};
    for (const n of briefs.value) { const owner = briefOwner(n); if (owner) latest[owner] = newest(latest[owner], n); }
    briefRaw = Object.fromEntries(Object.entries(latest).map(([name, n]) => [name, { content: n.content ?? "", updatedAt: n.updatedAt ?? null, generatedAt: typeof n.metadata?.generated_at === "string" ? n.metadata.generated_at : null }]));
  }
  let todayRaw = prev?.today ?? null;
  if (today.status === "fulfilled") {
    const t = today.value.filter((n) => (n.path ?? "").replace(/\.md$/i, "") === "Areas/Today").reduce<AreaNoteLike | undefined>((best, n) => newest(best, n), undefined);
    todayRaw = t ? { content: t.content ?? "", updatedAt: t.updatedAt ?? null } : null;
  }
  return { areas: parsed, briefs: briefRaw, today: todayRaw };
}

export function toView(p: AreasPayload, stale: boolean): AreasData {
  return {
    areas: p.areas, stale,
    briefs: Object.fromEntries(Object.entries(p.briefs).map(([name, b]) => [name, { brief: parseBrief(b.content), generatedAt: b.generatedAt, updatedAt: b.updatedAt }])),
    today: p.today ? { today: parseToday(p.today.content), updatedAt: p.today.updatedAt } : null,
  };
}

// Shown immediately on reopen (from memory, else from the device), then refreshed.
let payload: AreasPayload | null = null;
let lastLoadAt: number | null = null;
const remembered = () => {
  if (!payload) { const c = deviceCache.read(); if (c) payload = { areas: c.areas, briefs: c.briefs, today: c.today }; }
  return payload;
};

/** Load timings, kept for the device check (`window.__areasTiming`): cache paint and the network answer, in ms from mount. */
type Timing = { fromCache: boolean; cacheMs?: number; freshMs?: number };
const timing = (patch: Partial<Timing>) => { const w = window as unknown as { __areasTiming?: Timing }; w.__areasTiming = { ...(w.__areasTiming ?? { fromCache: false }), ...patch }; };

export function useAreas() {
  const [data, setData] = useState<AreasData | null>(() => { const p = remembered(); return p ? toView(p, true) : null; });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    const t0 = performance.now();
    if (n === 0) {
      timing({ fromCache: data !== null, cacheMs: undefined, freshMs: undefined });
      if (data) requestAnimationFrame(() => timing({ cacheMs: Math.round(performance.now() - t0) }));
    }
    let live = true;
    setLoading(true); setError(null);
    lastLoadAt = Date.now();
    fetchPayload(payload).then((p) => {
      payload = p; deviceCache.write(p);
      if (n === 0) timing({ freshMs: Math.round(performance.now() - t0) });
      if (live) setData(toView(p, false));
    }).catch((e) => { if (live) setError(String(e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [n]); // eslint-disable-line react-hooks/exhaustive-deps
  // Coming back to the app refreshes the view (at most once per 30 s); there is no manual refresh button.
  useEffect(() => {
    const visible = () => { if (document.visibilityState === "visible" && shouldReload(lastLoadAt, Date.now())) setN((x) => x + 1); };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, []);
  return { data, error, loading };
}
