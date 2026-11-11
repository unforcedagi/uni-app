// T-234: Uni's approval card and morning card (uni-ops CARD.md §2–5; the morning fence is CONTRACT-CHANGES.md P2). Rust
// checks every card from its signed event (`sealed_card`) and answers it (`sealed_answer`); the card draws only from the
// view Rust returns, never from the message text. Pure helpers here (unit-tested in scripts/sealedCardCore.test.ts).

export type SealedClass = "routine" | "powerful";
export type SealedAnswer = { decision: "approve" | "deny"; at: number; until: number | null; sent: boolean };
export type SealedRow = {
  rid: string; action: string; credential: string; class: SealedClass; scope: string; ttl_s: number; uses: number;
  payload: unknown; request_digest: string; expires: number; answer: SealedAnswer | null;
  /** T-335: approving it always asks for the device unlock, even just after one (Rust's `always_unlock`). */
  always_unlock?: boolean;
  /** When Uni asked: a card can wait up to a day. */
  asked?: number;
  /** The key's true reach (Rust's `reach_line`): what the card says first. */
  reach?: string | null;
  /** What a read key riding on the card can see (Rust's `read_key_line`): it stays on the card's face. */
  read_key?: string | null;
};

/** T-335: approving these rows would need only the tap while the unlock grace lasts (Rust decides, at the tap). */
export const tapOnly = (rows: Pick<SealedRow, "class" | "always_unlock">[]): boolean =>
  rows.length > 0 && rows.every((r) => r.always_unlock === false);

/** Held for a second, not tapped: a powerful credential, unless Rust says it opens only for a small key. */
export const needsHold = (r: Pick<SealedRow, "class" | "always_unlock">): boolean => r.class === "powerful" && r.always_unlock !== false;

/** The first thing the card says, when it has a true-reach line. */
export const reachLine = (r: Pick<SealedRow, "reach">): string | null => r.reach ?? null;

/** How old the job is, once it's older than a card could ever get before cards stayed open: null until 15 minutes. */
export function ageText(now: number, asked?: number): string | null {
  if (asked === undefined) return null;
  const s = now - asked;
  if (s < 900) return null;
  return s < 7200 ? `asked ${Math.floor(s / 60)} min ago` : `asked ${Math.floor(s / 3600)} h ago`;
}

const whenFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
/** "14:05", or "tomorrow 14:05" or "yesterday 14:05": a card can be open past midnight. */
export function whenText(ts: number, now: number): string {
  const at = new Date(ts * 1000), today = new Date(now * 1000);
  const t = whenFormat.format(at);
  if (at.toDateString() === today.toDateString()) return t;
  return at > today ? `tomorrow ${t}` : `yesterday ${t}`;
}
export type SealedCardView = { kind: "single" | "morning" | null; event_id: string; refused: string | null; rows: SealedRow[] };
/** A card waiting for a tap in some room (`sealed_waiting`), for Needs you. */
export type SealedWaiting = {
  ref: string; channel: string; root: string | null; ts: number; kind: "single" | "morning";
  credential: string | null; action: string | null; class: SealedClass; rows: number; expires: number; fingerprint: string;
  reach?: string | null;
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
  const first = (at < 0 ? body : body.slice(0, at)).trim().split("\n")[0] ?? "";
  return /^🔑 \*\*(🔴|🟡|🟢) /u.test(first) ? "" : first; // the card itself opens with the reach: the room needn't say it too
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
export function waitingTitle(w: Pick<SealedWaiting, "kind" | "credential" | "action" | "rows" | "reach">): string {
  if (w.reach) return w.reach;
  return w.kind === "morning" ? `Morning card · ${w.rows} routine credential${w.rows === 1 ? "" : "s"}` : `${w.credential} · ${w.action}`;
}

// ------------------------------------------------------------------ T-335 cards expand (11-11)
// Aaron: "I can't see the full text, theres no option to expand; and the cards often contain not much context; so in the case of those two I
// don't really know what they're even asking about". An expanded card says first, in plain words, what a yes does, what it touches
// (production or not, which account), who asked and why now: all from the card's checked row (the broker's own words in `scope`), and, when
// an ask in the same room points at this card (`sealed_card`), that ask's T-number and why-now.

/** The ask that points at a card, as the card names it (only one in the card's own room: asks are vetted per room). */
export type CardAsk = { tid: string | null; what: string; why: string | null };
/** What a card asks, one plain line each. */
export type Asking = { approve: string; touches: string; asked: string; why: string | null };

/** A broker-worded scope's lines (card_text.render): the reach, "Can: …", maybe "Read key: …", maybe "Uni says: …". */
const scopeLine = (scope: string, head: string): string | null => {
  const l = scope.split("\n").find((x) => x.startsWith(head));
  return l ? l.slice(head.length).trim() || null : null;
};

/** The account and whether it is production, from the reach line ("🔴 Open Site (site.example) — PRODUCTION account · …"); null when the
 *  card has no such line (a card the broker didn't word: production or not isn't on it). */
export function accountOf(reach: string | null | undefined): { account: string; production: boolean } | null {
  if (!reach) return null;
  const head = reach.replace(/^(🔴|🟡|🟢)\s*/u, "").split(" · ")[0].trim();
  const prod = / — PRODUCTION account$/.exec(head);
  if (prod) return { account: head.slice(0, prod.index).trim(), production: true };
  const none = / \(no production\)$/.exec(head);
  if (none) return { account: head.slice(0, none.index).trim(), production: false };
  return null;
}

const lower1 = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** The expanded card's head: what a yes does, what it touches, who asked, why now. `room`: the card's room name, no `#`; `now` unix seconds. */
export function askingOf(r: SealedRow, o: { room: string | null; now: number; ask?: CardAsk | null }): Asking {
  const uses = `${r.uses} use${r.uses === 1 ? "" : "s"}`;
  const can = scopeLine(r.scope, "Can:");
  const child = childToken(r);
  const key = child ? (child.permanent ? "a permanent token" : `a token that lasts ${span(child.ttl ?? 0)}`) : `a key for ${span(r.ttl_s)} (${uses})`;
  const approve = can
    ? `Uni gets ${key}. It ${/^can\b/i.test(can) ? lower1(can) : `can ${lower1(can)}`}`
    : `Uni opens ${r.credential} for ${r.action}, ${span(r.ttl_s)} and ${uses}: ${r.scope.split("\n")[0]}`;
  const acct = accountOf(r.reach);
  const dest = payloadField(r, "destination");
  const touches = (acct ? `${acct.production ? "PRODUCTION" : "Not production"} · ${acct.account}` : `${r.credential} · the card doesn't say whether it is production`)
    + (dest ? ` · to ${dest}` : "");
  const age = ageText(o.now, r.asked);
  const asked = ["Uni", o.room ? `in #${o.room}` : null, r.asked !== undefined ? `${whenText(r.asked, o.now)}${age ? ` (${age})` : ""}` : null,
    o.ask ? `for ${o.ask.tid ? `${o.ask.tid}: ` : ""}${o.ask.what}` : null].filter(Boolean).join(" · ");
  const says = payloadField(r, "purpose") ?? scopeLine(r.scope, "Uni says:");
  const why = o.ask?.why ?? says ?? null;
  return { approve: approve.replace(/\.?$/, "."), touches, asked, why };
}

/** A card named by an ask (`sealed_card`: its event id, at least its first 12 hex) is this message. */
export const cardIs = (named: string | null | undefined, ref: string): boolean =>
  !!named && named.length >= 12 && ref.toLowerCase().startsWith(named.toLowerCase());

/** Where the card an ask points at stands, as this device can tell. */
export type CardState =
  | { state: "checking" }
  | { state: "waiting"; channel: string; ref: string; expires: number }
  | { state: "expired"; channel: string; ref: string; at: number | null }
  | { state: "answered"; channel: string; ref: string; decision: "approve" | "deny"; at: number }
  | { state: "ended"; channel: string; ref: string; line: string }
  | { state: "refused"; channel: string; ref: string; why: string }
  | { state: "missing" };

const EXPIRED = "This card has expired.";
/**
 * The state of an ask's card from the room's message (`body` as the room shows it: a card the broker ended is edited to one line with no
 * fence) and, while it still carries its fence, its checked view.
 */
export function cardState(msg: { channel: string; ref: string; body: string } | null, view: SealedCardView | null, now: number): CardState {
  if (!msg) return { state: "missing" };
  const { channel, ref } = msg;
  if (!sealedFence(msg.body)) return { state: "ended", channel, ref, line: msg.body.split("\n")[0].trim() };
  if (!view) return { state: "checking" };
  if (view.refused) return view.refused === EXPIRED ? { state: "expired", channel, ref, at: null } : { state: "refused", channel, ref, why: view.refused };
  const answered = view.rows.find((x) => x.answer);
  if (answered?.answer) return { state: "answered", channel, ref, decision: answered.answer.decision, at: answered.answer.at };
  const expires = Math.min(...view.rows.map((x) => x.expires));
  if (!view.rows.length || now >= expires) return { state: "expired", channel, ref, at: view.rows.length ? expires : null };
  return { state: "waiting", channel, ref, expires };
}

/** A card that no longer waits, in a few words; null while it waits or is being checked. */
export function staleLine(s: CardState, clock: (ts: number) => string): string | null {
  switch (s.state) {
    case "expired": return s.at ? `Its card expired at ${clock(s.at)}: nothing was sent` : "Its card expired: nothing was sent";
    case "answered": return `Its card was already ${s.decision === "deny" ? "denied" : "approved"} here at ${clock(s.at)}`;
    case "ended": return `Its card has ended: ${s.line.replace(/^🔑\s*/u, "")}`;
    case "refused": return `Its card can't be approved: ${s.why}`;
    case "missing": return "Its card isn't in this room on this device: it may have ended, or never arrived";
    default: return null;
  }
}

/** What the room is told when he asks for a fresh card (addressed to its Uni, so it wakes). `fp`: the card's fingerprint, when known. */
export function repostBody(o: { tid: string | null; what: string | null; fp: string | null; why: string }): string {
  const card = o.fp ? `the approval card ${o.fp}` : "the approval card";
  const lead = o.tid ? `${o.tid}: ${card}` : o.what ? `${o.what}: ${card}` : card.charAt(0).toUpperCase() + card.slice(1);
  return `${lead} no longer waits (${o.why}). If it's still needed, post a fresh card${o.tid ? ` and point ${o.tid} at it (--sealed-card)` : ""}; if not, close it.`;
}
