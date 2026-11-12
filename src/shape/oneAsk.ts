// T-335 one ask, step 2: the app draws one card. Everything that asks the owner something becomes one `Card`, drawn one way in its room's
// chat, on home and in the bar's count, by one rule:
// - a room's ask (uni-ask SPEC.md: a signed message in its room), read by the shared library (src/ask), whose state is worked out from the
//   room's messages and the clock: nothing stored, nothing swept;
// - through the translation layer, today's asks: a task that needs him (asksCore.ts, as uni-tasks marks it) and an approval waiting for a
//   tap (Uni's sealed card, or a Hermes prompt). A task that only says "tap the card" folds into that card while the card waits: one card,
//   carrying the task's words when it is in the same room. Step 4 deletes this layer, once rooms ask with one verb.
// Pure: no React, no Tauri, no clock but the `now` it is given (unit-tested in scripts/oneAsk.test.ts).
import { buildAnswer, roomAsks, wakes, type Ask as RoomAsk, type AskState, type Policy, type Template } from "../ask/index.ts";
import { commandLine, type Approval } from "../approvals.ts";
import { cardIs, waitingTitle } from "../sealedCardCore.ts";
import { dayWords, laterUntil, type VaultAsk } from "./asksCore.ts";

export type CardKind = "tell" | "look" | "choose" | "do" | "approve" | "give";
/** Where it is in its life: `open` wants him now; `later` he put it off; the rest are over (drawn folded, in place, where it was asked). */
export type CardState = "open" | "later" | "answered" | "closed" | "lapsed";
export type CardOption = { id: string; label: string };

/** One ask, whatever made it. */
export type Card = {
  /** Unique across sources: a room ask's or approval's event id, a task note's id. */ id: string;
  /** What made it: a room's ask, a task (translated), Uni's approval card, a Hermes prompt (both translated). */ source: "room" | "task" | "card" | "prompt";
  /** The room it belongs to (channel id); null: no room this device has. */ room: string | null;
  kind: CardKind;
  /** What it wants, one line. */ what: string;
  /** Why now. */ why: string | null;
  /** (a task's) its next action, one line. */ next: string | null;
  /** (a room ask's) its context, as the asker wrote it. */ context: string | null;
  /** The task it belongs to (`T-NN`). */ tid: string | null;
  options: CardOption[];
  /** What happens if he does nothing (its words), when it names a default. */ fallback: string | null;
  link: string | null;
  /** Seconds: when it was asked (a room's movement). */ at: number;
  /** Seconds: when it lapses (leaves every list by the clock); null: it names no time. */ until: number | null;
  state: CardState;
  /** Seconds: Later's time, while put off. */ later: number | null;
  /** How it ended, when it has: one line ("You picked B", "Seen", "Lapsed"). */ ended: string | null;
  /** A private room's: drawn in full only inside that room, wordless on home. */ private?: boolean;
  /** The room ask, to answer it (source room). */ ask?: RoomAsk;
  /** The task, to answer it (source task); a card's folded task (source card). */ task?: VaultAsk;
  /** The approval (source card, prompt). */ approval?: Approval;
};

/** The words for how a room ask ended. */
const CLOSED: Record<string, string> = { done: "Done", withdrawn: "Withdrawn", overtaken: "Asked again", default: "Default taken", late: "Answered too late", approved: "Approved", declined: "Declined", given: "Given", closed: "Closed" };
function endedLine(st: AskState): string | null {
  const a = st.answer;
  if (st.state === "answered" && a) {
    if (a.type === "pick") return `You picked ${st.ask?.options?.find((o) => o.id === a.pick)?.label ?? a.pick}`;
    return ({ words: "You answered", did: "You did it", seen: "Seen", archive: "Archived", approve: "Approved", decline: "Declined", give: "Given" } as Record<string, string>)[a.type] ?? "Answered";
  }
  if (st.state === "closed") return CLOSED[st.close?.why ?? "closed"] ?? "Closed";
  if (st.state === "lapsed") return "Lapsed";
  return null;
}

/** A room's ask as a card (state "none", not an ask: null). */
export function roomCard(st: AskState, priv: (room: string) => boolean = () => false): Card | null {
  const a = st.ask;
  if (!a || st.state === "none") return null;
  return {
    id: a.id, source: "room", room: a.room, kind: a.kind, what: a.what, why: a.why, next: null, context: a.context ?? null, tid: a.task ?? null,
    options: a.options ?? [],
    fallback: a.default === undefined ? null : a.kind === "choose" ? a.options?.find((o) => o.id === a.default)?.label ?? a.default : a.default,
    link: null, at: a.at, until: a.until, state: st.state, later: st.later_until, ended: endedLine(st),
    ...(priv(a.room) ? { private: true } : {}), ask: a,
  };
}

/** Every ask the room events hold (any room), each with its state at `now`. Not yet asks ("none") are left out. */
export function roomCards(events: unknown[], now: number, policy: Policy, priv?: (room: string) => boolean): Card[] {
  return roomAsks(events, now, policy).map((s) => roomCard(s, priv)).filter((c): c is Card => c !== null);
}

