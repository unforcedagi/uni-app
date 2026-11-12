/** The ask: build its messages and work out its state from them and the clock. SPEC.md is the contract; the
 * Python twin (python/uni_ask/ask.py) must agree on every case in cases/cases.json. */
import { checkEvent, type NostrEvent, type Tag, type Template } from "./nostr.ts";

export const MAX_SPAN_S = 14 * 86400;
export const BUTTON_GRACE_S = 60;
export const READ_BACK_S = 15 * 86400;
/** How far an asker's clock may run ahead of a reader's before the 14-day promise counts as broken. */
export const SKEW_S = 3600;
export const PAGE_LIMIT = 2000; // no more than the relay's own cap per request (Buzz: 2000)
export const MAX_PAGES = 1000;
/** Numbers in a block must be safe integers or ordinary decimals, read the same in every language. */
export const MAX_SAFE = Number.MAX_SAFE_INTEGER;
/** Nesting in a block; deeper is not a block (a reader must never fall over on one member's message). */
export const MAX_DEPTH = 32;
export const KIND_MESSAGE = 9, KIND_EDIT = 40003, KIND_DELETE = 5, KIND_SEALED_ANSWER = 46043;
export const FENCE_ASK = "uni-ask", FENCE_ANSWER = "uni-answer", FENCE_CLOSE = "uni-ask-close";

export const KINDS = ["tell", "look", "choose", "do", "approve", "give"] as const;
export const ANSWERS = ["pick", "words", "did", "seen", "later", "archive"] as const;
export const WHYS = ["done", "withdrawn", "overtaken", "default", "late", "approved", "declined", "given"] as const;
const STRONG: readonly string[] = ["pick", "words", "did"];
const WEAK: readonly string[] = ["seen", "archive"];
const WAKES: readonly string[] = ["pick", "words", "did"];
const SEALED: readonly string[] = ["approve", "give"];
const LINES: Record<string, string> = { did: "Did it.", seen: "Seen.", later: "Later.", archive: "Archived." };
const BLOCK_ORDER = ["v", "kind", "what", "why", "context", "until", "options", "default", "task", "grant", "secret",
  "seal_to"];
const OPT_ID = /^[a-z0-9][a-z0-9-]{0,23}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export type AskKind = typeof KINDS[number];
export type AnswerType = typeof ANSWERS[number];
export type State = "none" | "open" | "later" | "answered" | "closed" | "lapsed";
export interface Option { id: string; label: string }
export interface Ask {
  id: string; asker: string; room: string; at: number; kind: AskKind; what: string; why: string; until: number;
  context?: string; options?: Option[]; default?: string; task?: string; grant?: Record<string, unknown>;
  secret?: string; seal_to?: string;
}
export interface Answer {
  event: string; type: string; pick: string | null; text: string | null; at: number; via: "room" | "signature";
}
export interface Close { event: string; why: string; at: number }
export interface AskState {
  id: string; state: State; on_list: boolean; buttons: boolean; needs_close: boolean; later_until: number | null;
  answer: Answer | null; close: Close | null; ask: Ask | null; ignored: [string, string][];
}
export interface Policy { askers: string[]; owner: string[]; room?: string }

export class AskError extends Error {}

type Obj = Record<string, unknown>;
const INVALID = Symbol("invalid");
const has = (o: Obj, k: string) => Object.hasOwn(o, k);

/** A whole number (1 or 1.0), never a bool. */
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
const len = (s: string) => [...s].length; // code points, as Python counts
const text = (v: unknown, lo: number, hi: number, blankOk = false): v is string =>
  typeof v === "string" && len(v) >= lo && len(v) <= hi && (blankOk || v.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "") !== "");

/** The one ```<fence> block's JSON object; null when there is none; INVALID when there are several or it isn't one
 * JSON object. */
export function findBlock(content: string, fence: string): Obj | null | typeof INVALID {
  const lines = content.split("\n");
  const opens = lines.flatMap((l, i) => (l === "```" + fence ? [i] : []));
  if (opens.length === 0) return null;
  if (opens.length > 1) return INVALID;
  const start = opens[0] + 1;
  const end = lines.indexOf("```", start);
  if (end < 0) return INVALID;
  const src = lines.slice(start, end).join("\n");
  if (!shallow(src)) return INVALID;
  let obj: unknown;
  try { obj = JSON.parse(src, (_k, v) => (Object.is(v, -0) ? 0 : v)); } catch { return INVALID; } // -0 reads as 0, as in Python
  if (!numbersOk(obj)) return INVALID;
  return obj !== null && typeof obj === "object" && !Array.isArray(obj) ? (obj as Obj) : INVALID;
}

