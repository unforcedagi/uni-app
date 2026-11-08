// For you (0.3.0): the one data module. Plain notes in (the vault's `task` notes on Aaron, the old open `decision` notes, the `card` notes),
// one view out: three bands (Yours, Ready to look at, Moving), each item with where / what / why now / its default and date / the other
// options / where the answer goes, and the counts. Pure: no React, no Tauri, no clock but the `now` it is given (unit-tested in
// scripts/forYou.test.ts). The component only draws this view; the hook (useForYou.ts) only reads and writes.
//
// It could become an applet with a manifest: it needs the types `task` (with the ask fields: kind, card, why_now, default, default_at,
// no_default, options, reply_room, reply_root, answer, answered_at), `decision` (the old ones: state open, options) and `card` (name, area,
// area_node, private, status, stands, stands_at, hill, lines[]), as declared in the vault's tag schemas. Nothing else.

/** A vault note as the query returns it (metadata only). */
export type Note = { id?: unknown; path?: unknown; tags?: unknown; metadata?: unknown; updatedAt?: unknown; createdAt?: unknown };
/** Where a node sits: its area's name, the node's room name (no `#`), and whether it is in a private area. */
export type Place = { area: string | null; room: string | null; private: boolean; /** the area's node path (the home's door it belongs to) */ areaPath?: string | null };
export type Kind = "do" | "choose" | "look" | "tell" | "decision";
/** An answer given on this device today, kept until midnight (the vault's own record is the ask's `answer`). */
export type Answered = { id: string; what: string; answer: string; at: number; room: string | null; post: "sending" | "sent" | "failed" | "none"; error?: string | null };

export type ForYouInput = {
  /** Live `task` notes (any owner: only Aaron's are kept) and open old `decision` notes. A note may come twice (both queries): it is kept once. */
  asks: readonly Note[];
  cards: readonly Note[];
  /** Where a node (a path or an id, as the task's `node` holds it) sits. */
  placeOf: (node: string) => Place;
  /** Who Aaron is in `owner` / `waiting_on` (the profile's `me`). */
  me: string;
  now: number;
  /** When he last looked (ms); null: the last day. */
  lastLooked: number | null;
  /** Answered on this device (hidden from the bands at once, listed as "Answered today"). */
  answered?: readonly Answered[];
  /** At most this many in Yours before "N more" (5). */
  cap?: number;
};

export type Item = {
  id: string;
  /** `T-NN`, or null (an old decision may have none). */
  tid: string | null;
  band: "yours" | "look";
  kind: Kind;
  /** An old `Decisions/` note: answered by its pick path (open -> decided), never the ask's. */
  legacy: boolean;
  where: { label: string; card: string | null; cardPath: string | null; area: string | null; areaPath: string | null };
  what: string;
  why: string | null;
  /** The default and its date ("Lantern Tool Library · Fri 5pm"); null when it waits for him. */
  default: { value: string; at: string | null; label: string } | null;
  /** The choices other than the default (a `choose` ask or an old decision). */
  options: string[];
  /** The plain action when there is no option to pick: Done, Got it, Seen it. */
  action: string | null;
  link: string | null;
  /** The room the answer goes to (a name, no `#`) and the post it threads under. */
  replyRoom: string | null;
  replyRoot: string | null;
  footer: string;
  node: string;
  state: string;
  updatedAt: string | null;
  defaultAt: string | null;
  asked: string | null;
};
export type PrivateLine = { area: string; node: string; areaPath: string | null; count: number };
export type CardView = {
  path: string; name: string; area: string | null; areaNode: string | null; status: string; private: boolean;
  stands: string | null; standsAt: string | null; hill: { pos: number; words: string; stuck: boolean } | null;
  lines: { at: string | null; text: string }[];
};
export type MovingLine = { card: string; cardPath: string; area: string | null; text: string; at: string; private: boolean };
export type ForYouView = {
  yours: Item[]; more: Item[]; privates: PrivateLine[]; look: Item[];
  moving: MovingLine[]; quiet: { quiet: number; resting: number; line: string };
  answered: Answered[];
  /** Everything waiting on him: Yours (shown and behind "N more") and the private ones. */
  count: number;
  cards: Map<string, CardView>;
  since: number;
};

