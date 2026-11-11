// T-335 the shape: asks. The things that need the owner (vault `task` notes with `needs_aaron: true`), read through the one reader, placed in
// their room, answered with buttons. Pure: no React, no Tauri, no clock but the `now` it is given (unit-tested in scripts/asks.test.ts).
// The hook (useAsks.ts) only reads and writes; the component (AskMessage.tsx) only draws.
//
// Moved here from For you (src/foryou/forYouCore.ts, retired with the bands, the cards and the areas tree): the field derivations of an ask
// (kind, what, why, options, default, action, link), the answer and Seen metadata, and the words its room is told. Whether an ask needs him
// is the task's own `needs_aaron`, as uni-tasks wrote it (the one rule: open, owned by him, fresh, in a live place with a live room).
import { privateWords, strings, unreadable } from "./privateWords.ts";
import type { Ask, ShapeRoom } from "./types.ts";
import { metaOf, type Note } from "../vault/reader.ts";
import { isPrivateName, isPrivatePath, isPrivateRoom, roomCluePrivate, roomView, type RoomRef } from "./privacy.ts";
import { ROOT, type Tree } from "../areas/treeCore.ts";
import { pathResolver } from "../areas/refs.ts";
import { isPrivateRoomName, successorOf, type RoomsRegistry } from "../areas/roomsRegistry.ts";

export type Kind = Ask["kind"];
/** An ask as the hook needs it to answer: the shared `Ask` plus what the write and the post need. */
export type VaultAsk = Ask & {
  /** The note's `updatedAt` as read: the revision every write is guarded by (a compare-and-set). */ rev: string;
  /** Its task state (open, doing, waiting): the `from` of the close. */ state: string;
  /** The room's name as the ask names it (`reply_room`, else `room`), no `#`; null when it names none. */ roomName: string | null;
  /** The post an answer threads under (`reply_root`): only in the room it names (in Uni's room, where it lands for want of its own, none). */ replyRoot: string | null;
  /** When its room last asked or confirmed it (ms): a seen ask asked again since shows again. */ askedAt: number | null;
};