/** Whether the JSON text nests no deeper than MAX_DEPTH (checked before parsing, as the Python twin must). */
function shallow(src: string): boolean {
  let depth = 0, inStr = false, esc = false;
  for (const ch of src) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "[" || ch === "{") { if (++depth > MAX_DEPTH) return false; }
    else if (ch === "]" || ch === "}") depth--;
  }
  return true;
}

/** Every number finite, and a whole one within ±MAX_SAFE (Python reads bigger ones exactly, JavaScript can't). */
function numbersOk(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v) && (!Number.isInteger(v) || Math.abs(v) <= MAX_SAFE);
  if (Array.isArray(v)) return v.every(numbersOk);
  if (v !== null && typeof v === "object") return Object.values(v).every(numbersOk);
  return true;
}
const isObj = (b: unknown): b is Obj => b !== null && b !== INVALID && typeof b === "object";

const tagValues = (ev: { tags?: unknown }, name: string): string[] =>
  Array.isArray(ev.tags)
    ? ev.tags.filter((t): t is Tag => Array.isArray(t) && t.length >= 2 && t[0] === name && typeof t[1] === "string")
      .map((t) => t[1])
    : [];
const tag = (ev: { tags?: unknown }, name: string): string | null => tagValues(ev, name).find((v) => v) ?? null;
const cmp = (a: [number, string], b: [number, string]) => (a[0] - b[0]) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
const byOrder = (a: NostrEvent, b: NostrEvent) => cmp([a.created_at, a.id], [b.created_at, b.id]);

// --- the ask block ------------------------------------------------------------------------------------------------

/** Validate an ask block: [normalized fields, ""] or [null, reason]. */
export function checkBlock(block: Obj, createdAt: number): [Omit<Ask, "id" | "asker" | "room" | "at"> | null, string] {
  if (int(block.v) !== 1) return [null, "bad-version"];
  const kind = block.kind as AskKind;
  if (!(KINDS as readonly unknown[]).includes(kind)) return [null, "bad-kind"];
  if (!text(block.what, 1, 200)) return [null, "bad-what"];
  if (!text(block.why, 1, 500)) return [null, "bad-why"];
  const out: Omit<Ask, "id" | "asker" | "room" | "at"> = { kind, what: block.what, why: block.why, until: 0 };
  if (has(block, "context")) {
    if (!text(block.context, 0, 4000, true)) return [null, "bad-context"];
    out.context = block.context;
  }
  const until = int(block.until);
  if (until === null || !(createdAt < until && until <= createdAt + MAX_SPAN_S)) return [null, "bad-until"];
  out.until = until;
  const opts = block.options;
  if (kind === "choose") {
    if (!(Array.isArray(opts) && opts.length >= 2 && opts.length <= 6)) return [null, "bad-options"];
    const norm: Option[] = [];
    for (const o of opts) {
      const oid = o !== null && typeof o === "object" ? (o as Obj).id : undefined;
      if (!(typeof oid === "string" && OPT_ID.test(oid) && text((o as Obj).label, 1, 80))) return [null, "bad-options"];
      norm.push({ id: oid, label: (o as Obj).label as string });
    }
    if (new Set(norm.map((o) => o.id)).size !== norm.length) return [null, "bad-options"];
    out.options = norm;
  } else if (opts !== undefined && opts !== null) return [null, "bad-options"];
  if (has(block, "default")) {
    const d = block.default;
    let ok: boolean;
    if (kind === "choose") ok = out.options!.some((o) => o.id === d);
    else if (kind === "approve") ok = d === "decline";
    else if (kind === "give") ok = false;
    else ok = text(d, 1, 200);
    if (!ok) return [null, "bad-default"];
    out.default = d as string;
  }
  if (has(block, "task")) {
    if (!text(block.task, 1, 40)) return [null, "bad-task"];
    out.task = block.task;
  }
  if (kind === "approve") {
    if (!isObj(block.grant) || Array.isArray(block.grant)) return [null, "bad-grant"];
    out.grant = block.grant;
  } else if (has(block, "grant")) return [null, "bad-grant"];
  if (kind === "give") {
    if (!(text(block.secret, 1, 80) && typeof block.seal_to === "string" && HEX64.test(block.seal_to))) {
      return [null, "bad-secret"];
    }
    out.secret = block.secret;
    out.seal_to = block.seal_to;
  } else if (has(block, "secret") || has(block, "seal_to")) return [null, "bad-secret"];
  return [out, ""];
}

