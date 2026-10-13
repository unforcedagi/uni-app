import { todayNeeds } from "./briefCore";
import type { AreasData } from "./useAreas";

export type RoomInfo = { id: string; name: string; last_message: string | null; last_ts: number | null };

/** What needs Aaron across areas, ranked (the lede of Uni's own work page). */
export function rootNeeds(data: AreasData | null, now: number) {
  if (!data) return [];
  const named = data.areas.filter((a) => a.kind === "area");
  const foreground = named.filter((a) => a.status === "foreground");
  return todayNeeds(data.today?.today ?? null, Object.fromEntries(named.flatMap((a) => (data.briefs[a.path] ? [[a.name, data.briefs[a.path].brief]] : []))), foreground.map((a) => a.name), now);
}
