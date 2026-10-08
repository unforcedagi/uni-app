import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isAreaPath, parseArea, sortAreas, type Area, type AreaNoteLike, type PathRow } from "./areasCore";

export type AreasData = { areas: Area[]; rows: PathRow[] };
export const AREA_VAULT = "uni";

export async function loadAreas(): Promise<AreasData> {
  const rows = await invoke<PathRow[]>("vault_paths", { vault: AREA_VAULT });
  const candidates = rows.filter((r) => isAreaPath(r.path) && (r.extension ?? "").toLowerCase() !== "html");
  const notes = await Promise.all(candidates.map((r) => invoke<{ note: AreaNoteLike }>("vault_note", { vault: AREA_VAULT, noteRef: r.id }).then((d) => d.note).catch(() => null)));
  return { areas: sortAreas(notes.map((n) => (n ? parseArea(n) : null)).filter((a): a is Area => !!a)), rows };
}

// Shown immediately on reopen, then refreshed.
let cached: AreasData | null = null;

export function useAreas() {
  const [data, setData] = useState<AreasData | null>(cached);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true); setError(null);
    loadAreas().then((d) => { cached = d; if (live) setData(d); })
      .catch((e) => { if (live) setError(String(e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [n]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  return { data, error, loading, reload };
}
