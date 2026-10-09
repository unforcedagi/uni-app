// vault module: a read-only REST subset compatible with surface-client's
// VaultClient, served over the frame. Every request is checked against the
// granted `vault.read` path prefixes, and so is every note that comes back
// (whatever key it was looked up by), so search, tag and id lookups can't leak.
//   GET /api/vault
//   GET /api/notes?path_prefix&tag&search&limit&id&path&include_content
//   GET /api/notes/:idOrPath

import { ContractError, ERROR_CODES, inScope, LIMITS, safePrefix, type ErrorCode } from "../contract.ts";
import type { CallCtx, UniModule } from "../router.ts";
import type { FetchResult } from "./frameFetch.ts";

export type PathRow = { id: string; path: string | null; extension?: string | null; updatedAt?: string | null };
export type VaultNote = { id: string; path?: string | null; content?: string | null; tags?: string[] | null; metadata?: Record<string, unknown> | null; createdAt?: string | null; updatedAt?: string | null };
export type VaultDeps = {
  listPaths(): Promise<PathRow[]>;
  /** By id or path; rejects when missing. */
  getNote(ref: string): Promise<VaultNote>;
  search(query: string, limit: number, pathPrefix: string | null): Promise<{ id: string; path: string | null; snippet: string }[]>;
};
type FetchParams = { method: string; path: string; headers: Record<string, string>; body: string | null };

const MAX_BODY = 512 * 1024;
const NOTE_TTL_MS = 10_000;
const CACHE_MAX = 40;
const CACHE_MAX_CONTENT = 200_000;
const NOTES_PARAMS = ["path_prefix", "tag", "search", "limit", "id", "path", "include_content"];
const NOTE_PARAMS = ["include_content"];
const VAULT_PARAMS = ["include_stats"];
const json = (status: number, statusText: string, data: unknown): FetchResult => {
  const body = JSON.stringify(data);
  return body.length > MAX_BODY
    ? { status: 413, statusText: "too_large", headers: { "content-type": "application/json" }, body: '{"error":"too_large"}' }
    : { status, statusText, headers: { "content-type": "application/json" }, body };
};
const fail = (status: number, code: ErrorCode | "not_found" | "method_not_allowed") => json(status, code, { error: code });
const notFound = () => fail(404, "not_found");
const safeRef = (ref: string) => ref.length > 0 && ref.length <= 300 && !/[\u0000-\u001f\\]/.test(ref) && !ref.split("/").some((s) => s === ".." || s === ".");

const publicNote = (n: VaultNote, content: boolean) => {
  const out: Record<string, unknown> = { id: n.id, path: n.path ?? null, createdAt: n.createdAt ?? null, updatedAt: n.updatedAt ?? null, tags: n.tags ?? [], metadata: n.metadata ?? {} };
  if (content) out.content = n.content ?? "";
  return out;
};