/** The ask an event is, or [null, reason]. The event must already have passed checkEvent. */
export function parseAsk(ev: NostrEvent, askers: Iterable<string>): [Ask | null, string] {
  if (ev.kind !== KIND_MESSAGE) return [null, "not-a-message"];
  const block = findBlock(ev.content, FENCE_ASK);
  if (block === null) return [null, "no-block"];
  if (!isObj(block)) return [null, "bad-block"];
  if (!(askers instanceof Set ? askers : new Set(askers)).has(ev.pubkey)) return [null, "not-an-asker"];
  const room = tag(ev, "h");
  if (room === null) return [null, "no-room"];
  const [fields, why] = checkBlock(block, ev.created_at);
  if (!fields) return [null, why];
  return [{ id: ev.id, asker: ev.pubkey, room, at: ev.created_at, ...fields }, ""];
}

// --- the state rule -----------------------------------------------------------------------------------------------

function refs(ev: { tags?: unknown; content?: unknown }): Set<string> {
  const out = new Set([...tagValues(ev, "q"), ...tagValues(ev, "e")]);
  if (typeof ev.content === "string") {
    for (const fence of [FENCE_ANSWER, FENCE_CLOSE]) {
      const b = findBlock(ev.content, fence);
      if (isObj(b) && typeof b.ask === "string") out.add(b.ask);
    }
  }
  return out;
}

function verified(events: unknown[]): [Map<string, NostrEvent>, [unknown, string][]] {
  const good = new Map<string, NostrEvent>();
  const bad: [unknown, string][] = [];
  for (const ev of events) {
    const why = checkEvent(ev);
    if (why === null) { const e = ev as NostrEvent; if (!good.has(e.id)) good.set(e.id, e); }
    else bad.push([ev, why]);
  }
  return [good, bad];
}

const none = (id: string): AskState => ({ id, state: "none", on_list: false, buttons: false, needs_close: false,
  later_until: null, answer: null, close: null, ask: null, ignored: [] });

type Got = Answer & { later?: number };

function answerOf(ev: NostrEvent, ask: Ask): [Got | null, string] {
  const block = findBlock(ev.content, FENCE_ANSWER);
  if (block === INVALID) return [null, "bad-block"];
  let a: string;
  let pick: string | null = null, words: string | null = null, later: number | undefined;
  if (block === null) {
    if (![...tagValues(ev, "q"), ...tagValues(ev, "e")].includes(ask.id)) return [null, "bad-ref"];
    a = "words";
    words = ev.content;
  } else {
    if (int(block.v) !== 1 || block.ask !== ask.id || !(ANSWERS as readonly unknown[]).includes(block.a)) {
      return [null, "bad-block"];
    }
    a = block.a as string;
    if (a === "pick") {
      if (ask.kind !== "choose" || !ask.options!.some((o) => o.id === block.pick)) return [null, "bad-pick"];
      pick = block.pick as string;
    } else if (a === "later") {
      const l = int(block.later);
      if (l === null || l <= ev.created_at) return [null, "bad-block"];
      later = l;
    } else if (a === "words") {
      if (!text(block.text, 1, 100000)) return [null, "bad-block"];
      words = block.text;
    }
  }
  if (SEALED.includes(ask.kind) && STRONG.includes(a)) return [null, "takes-signature"];
  if (ev.created_at > ask.until) return [null, "late"];
  const got: Got = { event: ev.id, type: a, pick, text: words, at: ev.created_at, via: "room" };
  if (later !== undefined) got.later = later;
  return [got, ""];
}

function closeOf(ev: NostrEvent, ask: Ask): [Close | null, string] {
  if (ev.kind === KIND_DELETE) return [{ event: ev.id, why: "withdrawn", at: ev.created_at }, ""];
  if (tag(ev, "e") !== ask.id) return [null, "bad-ref"];
  if (findBlock(ev.content, FENCE_ASK) !== null) return [null, "edit-keeps-ask"];
  const block = findBlock(ev.content, FENCE_CLOSE);
  let why = "closed";
  if (isObj(block) && block.ask === ask.id && (WHYS as readonly unknown[]).includes(block.why)) why = block.why as string;
  return [{ event: ev.id, why, at: ev.created_at }, ""];
}