/** Which room ask each answer message names (answer event id -> ask id), for drawing an answer as a quote of its ask in the main line. */
export function answersOf(events: unknown[], now: number, policy: Policy): Map<string, string> {
  const out = new Map<string, string>();
  const owner = new Set(policy.owner);
  const asks = new Set(roomAsks(events, now, policy).map((s) => s.id));
  for (const e of events as { id?: unknown; pubkey?: unknown; kind?: unknown; tags?: unknown }[]) {
    if (!e || e.kind !== 9 || typeof e.id !== "string" || !owner.has(String(e.pubkey)) || !Array.isArray(e.tags)) continue;
    const q = (e.tags as unknown[]).find((t): t is string[] => Array.isArray(t) && t[0] === "q" && typeof t[1] === "string" && asks.has(t[1]));
    if (q) out.set(e.id, q[1]);
  }
  return out;
}

/** A task that needs him as a card (the translation layer). */
export function taskCard(a: VaultAsk): Card {
  const kind: CardKind = a.kind === "decision" ? "choose" : a.kind;
  const options = a.options.map((label) => ({ id: label, label }));
  return {
    id: a.id, source: "task", room: a.room, kind, what: a.what, why: a.why, next: a.next ?? null, context: null, tid: a.tid,
    options: a.fallback ? [{ id: a.fallback.value, label: a.fallback.label }, ...options] : options,
    fallback: a.fallback?.label ?? null, link: a.link, at: a.updatedAt, until: null, state: "open", later: null, ended: null,
    ...(a.private ? { private: true } : {}), task: a,
  };
}

/** An approval waiting for a tap as a card (the translation layer): Uni's sealed card (answered on the card), or a Hermes prompt (answered
 *  in its room's composer). `folded`: the task that asked him to tap it, when it is in the card's own room (its words stay in their room). */
export function approvalCard(a: Approval, folded: VaultAsk | null, priv: (room: string) => boolean = () => false): Card {
  const until = a.kind === "sealed" && a.sealed ? a.sealed.expires : a.deadline;
  const what = a.kind === "sealed" ? (a.sealed ? waitingTitle(a.sealed) : commandLine(a)) : `${a.kind === "smart-deny" ? "Override: " : ""}OK to run ${commandLine(a)}?`;
  return {
    id: a.ref, source: a.kind === "sealed" ? "card" : "prompt", room: a.channel, kind: "approve",
    what: folded?.what ?? what, why: folded?.why ?? (a.kind === "sealed" ? null : a.why?.trim() || null), next: folded ? what : null, context: null,
    tid: folded?.tid ?? null, options: [], fallback: null, link: null, at: a.ts, until, state: "open", later: null, ended: null,
    ...(priv(a.channel) ? { private: true } : {}), approval: a, ...(folded ? { task: folded } : {}),
  };
}

/** Is it on his list at `now`? Open and not lapsed, by the clock alone. */
export const onList = (c: Pick<Card, "state" | "until">, now: number): boolean => c.state === "open" && (c.until === null || now < c.until);

export type OneList = {
  /** Every card on his list, newest first. */ cards: Card[];
  /** The same, by room (each room's newest first). */ byRoom: Map<string, Card[]>;
  /** Every room ask this device holds, open or over, by id: the chat draws each where it was asked. */ asked: Map<string, Card>;
  /** Approval cards on the list by their message id: the chat draws each where it was posted. */ approvals: Map<string, Card>;
};

/**
 * The one list. `tasks`: the tasks on his list (already placed and judged for privacy, asksCore.asksPlaced); `onCard`: tasks that only ask
 * him to tap a card (uni-tasks "on its card"), never drawn, only folded; `approvals`: what waits for a tap now. A task naming a card that
 * waits is that card: it folds into it (its words ride along only when it is in the card's room) and is not drawn on its own.
 */
export function oneList(o: { room: readonly Card[]; tasks: readonly VaultAsk[]; onCard?: readonly VaultAsk[]; approvals: readonly Approval[]; now: number; priv?: (room: string) => boolean }): OneList {
  const { now } = o;
  const waitingCards = o.approvals.filter((a) => a.kind === "sealed");
  const cardFor = (t: VaultAsk) => (t.sealedCard ? waitingCards.find((a) => cardIs(t.sealedCard, a.ref)) ?? null : null);
  const folded = new Set<string>();
  const foldInto = new Map<string, VaultAsk>();
  for (const t of [...o.tasks, ...(o.onCard ?? [])]) {
    const c = cardFor(t);
    if (!c) continue;
    folded.add(t.id);
    // its words only in its own room (a task in another room keeps them there), the first that names it
    if (t.room === c.channel && !foldInto.has(c.ref)) foldInto.set(c.ref, t);
  }
  const asked = new Map(o.room.map((c) => [c.id, c]));
  const approvals = new Map<string, Card>();
  const all: Card[] = [];
  for (const c of o.room) if (onList(c, now)) all.push(c);
  for (const t of o.tasks) if (!folded.has(t.id)) all.push(taskCard(t));
  for (const a of o.approvals) {
    const c = approvalCard(a, foldInto.get(a.ref) ?? null, o.priv);
    if (!onList(c, now)) continue;
    approvals.set(a.ref, c);
    all.push(c);
  }
  const seen = new Set<string>();
  const cards = all.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true))).sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  const byRoom = new Map<string, Card[]>();
  for (const c of cards) { if (!c.room) continue; const l = byRoom.get(c.room); if (l) l.push(c); else byRoom.set(c.room, [c]); }
  return { cards, byRoom, asked, approvals };
}

