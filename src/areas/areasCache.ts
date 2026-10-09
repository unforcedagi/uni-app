// The device cache for the Today view (unit-tested in scripts/lifeos.test.ts): the areas, their briefs and the Today
// note as last fetched, so the home paints from storage at once and the network only refreshes it.
import type { Area } from "./areasCore";

export const CACHE_KEY = "uni.areas.cache.v1";
export type NoteStamp = { content: string; updatedAt: string | null };
export type BriefRaw = NoteStamp & { generatedAt: string | null };
export type AreasPayload = { areas: Area[]; briefs: Record<string, BriefRaw>; today: NoteStamp | null };
export type Cached = AreasPayload & { savedAt: number };
type Store = Pick<Storage, "getItem" | "setItem">;

const isArea = (a: unknown): a is Area => {
  const x = a as Partial<Area> | null;
  return !!x && typeof x.id === "string" && typeof x.path === "string" && typeof x.name === "string" && Array.isArray(x.channels) && (x.status === "foreground" || x.status === "background");
};

export function createAreasCache(store: Store | null, now: () => number = Date.now) {
  return {
    read(): Cached | null {
      try {
        const v = JSON.parse(store?.getItem(CACHE_KEY) ?? "null");
        if (!v || v.v !== 1 || !Array.isArray(v.areas) || !v.areas.every(isArea) || typeof v.briefs !== "object" || !v.briefs || typeof v.savedAt !== "number") return null;
        return { savedAt: v.savedAt, areas: v.areas, briefs: v.briefs, today: v.today ?? null };
      } catch { return null; }
    },
    write(p: AreasPayload): void {
      try { store?.setItem(CACHE_KEY, JSON.stringify({ v: 1, savedAt: now(), areas: p.areas, briefs: p.briefs, today: p.today })); } catch { /* private storage or full: the next load just fetches */ }
    },
  };
}

export const deviceCache = createAreasCache(typeof localStorage === "undefined" ? null : localStorage);