const isId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

interface Index { good: Map<string, NostrEvent>; byAsk: Map<string, NostrEvent[]>; badByAsk: Map<string, [string, string][]> }

/** Verify, sort and work out what each event refers to, once per read (not once per ask). */
function index(events: unknown[]): Index {
  const [good, bad] = verified(events);
  const byAsk = new Map<string, NostrEvent[]>(), badByAsk = new Map<string, [string, string][]>();
  for (const e of [...good.values()].sort(byOrder)) {
    if (![KIND_MESSAGE, KIND_EDIT, KIND_DELETE].includes(e.kind)) continue;
    for (const r of refs(e)) { if (!byAsk.has(r)) byAsk.set(r, []); byAsk.get(r)!.push(e); }
  }
  for (const [e, why] of bad) {
    const o = e as Obj;
    if (!(o && typeof o === "object" && isId(o.id))) continue;
    for (const r of refs(o)) { if (!badByAsk.has(r)) badByAsk.set(r, []); badByAsk.get(r)!.push([o.id, why]); }
  }
  return { good, byAsk, badByAsk };
}

function stateOf(ix: Index, askId: string, now: number, policy: Policy, askers?: Set<string>): AskState {
  const ev = ix.good.get(askId);
  const ask = ev ? parseAsk(ev, askers ?? policy.askers)[0] : null;
  if (!ask) return none(askId);
  const owner = new Set(policy.owner);
  const ignored: [string, string][] = [...(ix.badByAsk.get(askId) ?? [])];
  const answers: Got[] = [], laters: Got[] = [], closes: Close[] = [];
  for (const e of ix.byAsk.get(askId) ?? []) {
    if (e.id === askId) continue;
    const room = tag(e, "h");
    if (e.kind === KIND_MESSAGE) {
      if (!owner.has(e.pubkey)) { ignored.push([e.id, "not-owner"]); continue; }
      if (room !== ask.room) { ignored.push([e.id, "other-room"]); continue; }
      const [got, why] = answerOf(e, ask);
      if (!got) ignored.push([e.id, why]);
      else (got.type === "later" ? laters : answers).push(got);
    } else {
      if (e.pubkey !== ask.asker) { ignored.push([e.id, "not-asker"]); continue; }
      if (room !== null && room !== ask.room) { ignored.push([e.id, "other-room"]); continue; }
      const [got, why] = closeOf(e, ask);
      if (!got) ignored.push([e.id, why]);
      else closes.push(got);
    }
  }
  let close: Close | null = closes[0] ?? null;
  for (const c of closes.slice(1)) ignored.push([c.event, "not-first-close"]);
  let ans = answers, lat = laters;
  if (close) {
    const key: [number, string] = [close.at, close.event];
    for (const a of [...answers, ...laters]) if (cmp([a.at, a.event], key) > 0) ignored.push([a.event, "after-close"]);
    ans = answers.filter((a) => cmp([a.at, a.event], key) <= 0);
    lat = laters.filter((a) => cmp([a.at, a.event], key) <= 0);
  }
  let best: Got | null = null;
  for (const rank of [STRONG, WEAK]) {
    const pool = ans.filter((a) => rank.includes(a.type));
    if (pool.length) { best = pool[0]; break; }
  }
  let state: State, answer: Answer | null = null, laterUntil: number | null = null;
  const signed = close !== null && ((ask.kind === "approve" && (close.why === "approved" || close.why === "declined"))
    || (ask.kind === "give" && close.why === "given"));
  if (close && close.why === "late") state = "closed";
  else if (signed) { // before `best`: the approver's signed decision outranks an earlier Seen/Archive on approve/give
    const type = ({ approved: "approve", declined: "decline", given: "give" } as Record<string, string>)[close!.why];
    state = "answered";
    answer = { event: close!.event, type, pick: null, text: null, at: close!.at, via: "signature" };
  } else if (best) { state = "answered"; answer = best; }
  else if (close) state = "closed";
  else if (now >= ask.until || ask.until - now > MAX_SPAN_S + SKEW_S) state = "lapsed"; // the second: an asker's clock far ahead
  else if (lat.length && lat[lat.length - 1].later! > now) { state = "later"; laterUntil = lat[lat.length - 1].later!; }
  else state = "open";
  if (answer) answer = { event: answer.event, type: answer.type, pick: answer.pick, text: answer.text, at: answer.at,
    via: answer.via };
  ignored.sort((a, b) => cmp([0, a[0] + "\u0000" + a[1]], [0, b[0] + "\u0000" + b[1]]));
  return { id: askId, state, on_list: state === "open",
    buttons: (state === "open" || state === "later") && now < ask.until - BUTTON_GRACE_S,
    needs_close: state === "lapsed", later_until: laterUntil, answer, close, ask, ignored };
}

