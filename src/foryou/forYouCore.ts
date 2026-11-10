// For you (0.3.0): the one data module. Plain notes in (the vault's `task` notes on Aaron, the old open `decision` notes, the `card` notes),
// one view out: three bands (Yours, Ready to look at, Moving), each item with where / what / why now / its default and date / the other
// options / where the answer goes, and the counts. Pure: no React, no Tauri, no clock but the `now` it is given (unit-tested in
// scripts/forYou.test.ts). The component only draws this view; the hook (useForYou.ts) only reads and writes.
//
// It could become an applet with a manifest: it needs the types `task` (with the ask fields: kind, card, why_now, default, default_at,
// no_default, options, reply_room, reply_root, answer, answered_at), `decision` (the old ones: state open, options) and `card` (name, area,
// area_node, project, private, status, stands, stands_at, hill, lines[], threads[], open_asks[], last_session_at), as declared in the vault's
// tag schemas. Nothing else. 0.3.2: the card itself is drawn from here too (its marks, an area's cards, which card a room's message is about).
//
// 0.3.3 (T-335 fresh): For you shows only what is live and fresh. An ask's room is a live room (an archived one, #Uni or any other, resolves
// to where its work went, else its node's room; with none it is not shown); an ask in a place that is archived or resting is not shown; and
// an ask its room hasn't asked or confirmed (`asked_at` / `confirmed_at`) for FRESH_DAYS has gone back to its room. Those are counted in
// one quiet line, "N waiting on their rooms", never listed. The daily read (uni-tasks for_you.py) and the rooms' handback use the same rule.

/** A vault note as the query returns it (metadata only). */
import { metaOf } from "../vault/reader.ts";

export type Note = { id?: unknown; path?: unknown; tags?: unknown; metadata?: unknown; updatedAt?: unknown; createdAt?: unknown };
/** Where a node sits: its area's name, the node's room name (no `#`), and whether it is in a private area. */
export type Place = { area: string | null; room: string | null; private: boolean; /** the area's node path (the home's door it belongs to) */ areaPath?: string | null;
  /** false: the node, or the area it sits in, is archived, resting or done (nothing of it is in For you) */ live?: boolean };
export type Kind = "do" | "choose" | "look" | "tell" | "decision";
/** An answer given on this device today, kept until midnight (the vault's own record is the ask's `answer`). */
export type Answered = { id: string; what: string; answer: string; at: number; room: string | null; post: "sending" | "sent" | "failed" | "none"; error?: string | null;
  /** 0.3.2: the card the ask was on: the card shows the answer as his line until its own line comes back from the vault. */ card?: string | null;
  /** T-335 Seen: he marked it seen (no words of his: never a line on the card). */ seen?: boolean };

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
  /** A room's name as a live room's name (an archived room's name: the live room its work went to); null: no live room by that name.
   *  Absent: every named room counts as live (tests, a vault with no rooms). */
  liveRoom?: (name: string) => string | null;
  /** Whether a room's name is a private place's room: an ask that names one is that room's, wherever its node is (counted, never shown). */
  privateRoom?: (name: string) => boolean;
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
  /** The plain action when there is no option to pick: Done (a do ask). A tell or look ask's one tap is Seen (T-335 Seen), drawn for every item. */
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
  /** An older ask's separate context note (`context_note`, before T-335 put the context in the ask's own body): read when the body has none. */
  contextNote: string | null;
};
export type PrivateLine = { area: string; node: string; areaPath: string | null; count: number };
/** One line on a card: one per session, newest first; `mine`: Aaron's own answer (the line says so, or it was given on this device). */
export type CardLine = { at: string | null; text: string; mine: boolean };
export type CardView = {
  path: string; name: string; area: string | null; areaNode: string | null; project: string | null; status: string; private: boolean;
  stands: string | null; standsAt: string | null; hill: { pos: number; words: string; stuck: boolean } | null;
  lines: CardLine[];
  /** Its recent thread names, newest first (a private card's are topics, as stored). */
  threads: string[];
  /** The open asks on it (T-NN ids, as the card note keeps them; what the app counts is the live asks: privateAsks, cardItems). */
  openAsks: string[];
  /** When its newest session started (orders an area's cards). */
  lastAt: string | null;
};
export type MovingLine = { card: string; cardPath: string; area: string | null; text: string; at: string; private: boolean; /** his own answer */ mine?: boolean };
export type ForYouView = {
  yours: Item[]; more: Item[]; privates: PrivateLine[]; look: Item[];
  moving: MovingLine[]; quiet: { quiet: number; resting: number; line: string };
  answered: Answered[];
  /** Everything waiting on him: Yours (shown and behind "N more") and the private ones. */
  count: number;
  /** T-335 one home: everything that needs him, his to answer and his to look at (the count plus Ready to look at): the home's number, the
   *  same as the places' badges and the tree's dots (which count every ask uni-tasks marked needs_aaron). */
  total: number;
  /** Asks no longer his: not asked or confirmed by their room in FRESH_DAYS, or in a place that isn't live, or with no live room. Counted only. */
  away: number;
  cards: Map<string, CardView>;
  /** 0.3.2: a private card's live asks, counted by card (never their words): its mark and its "N things wait on you". */
  privateCards: Map<string, number>;
  since: number;
};

