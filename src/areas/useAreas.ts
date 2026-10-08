import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isAreaPath, parseArea, sortAreas, type Area, type AreaNoteLike, type PathRow } from "./areasCore";
import { createPathCache, shouldReload } from "./pathCache";

export type AreasData = { areas: Area[]; rows: PathRow[] };
export const AREA_VAULT = "uni";

/** The `uni` path listing, cached for 10 s and shared by the grid and the bridge. */
export const areaPaths = createPathCache(() => invoke<PathRow[]>("vault_paths", { vault: AREA_VAULT }));

export async function loadAreas(): Promise<AreasData> {
  const rows = await areaPaths.get();
  const candidates = rows.filter((r) => isAreaPath(r.path) && (r.extension ?? "").toLowerCase() !== "html");
  const notes = await Promise.all(candidates.map((r) => invoke<{ note: AreaNoteLike }>("vault_note", { vault: AREA_VAULT, noteRef: r.id }).then((d) => d.note).catch(() => null)));
  return { areas: sortAreas(notes.map((n) => (n ? parseArea(n) : null)).filter((a): a is Area => !!a)), rows };
}

// Shown immediately on reopen, then refreshed.
let cached: AreasData | null = null;
let lastLoadAt: number | null = null;

export function useAreas() {
  const [data, setData] = useState<AreasData | null>(cached);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true); setError(null);
    lastLoadAt = Date.now();
    loadAreas().then((d) => { cached = d; if (live) setData(d); })
      .catch((e) => { if (live) setError(String(e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [n]);
  // Coming back to the app refreshes the grid (at most once per 30 s); there is no manual refresh button.
  useEffect(() => {
    const visible = () => { if (document.visibilityState === "visible" && shouldReload(lastLoadAt, Date.now())) setN((x) => x + 1); };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, []);
  return { data, error, loading };
}
