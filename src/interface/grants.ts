// The grant store: which applet (a sealed applet's note id, or `builtin:<id>` for one compiled in) the user has allowed to run, with
// the hash of what its needs RESOLVED to (prefixes, rooms, area) and the hash of
// its HTML (the hash the user last accepted). Storage is injectable. A different
// resolution is `none` (ask again). Only the HTML changing is `updated`: it runs,
// and the host says so until the user taps Accept (`acknowledge`), across restarts.
// A grant made on the card carries an expiry (grant2.ts `grantExpiry`); past it the record counts as `none` and the
// card comes back. A record from before the card has none and stays as it was.

export const GRANTS_KEY = "uni.interface.grants.v2";
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type GrantedUnder = "sealed" | "approved-code";
type Record_ = { scope: string; html: string; grantedAt: string; grantedUnder: GrantedUnder; expires?: string };
/** The subject a built-in applet's grant is stored under (a sealed applet's is its note id, which is never this shape). */
export const builtinSubject = (appletId: string) => `builtin:${appletId}`;
/** A built-in applet's code is the app's own: the release signature covers it, so its "HTML hash" is this constant. */
export const BUILTIN_CODE = "builtin";
export type GrantStatus = "none" | "ok" | "updated";

export function createGrantStore(storage: StorageLike | null = typeof localStorage === "undefined" ? null : localStorage, now: () => number = Date.now) {
  // Kept in memory too, so a failing or missing storage still works for this session.
  let memory: Map<string, Record_> | null = null;
  const read = (): Map<string, Record_> => {
    if (memory) return memory;
    const parsed = new Map<string, Record_>();
    try {
      const v: unknown = JSON.parse(storage?.getItem(GRANTS_KEY) ?? "{}");
      if (v && typeof v === "object" && !Array.isArray(v)) {
        for (const [k, r] of Object.entries(v as Record<string, unknown>)) {
          const rec = r as { scope?: unknown; html?: unknown; grantedAt?: unknown; grantedUnder?: unknown; expires?: unknown } | null;
          if (rec && typeof rec.scope === "string" && typeof rec.html === "string") parsed.set(k, { scope: rec.scope, html: rec.html, grantedAt: typeof rec.grantedAt === "string" ? rec.grantedAt : "", grantedUnder: rec.grantedUnder === "approved-code" ? "approved-code" : "sealed",
            // an expiry that can't be read is an expired one: never a grant with no end
            ...(rec.expires === undefined ? {} : { expires: typeof rec.expires === "string" && !isNaN(Date.parse(rec.expires)) ? rec.expires : new Date(0).toISOString() }) });
        }
      }
    } catch { parsed.clear(); }
    return (memory = parsed);
  };
  const write = () => { try { storage?.setItem(GRANTS_KEY, JSON.stringify(Object.fromEntries(read()))); } catch { /* session only */ } };
  return {
    status(noteId: string, scope: string, html: string): GrantStatus {
      const r = read().get(noteId);
      if (!r || r.scope !== scope || (r.expires !== undefined && Date.parse(r.expires) <= now())) return "none";
      return r.html === html ? "ok" : "updated";
    },
    /** When it was allowed and when it ends, for the card; null without a grant. */
    record(noteId: string): { grantedAt: string; expires: string | null } | null { const r = read().get(noteId); return r ? { grantedAt: r.grantedAt, expires: r.expires ?? null } : null; },
    /** The gate mode the grant was made under; a record without one (or with an unknown value) counts as `sealed`. */
    grantedUnder(noteId: string): GrantedUnder | null { return read().get(noteId)?.grantedUnder ?? null; },
    grant(noteId: string, scope: string, html: string, mode: GrantedUnder = "sealed", expires?: Date): void { read().set(noteId, { scope, html, grantedAt: new Date(now()).toISOString(), grantedUnder: mode, ...(expires ? { expires: expires.toISOString() } : {}) }); write(); },
    /** The user accepted the changed HTML: remember its hash. Never creates a grant. */
    acknowledge(noteId: string, html: string): void { const r = read().get(noteId); if (r) { r.html = html; write(); } },
    revoke(noteId: string): void { read().delete(noteId); write(); },
  };
}
export type GrantStore = ReturnType<typeof createGrantStore>;

let device: GrantStore | null = null;
/** This device's grants: one store for every host (a second one over the same storage would write over the first). */
export const deviceGrants = (): GrantStore => (device ??= createGrantStore());
