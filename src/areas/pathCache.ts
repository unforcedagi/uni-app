// One short-lived cache for the `uni` vault path listing, shared by the Areas
// grid and the bridge. `vault_paths` pages the whole vault, so it must not run
// per bridge call or per focus.

export const PATHS_TTL_MS = 10_000;
export const RELOAD_GAP_MS = 30_000;

export function createPathCache<T>(fetch: () => Promise<T>, ttlMs = PATHS_TTL_MS, now: () => number = Date.now) {
  let value: T | null = null;
  let at = 0;
  let inflight: Promise<T> | null = null;
  return {
    /** The listing, from cache while fresh; concurrent callers share one request. `force` bypasses the cache. */
    get(force = false): Promise<T> {
      if (!force && value !== null && now() - at < ttlMs) return Promise.resolve(value);
      if (inflight) return inflight;
      const p = fetch().then((v) => { value = v; at = now(); return v; }).finally(() => { if (inflight === p) inflight = null; });
      inflight = p;
      return p;
    },
  };
}

/** Whether a visibility-triggered reload may run (at most once per `gapMs`). */
export function shouldReload(lastAt: number | null, now: number, gapMs = RELOAD_GAP_MS): boolean {
  return lastAt === null || now - lastAt >= gapMs;
}