export function createVaultModule(deps: VaultDeps, opts: { now?: () => number } = {}): UniModule {
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; note: VaultNote }>();
  const remember = (key: string, note: VaultNote) => {
    cache.delete(key);
    cache.set(key, { at: now(), note });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  };
  /** Notes by ref, cached 10 s. Each underlying read costs one limiter token; a cache hit is free. */
  async function getNote(ref: string, ctx: CallCtx): Promise<VaultNote> {
    const hit = cache.get(ref);
    if (hit && now() - hit.at < NOTE_TTL_MS) return hit.note;
    ctx.charge(1);
    const note = await deps.getNote(ref);
    if ((note.content?.length ?? 0) <= CACHE_MAX_CONTENT) { remember(ref, note); if (note.id && note.id !== ref) remember(note.id, note); }
    return note;
  }

  async function lookup(ref: string, prefixes: string[], content: boolean, ctx: CallCtx) {
    if (!safeRef(ref)) return null;
    let note: VaultNote;
    try { note = await getNote(ref, ctx); } catch (e) { if (e instanceof ContractError) throw e; return null; }
    // Scope is judged on the note we got back, not on the key it was asked for by.
    return inScope(prefixes, note.path) ? publicNote(note, content) : null;
  }

  async function notes(q: URLSearchParams, granted: string[], ctx: CallCtx): Promise<FetchResult> {
    for (const k of q.keys()) if (!NOTES_PARAMS.includes(k)) return fail(400, "bad_params");
    let prefixes = granted;
    const asked = q.get("path_prefix");
    if (asked) {
      const sp = safePrefix(asked);
      if (!sp || !granted.some((g) => sp.startsWith(g))) return fail(403, "out_of_scope");
      prefixes = [sp];
    }
    const rawLimit = q.get("limit");
    let limit: number = LIMITS.maxNotes;
    if (rawLimit !== null) {
      if (!/^\d{1,9}$/.test(rawLimit) || Number(rawLimit) < 1) return fail(400, "bad_params");
      limit = Math.min(LIMITS.maxNotes, Number(rawLimit));
    }
    const content = q.get("include_content") === "true";

    const key = q.get("id") ?? q.get("path");
    if (key !== null) {
      const n = await lookup(key, prefixes, content, ctx);
      return json(200, "OK", n ? [n] : []);
    }

    const tag = q.get("tag")?.replace(/^#/, "") || null;
    const search = q.get("search");
    let rows: { id: string; path: string; updatedAt?: string | null }[];
    if (search) {
      if (search.length > 500) return fail(400, "bad_params");
      const seen = new Set<string>();
      rows = [];
      for (const p of prefixes) {
        for (const h of await deps.search(search, limit, p)) {
          if (h.path && inScope(prefixes, h.path) && !seen.has(h.id)) { seen.add(h.id); rows.push({ id: h.id, path: h.path }); }
        }
      }
    } else {
      rows = (await deps.listPaths())
        .filter((r): r is PathRow & { path: string } => !!r.path && inScope(prefixes, r.path) && (r.extension ?? "").toLowerCase().replace(/^\./, "") !== "html")
        .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.path.localeCompare(b.path));
    }
    if (tag || content) {
      // Tags and bodies need the notes themselves (the Tauri vault commands expose no tag filter, so
      // this is a bounded scan): read at most maxScan, charge each read, judge scope again on what comes back.
      const out: Record<string, unknown>[] = [];
      for (const r of rows.slice(0, LIMITS.maxScan)) {
        if (out.length >= limit) break;
        let note: VaultNote;
        try { note = await getNote(r.id, ctx); } catch (e) { if (e instanceof ContractError) throw e; continue; }
        if (!inScope(prefixes, note.path) || (tag && !(note.tags ?? []).includes(tag))) continue;
        out.push(publicNote(note, content));
      }
      return json(200, "OK", out);
    }
    return json(200, "OK", rows.slice(0, limit).map((r) => ({ id: r.id, path: r.path, updatedAt: r.updatedAt ?? null })));
  }

  return {
    namespace: "vault",
    methods: {
      fetch: {
        cap: "vault.read",
        validate: (p: unknown) => {
          const o = p as FetchParams | null;
          return o && typeof o === "object" && typeof o.method === "string" && typeof o.path === "string" ? { ok: true, value: o } : { ok: false };
        },
        async run(req: FetchParams, scopes, ctx) {
          const granted = scopes["vault.read"] ?? [];
          if (req.method !== "GET") return fail(405, "method_not_allowed");
          if (!req.path.startsWith("/") || req.path.startsWith("//") || /[\\\u0000-\u001f]/.test(req.path)) return fail(400, "bad_request" as ErrorCode);
          const cut = req.path.indexOf("?");
          const pathname = cut < 0 ? req.path : req.path.slice(0, cut);
          const query = new URLSearchParams(cut < 0 ? "" : req.path.slice(cut + 1));
          try {
            const only = (allowed: string[]) => [...query.keys()].every((k) => allowed.includes(k));
            if (pathname === "/api/vault") return only(VAULT_PARAMS) ? json(200, "OK", { name: "uni", scope: granted }) : fail(400, "bad_params");
            if (pathname === "/api/notes") return await notes(query, granted, ctx);
            if (pathname.startsWith("/api/notes/")) {
              const rest = pathname.slice("/api/notes/".length);
              if (!rest || rest.includes("/")) return notFound();
              let ref: string;
              try { ref = decodeURIComponent(rest); } catch { return fail(400, "bad_request" as ErrorCode); }
              if (!only(NOTE_PARAMS)) return fail(400, "bad_params");
              const n = await lookup(ref, granted, true, ctx);
              return n ? json(200, "OK", n) : notFound();
            }
            return notFound();
          } catch (e) {
            if (e instanceof ContractError && e.code === ERROR_CODES.rateLimited) return fail(429, "rate_limited");
            return fail(502, "failed");
          }
        },
      },
    },
  };
}