const LIVE = new Set(["open", "doing", "waiting"]);
const DAY = 86_400_000;
const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const meta = (n: Note): Record<string, unknown> => (n.metadata && typeof n.metadata === "object" ? n.metadata as Record<string, unknown> : {});
const tagsOf = (n: Note): string[] => (Array.isArray(n.tags) ? n.tags.filter((t): t is string => typeof t === "string") : []);
/** `[[Cards/A/B]]`, `Cards/A/B.md` or `Cards/A/B`: the path. */
export const refPath = (v: unknown): string | null => { const r = s(v); return r ? r.replace(/^\[\[|\]\]$/g, "").replace(/\|.*$/, "").replace(/\.md$/i, "") : null; };
const leaf = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
/** "T-501 Pick the glaze" -> id T-501, rest "Pick the glaze". */
export function splitTitle(path: string): { tid: string | null; rest: string } {
  const t = leaf(path).replace(/[⁄∕]/g, "/");
  const m = /^(T-\d+[a-z]?)\b[\s:.-]*(.*)$/i.exec(t);
  return m ? { tid: m[1].toUpperCase(), rest: m[2].trim() || t } : { tid: null, rest: t };
}
/** Whether `owner` / `waiting_on` names Aaron: `aaron`, `Aaron`, `@aaron`, `person:aaron`. */
export const isMe = (v: unknown, me: string) => { const x = s(v); return !!x && x.toLowerCase().replace(/^(person:|@)/, "") === me.toLowerCase(); };
function optionsOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((o) => (typeof o === "string" ? o.trim() : o && typeof o === "object" ? s((o as Record<string, unknown>).label) ?? s((o as Record<string, unknown>).name) ?? s((o as Record<string, unknown>).title) ?? "" : "")).filter(Boolean);
}
const ms = (v: string | null): number | null => { if (!v) return null; const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00` : v); return Number.isFinite(t) ? t : null; };
const localDay = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/**
 * A default's date in a few words, in the device's time: "today 5pm", "tomorrow 9am", "Fri 5pm" (within the week), "Nov 20" (further, or
 * past). A date with no time gets no time. null: no date, or one that can't be read.
 */
export function whenLabel(v: string | null, now: number): string | null {
  if (!v) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(v);
  const t = ms(v);
  if (t === null) return null;
  const d = new Date(t), n = new Date(now);
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()) / DAY);
  const day = days === 0 ? "today" : days === 1 ? "tomorrow" : days > 1 && days < 7 ? WEEKDAY[d.getDay()] : `${MONTH[d.getMonth()]} ${d.getDate()}`;
  if (dateOnly) return day;
  const h = d.getHours(), m = d.getMinutes();
  const time = `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
  return `${day} ${time}`;
}

/** Where the hill puts a card, in words: "Uphill, 30" (still figuring out), "Downhill, 64" (making), "Done". */
export function hillWords(pos: number): string { return pos >= 100 ? "Done" : `${pos >= 50 ? "Downhill" : "Uphill"}, ${Math.round(pos)}`; }

/** A card note as the view needs it. A private card keeps only its name, area and lines as stored (its stands and hill are never shown). */
export function cardView(n: Note): CardView | null {
  const m = meta(n), path = refPath(n.path);
  if (!path) return null;
  const priv = m.private === true;
  const hill = m.hill && typeof m.hill === "object" ? m.hill as Record<string, unknown> : null;
  const pos = hill && typeof hill.pos === "number" && Number.isFinite(hill.pos) ? Math.max(0, Math.min(100, hill.pos)) : null;
  const lines = (Array.isArray(m.lines) ? m.lines : []).flatMap((l) => {
    if (!l || typeof l !== "object") return [];
    const o = l as Record<string, unknown>; const text = s(o.text);
    return text ? [{ at: s(o.ended) ?? s(o.at), text }] : [];
  }).sort((a, b) => (ms(b.at) ?? 0) - (ms(a.at) ?? 0));
  return {
    path, name: s(m.name) ?? leaf(path), area: s(m.area), areaNode: refPath(m.area_node), status: s(m.status) ?? "active", private: priv,
    stands: priv ? null : s(m.stands), standsAt: priv ? null : s(m.stands_at),
    hill: priv || pos === null ? null : { pos, words: hillWords(pos), stuck: hill?.stuck === true },
    lines,
  };
}

