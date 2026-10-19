// T-176: Uni's secret requests and receipts in chat. A request is an ordinary message from Uni ending in a fenced
// ```uni-secret-request JSON block; the app shows it as a card with a masked field, and the value goes to Rust
// (`send_secret`), which seals it (NIP-59) to the request's one-time key. Uni answers with ```uni-secret-stored,
// ```uni-secret-forgotten or ```uni-secret-refused blocks. On by default; localStorage "uni:secret-cards" =
// "off" turns the cards off (requests then show as plain messages). Same validation as `uni_core::secret::parse_request`.

export type SecretRequest = { v: 1; rid: string; name: string; label: string; purpose: string; store: string; keep_days: number; expires: number; rpk: string };
export type SecretReceipt = { state: "stored" | "forgotten" | "refused"; rid?: string; name?: string; until?: number; reason?: string };

export const SECRET_FLAG = "uni:secret-cards";
export const secretCardsOn = (): boolean => { try { return localStorage.getItem(SECRET_FLAG) !== "off"; } catch { return true; } };

const FENCE = /```(uni-secret-(?:request|stored|forgotten|refused))\n([^\n]*)\n```\s*$/;
const hex = (s: unknown, n: number) => typeof s === "string" && s.length === n && /^[0-9a-f]+$/.test(s);
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function block(body: string): { lang: string; data: Record<string, unknown> } | null {
  const m = FENCE.exec(body);
  if (!m) return null;
  try {
    const data = JSON.parse(m[2]);
    return data && typeof data === "object" && !Array.isArray(data) ? { lang: m[1], data } : null;
  } catch { return null; }
}

export function parseSecretRequest(body: string): SecretRequest | null {
  const b = block(body);
  if (!b || b.lang !== "uni-secret-request") return null;
  const r = b.data as Partial<SecretRequest>;
  const len = (s: unknown, max: number) => typeof s === "string" && [...s].length <= max;
  const ok = r.v === 1 && hex(r.rid, 32) && typeof r.name === "string" && NAME.test(r.name) && hex(r.rpk, 64)
    && typeof r.label === "string" && r.label.trim() !== "" && len(r.label, 80) && len(r.purpose, 280) && len(r.store, 200)
    && Number.isInteger(r.keep_days) && r.keep_days! >= 1 && r.keep_days! <= 365 && Number.isInteger(r.expires);
  return ok ? (r as SecretRequest) : null;
}

export function parseSecretReceipt(body: string): SecretReceipt | null {
  const b = block(body);
  if (!b || b.lang === "uni-secret-request") return null;
  const d = b.data;
  const state = b.lang.slice("uni-secret-".length) as SecretReceipt["state"];
  return { state, rid: typeof d.rid === "string" ? d.rid : undefined, name: typeof d.name === "string" ? d.name : undefined,
    until: typeof d.until === "number" ? d.until : undefined, reason: typeof d.reason === "string" ? d.reason : undefined };
}

/** The message text without its machine block (the human lines Uni wrote above it). */
export const withoutSecretBlock = (body: string): string => body.replace(FENCE, "").trimEnd();

/**
 * What became of each request, from receipts by the same author: rid → latest receipt. A forget names only the
 * secret, so it applies to the latest stored request with that name.
 */
export function receiptsByRequest(messages: { author: string; body: string; ts: number }[]): Map<string, SecretReceipt> {
  const out = new Map<string, SecretReceipt>();
  const lastStoredByName = new Map<string, string>();
  const byAuthor = (a: string) => `${a}:`;
  for (const m of [...messages].sort((a, b) => a.ts - b.ts)) {
    const r = parseSecretReceipt(m.body);
    if (!r) continue;
    const rid = r.rid ?? (r.name ? lastStoredByName.get(byAuthor(m.author) + r.name) : undefined);
    if (!rid) continue;
    out.set(byAuthor(m.author) + rid, r);
    if (r.state === "stored" && r.name) lastStoredByName.set(byAuthor(m.author) + r.name, rid);
  }
  return out;
}
export const receiptFor = (receipts: Map<string, SecretReceipt>, author: string, rid: string) => receipts.get(`${author}:${rid}`);

/** "3f9a 1c2e 77b0 4d19": the first 16 hex (64 bits) of a key, grouped. Short enough to read out, too long to grind
 *  a look-alike key for (8 hex would be 2^32 tries). */
export const fingerprint = (pubkey: string): string => (pubkey.slice(0, 16).match(/.{4}/g) ?? []).join(" ");
