// Area apps (pure, unit-tested in scripts/areasCore.test.ts). Parses area
// notes, scopes paths, builds the sealed frame's srcdoc and validates bridge
// requests. No React, no Tauri: everything here is data in, data out.

export const AREAS_ROOT = "Areas";
export type AreaStatus = "foreground" | "background";
export type Area = {
  id: string; path: string; name: string; purpose: string; status: AreaStatus;
  channels: string[]; since: string | null; title: string; body: string;
  metadata: Record<string, unknown>; updatedAt: string | null;
};
export type AreaNoteLike = { id: string; path?: string | null; content?: string | null; tags?: string[] | null; metadata?: Record<string, unknown> | null; updatedAt?: string | null };
export type PathRow = { id: string; path: string | null; extension?: string | null; updatedAt?: string | null };

const leaf = (path: string) => path.split("/").filter(Boolean).pop() ?? path;
const stripExt = (path: string) => path.replace(/\.(md|html)$/i, "");

/** `Areas/<Name>` (one level, markdown or extensionless) — never `Areas/<Name>/app` or deeper. */
export function isAreaPath(path: string | null | undefined): boolean {
  return !!path && /^Areas\/[^/]+$/.test(stripExt(path)) && !/\.html$/i.test(path);
}

export function splitChannels(value: unknown): string[] {
  const parts = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(parts.map((p) => (typeof p === "string" ? p.trim() : "")).filter(Boolean))];
}