/** The words a room is told: `T-NN: <answer>`; an old decision with no id says its question. */
export function answerBody(item: Pick<Item, "tid" | "what">, answer: string): string {
  return `${item.tid ?? item.what}: ${answer.trim()}`;
}

/** The quiet line: "9 cards quiet, 6 resting" (or the part there is). */
export function quietLine(quiet: number, resting: number): string {
  const parts = [quiet ? `${quiet} card${quiet === 1 ? "" : "s"} quiet` : "", resting ? `${resting} resting` : ""].filter(Boolean);
  return parts.join(", ");
}

/** The view. */
export function forYou(input: ForYouInput): ForYouView {
  const { now, me } = input;
  const cap = input.cap ?? 5;
  const since = input.lastLooked ?? now - DAY;
  const cards = new Map<string, CardView>();
  for (const n of input.cards) { const c = cardView(n); if (c && c.status !== "retired") cards.set(c.path, c); }
  const today = localDay(now);
  // today's, and any still owed to its room (a failed post keeps its Retry past midnight)
  const answered = (input.answered ?? []).filter((a) => localDay(a.at) === today || a.post === "failed" || a.post === "sending");
  const gone = new Set((input.answered ?? []).map((a) => a.id));

  const seen = new Set<string>();
  const items: Item[] = [];
  const privates = new Map<string, PrivateLine>();
  for (const n of input.asks) {
    const id = s(n.id), path = refPath(n.path);
    if (!id || !path || seen.has(id) || gone.has(id)) continue;
    const tags = tagsOf(n), m = meta(n);
    const isTask = tags.includes("task");
    const legacy = !isTask && tags.includes("decision");
    if (!isTask && !legacy) continue;
    const state = s(m.state) ?? "";
    if (legacy ? state !== "open" : !LIVE.has(state)) continue;
    // Aaron's: he owns it or it waits on him (an old decision is his by being open)
    if (!legacy && !isMe(m.owner, me) && !isMe(m.waiting_on, me)) continue;
    // already answered (the close may not have landed), replaced, put off, or parked for someday
    if (s(m.answered_at) || s(m.answer) || s(m.superseded_by)) continue;
    const snoozed = s(m.snoozed_until);
    if (snoozed && snoozed.slice(0, 10) > today) continue;
    if (s(m.priority)?.toLowerCase() === "someday") continue;
    seen.add(id);
    const node = refPath(m.node) ?? "";
    const place = input.placeOf(node);
    const cardPath = refPath(m.card);
    const card = cardPath ? cards.get(cardPath) ?? null : null;
    const kindRaw = s(m.kind)?.toLowerCase();
    const kind: Kind = legacy ? "decision" : kindRaw === "choose" || kindRaw === "look" || kindRaw === "tell" ? kindRaw : tags.includes("decision") ? "choose" : "do";
    if (place.private || card?.private) {
      // (a private card's own area, wherever its ask is filed)
      const area = (card?.private ? card.area : null) ?? place.area ?? card?.area ?? "a private area";
      const p = privates.get(area) ?? { area, node: (card?.private ? card.areaNode : null) ?? node, areaPath: (card?.private ? card.areaNode : null) ?? place.areaPath ?? null, count: 0 };
      p.count++; privates.set(area, p);
      continue;
    }
    const { tid, rest } = splitTitle(path);
    const options = optionsOf(m.options);
    const noDefault = legacy || m.no_default === true || !s(m.default);
    const defAt = noDefault ? null : s(m.default_at);
    const defValue = noDefault ? null : s(m.default)!;
    const label = defValue ? [defValue, whenLabel(defAt, now)].filter(Boolean).join(" · ") : "";
    const replyRoom = (s(m.reply_room) ?? s(m.room) ?? place.room)?.replace(/^#/, "") ?? null;
    const replyRoot = s(m.reply_root);
    const cardName = card?.name ?? (cardPath ? leaf(cardPath) : null);
    // (the label and the path from one source: the card's area when it names one, else the node's)
    const area = card?.area ?? place.area;
    const areaPath = card?.area ? card.areaNode ?? place.areaPath ?? null : place.areaPath ?? null;
    const where = cardName ? { label: [cardName, area].filter(Boolean).join(" · "), card: cardName, cardPath, area, areaPath } : { label: area ?? "Uni", card: null, cardPath: null, area, areaPath };
    const footer = replyRoom ? `Goes to #${replyRoom}${replyRoot ? (cardName ? `, under ${cardName}'s post` : ", in its thread") : ""}` : "No room to send it to";
    const choices = kind === "choose" || kind === "decision" ? options.filter((o) => o !== defValue) : [];
    items.push({
      id, tid, band: kind === "look" ? "look" : "yours", kind, legacy, where,
      what: rest, why: s(m.why_now),
      default: defValue ? { value: defValue, at: defAt, label } : null,
      options: choices,
      action: choices.length ? null : kind === "tell" ? "Got it" : kind === "look" ? "Seen it" : kind === "decision" ? null : "Done",
      link: s(m.link) ?? s(m.url),
      replyRoom, replyRoot, footer, node, state, updatedAt: s(n.updatedAt), defaultAt: defAt,
      asked: s(m.asked_at) ?? s(m.asked) ?? s(m.created) ?? s(n.createdAt),
    });
  }
  // earliest default first (an ask with no default after every dated one), then the oldest asked
  const order = (a: Item, b: Item) => (ms(a.defaultAt) ?? Infinity) - (ms(b.defaultAt) ?? Infinity) || (ms(a.asked) ?? Infinity) - (ms(b.asked) ?? Infinity) || a.id.localeCompare(b.id);
  const yoursAll = items.filter((i) => i.band === "yours").sort(order);
  const look = items.filter((i) => i.band === "look").sort(order);

  // Moving: card lines since he last looked, newest first; a private card's line only as stored; quiet cards counted, not listed
  const moving: MovingLine[] = [];
  let quiet = 0, resting = 0;
  for (const c of cards.values()) {
    const fresh = c.lines.filter((l) => (ms(l.at) ?? 0) > since);
    if (fresh.length) for (const l of fresh) moving.push({ card: c.name, cardPath: c.path, area: c.area, text: l.text, at: l.at!, private: c.private });
    else if (c.status === "resting") resting++;
    else quiet++;
  }
  moving.sort((a, b) => (ms(b.at) ?? 0) - (ms(a.at) ?? 0));
  const priv = [...privates.values()].sort((a, b) => a.area.localeCompare(b.area));
  return {
    yours: yoursAll.slice(0, cap), more: yoursAll.slice(cap), privates: priv, look, moving,
    quiet: { quiet, resting, line: quietLine(quiet, resting) },
    answered: [...answered].sort((a, b) => b.at - a.at),
    count: yoursAll.length + priv.reduce((k, p) => k + p.count, 0),
    cards, since,
  };
}

/** The metadata written with the close (CONTRACT "Answering an ask"): one compare-and-set on `state` with these, in the same write. */
export function answerMeta(item: Pick<Item, "kind" | "options" | "default">, answer: string, by: string, at: string): Record<string, string> {
  const m: Record<string, string> = { answer: answer.trim(), answered_at: at, answered_by: by };
  const picked = item.kind === "choose" && (item.default?.value === answer || item.options.includes(answer));
  if (picked) Object.assign(m, { decided: answer, decided_at: at, decided_by: by });
  return m;
}
