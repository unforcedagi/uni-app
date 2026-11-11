// The one-time migration of the retired Home layout setting (T-124 r12: Map, Octopus and Classic were deleted; T-335 retired the room
// tree too). A saved choice of any of them is dropped once at start.

/** The retired Settings → Home layout key ("rooms", "tree", "octopus" or "classic"). Nothing reads it any more. */
export const HOME_LAYOUT_KEY = "uni.home.layout.v1";

/** Forget a saved Home layout. Returns what was stored (null: nothing). Runs once at start. */
export function migrateHomeLayout(storage: Pick<Storage, "getItem" | "removeItem"> | null = typeof localStorage === "undefined" ? null : localStorage): string | null {
  try {
    const was = storage?.getItem(HOME_LAYOUT_KEY) ?? null;
    if (was !== null) storage!.removeItem(HOME_LAYOUT_KEY);
    return was;
  } catch { return null; }
}