/** needs_aaron_why for his asks that went back to their rooms (For you's "N waiting on their rooms"). */
export const AWAY = new Set(["stale", "resting", "no card", "no room"]);
const DAY = 86_400_000;
/** An ask stays in For you this many days after its room last asked or confirmed it (T-335 fresh, 11-08). */
export const FRESH_DAYS = 7;
const SKEW = 5 * 60_000;
const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
/** For you reads asks (tasks, decisions) and cards: their metadata as the vault declares those kinds (src/vault/reader.ts). */
const meta = (n: Note) => metaOf(n, "task", "decision", "card");
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
/** A stored date as ms, in the device's time: a date with no time is that local day's start (never UTC midnight, a day early in the west). */
export const ms = (v: string | null): number | null => { if (!v) return null; const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00` : v); return Number.isFinite(t) ? t : null; };
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

/** A line that is Aaron's own answer: the line names him (`by`/`who`/`author`, or its status is `answer`), or says so in its words
 *  ("Aaron: ...", by the profile's `me`). Its words lose the name: the card marks the line instead. */
function lineOf(o: Record<string, unknown>, me: string): CardLine | null {
  const raw = s(o.text);
  if (!raw) return null;
  const by = s(o.by) ?? s(o.who) ?? s(o.author);
  const colon = raw.indexOf(":");
  const said = colon > 0 && isMe(raw.slice(0, colon), me);
  // (a line that names its author is that author's, whatever its words say)
  const mine = by ? isMe(by, me) : said || (s(o.status) ?? "").toLowerCase() === "answer";
  // (his name is dropped only from his own line: a line by someone else that quotes him keeps it)
  const text = said && mine ? raw.slice(colon + 1).trim() || raw : raw;
  return { at: s(o.ended) ?? s(o.at), text, mine };
}

/** A card note as the view needs it. A private card keeps only its name, area, lines and thread names as stored (its stands and hill are never
 *  shown, and its open asks only as a count). */
export function cardView(n: Note, me = "aaron", inPrivate = false): CardView | null {
  const m = meta(n), path = refPath(n.path);
  if (!path) return null;
  // (private by its own flag, or by where it is filed: a card in a private area missing the flag is still private)
  const priv = m.private === true || inPrivate;
  const hill = m.hill && typeof m.hill === "object" ? m.hill as Record<string, unknown> : null;
  const pos = hill && typeof hill.pos === "number" && Number.isFinite(hill.pos) ? Math.max(0, Math.min(100, hill.pos)) : null;
  const lines = (Array.isArray(m.lines) ? m.lines : []).flatMap((l) => {
    if (!l || typeof l !== "object") return [];
    const line = lineOf(l as Record<string, unknown>, me);
    // a private card's answer is marked as his, never in his words
    return line ? [priv && line.mine ? { ...line, text: "answered." } : line] : [];
  }).sort((a, b) => (ms(b.at) ?? 0) - (ms(a.at) ?? 0));
  return {
    path, name: s(m.name) ?? leaf(path), area: s(m.area), areaNode: refPath(m.area_node), project: refPath(m.project), status: s(m.status) ?? "active", private: priv,
    stands: priv ? null : s(m.stands), standsAt: priv ? null : s(m.stands_at),
    hill: priv || pos === null ? null : { pos, words: hillWords(pos), stuck: hill?.stuck === true },
    lines, threads: optionsOf(m.threads).slice(0, 6), openAsks: optionsOf(m.open_asks), lastAt: s(m.last_session_at) ?? lines[0]?.at ?? null,
  };
}

/** The words a room is told: `T-NN: <answer>`; an old decision with no id says its question. */
export function answerBody(item: Pick<Item, "tid" | "what">, answer: string): string {
  return `${item.tid ?? item.what}: ${answer.trim()}`;
}

/** When its room last asked or confirmed the ask: the newer of `asked_at` and `confirmed_at` (a stamp in the future is a wrong date, passed
 *  over, never "fresh forever"), else when it was created. The same rule as uni-tasks surface.current_at. */
export function currentAt(m: Record<string, unknown>, createdAt: unknown, now: number): number | null {
  const ok = [s(m.asked_at), s(m.confirmed_at)].map(ms).filter((t): t is number => t !== null);
  const sane = ok.filter((t) => t <= now + SKEW);
  if (sane.length) return Math.max(...sane);
  return ms(s(m.created)) ?? ms(s(createdAt));
}
/** A place in one of these is not live (T-335 fresh): For you shows nothing of it. */
export const DORMANT = /^(archived|resting|done)$/i;
/** A node as the dormant rule reads it (the vault's node notes, archived ones included). */
export type PlaceNote = { id: string; path: string; kind: string; status?: string; parent?: string | null; links?: readonly string[]; metadata: Record<string, unknown> };
/**
 * Whether a node (by id or path) isn't live: it is archived, resting or done, or every area it is linked to (its `parent` or `links`, or an area whose
 * `links` name it) is, archived areas included. An area stands by its own status. null: the node isn't among `all`. The same rule as uni-tasks
 * for_you.dormant.
 */
export function placeDormant(all: readonly PlaceNote[], ref: string): boolean | null {
  const n = all.find((a) => a.id === ref || a.path === ref);
  if (!n) return null;
  const off = (a: PlaceNote) => a.status === "archived" || a.status === "done" || DORMANT.test(String(a.metadata.status ?? ""));
  if (off(n)) return true;
  if (n.kind === "area") return false;
  const mine = new Set([n.parent, ...(n.links ?? [])].map(refPath).filter((x): x is string => !!x));
  const areas = all.filter((a) => a.kind === "area" && a.id !== n.id && (mine.has(a.id) || mine.has(a.path) || (a.links ?? []).map(refPath).some((r) => r === n.id || r === n.path)));
  if (areas.length) return areas.every(off);
  // (no area linked: the nearest area up its `parent` chain, as uni-tasks' area_of walks it)
  let up = refPath(n.parent);
  for (let i = 0; up && i < 12; i++) {
    const p = all.find((a) => a.id === up || a.path === up);
    if (!p) break;
    if (p.kind === "area") return off(p);
    if (off(p)) return true;
    up = refPath(p.parent);
  }
  return false;
}
/** placeDormant over a built tree: its live nodes and its archived and done ones (the tree keeps those apart, and a dormant place is often one). */
export function treeDormant(tree: { nodes: ReadonlyMap<string, PlaceNote>; archived: readonly PlaceNote[] }, ref: string): boolean | null {
  return placeDormant([...tree.nodes.values(), ...tree.archived], ref);
}
/** The quiet line for what went back: "3 waiting on their rooms" ("" for none). */
export const awayLine = (n: number): string => (n ? `${n} waiting on ${n === 1 ? "its room" : "their rooms"}` : "");

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
  for (const n of input.cards) { const inPrivate = [refPath(meta(n).area_node), refPath(meta(n).project)].some((p) => !!p && input.placeOf(p).private); const c = cardView(n, me, inPrivate); if (c && c.status !== "retired") cards.set(c.path, c); }
  const today = localDay(now);
  // today's, and any still owed to its room (a failed post keeps its Retry past midnight)
  const answered = (input.answered ?? []).filter((a) => localDay(a.at) === today || a.post === "failed" || a.post === "sending");
  // answered or seen on this device: hidden at once, before the list catches up. A seen ask its room has asked again since (a newer asked_at or
  // confirmed_at) is his again: it shows (an answer closed its ask, so that one stays hidden)
  const gone = new Map((input.answered ?? []).map((a) => [a.id, a] as const));
  const reasked = (a: Answered, m: Record<string, unknown>) => !!a.seen && Math.max(ms(s(m.asked_at)) ?? -Infinity, ms(s(m.confirmed_at)) ?? -Infinity) > a.at;

  const seen = new Set<string>();
  const items: Item[] = [];
  const privates = new Map<string, PrivateLine>();
  const privateCards = new Map<string, number>();
  let away = 0;
  // a room's name as the live room (no resolver: every named room counts)
  const live = (r: string | null): string | null => { const x = r?.replace(/^#/, "").trim(); return x ? (input.liveRoom ? input.liveRoom(x) : x) : null; };
  for (const n of input.asks) {
    const id = s(n.id), path = refPath(n.path);
    if (!id || !path || seen.has(id)) continue;
    const tags = tagsOf(n), m = meta(n);
    const mine = gone.get(id);
    if (mine && !reasked(mine, m)) continue;
    // an old `Decisions/` note is the record, not an ask (T-335 one home): only tasks are asks
    if (!tags.includes("task")) continue;
    seen.add(id);
    // T-335 one home: whether it needs him is the task's needs_aaron, as uni-tasks wrote it (the one rule: an open ask owned by him, on a card,
    // asked or confirmed by its room in FRESH_DAYS, in a live place with a live room); his asks that went back to their rooms are only counted
    if (m.needs_aaron !== true) { if (m.needs_aaron === false && AWAY.has(s(m.needs_aaron_why) ?? "")) away++; continue; }
    const legacy = false;
    const state = s(m.state) ?? "";
    const node = refPath(m.node) ?? "";
    const place = input.placeOf(node);
    const cardPath = refPath(m.card);
    const card = cardPath ? cards.get(cardPath) ?? null : null;
    const kindRaw = s(m.kind)?.toLowerCase();
    const kind: Kind = legacy ? "decision" : kindRaw === "choose" || kindRaw === "look" || kindRaw === "tell" ? kindRaw : tags.includes("decision") ? "choose" : "do";
    // a card not read yet (or unreadable) may be private: until it is read, its ask is counted, never shown (review 11-07)
    // an ask that names a private room (its reply_room, else its room) is that room's, wherever its node sits (as uni-tasks for_you.py reads it)
    const named = (s(m.reply_room) ?? s(m.room))?.replace(/^#/, "") ?? null;
    if (place.private || card?.private || (cardPath && !card) || (!!named && !!input.privateRoom?.(named))) {
      // (a private card's own area, wherever its ask is filed)
      const area = (card?.private ? card.area : null) ?? place.area ?? card?.area ?? "a private area";
      const p = privates.get(area) ?? { area, node: (card?.private ? card.areaNode : null) ?? node, areaPath: (card?.private ? card.areaNode : null) ?? place.areaPath ?? null, count: 0 };
      p.count++; privates.set(area, p);
      if (cardPath) privateCards.set(cardPath, (privateCards.get(cardPath) ?? 0) + 1);
      continue;
    }
    const { tid, rest } = splitTitle(path);
    const options = optionsOf(m.options);
    const noDefault = legacy || m.no_default === true || !s(m.default);
    const defAt = noDefault ? null : s(m.default_at);
    const defValue = noDefault ? null : s(m.default)!;
    const label = defValue ? [defValue, whenLabel(defAt, now)].filter(Boolean).join(" · ") : "";
    // its own reply room or room, as a live room (an archived one resolves to where its work went), else its node's live room (uni-tasks
    // checked it has one; if this device can't find it yet, the footer says so)
    const replyRoom = live(s(m.reply_room)) ?? live(s(m.room)) ?? live(place.room);
    const replyRoot = s(m.reply_root);
    const cardName = card?.name ?? (cardPath ? leaf(cardPath) : null);
    // (the label and the path from one source: the card's area when it names one, else the node's)
    const area = card?.area ?? place.area;
    const areaPath = card?.area ? card.areaNode ?? null : place.areaPath ?? null;
    const where = cardName ? { label: [cardName, area].filter(Boolean).join(" · "), card: cardName, cardPath, area, areaPath } : { label: area ?? "Uni", card: null, cardPath: null, area, areaPath };
    const footer = replyRoom ? `Goes to #${replyRoom}${replyRoot ? (cardName ? `, under ${cardName}'s post` : ", in its thread") : ""}` : "No room to send it to";
    const choices = kind === "choose" || kind === "decision" ? options.filter((o) => o !== defValue) : [];
    items.push({
      id, tid, band: kind === "look" ? "look" : "yours", kind, legacy, where,
      what: rest, why: s(m.why_now),
      default: defValue ? { value: defValue, at: defAt, label } : null,
      options: choices,
      action: choices.length || kind === "tell" || kind === "look" || kind === "decision" ? null : "Done",
      link: s(m.link) ?? s(m.url),
      replyRoom, replyRoot, footer, node, state, updatedAt: s(n.updatedAt), defaultAt: defAt,
      asked: s(m.asked_at) ?? s(m.asked) ?? s(m.created) ?? s(n.createdAt),
      contextNote: s(m.context_note),
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
    if (fresh.length) for (const l of fresh) moving.push({ card: c.name, cardPath: c.path, area: c.area, text: l.text, at: l.at!, private: c.private, mine: l.mine });
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
    total: yoursAll.length + priv.reduce((k, p) => k + p.count, 0) + look.length,
    away,
    cards, since, privateCards,
  };
}

/** The metadata written with the close (CONTRACT "Answering an ask"): one compare-and-set on `state` with these, in the same write. */
export function answerMeta(item: Pick<Item, "kind" | "options" | "default">, answer: string, by: string, at: string): Record<string, string> {
  const m: Record<string, string> = { answer: answer.trim(), answered_at: at, answered_by: by };
  const picked = item.kind === "choose" && (item.default?.value === answer || item.options.includes(answer));
  if (picked) Object.assign(m, { decided: answer, decided_at: at, decided_by: by });
  return m;
}

// ------------------------------------------------------------------ T-335 Seen (11-09): "I should really be able to just mark it as seen... to note that I'm aware of it"

/** A tell or look ask closes on Seen; a do or choose ask stays open with its room (it still needs his steer later: the room asks again). */
export const seenCloses = (kind: Kind): boolean => kind === "tell" || kind === "look";
/** What Seen writes (uni-tasks `tasks.py seen` writes the same): who and when, and out of For you by the one rule's field, never an answer. A
 *  tell or look ask's write closes it too (one compare-and-set on `state`); a do or choose ask's is a metadata patch on the revision shown. */
export function seenMeta(by: string, at: string): { seen_at: string; seen_by: string; needs_aaron: false; needs_aaron_why: "seen" } {
  return { seen_at: at, seen_by: by, needs_aaron: false, needs_aaron_why: "seen" };
}
/** The one quiet line its room is told (posted to the room, not addressed to its Uni: it wakes nobody; uni-tasks seen_words). */
export function seenBody(item: Pick<Item, "tid" | "what" | "kind">): string {
  const id = item.tid ?? item.what;
  return seenCloses(item.kind) ? `${id}: seen.` : `${id}: seen. It stays open here until it needs my steer; ask again then.`;
}

// ------------------------------------------------------------------ 0.3.2: the card itself (tap a card's name anywhere: For you, the stream, an area)

/** What a card is to him now, by shape (Daylight is greyscale): ● something on it is his, ◐ something on it is ready to look at, ○ it is moving,
 *  — it is resting. A private card is his when its note counts open asks (none of their words are read here). */
export type CardMark = "yours" | "look" | "moving" | "rest";
export const MARK_WORDS: Record<CardMark, string> = { yours: "waits on you", look: "ready to look at", moving: "moving", rest: "resting" };
const onCard = (path: string) => (i: Item) => i.where.cardPath === path;
export function cardMark(view: Pick<ForYouView, "yours" | "more" | "look" | "privateCards">, card: CardView): CardMark {
  const on = onCard(card.path);
  if (view.yours.some(on) || view.more.some(on) || (card.private && privateAsks(view, card) > 0)) return "yours";
  if (view.look.some(on)) return "look";
  return card.status === "resting" ? "rest" : "moving";
}
/** The asks on a card that For you shows (his first, then the ones to look at). A private card's are never shown: they are counted (privateAsks). */
export function cardItems(view: Pick<ForYouView, "yours" | "more" | "look">, card: CardView): Item[] {
  const on = onCard(card.path);
  return card.private ? [] : [...view.yours, ...view.more, ...view.look].filter(on);
}

const RANK: Record<CardMark, number> = { yours: 0, look: 1, moving: 2, rest: 3 };
export type AreaCard = { card: CardView; mark: CardMark };
/** A place's cards (the card's area is this node, or the card is this project's face): the active ones first (his, then to look at, then moving;
 *  the newest session first), the resting ones apart (folded where they are shown). */
export function areaCards(view: Pick<ForYouView, "yours" | "more" | "look" | "cards" | "privateCards">, node: string): { active: AreaCard[]; resting: AreaCard[] } {
  const all = [...view.cards.values()].filter((c) => c.areaNode === node || c.project === node).map((card) => ({ card, mark: cardMark(view, card) }));
  const order = (a: AreaCard, b: AreaCard) => RANK[a.mark] - RANK[b.mark] || (ms(b.card.lastAt) ?? 0) - (ms(a.card.lastAt) ?? 0) || a.card.name.localeCompare(b.card.name);
  return { active: all.filter((c) => c.mark !== "rest").sort(order), resting: all.filter((c) => c.mark === "rest").sort(order) };
}

const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** The card's lines, newest first: one per session, and his own answers marked. An answer given on this device shows at once, as his line, until
 *  the card's own line for it comes back (the same words). */
export function cardLines(card: CardView, answered: readonly Answered[] = []): CardLine[] {
  // (only a line of his written since: the same words answered last week are another answer; 10 min of clock slack)
  const back = (a: Answered) => card.lines.some((l) => l.mine && norm(l.text) === norm(a.answer) && (ms(l.at) ?? 0) >= a.at - 600_000);
  const here = answered.filter((a) => a.card === card.path && !a.seen && !back(a)).map((a) => ({ at: new Date(a.at).toISOString(), text: a.answer, mine: true }));
  return [...here, ...card.lines].sort((a, b) => (ms(b.at) ?? 0) - (ms(a.at) ?? 0));
}

/** How many of a private card's asks are live now (For you's own count of them; never their words). */
export const privateAsks = (view: Pick<ForYouView, "privateCards">, card: CardView): number => view.privateCards.get(card.path) ?? 0;
/** "1 thing waits on you" / "3 things wait on you": a private card's asks, by count only. */
export const waitsWords = (n: number) => `${n} thing${n === 1 ? " waits" : "s wait"} on you`;

/**
 * The card a room's message is about: the card's post that its asks thread under (an ask's `reply_root`), a reply in that thread, or a message that
 * opens with the card's name ("Glaze Tests: …", "**Glaze Tests**") in a room of the card's own area or project. Never a private card (a private
 * area's rooms are not in the stream; this keeps it so).
 */
export function cardOfMessage(view: Pick<ForYouView, "yours" | "more" | "look" | "cards" | "privateCards">, m: { ref: string; root?: string | null; body: string }, roomPath: string | null): CardView | null {
  return cardMatcher(view)(m, roomPath);
}
/** cardOfMessage, with its lookups built once (the stream asks for every message on every draw). */
export function cardMatcher(view: Pick<ForYouView, "yours" | "more" | "look" | "cards" | "privateCards">): (m: { ref: string; root?: string | null; body: string }, roomPath: string | null) => CardView | null {
  const byRoot = new Map<string, CardView>();
  for (const i of [...view.yours, ...view.more, ...view.look]) {
    const c = i.replyRoot && i.where.cardPath ? view.cards.get(i.where.cardPath) : null;
    if (c && !c.private && !byRoot.has(i.replyRoot!)) byRoot.set(i.replyRoot!, c);
  }
  // the longest name first: "Glaze Tests" before "Glaze"
  const named = [...view.cards.values()].filter((c) => !c.private && c.name).map((c) => ({ c, n: c.name.toLowerCase() })).sort((a, b) => b.n.length - a.n.length);
  return (m, roomPath) => {
    const hit = byRoot.get(m.ref) ?? (m.root ? byRoot.get(m.root) : undefined);
    if (hit) return hit;
    if (!roomPath || !named.length) return null;
    const head = m.body.trimStart().replace(/^[#>*_\s]+/, "").toLowerCase();
    for (const { c, n } of named) {
      const here = (!!c.areaNode && (roomPath === c.areaNode || roomPath.startsWith(`${c.areaNode}/`))) || (!!c.project && roomPath === c.project);
      if (here && head.startsWith(n) && /^[*_]*\s*(:|\n|$)/.test(head.slice(n.length))) return c;
    }
    return null;
  };
}

// ------------------------------------------------------------------------------------------------- T-335: the ask's context, in its body
/** What an ask carries for him to act on: why, the exact steps, the links, how long it takes, and what he already said. */
export type AskContext = { why: string | null; steps: string[]; links: string[]; time: string | null; answered: string | null };
const CTX_HEAD = /^##[ \t]+(why|steps|links|time|already answered)[ \t]*$/i;
/**
 * The context block of an ask's note (uni-tasks `tasks.py new/set --context…` writes it at the end of the ask's own body; an older ask's
 * separate `ask-context` note holds the same sections): the `## Why`, `## Steps`, `## Links`, `## Time` and `## Already answered` sections,
 * each to the next `#` or `##` heading. null when the note carries none of them.
 */
export function askContext(content: unknown): AskContext | null {
  if (typeof content !== "string") return null;
  const parts = new Map<string, string[]>();
  let cur: string[] | null = null;
  for (const line of content.replace(/\r\n?/g, "\n").split("\n")) {
    const h = CTX_HEAD.exec(line);
    if (h) { cur = []; parts.set(h[1].toLowerCase(), cur); continue; }
    if (/^#{1,2}[ \t]/.test(line)) { cur = null; continue; }
    // a smaller heading inside a section (uni-tasks demotes the room's own to ####) is read as its words
    cur?.push(line.replace(/^#{3,6}[ \t]+/, ""));
  }
  const text = (k: string) => (parts.get(k) ?? []).join("\n").trim() || null;
  // a list item's marker goes ("- ", "1. "); its words stay as written
  const items = (k: string) => (parts.get(k) ?? []).map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim()).filter(Boolean);
  const ctx: AskContext = { why: text("why"), steps: items("steps"), links: items("links"), time: text("time"), answered: text("already answered") };
  return ctx.why || ctx.steps.length || ctx.links.length || ctx.time || ctx.answered ? ctx : null;
}
/** The fold's one line: "Steps and links · About 5 minutes" (what it holds, and how long it takes when the room said); a context with only
 *  its time is that time. */
export function contextLine(c: AskContext): string {
  const has = [c.steps.length ? "steps" : null, c.links.length ? "links" : null].filter(Boolean) as string[];
  const what = has.length ? `${has.join(" and ")}` : c.why ? "why" : c.answered ? "what you said before" : null;
  return [what ? what[0].toUpperCase() + what.slice(1) : null, c.time ? c.time.split("\n")[0] : null].filter(Boolean).join(" · ");
}
/** Text cut at its web links: `[words](https://…)` and bare `https://…` addresses, a bare one without the sentence's closing punctuation
 *  or an unbalanced closing bracket. */
export function linkParts(text: string): { text: string; url?: string; label?: string }[] {
  const out: { text: string; url?: string; label?: string }[] = [];
  const re = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|https?:\/\/[^\s<>]+/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let url = m[2] ?? m[0], end = m.index + m[0].length;
    if (!m[2]) {
      // a bare address: its trailing . , ; : ! ? and any ) it didn't open stay text
      while (/[.,;:!?'"]$/.test(url) || (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0))) { url = url.slice(0, -1); end--; }
    }
    if (m.index > at) out.push({ text: text.slice(at, m.index) });
    out.push({ text: m[0], url, ...(m[1] ? { label: m[1] } : {}) });
    at = end; re.lastIndex = end;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}
