// The window's width class, and the one-time migration of the retired Home layout setting (T-124 r12: Map, Octopus and Classic were
// deleted; the room tree is the only layout). A saved choice of any of them is dropped, so the device opens on the room layout.
import { useSyncExternalStore } from "react";

/** The retired Settings → Home layout key ("rooms", "tree", "octopus" or "classic"). Nothing reads it any more. */
export const HOME_LAYOUT_KEY = "uni.home.layout.v1";

/** Forget a saved Home layout: every choice maps to the room layout. Returns what was stored (null: nothing). Runs once at start. */
export function migrateHomeLayout(storage: Pick<Storage, "getItem" | "removeItem"> | null = typeof localStorage === "undefined" ? null : localStorage): string | null {
  try {
    const was = storage?.getItem(HOME_LAYOUT_KEY) ?? null;
    if (was !== null) storage!.removeItem(HOME_LAYOUT_KEY);
    return was;
  } catch { return null; }
}

/** Daylight and tablets: the room tree beside the room. Narrower is the phone's room tree, then a room. */
export const WIDE_MIN = 900;
const wideQuery = `(min-width: ${WIDE_MIN}px)`;
const subscribeWide = (f: () => void) => { const mq = window.matchMedia(wideQuery); mq.addEventListener("change", f); return () => mq.removeEventListener("change", f); };
export const useWide = (): boolean => useSyncExternalStore(subscribeWide, () => window.matchMedia(wideQuery).matches, () => true);

/**
 * The rail (Uni, Journal, Vault, Search, Settings) is hidden on a short window up to 950px wide (phone landscape, a short laptop window).
 * One rule (r14): the App hides the rail by it, and the room shows its Places drawer whenever it holds, as well as below 900px.
 */
export const RAIL_HIDDEN_QUERY = "(max-height: 499px) and (max-width: 950px)";
const subscribeRail = (f: () => void) => { const mq = window.matchMedia(RAIL_HIDDEN_QUERY); mq.addEventListener("change", f); return () => mq.removeEventListener("change", f); };
export const useRailHidden = (): boolean => useSyncExternalStore(subscribeRail, () => window.matchMedia(RAIL_HIDDEN_QUERY).matches, () => false);
