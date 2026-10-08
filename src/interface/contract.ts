// The interface contract, version 1: the only door between the host and a
// sealed interface (an area app, later others). Pure data in, data out: no
// React, no Tauri, no imports from the app, so it can be lifted into a package.
//
// Two envelopes cross the frame boundary, both validated here:
//   {uni:1, id, ns, method, params?}  → {uni:1, id, result} | {uni:1, id, error:{code,message}}
//   {pfr:1, channel:"vault", id, method, path, headers, body}  (frame-fetch; see modules/frameFetch.ts)
// and the host pushes events: {uni:1, event, data}.

export const CONTRACT_VERSION = 1;
export const NAMESPACES = ["vault", "chat", "note", "theme"] as const;
export type Namespace = (typeof NAMESPACES)[number];

/** Capabilities an interface can ask for in its manifest. */
export const CAPABILITIES = ["vault.read", "chat.read", "chat.draft"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const ERROR_CODES = {
  badRequest: "bad_request", badVersion: "bad_version", badParams: "bad_params", tooLarge: "too_large",
  unknownNamespace: "unknown_namespace", unknownMethod: "unknown_method", notGranted: "not_granted", outOfScope: "out_of_scope",
  rateLimited: "rate_limited", tooManyPending: "too_many_pending", failed: "failed",
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class ContractError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message?: string) { super(message ?? code); this.code = code; }
}

export const LIMITS = {
  /** Largest request, measured as a budgeted walk (no stringify of attacker data). */
  maxRequestBytes: 8 * 1024,
  maxPending: 8,
  maxRequests: 60,
  rateWindowMs: 10_000,
  maxDraft: 2000,
  maxRecent: 30,
  maxNotes: 50,
  maxPath: 2000,
  maxHeaders: 20,
  maxFetchBody: 4096,
};

export type UniRequest = { uni: 1; id: string; ns: string; method: string; params: Record<string, unknown> };
export type FrameFetchRequest = { pfr: 1; channel: "vault"; id: string; method: string; path: string; headers: Record<string, string>; body: string | null };
export type Envelope =
  | ({ kind: "uni" } & UniRequest)
  | ({ kind: "pfr" } & FrameFetchRequest)
  | { kind: "bad"; id: string | null; error: ErrorCode };

export type HostMessage =
  | { uni: 1; id: string; result: unknown }
  | { uni: 1; id: string; error: { code: ErrorCode; message: string } }
  | { uni: 1; event: string; data: unknown }
  | { pfr: 1; channel: "vault"; id: string; status: number; statusText: string; headers: Record<string, string>; body: string };

export const plain = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
export const hasOnly = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).every((k) => keys.includes(k));

/**
 * A cheap upper bound on the JSON size of a request, walked with a budget so a
 * huge array or string is refused without being stringified. Anything that is
 * not plain JSON data (class instances, Maps, functions) or nests deeper than
 * a request ever does is refused too.
 */
export function withinBudget(x: unknown, budget: { left: number }, depth = 0): boolean {
  if (depth > 6) return false;
  switch (typeof x) {
    case "string": budget.left -= x.length + 2; return budget.left >= 0;
    case "number": case "boolean": budget.left -= 8; return budget.left >= 0;
    case "undefined": return true;
    case "object": {
      if (x === null) return true;
      if (Array.isArray(x)) {
        for (let i = 0; i < x.length; i++) { budget.left -= 1; if (budget.left < 0 || !withinBudget(x[i], budget, depth + 1)) return false; }
        return true;
      }
      if (!plain(x)) return false;
      for (const k in x) { budget.left -= k.length + 3; if (budget.left < 0 || !withinBudget(x[k], budget, depth + 1)) return false; }
      return true;
    }
    default: return false;
  }
}

const UNI_KEYS = ["uni", "id", "ns", "method", "params"];
const PFR_KEYS = ["pfr", "channel", "id", "method", "path", "headers", "body"];
const idOf = (x: unknown) => (typeof x === "string" && x.length >= 1 && x.length <= 64 ? x : null);