/** The next moment a card's state changes by the clock alone (a lapse, Later's end), after `now`: the app redraws then. No sweep: it reads. */
export function nextChange(cards: Iterable<Card>, now: number): number | null {
  let next: number | null = null;
  for (const c of cards) for (const t of [c.until, c.state === "later" ? c.later : null, c.until !== null ? c.until - BUTTON_GRACE : null]) {
    if (t !== null && t > now && (next === null || t < next)) next = t;
  }
  return next;
}
/** Buttons stop a minute before the lapse (the library's rule), so a tap can't land after the asker's deadline. */
const BUTTON_GRACE = 60;

// ------------------------------------------------------------------ the buttons: one rule for every card

export type CardAct = "pick" | "did" | "seen" | "later" | "reply" | "open" | "archive" | "room";
export type CardButton = { label: string; act: CardAct; value: string; primary: boolean; /** what it does, in one plain line */ does: string };

/**
 * A card's buttons, by its kind, the same for every source (Aaron, 11-11; T-335 asks in tune: each says what it does, none starts a new chat):
 * do: I did it, Seen, Later · choose: its options, Seen, Later · look: Open (its link), Seen · tell: Seen · approve, give: answered on the
 * card itself (a room's: Seen, Later). Opened (`open`), it adds Reply in the room and Archive. None while it can't be answered here.
 * `roomName`: for the words; `now`: Later's day and the minute before a lapse.
 */
export function cardButtons(c: Card, o: { open?: boolean; roomName?: string; now: number }): CardButton[] {
  const to = o.roomName ? `#${o.roomName}` : "its room";
  if (c.source === "card") return [];
  if (c.source === "prompt") return [{ label: "Answer in the room", act: "room", value: "", primary: true, does: `Opens ${to}, where you answer it` }];
  const answerable = c.state === "open" || c.state === "later";
  if (!answerable || (c.until !== null && o.now >= c.until - BUTTON_GRACE)) return [];
  const out: CardButton[] = [];
  const day = laterUntil(new Date(o.now * 1000));
  const later: CardButton = { label: `Later · ${dayWords(day).split(" ")[0]}`, act: "later", value: day, primary: false, does: `Off your list until ${dayWords(day)}, then back` };
  const seen: CardButton = { label: "Seen", act: "seen", value: "", primary: false, does: `Ends it for good; ${to} sees it on its next turn` };
  const sealed = c.kind === "approve" || c.kind === "give";
  if (c.kind === "do") out.push({ label: "I did it", act: "did", value: "", primary: false, does: `Ends it and tells ${to}, which does any follow-up` }, seen, later);
  else if (c.kind === "choose") out.push(...c.options.map((op): CardButton => ({ label: op.label, act: "pick", value: op.id, primary: false, does: `Your pick goes to ${to} and ends it` })), seen, later);
  else if (c.kind === "look") out.push(...(c.link ? [{ label: "Open", act: "open", value: c.link, primary: false, does: "Opens the link; Seen then ends it" } as CardButton] : []), seen);
  else if (sealed) out.push(seen, later);
  else out.push(seen);
  if (o.open) {
    if (c.room && !sealed) out.push({ label: "Reply in the room", act: "reply", value: "", primary: false, does: `Your words go to ${to}'s main line, quoting this, and end it` });
    out.push({ label: "Archive", act: "archive", value: "", primary: false, does: `Off your list for good; ${to} sees it on its next turn` });
  }
  if (out.length) out[0].primary = true;
  return out;
}

/** The library's answer to a room ask for a button (or a reply's words). Later's day is local midnight, at most the ask's lapse. */
export function roomAnswer(c: Card, b: Pick<CardButton, "act" | "value"> | { act: "words"; text: string }, now: number): Template {
  if (!c.ask) throw new Error("not a room ask");
  if (b.act === "words") return buildAnswer(c.ask, "words", { text: b.text });
  if (b.act === "pick") return buildAnswer(c.ask, "pick", { pick: b.value });
  if (b.act === "did") return buildAnswer(c.ask, "did");
  if (b.act === "seen") return buildAnswer(c.ask, "seen");
  if (b.act === "archive") return buildAnswer(c.ask, "archive");
  if (b.act === "later") {
    const [y, m, d] = b.value.split("-").map(Number);
    return buildAnswer(c.ask, "later", { later: Math.floor(new Date(y, m - 1, d).getTime() / 1000), now });
  }
  throw new Error(`no answer for ${b.act}`);
}
export { wakes };
