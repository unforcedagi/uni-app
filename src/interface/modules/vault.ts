// vault module: a REST subset compatible with surface-client's VaultClient,
// served over the frame. Every read is checked against the granted
// `vault.read` path prefixes, and so is every note that comes back (whatever
// key it was looked up by), so search, tag and id lookups can't leak.
//   GET   /api/vault
//   GET   /api/notes?path_prefix&tag&search&limit&id&path&include_content
//   GET   /api/notes/:idOrPath
// Two writes, only for a grant that names them (a contract 2 sealed manifest):
//   POST  /api/notes            {path, content}            a new note, its path inside a `vault.create` folder
//   PATCH /api/notes/:idOrPath  {content, if_updated_at}   new content for a note inside a `vault.update` folder
// A write sets content only (no tags, metadata, links, move or force: the shell's writer takes none), never touches an
// HTML note or a note tagged `applet` (an applet can't rewrite itself or another), and is judged on the note as it is
// read now. A session that has ended writes nothing.

import { ContractError, ERROR_CODES, hasHidden, hasOnly, inScope, LIMITS, plain, safePrefix, type ErrorCode } from "../contract.ts";
import type { CallCtx, UniModule } from "../router.ts";
import type { Resolved } from "../manifest.ts";
import type { FetchResult } from "./frameFetch.ts";

