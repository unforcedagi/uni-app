// The grant store: which interface (note id) the user has allowed to run, with
// the hash of what its needs RESOLVED to (prefixes, rooms, area) and the hash of
// its HTML. Storage is injectable. A different resolution is `none` (ask
// again). Only the HTML changing is `updated`: it runs, and the host says so.

export const GRANTS_KEY = "uni.interface.grants.v2";
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Record_ = { scope: string; html: string; grantedAt: string };
export type GrantStatus = "none" | "ok" | "updated";

export function createGrantStore(storage: StorageLike | null = typeof localStorage === "undefined" ? null : localStorage) {
  // Kept in memory too, so a failing or missing storage still works for this session.
  let memory: Map<string, Record_> | null = null;
  const read = (): Map<string, Record_> => {
    if (memory) return memory;
    const parsed = new Map<string, Record_>();
    try {
      const v: unknown = JSON.parse(storage?.getItem(GRANTS_KEY) ?? "{}");
      if (v && typeof v === "object" && !Array.isArray(v)) {
        for (const [k, r] of Object.entries(v as Record<string, unknown>)) {
          const rec = r as { scope?: unknown; html?: unknown; grantedAt?: unknown } | null;
          if (rec && typeof rec.scope === "string" && typeof rec.html === "string") parsed.set(k, { scope: rec.scope, html: rec.html, grantedAt: typeof rec.grantedAt === "string" ? rec.grantedAt : "" });
        }
      }
    } catch { parsed.clear(); }
    return (memory = parsed);
  };
  const write = () => { try { storage?.setItem(GRANTS_KEY, JSON.stringify(Object.fromEntries(read()))); } catch { /* session only */ } };
  return {
    status(noteId: string, scope: string, html: string): GrantStatus {
      const r = read().get(noteId);
      return !r || r.scope !== scope ? "none" : r.html === html ? "ok" : "updated";
    },
    grant(noteId: string, scope: string, html: string): void { read().set(noteId, { scope, html, grantedAt: new Date().toISOString() }); write(); },
    /** Record the HTML the user has now been told about, keeping the scope grant. */
    touch(noteId: string, html: string): void { const r = read().get(noteId); if (r) { r.html = html; write(); } },
    revoke(noteId: string): void { read().delete(noteId); write(); },
  };
}
export type GrantStore = ReturnType<typeof createGrantStore>;