/** The state of one ask, from the room's messages, the reader's clock and its policy. */
export function askState(events: unknown[], askId: string, now: number, policy: Policy): AskState {
  return stateOf(index(events), askId, Math.trunc(now), policy);
}

/** Every valid ask in the events (in policy.room when given), earliest first, each with its state. */
export function roomAsks(events: unknown[], now: number, policy: Policy): AskState[] {
  const ix = index(events);
  const askers = new Set(policy.askers);
  const asks = [...ix.good.values()].filter((ev) => {
    const [a] = parseAsk(ev, askers);
    return a !== null && (policy.room === undefined || a.room === policy.room);
  });
  return asks.sort(byOrder).map((ev) => stateOf(ix, ev.id, Math.trunc(now), policy, askers));
}

// --- builders -----------------------------------------------------------------------------------------------------

/** The kind-9 template for a new ask. Refuses anything a reader would not show. */
export function buildAsk(room: string, fields: Obj, now: number): Template {
  if (typeof room !== "string" || !room) throw new AskError("an ask needs its room's id");
  const unknown = Object.keys(fields).filter((k) => !BLOCK_ORDER.includes(k));
  if (unknown.length) throw new AskError(`unknown fields: ${unknown.sort()}`);
  const block: Obj = { v: 1 };
  for (const k of BLOCK_ORDER) if (k !== "v" && has(fields, k)) block[k] = fields[k];
  const [norm, why] = checkBlock(block, Math.trunc(now));
  if (!norm) throw new AskError(why);
  block.until = norm.until;
  let body = `${norm.what}\n${norm.why}`;
  if (norm.context) body += "\n\n" + norm.context;
  if (norm.options?.length) body += "\n\n" + norm.options.map((o) => `- ${o.label}`).join("\n");
  const content = `${body}\n\n\`\`\`${FENCE_ASK}\n${JSON.stringify(block)}\n\`\`\``;
  readsBack(content, FENCE_ASK, block);
  return { kind: KIND_MESSAGE, tags: [["h", room]], content };
}

const oneLine = (s: string) => s.split("\n").join(" ");

/** Refuse a message a reader would read differently: the block must read back as built, and no other fence of ours
 * may appear (a fence line in someone's text would otherwise break or fake a block). */
function readsBack(content: string, fence: string, block: Obj | null): void {
  if (!content.isWellFormed()) throw new AskError("text in a block must be valid Unicode (no lone surrogates)");
  for (const f of [FENCE_ASK, FENCE_ANSWER, FENCE_CLOSE]) {
    const got = findBlock(content, f);
    if (f === fence && block !== null) {
      if (!numbersOk(block) || !isObj(got) || JSON.stringify(got) !== JSON.stringify(block)) {
        throw new AskError("the block doesn't read back as built (a fence line in the text, or a number or nesting a reader refuses)");
      }
    } else if (got !== null) throw new AskError(`the text holds a ${f} fence line`);
  }
}

/** Whether this answer is addressed to the room (wakes Hermes) or stays quiet until its next turn. */
export const wakes = (type: string): boolean => WAKES.includes(type);

