import type { NotePath } from "./vaultTree.ts";
// Entries retain in-flight requests so switching tabs never starts duplicate paging.
const cache = new Map<string, { rows?: NotePath[]; pending?: Promise<NotePath[]> }>();
const listeners = new Set<() => void>();
export const cachedPaths = (vault: string) => cache.get(vault)?.rows;
export function loadPaths(vault: string, fetch: () => Promise<NotePath[]>): Promise<NotePath[]> {
  const old = cache.get(vault);
  if (old?.rows) return Promise.resolve(old.rows);
  if (old?.pending) return old.pending;
  const entry: { rows?: NotePath[]; pending?: Promise<NotePath[]> } = {};
  cache.set(vault, entry);
  entry.pending = fetch().then((rows) => { entry.rows = rows; return rows; }).finally(() => { entry.pending = undefined; });
  return entry.pending;
}
export function invalidatePaths(vault?: string) {
  if (vault) cache.delete(vault); else cache.clear();
  listeners.forEach((listener) => listener());
}
export function watchPaths(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
