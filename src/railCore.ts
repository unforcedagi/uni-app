export const FOR_YOU_ID = "01M3ZQF7EM4ADC7HEY36D3DC3B";
export const LAST_SURFACE_KEY = "uni.lastSurface.v1";
export const FOR_YOU_OPENED_KEY = "uni.forYou.opened.v1";
export type LastSurface = "uni" | "journal";
type StorageLike = Pick<Storage, "getItem" | "setItem">;
export function countRecommendations(content: string): number {
  let count = 0;
  let fence: { mark: string; length: number } | null = null;
  for (const line of content.split(/\r?\n/)) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (match && match[1][0] === fence.mark && match[1].length >= fence.length && !match[2].trim()) fence = null;
      continue;
    }
    if (match) { fence = { mark: match[1][0], length: match[1].length }; continue; }
    if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) continue;
    if (/^(?:[-*+]|\d{1,9}[.)])\s+/.test(line)) count++;
  }
  return count;
}
export function readLastSurface(storage: StorageLike): LastSurface {
  try { return storage.getItem(LAST_SURFACE_KEY) === "journal" ? "journal" : "uni"; } catch { return "uni"; }
}
export function saveLastSurface(storage: StorageLike, surface: LastSurface): void {
  try { storage.setItem(LAST_SURFACE_KEY, surface); } catch { /* unavailable storage */ }
}
export function isRecommendationNew(updatedAt: string | null, openedAt: string | null): boolean {
  return !!updatedAt && (!openedAt || Date.parse(updatedAt) > Date.parse(openedAt));
}