/** Validate the envelope of one message from the frame. Never throws. */
export function parseEnvelope(raw: unknown): Envelope {
  if (!plain(raw)) return { kind: "bad", id: null, error: ERROR_CODES.badRequest };
  const id = idOf(raw.id);
  const bad = (error: ErrorCode): Envelope => ({ kind: "bad", id, error });
  if (!withinBudget(raw, { left: LIMITS.maxRequestBytes })) return bad(ERROR_CODES.tooLarge);
  if ("uni" in raw) {
    if (raw.uni !== CONTRACT_VERSION) return bad(ERROR_CODES.badVersion);
    if (id === null || !hasOnly(raw, UNI_KEYS) || typeof raw.ns !== "string" || typeof raw.method !== "string") return bad(ERROR_CODES.badRequest);
    if (raw.params !== undefined && !plain(raw.params)) return bad(ERROR_CODES.badParams);
    return { kind: "uni", uni: 1, id, ns: raw.ns, method: raw.method, params: (raw.params ?? {}) as Record<string, unknown> };
  }
  if ("pfr" in raw) {
    if (raw.pfr !== 1) return bad(ERROR_CODES.badVersion);
    if (id === null || !hasOnly(raw, PFR_KEYS) || raw.channel !== "vault" || typeof raw.method !== "string" || raw.method.length > 16) return bad(ERROR_CODES.badRequest);
    if (typeof raw.path !== "string" || !raw.path.startsWith("/") || raw.path.length > LIMITS.maxPath) return bad(ERROR_CODES.badRequest);
    if (!plain(raw.headers) || Object.keys(raw.headers).length > LIMITS.maxHeaders || !Object.values(raw.headers).every((v) => typeof v === "string")) return bad(ERROR_CODES.badRequest);
    if (raw.body !== null && (typeof raw.body !== "string" || raw.body.length > LIMITS.maxFetchBody)) return bad(ERROR_CODES.badRequest);
    return { kind: "pfr", pfr: 1, channel: "vault", id, method: raw.method, path: raw.path, headers: raw.headers as Record<string, string>, body: raw.body as string | null };
  }
  return bad(ERROR_CODES.badRequest);
}

/** Sliding-window limiter: at most `max` hits per `windowMs`. */
export class RateLimiter {
  private hits: number[] = [];
  private max: number;
  private windowMs: number;
  constructor(max: number = LIMITS.maxRequests, windowMs: number = LIMITS.rateWindowMs) { this.max = max; this.windowMs = windowMs; }
  take(now: number): boolean {
    this.hits = this.hits.filter((t) => now - t < this.windowMs);
    if (this.hits.length >= this.max) return false;
    this.hits.push(now);
    return true;
  }
}

/** Notes at `Areas/Foo.md` and `Areas/Foo` are the same note. */
export const stripExt = (path: string) => path.replace(/\.(md|html)$/i, "");

/**
 * A folder prefix that ends in `/`, with plain segments only: no `..`, `.`,
 * empty segments, backslashes, control characters or encoded separators/dots.
 */
export function safePrefix(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length < 2 || raw.length > 300 || !raw.endsWith("/")) return null;
  if (/[\u0000-\u001f\\]/.test(raw) || raw.startsWith("/") || /%/.test(raw)) return null;
  const segments = raw.slice(0, -1).split("/");
  return segments.some((s) => s === ".." || s === "." || s === "") ? null : raw;
}

/** Is `path` (extension ignored) strictly inside one of the folder `prefixes`? */
export function inScope(prefixes: readonly string[], path: string | null | undefined): boolean {
  if (typeof path !== "string" || !path || /[\u0000-\u001f\\]/.test(path)) return false;
  const p = stripExt(path);
  if (p.split("/").some((s) => s === ".." || s === "." || s === "")) return false;
  return prefixes.some((x) => p.startsWith(x) && p.length > x.length);
}
