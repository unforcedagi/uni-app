// T-234: Uni's approval card and morning card (uni-ops CARD.md §2–5; the morning fence is CONTRACT-CHANGES.md P2). Rust
// checks every card from its signed event (`sealed_card`) and answers it (`sealed_answer`); the card draws only from the
// view Rust returns, never from the message text. Pure helpers here (unit-tested in scripts/sealedCardCore.test.ts).

export type SealedClass = "routine" | "powerful";
export type SealedAnswer = { decision: "approve" | "deny"; at: number; until: number | null; sent: boolean };
export type SealedRow = {
  rid: string; action: string; credential: string; class: SealedClass; scope: string; ttl_s: number; uses: number;
  payload: unknown; request_digest: string; expires: number; answer: SealedAnswer | null;
};
export type SealedCardView = { kind: "single" | "morning" | null; event_id: string; refused: string | null; rows: SealedRow[] };
/** A card waiting for a tap in some room (`sealed_waiting`), for Needs you. */
export type SealedWaiting = {
  ref: string; channel: string; root: string | null; ts: number; kind: "single" | "morning";
  credential: string | null; action: string | null; class: SealedClass; rows: number; expires: number; fingerprint: string;
};

/** Tells the Needs you list to read again after an answer. */
export const SEALED_CHANGED = "uni:sealed-changed";

const FENCE = /```(uni-sealed-approval|uni-sealed-morning)\n/;

/** Which card a message carries, unverified (as `sealed_card::card_kind`): where to draw a card; Rust decides what it is. */
export function sealedFence(body: string): "single" | "morning" | null {
  if (body.includes("```uni-sealed-approval\n")) return "single";
  return body.includes("```uni-sealed-morning\n") ? "morning" : null;
}

/** The words Uni wrote above the fenced block: the room shows the first line as an ordinary message, never inside the card. */
export function sealedProse(body: string): string {
  const at = body.search(FENCE);
  return (at < 0 ? body : body.slice(0, at)).trim().split("\n")[0] ?? "";
}

/** "45 s", "10 min", "14 h" (CARD.md §4: seconds under 2 minutes, minutes under 2 hours, hours above). */
export function span(ttl: number): string {
  if (ttl < 120) return `${ttl} s`;
  if (ttl < 7200) return `${Math.floor(ttl / 60)} min`;
  return `${Number((ttl / 3600).toPrecision(6))} h`;
}

/** "10 min, 1 use": always with the use count. */
export const windowText = (ttl: number, uses: number): string => `${span(ttl)}, ${uses} use${uses === 1 ? "" : "s"}`;

/** "9b13 b2ae": the first 8 hex digits of the request digest, the fingerprint Uni can quote in chat. */
export const jobFingerprint = (digest: string): string => `${digest.slice(0, 4)} ${digest.slice(4, 8)}`;

/** Longer values are cut with "more". */
export const PAYLOAD_SHORT = 64;

/** The payload's top-level entries as text (never markdown or HTML; URLs stay text). `child_ttl_s: null` reads "permanent". */
export function payloadEntries(payload: unknown): { key: string; text: string; long: boolean }[] {
  if (payload === null || payload === undefined) return [];
  const show = (k: string, v: unknown) => (k === "child_ttl_s" && v === null ? "permanent" : typeof v === "string" ? v : JSON.stringify(v));
  const entries: [string, unknown][] = typeof payload === "object" && !Array.isArray(payload) ? Object.entries(payload as Record<string, unknown>) : [["", payload]];
  return entries.map(([key, v]) => { const text = show(key, v); return { key, text, long: [...text].length > PAYLOAD_SHORT }; });
}

/** The cut form of a long value. */
export const shortText = (text: string): string => [...text].slice(0, PAYLOAD_SHORT - 1).join("") + "…";

/** A mint's child token: permanent (`child_ttl_s: null`) or short-lived; null when the request isn't a mint. */
export function childToken(row: Pick<SealedRow, "action" | "payload">): { permanent: boolean; ttl: number | null } | null {
  if (row.action !== "mint.cloudflare" || !row.payload || typeof row.payload !== "object" || Array.isArray(row.payload)) return null;
  const t = (row.payload as Record<string, unknown>).child_ttl_s;
  if (t === null) return { permanent: true, ttl: null };
  return typeof t === "number" ? { permanent: false, ttl: t } : null;
}

/** A plain-text field of the payload the card names on its own row (a mint's purpose and destination). */
export function payloadField(row: Pick<SealedRow, "payload">, key: string): string | null {
  const p = row.payload;
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const v = (p as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() ? v : null;
}

/** P5: what a powerful approval really releases, built from the checked fields, never from `scope`. Null for routine. */
export function releasesLine(row: Pick<SealedRow, "class" | "credential" | "ttl_s">): string | null {
  if (row.class !== "powerful") return null;
  return `Approving opens ${row.credential} itself on uni for up to ${span(row.ttl_s)}. Uni is trusted to do only what's shown. If uni were compromised, this would hand over all of ${row.credential}.`;
}

/** What a failed call says, in words ("invalid: " is Rust's error prefix, not news). */
export function plainError(e: unknown): string {
  const m = typeof e === "string" ? e : (e as Error)?.message;
  return (typeof m === "string" ? m.replace(/^invalid: /, "").trim() : "") || "it couldn't be sent";
}

/** The Needs you title of a waiting card. */
export function waitingTitle(w: Pick<SealedWaiting, "kind" | "credential" | "action" | "rows">): string {
  return w.kind === "morning" ? `Morning card · ${w.rows} routine credential${w.rows === 1 ? "" : "s"}` : `${w.credential} · ${w.action}`;
}
