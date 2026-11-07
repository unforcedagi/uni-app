export const LAST_SURFACE_KEY = "uni.lastSurface.v1";
export type LastSurface = "uni" | "journal";
type StorageLike = Pick<Storage, "getItem" | "setItem">;
export function readLastSurface(storage: StorageLike): LastSurface {
  try { return storage.getItem(LAST_SURFACE_KEY) === "journal" ? "journal" : "uni"; } catch { return "uni"; }
}
export function saveLastSurface(storage: StorageLike, surface: LastSurface): void {
  try { storage.setItem(LAST_SURFACE_KEY, surface); } catch { /* unavailable storage */ }
}