/** First paragraph after the H1 (front matter skipped), markdown punctuation stripped. */
export function purposeOf(content: string): string {
  const body = content.replace(/^\s*---\n[\s\S]*?\n---\n/, "");
  const blocks = body.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  for (const block of blocks) {
    if (/^#{1,6}\s/.test(block) && !block.includes("\n")) continue;
    const lines = block.split("\n").filter((l) => !/^#{1,6}\s/.test(l));
    const text = lines.join(" ").replace(/!?\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_m, a, b) => b || a)
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`>]/g, "").replace(/\s+/g, " ").trim();
    if (text) return text.slice(0, 400);
  }
  return "";
}

export function titleOf(content: string, fallback: string): string {
  return /^\s*#\s+(.+?)\s*#*\s*$/m.exec(content)?.[1]?.trim() || fallback;
}

/** An area note → Area, or null when it isn't a tagged `Areas/<Name>` note. */
export function parseArea(note: AreaNoteLike): Area | null {
  const path = note.path ? stripExt(note.path) : "";
  if (!isAreaPath(note.path) || !(note.tags ?? []).includes("area")) return null;
  const metadata = note.metadata ?? {};
  const content = note.content ?? "";
  const name = leaf(path);
  return {
    id: note.id, path, name, purpose: purposeOf(content),
    status: metadata.status === "foreground" ? "foreground" : "background",
    channels: splitChannels(metadata.channel),
    since: typeof metadata.since === "string" ? metadata.since : null,
    title: titleOf(content, name), body: content, metadata, updatedAt: note.updatedAt ?? null,
  };
}

/** Foreground first, then by name. */
export function sortAreas(areas: Area[]): Area[] {
  const rank = (a: Area) => (a.status === "foreground" ? 0 : 1);
  return [...areas].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.name.localeCompare(b.name));
}

export const appPathOf = (areaPath: string) => `${stripExt(areaPath)}/app`;

/** The area's app note in a path listing: `Areas/<Name>/app` with extension html. */
export function findAppRow(rows: PathRow[], areaPath: string): PathRow | null {
  const want = appPathOf(areaPath);
  return rows.find((r) => !!r.path && stripExt(r.path) === want && (r.extension ?? (/\.html$/i.test(r.path ?? "") ? "html" : "")).toLowerCase().replace(/^\./, "") === "html") ?? null;
}

/**
 * Normalise a note path that must live under `Areas/<Name>/`. Returns the
 * clean path, or null for `..`/`.` segments, absolute or backslash paths,
 * encoded dots, control characters, other areas, or the area's own folder.
 */
export function scopedPath(areaPath: string, raw: unknown): string | null {
  if (typeof raw !== "string" || !raw || raw.length > 300) return null;
  if (/[\u0000-\u001f\\]/.test(raw) || raw.startsWith("/") || /%2e|%2f|%5c/i.test(raw)) return null;
  const segments = raw.split("/");
  if (segments.some((s) => s === ".." || s === "." || s === "")) return null;
  const clean = segments.join("/");
  const prefix = `${stripExt(areaPath)}/`;
  return clean.startsWith(prefix) && clean.length > prefix.length ? clean : null;
}

export type NoteRow = { path: string; title: string; updatedAt: string | null };
/** Notes under `Areas/<Name>/` (the app note excluded), newest first. */
export function areaNotes(rows: PathRow[], areaPath: string, limit: number): NoteRow[] {
  const prefix = `${stripExt(areaPath)}/`;
  const app = appPathOf(areaPath);
  return rows.filter((r) => !!r.path && r.path.startsWith(prefix) && stripExt(r.path) !== app)
    .map((r) => ({ path: stripExt(r.path!), title: leaf(stripExt(r.path!)), updatedAt: r.updatedAt ?? null }))
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.path.localeCompare(b.path))
    .slice(0, Math.max(1, Math.min(50, Math.floor(limit) || 50)));
}

// ---------------------------------------------------------------- the frame

export const AREA_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${AREA_CSP}">`;

/**
 * The srcdoc for an area app. The CSP meta is the first thing in the document,
 * so the policy applies before any app markup or script. A leading doctype is
 * dropped (ours replaces it); the parser puts the meta in an implicit <head>
 * and merges the app's own <html>/<head> tags after it. `headExtra` (the host
 * fonts) goes after the meta.
 */
export function buildSrcdoc(html: string, headExtra = ""): string {
  const body = html.replace(/^﻿/, "").replace(/^\s*<!doctype[^>]*>/i, "");
  return `<!doctype html>${CSP_META}${headExtra}${body}`;
}

// ---------------------------------------------------------------- the bridge

export const BRIDGE_VERSION = 1;
export const MAX_REQUEST_BYTES = 8 * 1024;
export const MAX_PENDING = 8;
export const MAX_REQUESTS = 60;
export const RATE_WINDOW_MS = 10_000;
export const MAX_COMPOSE = 2000;
export const BRIDGE_METHODS = ["area.get", "notes.list", "note.get", "channel.recent", "channel.compose", "note.open"] as const;
export type BridgeMethod = (typeof BRIDGE_METHODS)[number];

export type BridgeCall =
  | { method: "area.get" }
  | { method: "notes.list"; limit: number }
  | { method: "note.get"; path: string }
  | { method: "channel.recent"; limit: number }
  | { method: "channel.compose"; text: string }
  | { method: "note.open"; ref: string };

export type Validated = { ok: true; id: string; call: BridgeCall } | { ok: false; id: string | null; error: string };

const REQUEST_KEYS = new Set(["bridge", "id", "method", "params"]);
const plain = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
const hasOnly = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));

function limitOf(params: Record<string, unknown>, max: number, dflt: number): number | null {
  if (params.limit === undefined) return dflt;
  const n = params.limit;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= max ? n : null;
}

/** Validate the envelope and the params of one request. Never throws. */
export function validateRequest(raw: unknown): Validated {
  if (!plain(raw)) return { ok: false, id: null, error: "bad_request" };
  const id = typeof raw.id === "string" && raw.id.length >= 1 && raw.id.length <= 64 ? raw.id : null;
  const bad = (error: string): Validated => ({ ok: false, id, error });
  let size = Infinity;
  try { size = JSON.stringify(raw)?.length ?? Infinity; } catch { /* cyclic or unserialisable */ }
  if (size > MAX_REQUEST_BYTES) return bad("too_large");
  if (raw.bridge !== BRIDGE_VERSION) return bad("bad_version");
  if (id === null) return bad("bad_id");
  if (!Object.keys(raw).every((k) => REQUEST_KEYS.has(k)) || typeof raw.method !== "string") return bad("bad_request");
  if (raw.params !== undefined && !plain(raw.params)) return bad("bad_params");
  const params = (raw.params ?? {}) as Record<string, unknown>;
  const ok = (call: BridgeCall): Validated => ({ ok: true, id, call });
  switch (raw.method) {
    case "area.get":
      return hasOnly(params, []) ? ok({ method: "area.get" }) : bad("bad_params");
    case "notes.list": case "channel.recent": {
      const max = raw.method === "notes.list" ? 50 : 30;
      const limit = limitOf(params, max, max);
      return hasOnly(params, ["limit"]) && limit !== null ? ok({ method: raw.method, limit }) : bad("bad_params");
    }
    case "note.get":
      return hasOnly(params, ["path"]) && typeof params.path === "string" ? ok({ method: "note.get", path: params.path }) : bad("bad_params");
    case "channel.compose":
      return hasOnly(params, ["text"]) && typeof params.text === "string" && params.text.trim().length > 0 && params.text.length <= MAX_COMPOSE
        ? ok({ method: "channel.compose", text: params.text }) : bad("bad_params");
    case "note.open":
      return hasOnly(params, ["ref"]) && typeof params.ref === "string" && params.ref.trim().length > 0 && params.ref.length <= 300 && !/[\u0000-\u001f]/.test(params.ref)
        ? ok({ method: "note.open", ref: params.ref.trim() }) : bad("bad_params");
    default:
      return bad("unknown_method");
  }
}

/** Sliding-window limiter: at most `max` hits per `windowMs`. */
export class RateLimiter {
  private hits: number[] = [];
  private max: number;
  private windowMs: number;
  constructor(max = MAX_REQUESTS, windowMs = RATE_WINDOW_MS) { this.max = max; this.windowMs = windowMs; }
  take(now: number): boolean {
    this.hits = this.hits.filter((t) => now - t < this.windowMs);
    if (this.hits.length >= this.max) return false;
    this.hits.push(now);
    return true;
  }
}

export type ThemeData = { text: string; muted: string; accent: string; surface: string; line: string; sans: string; serif: string; mono: string };