/** The owner's kind-9 answer template: main line, quoting the ask, never a thread. */
export function buildAnswer(ask: Ask, a: string,
  opts: { pick?: string; text?: string; later?: number; now?: number } = {}): Template {
  if (!(ANSWERS as readonly string[]).includes(a)) throw new AskError(`unknown answer ${a}`);
  if (SEALED.includes(ask.kind) && STRONG.includes(a)) {
    throw new AskError(`a ${ask.kind} ask is answered by signature, not in the room`);
  }
  const tags: Tag[] = [["h", ask.room], ["q", ask.id, "", ask.asker]];
  if (wakes(a)) tags.push(["p", ask.asker]);
  if (a === "words") {
    if (!text(opts.text, 1, 100000)) throw new AskError("words need text");
    readsBack(opts.text, FENCE_ANSWER, null);
    return { kind: KIND_MESSAGE, tags, content: opts.text };
  }
  const block: Obj = { v: 1, ask: ask.id, a };
  let line: string;
  if (a === "pick") {
    const opt = ask.kind === "choose" ? ask.options?.find((o) => o.id === opts.pick) : undefined;
    if (!opt) throw new AskError("a pick must be one of a choose ask's options");
    block.pick = opt.id;
    line = `Picked: ${oneLine(opt.label)}`;
  } else line = LINES[a];
  if (a === "later") {
    const at = int(opts.later);
    if (at === null || opts.now === undefined || at <= Math.trunc(opts.now) || at > MAX_SAFE) {
      throw new AskError("later needs a whole time after now (and within range)");
    }
    block.later = at;
  }
  const content = `${line}\n\n\`\`\`${FENCE_ANSWER}\n${JSON.stringify(block)}\n\`\`\``;
  readsBack(content, FENCE_ANSWER, block);
  return { kind: KIND_MESSAGE, tags, content };
}

/** The asker's close: an edit of the ask that drops its block. */
export function buildClose(ask: Ask, why: string): Template {
  if (!(WHYS as readonly string[]).includes(why)) throw new AskError(`unknown close reason ${why}`);
  const block = { v: 1, ask: ask.id, why };
  const content = `Closed (${why}): ${oneLine(ask.what)}\n\n\`\`\`${FENCE_CLOSE}\n${JSON.stringify(block)}\n\`\`\``;
  readsBack(content, FENCE_CLOSE, block);
  return { kind: KIND_EDIT, tags: [["h", ask.room], ["e", ask.id]], content };
}

/** The rumor the app seals to the approver (NIP-59). Never posted to the room. */
export function buildSealedAnswer(ask: Ask, decision: string): Template {
  if (ask.kind !== "approve" || (decision !== "approve" && decision !== "decline")) {
    throw new AskError("a sealed answer approves or declines an approve ask");
  }
  return { kind: KIND_SEALED_ANSWER, tags: [["h", ask.room], ["q", ask.id]],
    content: JSON.stringify({ v: 1, ask: ask.id, a: decision }) };
}

// --- reading a room -----------------------------------------------------------------------------------------------

export interface Filter { kinds?: number[]; "#h"?: string[]; since?: number; until?: number; limit?: number }

export const roomFilter = (room: string, now: number): Filter =>
  ({ kinds: [KIND_MESSAGE, KIND_EDIT, KIND_DELETE], "#h": [room], since: Math.trunc(now) - READ_BACK_S });

/** Page a relay query newest-first; the twin of Python's read_all, whose docstring explains the stopping rules. */
export async function readAll<E extends { id: string; created_at: number }>(
  query: (f: Filter) => Promise<E[]> | E[], flt: Filter, limit = PAGE_LIMIT,
  maxPages = MAX_PAGES): Promise<{ events: E[]; truncated: boolean }> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a whole number, at least 1");
  const seen = new Map<string, E>();
  let until = flt.until;
  let truncated = false, stuck = 0, pages = 0, done = false, cap = limit, prev: number | null = null;
  while (pages++ < maxPages) {
    const f: Filter = { ...flt, limit };
    if (until !== undefined) f.until = until;
    const batch = await query(f);
    const fresh = batch.filter((e) => !seen.has(e.id));
    for (const e of fresh) seen.set(e.id, e);
    if (!batch.length) { done = true; break; }
    if (fresh.length && prev !== null && prev < cap) cap = prev; // the last new-bearing page was cut short, yet more came
    prev = fresh.length ? batch.length : null; // a re-read page says nothing about the cap
    const oldest = batch.reduce((m, e) => Math.min(m, e.created_at), Infinity);
    if (fresh.length) { stuck = 0; until = oldest; }
    else { // nothing new: step back a second before stopping, in case this second holds more than a page
      stuck++;
      if (batch.length >= cap || stuck >= 2) truncated = true;
      if (stuck >= 2) { done = true; break; } // stepping back brought nothing new either: until is ignored
      until = oldest - 1;
    }
    if (flt.since !== undefined && until < flt.since) { done = true; break; }
  }
  if (!done) truncated = true;
  return { events: [...seen.values()], truncated };
}