export type PathRow = { id: string; path: string | null; extension?: string | null; updatedAt?: string | null };
export type VaultNote = { id: string; path?: string | null; extension?: string | null; content?: string | null; tags?: string[] | null; metadata?: Record<string, unknown> | null; createdAt?: string | null; updatedAt?: string | null };
export type VaultDeps = {
  listPaths(): Promise<PathRow[]>;
  /** By id or path; rejects when missing. */
  getNote(ref: string): Promise<VaultNote>;
  search(query: string, limit: number, pathPrefix: string | null): Promise<{ id: string; path: string | null; snippet: string }[]>;
  /** A new note at `path` (refused when one is there). Absent: the host can't write, and every write is 405. */
  create?(path: string, content: string): Promise<VaultNote>;
  /** New content for the note `id`, only if it is still at `ifUpdatedAt`; a rejection whose message starts "conflict:" is a conflict. */
  save?(id: string, content: string, ifUpdatedAt: string): Promise<VaultNote>;
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
const fail = (status: number, code: ErrorCode | "not_found" | "method_not_allowed" | "conflict") => json(status, code, { error: code });
const notFound = () => fail(404, "not_found");
const safeRef = (ref: string) => ref.length > 0 && ref.length <= 300 && !/[\u0000-\u001f\\]/.test(ref) && !ref.split("/").some((s) => s === ".." || s === ".");
/** A path a write may name: plain segments (inScope checks those), no hidden character, no encoded dot or slash, not an HTML file. */
const writablePath = (p: unknown): p is string => typeof p === "string" && p.length <= 300 && !hasHidden(p) && !/%(?:2e|2f|5c|25)/i.test(p)
  && !/\.html?$/i.test(p) && p.trim() === p && !p.split("/").some((s) => s.trim() !== s);
/** A note no applet may change: an HTML note (an applet's code) or one tagged `applet`. */
const isAppletCode = (n: VaultNote) => /\.html?$/i.test(n.path ?? "") || n.extension?.replace(/^\./, "").toLowerCase() === "html"
  || (n.tags ?? []).some((t) => t === "applet" || t.startsWith("applet/"));
const bodyOf = (raw: string | null, keys: readonly string[], required: readonly string[]): Record<string, string> | null => {
  if (raw === null) return null;
  let b: unknown;
  try { b = JSON.parse(raw); } catch { return null; }
  if (!plain(b) || !hasOnly(b, keys) || !required.every((k) => k in b) || !Object.values(b).every((v) => typeof v === "string")) return null;
  return b as Record<string, string>;
};

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
        ctx.charge(1);
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

  const forget = (...refs: (string | null | undefined)[]) => { for (const r of refs) if (r) cache.delete(r); };

  /** POST /api/notes {path, content}: a new note inside a folder the grant lets it add to. */
  async function create(body: string | null, scopes: Resolved, ctx: CallCtx): Promise<FetchResult> {
    const folders = scopes["vault.create"] ?? [];
    if (!folders.length || !deps.create) return fail(403, "not_granted");
    const b = bodyOf(body, ["path", "content"], ["path", "content"]);
    if (!b || !writablePath(b.path)) return fail(400, "bad_params");
    if (!inScope(folders, b.path)) return fail(403, "out_of_scope");
    if (ctx.closed()) return fail(502, "failed");
    ctx.charge(1);
    try {
      const note = await deps.create(b.path, b.content);
      forget(note.id, note.path, b.path);
      return json(201, "Created", publicNote({ ...note, path: note.path ?? b.path }, false));
    } catch (e) {
      if (e instanceof ContractError) throw e;
      return /exist|conflict/i.test(String(e)) ? fail(409, "conflict") : fail(502, "failed");
    }
  }

  /** PATCH /api/notes/:ref {content, if_updated_at}: new content for a note inside a folder the grant lets it change, judged on the note as read now. */
  async function update(ref: string, body: string | null, scopes: Resolved, ctx: CallCtx): Promise<FetchResult> {
    const folders = scopes["vault.update"] ?? [];
    if (!folders.length || !deps.save) return fail(403, "not_granted");
    const b = bodyOf(body, ["content", "if_updated_at"], ["content", "if_updated_at"]);
    if (!b || !b.if_updated_at) return fail(400, "bad_params");
    if (!safeRef(ref)) return notFound();
    ctx.charge(1);
    let note: VaultNote;
    try { note = await deps.getNote(ref); } catch (e) { if (e instanceof ContractError) throw e; return notFound(); }
    // a note it can't even read is absent (no existence oracle); one it reads but may not change is refused
    if (!inScope(folders, note.path) || isAppletCode(note)) return inScope(scopes["vault.read"] ?? [], note.path) ? fail(403, "out_of_scope") : notFound();
    if (ctx.closed()) return fail(502, "failed");
    try {
      const saved = await deps.save(note.id, b.content, b.if_updated_at);
      forget(ref, note.id, note.path, saved.id, saved.path);
      return json(200, "OK", publicNote({ ...saved, path: saved.path ?? note.path }, false));
    } catch (e) {
      if (e instanceof ContractError) throw e;
      return /^(error:\s*)?conflict:/i.test(String(e)) ? fail(409, "conflict") : fail(502, "failed");
    }
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
          if (req.method !== "GET" && req.method !== "POST" && req.method !== "PATCH") return fail(405, "method_not_allowed");
          if (!req.path.startsWith("/") || req.path.startsWith("//") || /[\\\u0000-\u001f]/.test(req.path)) return fail(400, "bad_request" as ErrorCode);
          const cut = req.path.indexOf("?");
          const pathname = cut < 0 ? req.path : req.path.slice(0, cut);
          const query = new URLSearchParams(cut < 0 ? "" : req.path.slice(cut + 1));
          try {
            const only = (allowed: string[]) => [...query.keys()].every((k) => allowed.includes(k));
            if (req.method === "POST") return pathname === "/api/notes" && only([]) ? await create(req.body, scopes, ctx) : fail(405, "method_not_allowed");
            if (req.method === "PATCH") {
              const rest = pathname.startsWith("/api/notes/") ? pathname.slice("/api/notes/".length) : "";
              if (!rest || rest.includes("/") || !only([])) return fail(405, "method_not_allowed");
              let ref: string;
              try { ref = decodeURIComponent(rest); } catch { return fail(400, "bad_request" as ErrorCode); }
              return await update(ref, req.body, scopes, ctx);
            }
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