/** The task states an ask can be answered from (the reader's live list asks for the same). */
const LIVE = new Set(["open", "doing", "waiting"]);
const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
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
function optionsOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((o) => (typeof o === "string" ? o.trim() : o && typeof o === "object" ? s((o as Record<string, unknown>).label) ?? s((o as Record<string, unknown>).name) ?? s((o as Record<string, unknown>).title) ?? "" : "")).filter(Boolean);
}
/** A stored date as ms, in the device's time: a date with no time is that local day's start (never UTC midnight, a day early in the west). */
export const ms = (v: string | null): number | null => { if (!v) return null; const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00` : v); return Number.isFinite(t) ? t : null; };

const DAY = 86_400_000;
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

/** A room's name as privacy.ts roomByName matches it: case, a leading `#`, spaces and punctuation aside, each `a/b` segment on its own. */
const loose = (name: string): string => name.toLowerCase().replace(/^#/, "").trim().split("/").map((p) => p.replace(/[^a-z0-9]+/g, "")).join("/");

/** A room's name as the rooms list is matched by it: case-insensitive, a leading `#` ignored. */
export const roomKey = (name: string): string => name.trim().replace(/^#/, "").trim().toLowerCase();

/**
 * The asks: the reader's task notes that need him (`needs_aaron === true`, still open), newest first, each placed in its room.
 *
 * Its room is the one it names (`reply_room`, else `room`), by channel id or by name among the rooms home shows (`opts.hidden` left out). Two
 * live rooms of that name: the one that isn't a DM, else the one the registry lists, else none (Uni's room: never a guess). A name with no
 * live room (an old name, a retired or folded room, one this device doesn't have) goes where its work went: the registry's successor, else
 * the room_fallback of a node that marks that room archived, else its own node's room (the tree's steward), else Uni's room (`opts.uniRoom`).
 * Only in the room it names is it threaded under its `reply_root`.
 *
 * Privacy is judged on the result, by names, the registry (`opts.reg`), `opts.privateRooms` (ids or names) and the node tree (`opts.tree`):
 * a private node or card (by its name, or inside a private area however it is linked there), a private room named, or a room a private
 * place owns under any name. Such an ask is `private` and kept only when it lands in a private room of this device (drawn in full there,
 * wordless on home); otherwise it is dropped: its words never land in Uni's room or a public one. `opts.tree` null: the tree isn't read
 * yet, and only an ask with no node, card or room named (Uni's room's own) can be judged; the rest wait.
 */
export type AskPlacing = {
  uniRoom: string | null;
  privateRooms?: ReadonlySet<string>;
  /** The areas and projects (null: not read yet). */ tree: Tree | null;
  reg?: RoomsRegistry | null;
  /** Rooms home leaves out (retired, folded): no place for an ask. */ hidden?: ReadonlySet<string>;
  /** ms; default labels' dates ("Fri 5pm") are relative to it */ now?: number;
};
/** The asks, placed. A private one that has no private room of its own on this device is never drawn: `asksPlaced` says how many, so home can
 *  say that something waits out of sight (a number, never a word of it). */
export function asksFrom(notes: readonly Note<"task">[], rooms: readonly ShapeRoom[], opts: AskPlacing): VaultAsk[] {
  return asksPlaced(notes, rooms, opts).asks;
}
export function asksPlaced(notes: readonly Note<"task">[], rooms: readonly ShapeRoom[], opts: AskPlacing): { asks: VaultAsk[]; unseen: number } {
  let unseen = 0;
  const now = opts.now ?? Date.now();
  const { tree, reg = null } = opts;
  const hidden = opts.hidden ?? new Set<string>();
  const live = rooms.filter((r) => !hidden.has(r.id));
  const refs: RoomRef[] = live.map((r) => ({ id: r.id, name: r.name }));
  const allRefs: RoomRef[] = rooms.map((r) => ({ id: r.id, name: r.name }));
  const uni = refs.find((r) => r.id === opts.uniRoom) ?? null;
  const resolve = tree ? pathResolver([...tree.nodes.values(), ...tree.archived]) : null;
  const priv = new Set([...(opts.privateRooms ?? [])].map(roomKey));
  const privLoose = new Set([...(opts.privateRooms ?? [])].map(loose));
  // the names of the nodes inside a private place: a room named after one is that place's, whether or not this device has it
  const privNodeNames = new Set(tree ? [...tree.nodes.values(), ...tree.archived].filter((n) => isPrivatePath(tree, n.path)).map((n) => loose(n.name)).filter(Boolean) : []);
  const listed = new Set(reg ? Object.values(reg.rooms).map((x) => x.id?.toLowerCase()).filter((x): x is string => !!x) : []);
  const namePrivate = (p: string | null) => !!p && p.replace(/^#/, "").split("/").some((w) => isPrivateName(w.trim()));
  const roomPrivate = (r: ShapeRoom) => priv.has(roomKey(r.id)) || priv.has(roomKey(r.name)) || privLoose.has(loose(r.name)) || namePrivate(r.name)
    || (!!reg && isPrivateRoomName(reg, r.name)) || (!!tree && isPrivateRoom(tree, r.id, allRefs, uni));
  /**
   * A live room by id, else by name, matched as the app matches room names everywhere (privacy.ts roomByName: case, `#`, spaces and
   * dashes aside). `twins`: every live room of that name when there is more than one (their privacy counts, whichever is picked).
   */
  const pick = (name: string): { room: ShapeRoom | null; twins: ShapeRoom[] } => {
    const byId = live.find((r) => r.id === name);
    if (byId) return { room: byId, twins: [] };
    const want = loose(name);
    const all = want ? live.filter((r) => loose(r.name) === want) : [];
    if (all.length <= 1) return { room: all[0] ?? null, twins: [] };
    const rooms = all.filter((r) => r.dm !== true);
    if (rooms.length === 1) return { room: rooms[0], twins: all };
    const pool = rooms.length ? rooms : all;
    const reged = pool.filter((r) => listed.has(r.id.toLowerCase()));
    return { room: reged.length === 1 ? reged[0] : null, twins: all };
  };
  /** The channel ids the registry gives a room name (its own name or one it was known by). */
  const regIds = (nm: string): string[] => (reg ? Object.entries(reg.rooms).filter(([k, v]) => !!v.id && (loose(k) === loose(nm) || (v.was ?? []).some((w) => loose(w) === loose(nm)))).map(([, v]) => v.id!) : []);
  // the one conservative judge: any spelling, any number of moves, either room field (privateWords.ts)
  const words = privateWords({ tree: tree ?? null, reg, rooms: allRefs, uni, known: opts.privateRooms });
  const out: VaultAsk[] = [];
  const seen = new Set<string>();
  for (const n of notes) {
    const id = s(n.id), path = refPath(n.path);
    if (!id || !path || seen.has(id)) continue;
    // an old `Decisions/` note is the record, not an ask (T-335 one home): only tasks are asks
    if (!tagsOf(n).includes("task")) continue;
    const m = metaOf(n, "task");
    // whether it needs him is the task's needs_aaron, as uni-tasks wrote it (the one rule)
    if (m.needs_aaron !== true) continue;
    const state = s(m.state) ?? "";
    if (!LIVE.has(state)) continue;
    seen.add(id);
    // (a field may hold a list: its first word is the room it is placed by; every word is judged for privacy below)
    const named = (strings(m.reply_room)[0] ?? strings(m.room)[0])?.replace(/^#/, "").trim() || null;
    /** Anything at all in a field that names a place, whatever its shape. */
    const says = (v: unknown) => v !== undefined && v !== null && v !== "";
    // before the tree is read, a node, a card or a named room can't be judged (a room may be a private area's under any name): it waits
    if (!tree && (says(m.reply_room) || says(m.room) || says(m.node) || says(m.card))) continue;
    const node = resolve?.(m.node) ?? null;
    let room: ShapeRoom | null = null, direct = false, twins: ShapeRoom[] = [];
    // every name its work is said to have moved to (the registry's successor, a node's room_fallback): a private one hushes the ask
    // even when this device has no such room, so it never falls through to Uni's room
    const moved: string[] = [];
    // the rooms it names that are gone from home (a retired or folded channel): their privacy counts too
    const gone = named ? rooms.filter((r) => hidden.has(r.id) && (r.id === named || loose(r.name) === loose(named))) : [];
    if (named) {
      const p = pick(named);
      room = p.room; twins = p.twins; direct = !!room;
      if (!room && !twins.length) {
        // where its work went: the registry's successor (an old name, a retired or folded room)
        const next = reg ? gone.map((g) => successorOf(reg, g.id)).find(Boolean) ?? successorOf(reg, named) : null;
        if (next) { moved.push(next); room = pick(next).room; }
        // a node that marks the room archived names the room it moved to
        if (!room && tree) for (const a of [...tree.nodes.values(), ...tree.archived]) {
          const md = a.metadata;
          if (typeof md.room !== "string" || roomKey(md.room) !== roomKey(named) || !/^(archived|missing)$/i.test(String(md.room_status ?? "")) || typeof md.room_fallback !== "string") continue;
          const to = md.room_fallback.replace(/^#/, "").trim();
          moved.push(to);
          room = pick(to).room;
          if (room) break;
        }
        // its own node's room (its own, else an ancestor's)
        if (!room && tree && node && node !== ROOT) { const t = roomView(tree, node, refs, uni).target; room = t && t.id !== uni?.id ? live.find((r) => r.id === t.id) ?? null : null; }
      }
    }
    const privatePath = (v: unknown) => namePrivate(refPath(v)) || (!!tree && !!resolve && (() => { const at = resolve(v); return !!at && isPrivatePath(tree, at); })());
    /** A room's name says private: by its own words, the rooms known private, a private node's name, the registry, or the tree. */
    const clue = (nm: string) => namePrivate(nm) || priv.has(roomKey(nm)) || privLoose.has(loose(nm)) || privNodeNames.has(loose(nm)) || (!!reg && isPrivateRoomName(reg, nm)) || (!!tree && roomCluePrivate(tree, nm, allRefs, uni))
      // a room this device doesn't have, known only by the registry's channel id for its name: private when a private place owns that channel
      || (!!tree && regIds(nm).some((id) => isPrivateRoom(tree, id, allRefs, uni)));
    const namedPrivate = (!!named && clue(named)) || moved.some(clue);
    // (the room it lands in is judged by what that room IS, never by a name it shares: a public twin of a private room stays public,
    // and an ask the words taint is then dropped, not drawn in it)
    const targetPrivate = !!room && roomPrivate(room);
    // every word on the ask that could point at a private place: both room fields, where the work moved, the node, the card
    // (a field that says something but holds no word to read can't be judged: it counts as private)
    const unread = [m.reply_room, m.room, m.node, m.card].some(unreadable);
    const tainted = unread || [m.reply_room, m.room, ...moved].some(words.room) || words.ref(m.node) || words.ref(m.card);
    const hush = tainted || namedPrivate || targetPrivate || gone.some(roomPrivate) || twins.some(roomPrivate) || privatePath(m.node) || privatePath(m.card);
    if (hush && !targetPrivate) { unseen++; continue; }
    const kindRaw = s(m.kind)?.toLowerCase();
    const kind: Kind = kindRaw === "choose" || kindRaw === "look" || kindRaw === "tell" ? kindRaw : tagsOf(n).includes("decision") ? "choose" : "do";
    const { tid, rest } = splitTitle(path);
    const options = optionsOf(m.options);
    const noDefault = m.no_default === true || !s(m.default);
    const defValue = noDefault ? null : s(m.default)!;
    const defAt = noDefault ? null : s(m.default_at);
    const choices = kind === "choose" ? options.filter((o) => o !== defValue) : [];
    const updated = ms(s(n.updatedAt));
    const asked = [s(m.asked_at), s(m.confirmed_at)].map(ms).filter((t): t is number => t !== null);
    out.push({
      id, tid, room: room?.id ?? opts.uniRoom, kind, what: rest, next: s(m.next), why: s(m.why_now),
      options: choices,
      fallback: defValue ? { value: defValue, label: [defValue, whenLabel(defAt, now)].filter(Boolean).join(" · ") } : null,
      // the plain action when there is no option to pick: Done (a do ask). A tell or look ask's one tap is Seen (T-335 Seen)
      action: choices.length || kind === "tell" || kind === "look" ? null : "Done",
      // a look-here pin: its deep link (look_url, uni-tasks look.py) is the point, before any other link; the Arcade's opens in the app (src/openLink.ts)
      link: s(m.look_url) ?? s(m.link) ?? s(m.url),
      updatedAt: updated === null ? 0 : Math.floor(updated / 1000),
      rev: s(n.updatedAt) ?? "", state, roomName: named, replyRoot: direct ? s(m.reply_root) : null, askedAt: asked.length ? Math.max(...asked) : null,
      ...(hush ? { private: true } : {}),
      // T-335 cards expand: the card a "Tap the … card" ask means (uni-tasks --sealed-card), so the ask shows where that card stands
      // (not in the vault's task schema yet: read as the note holds it)
      ...(sealedRef((m as Record<string, unknown>).sealed_card) ? { sealedCard: sealedRef((m as Record<string, unknown>).sealed_card) } : {}),
    });
  }
  return { asks: out.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)), unseen };
}

/** An ask's `sealed_card`: a card's event id, or at least its first 12 hex, lower-cased; null for anything else. */
export const sealedRef = (v: unknown): string | null => { const r = s(v)?.toLowerCase() ?? null; return r && /^[0-9a-f]{12,64}$/.test(r) ? r : null; };

/** The asks by their room's channel id (an ask with no room, when there is no Uni room either, is in no room). Each room's newest first. */
export function asksByRoom<A extends Ask>(asks: readonly A[]): Map<string, A[]> {
  const by = new Map<string, A[]>();
  for (const a of asks) { if (!a.room) continue; const l = by.get(a.room); if (l) l.push(a); else by.set(a.room, [a]); }
  return by;
}

/**
 * What this device answered or saw, hidden from the list at once, before the vault's list catches up. A seen ask its room has asked again
 * since (a newer asked_at or confirmed_at) is his again: it shows (an answer closed its ask, so that one stays hidden).
 */
export type Gone = { at: number; seen: boolean };
export function visibleAsks<A extends Pick<VaultAsk, "id" | "askedAt">>(asks: readonly A[], gone: ReadonlyMap<string, Gone>): A[] {
  return asks.filter((a) => { const g = gone.get(a.id); return !g || (g.seen && (a.askedAt ?? -Infinity) > g.at); });
}

// ------------------------------------------------------------------ answering

/** The words a room is told: `T-NN: <answer>`; an ask with no id says its question. */
export function answerBody(ask: Pick<Ask, "tid" | "what">, answer: string): string {
  return `${ask.tid ?? ask.what}: ${answer.trim()}`;
}
/** The metadata written with the close (CONTRACT "Answering an ask"): one compare-and-set on `state` with these, in the same write. A pick
 *  of a choose ask (its default or one of its options) is a decision too. */
export function answerMeta(ask: Pick<Ask, "kind" | "options" | "fallback">, answer: string, by: string, at: string): Record<string, string> {
  const m: Record<string, string> = { answer: answer.trim(), answered_at: at, answered_by: by };
  const picked = ask.kind === "choose" && (ask.fallback?.value === answer || ask.options.includes(answer));
  if (picked) Object.assign(m, { decided: answer, decided_at: at, decided_by: by });
  return m;
}

// ------------------------------------------------------------------ T-335 Seen (11-09): "I should really be able to just mark it as seen... to note that I'm aware of it"

/** A tell or look ask closes on Seen; a do or choose ask stays open with its room (it still needs his steer later: the room asks again). */
export const seenCloses = (kind: Kind): boolean => kind === "tell" || kind === "look";
/** What Seen writes (uni-tasks `tasks.py seen` writes the same): who and when, and out of the asks by the one rule's field, never an answer. A
 *  tell or look ask's write closes it too (one compare-and-set on `state`); a do or choose ask's is a metadata patch on the revision shown. */
export function seenMeta(by: string, at: string): { seen_at: string; seen_by: string; needs_aaron: false; needs_aaron_why: "seen" } {
  return { seen_at: at, seen_by: by, needs_aaron: false, needs_aaron_why: "seen" };
}
/** The one quiet line its room is told (posted to the room, not addressed to its Uni: it wakes nobody; uni-tasks seen_words). */
export function seenBody(ask: Pick<Ask, "tid" | "what" | "kind">): string {
  const id = ask.tid ?? ask.what;
  return seenCloses(ask.kind) ? `${id}: seen.` : `${id}: seen. It stays open here until it needs my steer; ask again then.`;
}

// ------------------------------------------------------------------ T-335 fixes (11-11): every ask opens to its context and an action

/** "Not now" on a do or choose ask: the same write as Seen (it stays open with its room, out of his view until it is asked again). */
export function notNowBody(ask: Pick<Ask, "tid" | "what">): string {
  return `${ask.tid ?? ask.what}: not now. It stays open here; ask again when it needs my steer.`;
}
/** "Done" on a do ask: he did it. Like tasks.py handback, the ask goes back to its room (addressed to its Uni, so it wakes) for any
 *  follow-up, and the room closes it; the app's write takes it out of his view (Seen's write: the room's handback moves the owner). */
export function doneBody(ask: Pick<Ask, "tid" | "what">): string {
  return ask.tid
    ? `${ask.tid}: I did this. Hand it back to this room for any follow-up (tasks.py handback ${ask.tid}), then post [done ${ask.tid}].`
    : `${ask.what}: I did this. Do any follow-up it needs, then close it.`;
}
/** "Archive": out of his view for good (state archived); one quiet line in its room, so the room sees it. */
export function archiveBody(ask: Pick<Ask, "tid" | "what">): string {
  return `${ask.tid ?? ask.what}: archived. It's out of my view; open a new ask if it still needs me.`;
}

/** The ask a waiting run is about: the live ask on the run's own task (`T-NN`), else none. */
export function askForRun<A extends Pick<Ask, "tid">>(run: { task?: string | null }, asks: readonly A[]): A | null {
  const t = run.task?.trim().toUpperCase();
  return t ? asks.find((a) => a.tid === t) ?? null : null;
}

/** An ask with no body and no next action is a data fault (the room wrote it without its context): still shown, still answerable. */
export const askFault = (ask: Pick<Ask, "next">, body: string | null): boolean => !ask.next?.trim() && !(body ?? "").trim();

/** Kind in one word, for the sheet's head. */
export const KIND_WORD: Record<Ask["kind"], string> = { do: "To do", choose: "Choose", look: "Look", tell: "For you to know", decision: "Choose" };

/**
 * The body of an ask's note as the sheet shows it: tasks.py's context block (## Why, ## Steps, ## Links, ## Time, ## Already answered) and
 * whatever is above it, minus a front matter block and a first `# heading` (the sheet's own title says it).
 */
export function askBody(content: string | null | undefined): string {
  let b = String(content ?? "").replace(/\r\n?/g, "\n");
  b = b.replace(/^---\n[\s\S]*?\n---\n/, "");
  b = b.replace(/^\s*# [^\n]*\n?/, "");
  return b.trim();
}

// ------------------------------------------------------------------ the buttons

export type AskAct = "answer" | "done" | "notnow" | "seen" | "open" | "archive";
export type AskButton = { label: string; value: string; primary: boolean; act: AskAct };
/**
 * An ask's buttons, by its kind (Aaron, 11-11: "I should really be able to just mark it as seen or archive it"):
 * - do: Done (he did it: back to its room) and Not now;
 * - choose: one button per option (the default first, with its date), and Not now;
 * - look: Open (its link) and Seen;
 * - tell: Seen.
 * `archive`: Archive last (the sheet; every ask has it there). The first is the primary one.
 */
export function askButtons(ask: Pick<Ask, "kind" | "options" | "fallback" | "action" | "link">, o: { archive?: boolean } = {}): AskButton[] {
  const out: AskButton[] = [];
  const kind = ask.kind === "decision" ? "choose" : ask.kind;
  if (kind === "do") {
    out.push({ label: "Done", value: "Done", primary: false, act: "done" });
    out.push({ label: "Not now", value: "Not now", primary: false, act: "notnow" });
  } else if (kind === "choose") {
    if (ask.fallback) out.push({ label: ask.fallback.label, value: ask.fallback.value, primary: false, act: "answer" });
    for (const opt of ask.options) out.push({ label: opt, value: opt, primary: false, act: "answer" });
    out.push({ label: "Not now", value: "Not now", primary: false, act: "notnow" });
  } else {
    if (kind === "look" && ask.link) out.push({ label: "Open", value: ask.link, primary: false, act: "open" });
    out.push({ label: "Seen", value: "Seen", primary: false, act: "seen" });
  }
  if (o.archive) out.push({ label: "Archive", value: "Archive", primary: false, act: "archive" });
  out[0].primary = true;
  return out;
}
/** Seen's words for a screen reader and a title: what it does to this ask. */
export const seenHint = (kind: Kind): string => (seenCloses(kind) ? "ends it; its room is told" : "it stays with its room until it needs you");
