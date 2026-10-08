// The grant store: which interface (note id) the user has allowed to run with
// which needs (hash). Storage is injectable; a change of needs changes the
// hash, so the grant no longer matches and the user is asked again.

export const GRANTS_KEY = "uni.interface.grants.v1";
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Record_ = { hash: string; grantedAt: string };

export function createGrantStore(storage: StorageLike | null = typeof localStorage === "undefined" ? null : localStorage) {
  // Kept in memory too, so a failing or missing storage still works for this session.
  let memory: Record<string, Record_> | null = null;
  const read = (): Record<string, Record_> => {
    if (memory) return memory;
    let parsed: Record<string, Record_> = {};
    try {
      const v: unknown = JSON.parse(storage?.getItem(GRANTS_KEY) ?? "{}");
      if (v && typeof v === "object" && !Array.isArray(v)) {
        for (const [k, r] of Object.entries(v as Record<string, unknown>)) {
          const rec = r as { hash?: unknown; grantedAt?: unknown } | null;
          if (rec && typeof rec.hash === "string") parsed[k] = { hash: rec.hash, grantedAt: typeof rec.grantedAt === "string" ? rec.grantedAt : "" };
        }
      }
    } catch { parsed = {}; }
    return (memory = parsed);
  };
  const write = () => { try { storage?.setItem(GRANTS_KEY, JSON.stringify(memory ?? {})); } catch { /* session only */ } };
  return {
    isGranted(noteId: string, hash: string): boolean { return read()[noteId]?.hash === hash; },
    grant(noteId: string, hash: string): void { read()[noteId] = { hash, grantedAt: new Date().toISOString() }; write(); },
    revoke(noteId: string): void { delete read()[noteId]; write(); },
  };
}
export type GrantStore = ReturnType<typeof createGrantStore>;
