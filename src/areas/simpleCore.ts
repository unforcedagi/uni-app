// T-124 "Simple first" (pure, unit-tested in scripts/steer.test.ts): what the room's quiet companion says. One sentence for where
// the room stands, at most three things that need the user (Now first), the chat composer's placeholder.
import { isMe, PRIORITIES, type Task } from "./taskCore.ts";
import { taskTitle, type Where } from "./whereCore.ts";
import { ROOT } from "./treeCore.ts";

/** The first sentence of the level's lede, as plain text and whole (a long one is clamped on screen, never cut here: it opens in full). */
export function firstSentence(text: string | null | undefined): string {
  const plain = (text ?? "").replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2").replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
  if (!plain) return "";
  const m = /^.*?[.!?](?=\s|$)/.exec(plain);
  return m ? m[0] : plain;
}

/** A task someone else holds that waits on the user (r17: `waiting_on` names them, whatever its owner): their part is the step it asks for. */
export const waitsOnMe = (t: Pick<Task, "owner" | "waitingOn">): boolean => isMe(t.waitingOn) && !isMe(t.owner);
/**
 * Whether a task belongs in Needs you: the companion's list, the work view and the tree's dots use this one rule (r12). Every open decision,
 * the user's own tasks, and (r17) any task whose `waiting_on` names the user whatever its owner, at Now or Soon (unsorted is Soon); live,
 * never Someday. A room's or Uni's own drafting that waits on no one is not theirs (r16). Snoozed and finished tasks are dropped before.
 */
export function needsYou(t: Pick<Task, "kind" | "owner" | "waitingOn" | "priority" | "state"> & Partial<Pick<Task, "title" | "next" | "options" | "ask" | "askAt" | "updatedAt" | "askFailed" | "check">>): boolean {
  // r19: a record that isn't a real request is Uni's to tidy, listed apart and never counted here. r20: nor is a decision not read yet
  return wouldNeedYou(t) && !tidyReason(t) && !unknownDecision(t);
}
/**
 * A decision whose full record isn't read yet (r20, Codex P1-2): its title was cut and its note's question isn't read at this revision, the
 * read failed, or the notes it stands on (`source`, `depends_on`) are still being read. It is "Checking what's needed…": not owed, not in the
 * count or the dots, and never "Decide: …", until it is classified (a request, or Uni's to tidy).
 */
export function unknownDecision(t: Partial<Pick<Task, "kind" | "title" | "ask" | "askAt" | "updatedAt" | "askFailed" | "check">>): boolean {
  if (t.kind !== "decision" || typeof t.title !== "string") return false;
  if (t.askFailed) return true;
  if (t.check && (t.check.kind === "checking" || t.check.kind === "unavailable")) return true;
  const tt = taskTitle(t.title);
  if (!(tt.cut || tt.previewed)) return false;
  return !(typeof t.ask === "string" && !!t.updatedAt && t.askAt === t.updatedAt);
}
/** The r12 rule before r19's tidy check: open decisions, the user's own tasks and tasks waiting on them, at Now or Soon. */
export function wouldNeedYou(t: Pick<Task, "kind" | "owner" | "waitingOn" | "priority" | "state">): boolean {
  if (t.state !== "open" && t.state !== "doing" && t.state !== "waiting") return false;
  return t.kind === "decision" || ((isMe(t.owner) || isMe(t.waitingOn)) && t.priority !== "someday");
}
/** A record the user would be asked for that Uni has to tidy first (r19): the work view's "Uni needs to tidy these (N)". */
export const toTidy = (t: Task): TidyReason | null => (wouldNeedYou(t) ? tidyReason(t) : null);
/** The user's own: an open decision, a task they own, or one that waits on them (r17). Everything else here is someone else's, in In motion. */
export const isMine = (t: Pick<Task, "kind" | "owner" | "waitingOn">): boolean => t.kind === "decision" || isMe(t.owner) || isMe(t.waitingOn);

/** How many items under each node path need you there (the node's own, never its children's): the tree's dots. */
export function needsByNode(tasks: readonly Task[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tasks) if (needsYou(t)) m.set(t.node, (m.get(t.node) ?? 0) + 1);
  return m;
}

/**
 * The tree's dots (r13): each item that needs you counts on its node's row or, when that node has no row in the tree, on its nearest
 * ancestor's (else Uni's), so the dots under a level add up to that level's feed.
 */
export function needsByRow(tasks: readonly Task[], rows: ReadonlySet<string>, parentOf: (path: string) => string | undefined): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tasks) {
    if (!needsYou(t)) continue;
    let at: string | undefined = t.node;
    for (let n = 0; at !== undefined && at !== ROOT && !rows.has(at) && n < 64; n++) at = parentOf(at);
    const key = at !== undefined && rows.has(at) ? at : ROOT;
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return m;
}

/** Uni's own panel (r12): what is Uni's own, then at most `fromAreas` from the areas by urgency; the rest is in "All of Uni's work". */
export function uniNeeds(feed: readonly Task[], fromAreas = 3): Task[] {
  const own = feed.filter((t) => t.node === ROOT);
  return [...own, ...feed.filter((t) => t.node !== ROOT).slice(0, fromAreas)];
}

/** A place whose words are never shown elsewhere (a private area), as the feed names it: by place only. */
export type PrivatePlace = { path: string; name: string };
/**
 * Items that need you in a private area, seen from outside it (r14): one line per private area, "Sanctum: 2 for you ›", opening that area.
 * Inside the area Aaron opened himself, its items are ordinary rows. They always count.
 */
export type PrivateNeed = { key: string; count: number; place: string; open: { path: string };
  /** r22: each item's action as its verb and object only ("Book the dentist"), when it is a short work imperative; never its other words */
  actions: string[];
  /** r22: the items whose text reads as personal (no work verb, or longer than a short imperative): one "N things for you" line */
  others: number };
/** Needs you at one level, the one list every surface reads (r13): the companion, "+N in areas", the dots and the work view add up to `total`. */
export type NeedsFeed = { rows: Task[]; privates: PrivateNeed[]; total: number;
  /** r19: records Uni has to tidy (not real requests yet), outside private areas; never in `total`. */
  tidy?: Task[];
  /** r20: decisions not read yet ("Checking what's needed…"), outside private areas: shown after the rows, never in `total` or the dots. */
  pending?: Task[] };

/** Now before Soon (overdue first), then by due date (undated last), then a decision before a task, then by title. */
export function rankNeeds(list: readonly Task[], today = localDay()): Task[] {
  const rank = (t: Task) => (isOverdue(t.due, today) ? -1 : t.priority === "now" ? 0 : t.priority === "someday" ? 2 : 1);
  return [...list].sort((a, b) => rank(a) - rank(b) || (a.due ?? "9999").localeCompare(b.due ?? "9999") || Number(b.kind === "decision") - Number(a.kind === "decision") || a.title.localeCompare(b.title));
}

/**
 * Everything that needs you at a level and below, by the one rule (`needsYou`). `privateOf(node)`: the private area a node sits in, or null.
 * `self`: the private area this level is (or sits in), opened by the user: its own items are ordinary rows with their titles (r14); items in
 * any other private area are one line per area.
 */
export function needsFeed(tasks: readonly Task[], privateOf: (node: string) => PrivatePlace | null, self: PrivatePlace | null = null, today = localDay()): NeedsFeed {
  const all = rankNeeds(tasks.filter(needsYou), today);
  const rows: Task[] = [];
  const by = new Map<string, PrivateNeed>();
  for (const t of all) {
    const p = privateOf(t.node);
    if (!p || (self && p.path === self.path)) { rows.push(t); continue; }
    const g = by.get(p.path) ?? { key: p.path, count: 0, place: p.name, open: { path: p.path }, actions: [], others: 0 };
    by.set(p.path, g);
    g.count++;
    const a = privateAction(t);
    if (a) g.actions.push(a); else g.others++;
  }
  const here = (t: Task) => !privateOf(t.node) || privateOf(t.node)?.path === self?.path;
  const tidy = tasks.filter((t) => toTidy(t) && here(t));
  const pending = rankNeeds(tasks.filter((t) => wouldNeedYou(t) && unknownDecision(t) && here(t)), today);
  return { rows, privates: [...by.values()], total: all.length, tidy, pending };
}

/** Rows Uni's own panel shows (r17): the rest, private items included, are one "N more ›" to the work view. */
export const UNI_ROWS = 3;
/**
 * Uni's panel (r17, lighter): at most `max` rows (Uni's own first, then the areas by urgency) and one count of everything else (`rest`, which
 * folds in the private areas' items: `privateCount`, said only in the link's tooltip). No private lines and no second "more" line here; the work
 * view keeps the full list.
 */
export function uniPanel(feed: NeedsFeed, max = UNI_ROWS): NeedsFeed & { rest: number; privateCount: number } {
  const own = feed.rows.filter((t) => t.node === ROOT);
  const areas = feed.rows.filter((t) => t.node !== ROOT);
  const rows = [...own, ...areas].slice(0, max);
  const privateCount = feed.privates.reduce((n, p) => n + p.count, 0);
  // r20: a decision still being read fills a row only where nothing owed is left to show; it is never counted
  const pending = (feed.pending ?? []).slice(0, Math.max(0, max - rows.length));
  return { rows, privates: [], total: feed.total, rest: Math.max(0, feed.total - rows.length), privateCount, pending };
}
/** "Includes 1 in a private area": the "N more ›" link's tooltip, when private items are folded into its count. */
export const privateNote = (n: number): string | null => (n <= 0 ? null : n === 1 ? "Includes 1 item in a private area" : `Includes ${n} items in private areas`);

/** "Sanctum: 2 for you": a private area's items, from outside it, by place and count only (r14). */
export function privateLabel(p: Pick<PrivateNeed, "count" | "place">): string {
  return `${p.place}: ${p.count} for you`;
}
/** A short imperative (r22): one step, at most this many words, and no longer than `PRIVATE_ACTION_MAX` characters. */
export const PRIVATE_ACTION_WORDS = 7;
export const PRIVATE_ACTION_MAX = 48;
/**
 * What a private area's item shows outside it (r22, both critics): its action's verb and object only ("Book the dentist"), when its step is a
 * short work imperative: a work verb, one step, a few words. Null when the text reads as personal (no work verb, a decision, or longer than a
 * short imperative): it is then counted in "In Sanctum: 1 thing for you · open Sanctum", with none of its words.
 */
export function privateAction(t: Pick<Task, "kind" | "next">): string | null {
  if (t.kind !== "task") return null;
  const a = rowAction(t.next);
  if (!a || a.steps.length > 1 || a.prefix) return null;
  const text = withoutBrackets(a.text);
  if (/https?:\/\/|\bwww\.|\[\[|\buni:/i.test(text)) return null;
  if (text.length > PRIVATE_ACTION_MAX || text.split(" ").filter(Boolean).length > PRIVATE_ACTION_WORDS) return null;
  const v = verbPhrase(text);
  return v ? capFirst(v) : null;
}
/** A private item's row outside its area (r22): "In Sanctum: Book the dentist". */
export const privateActionLabel = (place: string, action: string): string => `In ${place}: ${action}`;
/** The private items with no action shown (r22): "In Sanctum: 1 thing for you · open Sanctum" ("1 more thing" beside shown actions). */
export function privateRestLabel(p: Pick<PrivateNeed, "place" | "others" | "actions">): string {
  const more = p.actions.length ? " more" : "";
  return `In ${p.place}: ${p.others} ${more ? "more " : ""}${p.others === 1 ? "thing" : "things"} for you · open ${p.place}`;
}

const ACTION_VERBS = /^(say|reply|tell|answer|send|edit|approve|confirm|review|decide|sign|pay|call|email|write|read|pick|choose|check|book|schedule|draft|merge|deploy|ship|test|ask|give|post|share|record|update|fix|add|set|move|file|submit|finish|meet|join|buy|order|cancel|renew|follow|try|look|go|let|ping|invite|publish|upload|run|print|prepare|bring|forward|accept|decline|reject|ok|okay|listen|watch|talk|grade|fill|keep|archive|close|change)(?=[\s:,]|$)/i;
/**
 * A date or time a step starts with as its label (r20): "Wed 10-14:", "10-05 09:04:", "Oct 14 —", "2026-10-14:", "Today:". A row never leads with
 * it: the action leads, and the date is the due cue (or, with no due date, the subtitle).
 */
const DATE_PREFIX = /^(?:(?:(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|nesday|sday|urday)?\.?,?\s+)?(?:\d{4}-\d{2}-\d{2}|\d{1,2}[-/]\d{1,2}(?:[-/]\d{2,4})?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2})|(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|nesday|sday|urday)?|today|tonight|tomorrow|this week)(?:,?\s+\d{1,2}[:.]\d{2})?\s*(?::|\s[—–-])\s+(?=\S)/i;
/** The step without a leading date label ("Wed 10-14: say go…" → "say go…"), and the label. */
export function datePrefix(step: string): { prefix: string | null; rest: string } {
  const m = DATE_PREFIX.exec(step);
  return m ? { prefix: m[0].replace(/\s*(?::|[—–-])\s*$/, "").trim(), rest: step.slice(m[0].length) } : { prefix: null, rest: step };
}
/** A step as plain words: markdown emphasis dropped, but an underscore inside a word kept ("BV_CHAT_ENABLED"). */
const plainStep = (next: string | null | undefined): string => (next ?? "").replace(/[*`>]/g, "").replace(/(^|[\s(])_+|_+(?=[\s).,;:!?]|$)/g, "$1").replace(/\s+/g, " ").trim();
/** A step written as a label that asks ("Production go: gateway deploy, merge #55"): the label names what is asked for (r20). */
const ASKING_LABEL = /^([^:;]{3,40}):\s+\S/;
const labelAsks = (step: string): boolean => { const m = ASKING_LABEL.exec(step); return !!m && /\b(?:go|ok|okay|yes|no|approve|approval|sign[- ]?off|decide|decision|pick|choose|review|confirm|answer|reply|call)\b/i.test(m[1]); };
/** A next step that names something to do ("Say go to deploy #38 + #58"), not a status ("Waiting on Casey"): the task sheet leads with it.
 *  r20: a leading date label is not the action ("Wed 10-14: say go…" leads with "Say go…"); a label that asks ("Production go: …") is one. */
export function actionLead(next: string | null | undefined): string | null {
  const t = datePrefix(plainStep(next)).rest;
  if (!t || (!ACTION_VERBS.test(t) && !labelAsks(t))) return null;
  return t[0].toLocaleUpperCase() + t.slice(1);
}
/**
 * Who a step's words are for (r17). `room`: the message is for the room itself ("Say go to deploy…", "Tell Uni…", "Tell the room…", "Ask Uni
 * to…", or a step that names this room, "…in #woven-web"): the sheet offers "Say it in #room ›" with `text` in the composer (never sent; "" when
 * there are no words to put there). `person`: an action toward someone outside the room ("Tell Sebastian…", "Reply to jonbo…", "Email…", "Send
 * Ryan…"): the sheet leads with the action and offers an explicit destination (r18: a `mailto:` in the step; the task's `link` field is the
 * caller's), the message to copy when one is stored, or "Ask Uni to draft it"; never a room prefill. Null: any
 * other step. `room`: the task's room name (with or without "#"), so a step naming it is known to be for it.
 */
export type Audience = { kind: "room"; text: string } | { kind: "person"; link: { href: string; label: string } | null };
const ROOM_WORDS = /^(?:uni|main|the room|this room|the channel|everyone here)\b/i;
const QUESTION_WORD = /^(?:whether|which|if|what|who|when|how|why)\b/i;
const PERSON_VERB = /^(?:tell|reply|respond|email|e-mail|mail|message|text|call|phone|ping|ask|send|forward|invite|write|thank|remind|follow up|introduce|nudge|answer)\b/i;
const unquote = (s: string) => s.replace(/^["“'‘]+|["”'’]+$/g, "").replace(/[.\s]+$/, "").trim();
const capFirst = (s: string) => (s ? s[0].toLocaleUpperCase() + s.slice(1) : s);
const slugOf = (s: string | null | undefined) => (s ?? "").trim().replace(/^#/, "").toLowerCase();
/** A recipient written as a name ("to Sebastian", "Sebastian the…", "Benya + Harper"): a capitalised word that is not Uni, the room or a channel. */
const namesPerson = (rest: string) => /^(?:to\s+|with\s+)?(?!uni\b|main\b|the\b|this\b|everyone\b|#)\p{Lu}[\p{L}'’.-]*/u.test(rest);
export function stepAudience(next: string | null | undefined, room: string | null = null): Audience | null {
  // r20: a leading date label ("Wed 10-14: say go…") is not who the step speaks to
  const step = datePrefix((next ?? "").replace(/[*_`>]/g, "").replace(/\s+/g, " ").trim()).rest;
  if (!step) return null;
  const here = slugOf(room);
  // r19: a room named as where something is ("#cohere's 'For Harper' block") is not who the step speaks to
  const named = [...step.matchAll(/(?:^|\s)#([\w./-]*\w)(?!['’]s\b)/g)].map((m) => m[1].toLowerCase());
  const quoted = /["“'‘]([^"”'’]{1,120})["”'’]/.exec(step)?.[1] ?? "";
  // "Say …": for the room, unless it is said to a named person ("Say thanks to Mark")
  let m = /^say\b[\s:,-]*(.*)$/i.exec(step);
  // "Say go…", "Say yes…", "Say 'ship it'…": a word for the room (whatever the step does next, "…to send the SOW to Casey")
  const roomWord = !!m && /^(?:go|yes|no|ok|okay|stop|wait|done|hold|ship it|start\b|["“'‘])/i.test(m[1]);
  if (m && (roomWord || !/\bto\s+\p{Lu}[\p{L}'’.-]*(?:\s|$|[,.])/u.test(m[1].replace(/\bto\s+(?:uni|the room)\b/gi, "")))) {
    const rest = m[1].replace(/^(?:with\s+|to\s+(?:the\s+)?room\s+)/i, "");
    // r20: the words to say are the step's first clause ("Go on prod deploy of #38 + #58"), never the notes after it ("; Harper signs off…")
    return { kind: "room", text: QUESTION_WORD.test(rest) ? "" : capFirst(unquote(firstClause(rest))) };
  }
  // "Tell Uni …", "Tell the room …", "Ask Uni to …", "Reply to Uni …"
  m = /^(?:tell|ask|reply to|answer|message|ping)\s+(uni|main|the room|this room|the channel|everyone here)\b[\s:,-]*(?:to\s+|that\s+)?(.*)$/i.exec(step);
  if (m && ROOM_WORDS.test(m[1])) return { kind: "room", text: QUESTION_WORD.test(m[2]) ? "" : capFirst(unquote(m[2])) };
  // a step that names this room ("Answer the 7 questions in #woven-web", "Reply in the room with…")
  if (here && named.includes(here)) return { kind: "room", text: unquote(quoted) };
  if (/^(?:reply|answer|respond)\b/i.test(step) && !named.length && (/\b(?:in|to) (?:the|this) room\b/i.test(step) || (/^reply\b/i.test(step) && !/^reply\s+to\b/i.test(step) && !namesPerson(step.replace(/^reply\s*/i, ""))))) return { kind: "room", text: unquote(quoted || (/^\w+\s*[:—–]\s*(.+)$/.exec(step)?.[1] ?? "")) };
  // toward a person outside the room
  // "Edit and send the draft to Mark…": the sending is the action
  const act = step.replace(/^(?:edit|review|check|finish|polish|read)(?:\s+(?:it|this|the draft))?\s+and\s+/i, "");
  if (PERSON_VERB.test(act)) {
    const rest = act.replace(PERSON_VERB, "").trim();
    const toSomeone = /^(?:email|e-mail|mail|call|phone|text)\b/i.test(act) || namesPerson(rest) || /\bto\s+\p{Lu}/u.test(rest) || /^(?:to|back to)\s+\S/i.test(rest);
    if (toSomeone) {
      // r18: a link leads only when it is written as the destination: an explicit `mailto:` here, or the task's `link`/`url` field
      // (`destination`); never a web address that merely appears in the instruction
      const mail = /\bmailto:([\w.+-]+@[\w-]+(?:\.[\w-]+)+)\b/i.exec(step)?.[1];
      return { kind: "person", link: mail ? { href: `mailto:${mail}`, label: `Email ${mail}` } : null };
    }
  }
  return null;
}
/** r19: a text with each web address written as its host ("Look at cohere-signup-staging.unforced.workers.dev on phone"): a heading never
 *  drops a link and leaves a gap ("Look at  on phone"). */
export const withHosts = (text: string): string => text.replace(/https?:\/\/[^\s)]+|\bwww\.[^\s)]+/g, (u) => hostOf(/^www\./.test(u) ? `https://${u}` : u.replace(/[.,;:]+$/, ""))).replace(/\s+/g, " ").trim();
export const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "the link"; } };
/** What a room-directed step would put in the room's composer (never sent). Kept for the r13 callers: the room's words, else null. */
export function sayText(lead: string | null, room: string | null = null): string | null {
  const a = stepAudience(lead, room);
  return a?.kind === "room" ? a.text : null;
}

/** Number words a step may use for its questions ("the nine questions"). */
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
/**
 * A step that asks for answers to questions written elsewhere (r17): "answer the nine operational/editorial questions…", "Answer the 7 Woven
 * Web direction questions". The count, or null. The row says "Answer 9 questions ›" and the sheet lists them, read from the notes.
 */
export function questionCount(next: string | null | undefined): number | null {
  const m = /\banswer\b(?:\s+(?:the|any of the|all|all of the|these|those|my|your|his|her))?\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b(?:[^.?!;]|\.(?=\S)){0,60}?\bquestions?\b/i.exec(next ?? "");
  if (!m) return null;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1].toLowerCase()];
  return n && n > 0 ? n : null;
}
/** "Answer 9 questions": the row's way into the sheet that lists them. */
export const answerLabel = (n: number): string => `Answer ${n} ${n === 1 ? "question" : "questions"}`;
const LIST_ITEM = /^(\s*)(?:[-*+•]|\d+[.)])\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+/;
const cleanItem = (s: string) => s.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
/**
 * The lists in a note: runs of top-level list items, each with the heading it sits under. r18: an item is kept whole, with its indented
 * continuation lines and nested items (joined into its text), never cut at its first line.
 */
function listsIn(content: string): { heading: string; numbered: boolean; items: string[] }[] {
  const out: { heading: string; numbered: boolean; items: string[] }[] = [];
  let heading = ""; let cur: { heading: string; numbered: boolean; items: string[] } | null = null;
  let item: string[] | null = null;
  const close = () => { if (cur && item) cur.items.push(cleanItem(item.join(" "))); item = null; };
  for (const raw of content.split(/\r?\n/)) {
    const h = /^#{1,6}\s+(.*)$/.exec(raw.trim());
    if (h) { close(); heading = h[1]; cur = null; continue; }
    const li = LIST_ITEM.exec(raw);
    if (li && li[1].length < 2) {
      close();
      // a list of the other kind (numbered after bullets) is a new list
      if (cur && cur.numbered !== NUMBERED.test(raw)) cur = null;
      if (!cur) { cur = { heading, numbered: NUMBERED.test(raw), items: [] }; out.push(cur); }
      item = [li[2]];
      continue;
    }
    // an indented line (a wrapped line or a nested item) belongs to the item above it
    if (item && raw.trim() && /^\s{2,}/.test(raw)) { item.push(LIST_ITEM.exec(raw)?.[2] ?? raw.trim()); continue; }
    if (raw.trim()) { close(); cur = null; }
  }
  close();
  return out.filter((l) => l.items.length);
}
/**
 * The questions a note holds (r18: only from an explicit source): its structured `questions` field, else the list under a heading that names
 * questions ("## Questions for Aaron"). No numbered plan or bullet list elsewhere is taken for questions. `want`: the count the step names; a
 * source that holds another count is `unclear` (the sheet then says "Open the note to answer" and claims no list). Null: no explicit source here.
 */
export type Questions = { status: "list"; items: string[] } | { status: "unclear"; found: number };
export function questionsFrom(content: string | null | undefined, want: number | null = null, metadata: Record<string, unknown> | null = null): Questions | null {
  const field = metadata?.questions;
  const stored = Array.isArray(field) ? field.filter((q): q is string => typeof q === "string" && !!q.trim()).map(cleanItem) : null;
  const items = stored?.length ? stored : listsIn(content ?? "").find((l) => /\bquestions?\b/i.test(l.heading))?.items ?? null;
  if (!items) return null;
  return want !== null && items.length !== want ? { status: "unclear", found: items.length } : { status: "list", items };
}
/** A note a text links to, as `{vault, id}` (r18): `uni:<ULID>` names its vault; a bare ULID or `[[Path]]` is the text's own vault (null). */
export type LinkRef = { vault: string | null; id: string };
/** Notes a text links to, in order, once each: `uni:<ULID>`, `[[Path]]` and bare ULIDs, each with the vault it names. */
export function linkedRefs(text: string | null | undefined): LinkRef[] {
  const out: LinkRef[] = [];
  const add = (vault: string | null, r: string) => { const id = r.trim(); if (id && !out.some((o) => o.id === id && o.vault === vault)) out.push({ vault, id }); };
  for (const m of (text ?? "").matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]|(?:\b([a-z][\w-]*):)?\b([0-9A-HJKMNP-TV-Z]{26})\b/g)) {
    if (m[1]) add(null, m[1]); else add(m[2] ?? null, m[3]);
  }
  return out;
}
/**
 * Whether a note's own metadata says it is finished (r18): a task or decision `done`, `archived`, `decided` or `closed`, or a `superseded_by`
 * field. Only explicit state; a title's words are never read for it. Null: open, or nothing said.
 */
export function closedBy(metadata: Record<string, unknown> | null | undefined): "closed" | "superseded" | null {
  const m = metadata ?? {};
  if (typeof m.superseded_by === "string" ? m.superseded_by.trim() : m.superseded_by) return "superseded";
  const st = typeof m.state === "string" ? m.state.trim().toLowerCase() : "";
  return ["done", "archived", "decided", "closed"].includes(st) ? "closed" : null;
}
/**
 * Where a task's questions (or the detail it carries) come from (r18), as every surface shows it. `list`: read from an explicit source (`from`
 * when it is not the task's own note). `closed`: its source note is closed or superseded, so its action is not shown as current: "Check: <source>
 * is closed — still needed?". `unclear`: no explicit list, or a count other than the step's: "Open the note to answer", no list claimed.
 */
export type SourceRef = { vault: string; id: string; title: string };
export type Support = { kind: "list"; items: string[]; from: SourceRef | null } | { kind: "closed"; how: "closed" | "superseded"; from: SourceRef } | { kind: "unclear"; from: SourceRef | null };
/** "Check: “RegenHub: deployed fixes…” is closed — still needed?": a task whose source note is finished (r18). */
export const checkLine = (s: Extract<Support, { kind: "closed" }>): string => `Check: “${s.from.title}” ${s.how === "superseded" ? "was superseded" : "is closed"} — still needed?`;
export const OPEN_TO_ANSWER = "Open the note to answer";

/**
 * The answers a decision offers (r18: only what is stored on it). Its `options`, each written back as stored; plain Yes/No only when the stored
 * options are exactly yes and no (the writer, `tasks.py decide new`, has no `kind: binary` field). With no options there are no buttons: the
 * sheet has a one-line answer box ("Answer in your words") written with the same revision-guarded write. Nothing is read from punctuation.
 */
export type Choice = { label: string; value: string };
export function answerChoices(options: readonly string[]): { choices: Choice[]; box: boolean; binary: boolean } {
  if (!options.length) return { choices: [], box: true, binary: false };
  const low = options.map((o) => o.trim().toLowerCase());
  const binary = options.length === 2 && low.includes("yes") && low.includes("no");
  return { choices: options.map((o) => ({ label: binary ? capFirst(o.trim().toLowerCase()) : o, value: o })), box: false, binary };
}
/** The vault keeps an answer to 500 characters (uni-core `check_decide_patch`). */
export const ANSWER_MAX = 500;
/** An answer typed in words, as written: one line, trimmed; null when empty or too long to record. */
export function answerText(raw: string): string | null {
  const t = raw.replace(/\s+/g, " ").trim();
  return t && t.length <= ANSWER_MAX ? t : null;
}

/**
 * The needs-you feed (T-124 r7): only what the user must do. Their tasks (owner, or waiting on them) that are live and not snoozed (the
 * caller's `Where` has already dropped those, and anything done or archived), at priority Now or Soon (unsorted counts as Soon), plus open
 * decisions; Someday is not here. Now before Soon, then by due date (undated last), then a decision before a task, then by title.
 */
export function topNeeds(w: Where, _path?: string, max = Infinity, today = localDay()): Task[] {
  const rank = (t: Task) => (isOverdue(t.due, today) ? -1 : t.priority === "now" ? 0 : t.priority === "someday" ? 2 : 1);
  const all = PRIORITIES.flatMap((p) => w.needs[p].rows).filter(needsYou);
  return all.sort((a, b) => rank(a) - rank(b) || (a.due ?? "9999").localeCompare(b.due ?? "9999") || Number(b.kind === "decision") - Number(a.kind === "decision") || a.title.localeCompare(b.title)).slice(0, max);
}

/** Today as YYYY-MM-DD, local. */
export const localDay = (d = new Date()): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** A due date (YYYY-MM-DD) before today. */
/**
 * When a request was set or last changed (r22, Codex P1): "asked today", "asked yesterday", "asked Oct 11". From the record's last change, the
 * only time the app has for it. Null: no time known.
 */
export function askedLine(iso: string | null | undefined, today = localDay()): string | null {
  const ms = stampMs(iso);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const day = localDay(d);
  if (day === today) return "asked today";
  const y = new Date(`${today}T12:00:00`); y.setDate(y.getDate() - 1);
  if (day === localDay(y)) return "asked yesterday";
  return `asked ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(day.slice(0, 4) !== today.slice(0, 4) ? { year: "numeric" } : {}) })}`;
}
/** The room's chat has moved on (r22, Codex P1): its last message is more than a day newer than the request. `lastTs` in seconds, as the rooms list has it. */
export const MOVED_ON_MS = 24 * 3600_000;
export function chatMovedOn(asked: string | null | undefined, lastTs: number | null | undefined): boolean {
  const ms = stampMs(asked);
  return Number.isFinite(ms) && typeof lastTs === "number" && Number.isFinite(lastTs) && lastTs * 1000 - ms > MOVED_ON_MS;
}
export const MOVED_ON = "Chat has moved on since this was asked";
export const isOverdue = (due: string | null | undefined, today = localDay()): boolean => !!due && due < today;
/** "due Oct 14", or "was due Oct 12" once it has passed. Null without a date. */
export function dueLine(due: string | null | undefined, today = localDay()): string | null {
  if (!due) return null;
  // r20: the cue a row leads its subtitle with reads as the day it is
  if (due.slice(0, 10) === today) return "due today";
  const d = new Date(`${due}T12:00:00`);
  if (Number.isNaN(d.getTime())) return due;
  return `${isOverdue(due, today) ? "was due" : "due"} ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

/** A title says what to do when it has words beyond its id; "T-12" or one bare word does not. */
export function actionableTitle(rest: string): boolean {
  return rest.trim().split(/\s+/).filter(Boolean).length >= 2;
}

/** A stamp as a moment: a bare date (`2026-10-13`) is that day on the local calendar, never UTC midnight (the evening before, west of UTC). */
export const stampMs = (iso: string | null | undefined): number => (!iso ? NaN : /^\d{4}-\d{2}-\d{2}$/.test(iso.trim()) ? new Date(`${iso.trim()}T12:00:00`).getTime() : Date.parse(iso));
/** Whole calendar days between two moments on the local clock (r15: "yesterday" is the day before today, not 24 hours ago). */
export const calendarDays = (fromMs: number, toMs: number): number => {
  const a = new Date(fromMs), b = new Date(toMs);
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86_400_000);
};
/**
 * How long ago, quietly: "today", "yesterday", "3 days ago", "2 weeks ago", else the month and day. Empty for a missing or future time.
 * By calendar day on one local clock (r15), so every room says the same of the same moment.
 */
export function quietAgo(iso: string | null | undefined, nowMs: number): string {
  const t = stampMs(iso);
  if (Number.isNaN(t) || t > nowMs + 60_000) return "";
  const days = Math.max(0, calendarDays(t, nowMs));
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

type Recent = Pick<Task, "title" | "state" | "kind" | "updatedAt" | "options">;
const plainTitle = (t: string) => withoutCut(taskTitle(t).rest);

/**
 * Where the room stands, in one sentence and never a count. The node's own `stands` (with `stands_at` as a quiet time); without it the
 * newest decision, else the newest task change, in plain words; else nothing.
 */
export function standsLine(stands: { text: string; at: string | null } | null | undefined, tasks: readonly Recent[], nowMs: number): { text: string; ago: string } | null {
  const text = firstSentence(stands?.text);
  if (text) return { text, ago: quietAgo(stands?.at, nowMs) };
  const stamped = tasks.filter((t) => t.updatedAt && !Number.isNaN(stampMs(t.updatedAt))).sort((a, b) => stampMs(b.updatedAt) - stampMs(a.updatedAt));
  const pick = stamped.find((t) => t.kind === "decision") ?? stamped[0];
  if (!pick) return null;
  const what = plainTitle(pick.title);
  const line = pick.kind === "decision" ? `Waiting on a decision: ${what}.` : pick.state === "doing" ? `${what} is underway.` : pick.state === "waiting" ? `${what} is waiting.` : `Latest: ${what}.`;
  return { text: line, ago: quietAgo(pick.updatedAt, nowMs) };
}

/**
 * The companion's heading, and the work view's (r18: one wording, one timestamp, `standsLine`'s): "Where this stands · 2 days ago" once the
 * summary is older than today; "Where Expression stands" for a node shown in a room it borrows.
 */
export function standsHeading(scope: string | null | undefined, ago: string | null | undefined): string {
  const base = scope ? `Where ${scope} stands` : "Where this stands";
  return ago && ago !== "today" ? `${base} · ${ago}` : base;
}

/** `Message #atlas/build`; a node held by a room says whose (`Message #atlas`); no room, the node's name. */
export function chatPlaceholder(a: { name: string; slash: string | null; heldBy: string | null }): string {
  if (a.slash) return `Message #${a.slash}`;
  if (a.heldBy) return `Message #${a.heldBy.replace(/^#/, "")}`;
  return `Message ${a.name}`;
}

/** A title that was cut short on the way into the vault ("…", "..."), so the real question is in the note's content. */
export const isCutTitle = (rest: string): boolean => /(…|\.\.\.)\s*$/.test(rest.trim());

/** The longest question a Needs-you row shows in full beside its answers; a longer one opens to decide (r14). */
export const ROW_ASK_MAX = 280;
/** A list item ("- Ship it", "2. Wait"): a decision's options are listed so, and an option is never its question (r13). */
export const isListLine = (l: string): boolean => /^([-*+•]|\d+[.)])\s/.test(l.trim());
const skipLine = (l: string) => /^_?converted from\b/i.test(l.replace(/^[*_>\s]+/, "")) || /^#{1,6}\s/.test(l) || /^---+$/.test(l) || isListLine(l);
/**
 * The full question of a decision (or task) whose title is cut (r14): the first paragraph of its content, whole, without `_Converted from …_`
 * lines, headings, rules, list items or the "Decision (default yes):" label. Never trimmed: a shortened question is a preview
 * (`askPreview`), and only a whole one is answered. "" when there is nothing.
 */
export function askFromContent(content: string | null | undefined): string {
  const lines = (content ?? "").split(/\r?\n/).map((l) => l.trim());
  const start = lines.findIndex((l) => l && !skipLine(l));
  // r16: a note that is only its heading and its options ("# Ship the chat? (preview: …)" then a list): the heading is the question
  if (start < 0) { const h = lines.find((l) => /^#{1,6}\s+\S/.test(l)); return h ? askFromContent(h.replace(/^#{1,6}\s+/, "")) : ""; }
  const para: string[] = [];
  for (const l of lines.slice(start)) { if (!l || skipLine(l)) break; para.push(l); }
  return para.join(" ").replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`>]/g, "").replace(/^decision\s*(\([^)]*\))?\s*[:\-–—]\s*/i, "").replace(/\s+/g, " ").trim();
}
/** A short preview of a long question: its first whole sentences within `max`, else its first words, and always "…" when anything is left out. */
export function askPreview(text: string, max = 160): string {
  const plain = text.replace(/\s+/g, " ").trim();
  if (plain.length <= max) return plain;
  let out = "";
  for (const sen of plain.match(/[^.!?]+[.!?]+(?=\s|$)/g) ?? []) { if ((out + sen).length > max) break; out = `${out}${sen}`; }
  return out.trim() ? `${out.trim()} …` : cutWords(plain, max);
}

/** A Needs-you row shows a whole question beside its answers only when it fits the row; a longer one opens to decide (r14). */
export const fitsRow = (q: string): boolean => q.length <= ROW_ASK_MAX;

/**
 * A decision's whole question (r14), or null when none is known: its title when the title is not cut (`rest`, without its id), else the ask
 * read from its note, but only when that ask was read at the row's own revision (`askAt === updatedAt`), so the question shown and the
 * answer written are the same revision's. Punctuation proves nothing: a cut title with no ask at this revision has no question here.
 */
export function decisionQuestion(rest: string, ask: string | undefined, askAt: string | null | undefined, updatedAt: string | null, inNote = isCutTitle(rest)): string | null {
  if (!inNote) { const t = rest.replace(/\s+/g, " ").trim(); return t.replace(/^decision\s*(\([^)]*\))?\s*[:\-–—]\s*/i, "").trim() || t || null; }
  // an ask that is itself cut (the note repeats the cut title) is no whole question either
  if (ask && !isCutTitle(ask) && updatedAt && askAt === updatedAt) return ask;
  return null;
}

/** Words a fragment must not end on ("…feature 4, the"): an article, a preposition or a joining word left hanging. */
export const DANGLING = /^(a|an|the|to|of|for|in|on|at|by|with|and|or|but|nor|who|whom|whose|that|which|from|as|is|are|was|be|if|than|then|into|onto|about|your|their|its|this|these|those|our|my|so|via|per|because|since|unless|until|while|although|though|whether|when|where|&|\+|-|–|—)$/i;
const SEP_TAIL = /[\s,;:(\[–—+&-]+$/;
/** Already says it was cut: ends in "…" or "..." (perhaps inside a closing bracket or quote, "hero wording…)"). */
const endsCut = (t: string) => /(…|\.\.\.)[)\]"”’']*$/.test(t);
/** The words kept, without a hanging word, a separator or an unclosed "(" left at the end. */
function tidyTail(words: string[]): string[] {
  const out = [...words];
  const strip = (w: string) => w.replace(SEP_TAIL, "");
  for (let n = 0; n < 16; n++) {
    const joined = out.join(" "); const open = joined.lastIndexOf("(");
    if (open > 0 && joined.indexOf(")", open) < 0) { const keep = joined.slice(0, open).trim().split(" ").filter(Boolean); if (keep.length) { out.splice(0, out.length, ...keep); continue; } }
    if (out.length > 1 && (DANGLING.test(strip(out[out.length - 1])) || !strip(out[out.length - 1]))) { out.pop(); continue; }
    break;
  }
  if (out.length) out[out.length - 1] = endsCut(out[out.length - 1]) ? out[out.length - 1] : strip(out[out.length - 1]) || out[out.length - 1];
  return out;
}
/**
 * The one cut (r18): every text the app shortens goes through here. The first whole words within `max` characters, never ending on a hanging
 * word, a separator or an unclosed "("; then "…" (`mark`), unless the words kept already end in one (never "wording…) …"). A text within
 * `max` comes back whole. `max` Infinity: only tidies a text that was cut elsewhere (its own "…" is dropped first).
 */
export function cutWords(text: string, max = Infinity, mark = true): string {
  const plain = text.replace(/\s+/g, " ").trim();
  if (max === Infinity) { const t = tidyTail(withoutCut(plain).split(" ").filter(Boolean)).join(" "); return mark && t && !endsCut(t) ? `${t}…` : t; }
  if (plain.length <= max) return plain;
  const words = plain.split(" ");
  const out: string[] = [];
  for (const w of words) { if (out.length && [...out, w].join(" ").length > max) break; out.push(w); }
  const t = tidyTail(out).join(" ");
  return mark && !endsCut(t) ? `${t}…` : t;
}
/** The first whole words of a text within `max` characters, never ending on a hanging word or a separator, and never with "…" (r16). */
export const firstWords = (text: string, max = 48): string => tidyTail(cutWords(withoutCut(text), max, false).split(" ").filter(Boolean)).join(" ");
/**
 * A decision row with no whole question to show (r16): the verb first, the first words, and the way in: "Decide: Uni adds Benya's missing
 * feature 4". The row opens to decide; it never ends on "…" with nothing to act on.
 */
export const decideLine = (words: string): string => {
  const w = firstWords(words);
  if (!w) return "A decision waits on you";
  // a question that already leads with the verb keeps it once ("Decide the ATLAS hosting", never "Decide: Decide …")
  return /^decide\b/i.test(w) ? w.replace(/^decide\b\s*:?\s*/i, "Decide: ") : `Decide: ${w}`;
};

/** The vault's task writer keeps `next` to 140 characters (tasks.py): a step that long with no ending was cut there (r16). */
export const NEXT_CAP = 140;
/**
 * A task's next step as rows show it (r16): a step cut at the writer's 140 characters loses its last (possibly partial) word and any hanging
 * word, and says it was cut ("…"), so a row never ends mid-phrase ("…in the"). `cut`: the full step is only in the note.
 */
export function stepText(next: string): { text: string; cut: boolean } {
  const t = next.replace(/\s+/g, " ").trim();
  if (t.length < NEXT_CAP || /[.!?)"”’'\]]$/.test(t)) return { text: t, cut: false };
  const words = t.split(" "); words.pop();
  return { text: cutWords(words.join(" ")), cut: true };
}

/** A cut fragment as whole words (r16): no "…", no unclosed "(3" tail, no hanging word ("…install flow (3" → "…install flow"). */
export const wholeWords = (text: string): string => cutWords(text, Infinity, false);
/** A cut title without its "…": what is left reads as a plain fragment, never as a row that ends on an ellipsis. */
export const withoutCut = (rest: string): string => rest.replace(/\s*(…|\.\.\.)\s*$/, "").trim();

/** What a Needs-you row says about its ask, given what is known: the full question, a whole title, or that there is no whole question. */
export type RowAsk = { text: string; /** a decision with no full question anywhere: open it to see the question, no buttons and no fragment */ openToDecide: boolean };
export const OPEN_TO_SEE = "Open to see the question";
export function rowAsk(full: string, ask: string | undefined, isDecision: boolean, hasNext: boolean, cut = isCutTitle(full)): RowAsk {
  if (!cut) return { text: full, openToDecide: false };
  if (ask && !isCutTitle(ask)) return { text: ask, openToDecide: false };
  if (isDecision) return { text: OPEN_TO_SEE, openToDecide: true };
  return { text: hasNext ? wholeWords(full) : "", openToDecide: false };
}

/** A decision's ask as a question: sentence-cased, and "Your call:" above it when the stored ask does not end in "?". */
export function askLead(text: string): { text: string; yourCall: boolean } {
  const t = text.trim();
  const cased = t ? t[0].toLocaleUpperCase() + t.slice(1) : t;
  return { text: cased, yourCall: !!cased && !/\?["')\]]*$/.test(cased) };
}

/** One plain line for where a task stands, never both the state and who it waits on ("waiting, waiting on aaron"). */
export function stateLine(t: { state: string; waitingOn: string | null; kind: string }, isMeFn: (who: string | null) => boolean, nameOf: (who: string) => string = (w) => w): string {
  if (t.kind === "decision") return "Needs your decision";
  if (isMeFn(t.waitingOn)) return "Waiting on you";
  // r16: the writer's markers read as words, never "Waiting on blocked"
  const marker: Record<string, string> = { blocked: "Blocked", parked: "Parked", external: "Waiting on someone outside" };
  if (t.waitingOn && marker[t.waitingOn.toLowerCase()]) return marker[t.waitingOn.toLowerCase()];
  if (t.waitingOn) return `Waiting on ${nameOf(t.waitingOn)}`;
  return t.state === "doing" ? "In progress" : t.state === "waiting" ? "Waiting" : "Open";
}

/** The cut-title reads that matter most go first: decisions, then Now, then the soonest due. */
export function askOrder<T extends { kind: string; priority: string | null; due: string | null; title: string }>(tasks: readonly T[]): T[] {
  const rank = (t: T) => (t.kind === "decision" ? 0 : t.priority === "now" ? 1 : 2);
  return [...tasks].sort((a, b) => rank(a) - rank(b) || (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.title.localeCompare(b.title));
}

/** How many text lines each part of a row may take so the whole stays within `budget` (3): title first, then the due line, then the next step. */
export function lineBudget(titleLines: number, hasDue: boolean, budget = 3): { next: number } {
  return { next: Math.max(0, budget - Math.min(titleLines, budget) - (hasDue ? 1 : 0)) };
}

/** Of the room's height, what the conversation keeps before the strip gets any (r16), with the whole composer. */
export const CONVERSATION_SHARE = 0.4;
/** Less room than this for the strip's body and it opens as a sheet over the room instead of pushing the conversation away. */
export const STRIP_MIN_BODY = 200;
/**
 * Where an opened strip goes (r16): inline (with this many px for its body) when the room keeps its composer and 40% of its height for the
 * conversation and still has STRIP_MIN_BODY to spare; otherwise a sheet over the room. Pure: the numbers are measured by the strip.
 */
export function stripRoom(m: { room: number; above: number; line: number; composer: number }): { mode: "inline"; body: number } | { mode: "sheet" } {
  const body = Math.floor(m.room - m.above - m.line - m.composer - CONVERSATION_SHARE * m.room);
  return body >= STRIP_MIN_BODY ? { mode: "inline", body } : { mode: "sheet" };
}

// ------------------------------------------------------------------------------------------------- r19
/**
 * What a task's action stands on (r19), modelled explicitly: notes its step links (`uni:<ULID>`, a bare id, `[[Path]]`), its `source` when
 * that names a note (a provenance string such as "Aaron/Tasks#T-21" or "tasks.py new" names none), and its `depends_on`. A step that asks for
 * answers (`questions`: the count) also needs its own note, where the questions are, unless its `questions` field already holds them. Until
 * every one of these is read, the row and the sheet say "Checking what's needed…" and assert no action. Decisions have none here: a decision's
 * question is read on its own (`decisionAsk`).
 */
export type DepRef = LinkRef & { role: "step" | "source" | "after" };
export type TaskDeps = { refs: DepRef[]; questions: number | null };
export function taskDeps(t: Pick<Task, "id" | "kind" | "next"> & { sourceRef?: string | null; dependsOn?: readonly string[]; questions?: readonly string[] }): TaskDeps {
  const out: DepRef[] = [];
  const add = (r: LinkRef, role: DepRef["role"]) => { if (r.id !== t.id && !out.some((o) => o.id === r.id && o.vault === r.vault)) out.push({ ...r, role }); };
  // r20: a decision has the same contract for what it stands on (`source`, `depends_on`); its question is read on its own (`unknownDecision`)
  if (t.kind === "task") for (const r of linkedRefs(t.next)) add(r, "step");
  for (const r of linkedRefs(t.sourceRef ?? "")) add(r, "source");
  for (const d of t.dependsOn ?? []) for (const r of linkedRefs(d)) add(r, "after");
  // r20: every reference is read (never the first six only): the reads are bounded in how many run at once, not in how many there are
  const q = t.kind === "task" ? questionCount(t.next) : null;
  return { refs: out, questions: q !== null && !t.questions?.length ? q : null };
}
export const hasDeps = (d: TaskDeps): boolean => d.refs.length > 0 || d.questions !== null;

/** What reading a task's supporting notes came to (r19): its source state (`Support`), all clear (`ok`), or a `depends_on` note still open.
 *  r20: `missing`: a note it stands on isn't in the vault ("Couldn't find “Cutover plan” · Open the task"): unresolved, never all clear. */
export type Assessed = Support | { kind: "ok" } | { kind: "waits"; from: SourceRef } | { kind: "missing"; ref: string };
/** One note read for it, at the revision read: the record says which revisions it stands on. */
export type SourceStamp = { vault: string; id: string; rev: string | null };
/**
 * A check of a task's supporting notes (r19), kept by the sources it read ({vault, id, revision}) and when it was verified, never by the task's
 * revision alone: every list refresh reads the sources again, so a source that closes while the task stays unchanged is seen. `taskRev`: the
 * task revision it was made for (a rewritten task may stand on other notes).
 */
export type CheckRecord = { taskRev: string | null; at: number; result: Assessed; sources: SourceStamp[] };
/** Where a task's check stands: the last good record (if any), and when the last read failed (cleared by a good read). */
export type CheckState = { rec: CheckRecord | null; failedAt: number | null };
/** A check is trusted this long after it was verified; past it the row is "Checking what's needed…" (or "Couldn't check") until read again. */
export const CHECK_TTL = 30 * 60_000;
/**
 * What a row shows about its supporting notes (r19). `checking`: not read yet (or the last check expired) and no failure: no action is
 * asserted. `unavailable`: the read failed (not "read but ambiguous", which is `unclear`): "Couldn't check · Retry". Otherwise the record's
 * result. Null: the task stands on no note, so there is nothing to check.
 */
export type Check = { kind: "checking" } | { kind: "unavailable" } | Assessed;
export function checkOf(t: Parameters<typeof taskDeps>[0] & Pick<Task, "updatedAt">, state: CheckState | undefined, nowMs: number): Check | null {
  if (!hasDeps(taskDeps(t))) return null;
  const rec = state?.rec;
  // r21 (Codex P1-1): a failed check newer than the last good one invalidates it: "Couldn't check · Retry", never the old instruction
  if (state?.failedAt && (!rec || state.failedAt >= rec.at)) return { kind: "unavailable" };
  if (rec && rec.taskRev === t.updatedAt && nowMs - rec.at < CHECK_TTL && nowMs >= rec.at - 60_000) return rec.result;
  return state?.failedAt ? { kind: "unavailable" } : { kind: "checking" };
}
/** r21: Retry: a failed check reads as checking again (never the result it invalidated) until a read succeeds. */
export const retryState = (s: CheckState): CheckState => (s.failedAt ? { rec: null, failedAt: null } : s);
export const CHECKING = "Checking what's needed…";
export const CHECK_FAILED = "Couldn't check";
/** "Waits on “Mail plan v2” first": a `depends_on` note that is still open (r19). */
export const waitsLine = (s: Extract<Assessed, { kind: "waits" }>): string => `Waits on “${s.from.title}” first`;
/** How a reference that can't be found is named (r20): a path by its last part, an id as written (its vault, the first characters). */
export const refName = (r: LinkRef): string => (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(r.id) ? `${r.vault ? `${r.vault}:` : ""}${r.id.slice(0, 10)}…` : `“${r.id.split("/").filter(Boolean).pop() ?? r.id}”`);
/** "Couldn't find “Cutover plan”": a note a task or decision stands on that the vault doesn't have (r20). */
export const missingLine = (s: Extract<Assessed, { kind: "missing" }>): string => `Couldn't find ${s.ref}`;
export const OPEN_TASK = "Open the task";

/**
 * Records that aren't real requests (r19, P1-3): a Needs-you item that names no concrete action Aaron can finish. Conservative and tested on
 * real titles; when unsure, null (the item stays in Needs you). tasks.py (T-131) already refuses such records, so these are legacy ones.
 * - `outline`: a labelled list of notes ("Fractal flow test: real work in area rooms, check updates propagate up; nested room names; …"): a
 *   label that asks nothing, then two or more ";" parts, none of which starts with an action.
 * - `machinery`: Uni's own upkeep shown as a request ("Run /restart … loads the uni-relay hook … [done|blocked|decision] markers").
 * - `status`: a step that says the work is over ("Superseded: …", "Done …") on a record still open.
 * - `proposal`: a decision with no stored options whose whole question asks nothing ("Decision (needs your yes): a daily calendar email…").
 *   A cut title whose question isn't read yet is unsure: kept.
 */
export type TidyReason = "outline" | "machinery" | "status" | "proposal";
const PART_ACTION = /^(?:say|ok|okay|yes|no|go|listen|watch|look|approve|sign|confirm|decide|pick|choose|answer|reply|tell|send|review|check|merge|deploy|ship|read|call|email|write|forward|pay|book|schedule|give|put|share|post|record|fill|talk|meet|test|try|open|grade|draft)\b/i;
const ASKS_IN_LABEL = /\b(?:go|ok|okay|yes|no|approve|approval|sign[- ]?off|decide|decision|pick|choose|review|confirm|answer|reply|call)\b/i;
export function tidyReason(t: Partial<Pick<Task, "kind" | "title" | "next" | "options" | "ask" | "askAt" | "updatedAt">>): TidyReason | null {
  if (typeof t.title !== "string") return null;
  if (t.kind === "decision") {
    if (!Array.isArray(t.options) || t.options.length) return null;
    const tt = taskTitle(t.title);
    const q = decisionQuestion(tt.rest, t.ask, t.askAt, t.updatedAt ?? null, tt.cut || tt.previewed);
    if (!q) return null; // its question isn't known yet: unsure, so it stays
    // a "?" inside a quote ("the “were you there?” prompt") asks nothing of the user; a request to decide ("Decide the COhere venue", "Which
    // hours…", "Whether to…") asks, even without one
    if (/^(?:decide|choose|pick|which|whether|what|who|when|where|how|should|shall)\b/i.test(q.trim())) return null;
    return /\?/.test(q.replace(/["“][^"”]*["”]/g, "")) ? null : "proposal";
  }
  if (t.kind !== "task" || typeof t.next !== "string") return null;
  const step = t.next.replace(/[*_`>]/g, "").replace(/\s+/g, " ").trim();
  if (!step) return null;
  if (/^(?:superseded|obsolete|no longer (?:needed|an ask)|done|closed|merged into)\b\s*[:.,;—–-]/i.test(step)) return "status";
  if (/^run\s+\/[a-z][\w-]*/i.test(step) || /\[(?:done|blocked|decision)(?:\|(?:done|blocked|decision))+\]/i.test(step)) return "machinery";
  const m = /^([^:;]{3,60}):\s+(.+)$/.exec(step);
  if (m && !ACTION_VERBS.test(step) && !PART_ACTION.test(step) && !ASKS_IN_LABEL.test(m[1])) {
    const parts = m[2].split(/\s*;\s*/).filter(Boolean);
    if (parts.length >= 2 && !parts.some((p) => ACTION_VERBS.test(p) || PART_ACTION.test(p))) return "outline";
  }
  return null;
}
/** What the work view's quiet line under a record to tidy says, and the sheet's sentence (r19). */
export const TIDY_LINE: Record<TidyReason, string> = {
  outline: "Notes, not one step you can finish",
  machinery: "Uni's own upkeep, not yours",
  status: "Says it's finished, but still open",
  proposal: "States a proposal, asks nothing",
};
export const TIDY_SAYS: Record<TidyReason, string> = {
  outline: "This record is a list of notes, not one step you can finish.",
  machinery: "This is Uni's own upkeep shown as a request; nothing here is yours to do.",
  status: "Its step says the work is over, but the record is still open.",
  proposal: "This states a proposal but asks you nothing: it has no question and no options to pick.",
};

// ------------------------------------------------------------------------------------------------- r20
/** Where a step's first clause ends (r20): ";", a spaced dash, " then ", ": " or a sentence's end, the first after `from`. */
const CLAUSE_END = /;|\s[—–-]\s|,?\s+then\s|:\s|[.!?](?=\s|$)/gi;
/** Words that end a verb phrase's object ("Edit and send the ATLAS follow-up | to Mark…"): a preposition or a joining word. */
const OBJECT_END = /^(?:to|from|with|in|on|at|for|by|about|before|after|via|into|onto|over|under|through|if|when|so|because|then|and|or|but|while|until|unless|once|as|than|per)$/i;
/** A word that belongs to the verb before its object ("Look at", "Reply to", "Follow up", "Sign off"). */
const PARTICLE = /^(?:at|to|up|out|off|back|over|through|in|on)$/i;
/**
 * The verb phrase a step leads with (r20): the verb (or two joined, "Edit and send", "Approve or change"), a particle ("Look at"), and its object
 * up to the first preposition, joining word, bracket or comma ("Tell Uni who pays", "Edit and send the ATLAS follow-up"). A row never cuts inside
 * it. At most eight words.
 */
export function verbPhrase(action: string): string {
  // a label ("Production go:", "Reply:") is part of the phrase, with the verb phrase after it
  const lab = /^([^:;]{1,40}):\s+(\S.*)$/.exec(action);
  if (lab && ((labelAsks(action) && !ACTION_VERBS.test(lab[1])) || (/^\S+$/.test(lab[1]) && ACTION_VERBS.test(lab[1])))) return `${lab[1]}: ${verbPhrase(lab[2])}`.replace(/[,;:.]+$/, "");
  const words = action.split(" ").filter(Boolean);
  if (!words.length) return "";
  const out = [words[0]];
  let i = 1;
  if (words[i] && /^(?:and|or)$/i.test(words[i]) && words[i + 1] && ACTION_VERBS.test(words[i + 1])) { out.push(words[i], words[i + 1]); i += 2; }
  if (words[i] && PARTICLE.test(words[i]) && words[i + 1]) { out.push(words[i]); i++; }
  for (; i < words.length && out.length < 8; i++) {
    const w = words[i];
    if (/^[([{]/.test(w) || OBJECT_END.test(w)) break;
    if (/[,;:]$/.test(w)) { out.push(w.replace(/[,;:]+$/, "")); break; }
    out.push(w);
  }
  return out.join(" ").replace(/[,;:.]+$/, "");
}
/** A text's first clause (r20): up to the first ";", spaced dash, " then ", ": " or sentence end at or after `from`; a cut inside "(…)" backs up
 *  to before the bracket. Trailing separators are dropped. */
export function firstClause(text: string, from = 0): string {
  const t = text.replace(/\s+/g, " ").trim();
  CLAUSE_END.lastIndex = Math.max(0, from);
  let m: RegExpExecArray | null;
  let at = t.length;
  while ((m = CLAUSE_END.exec(t))) {
    // a sentence end inside a word or a number ("unforced.dev", "v1.2") was skipped by the lookahead; "e.g." and "i.e." are not ends
    if (/^[.!?]$/.test(m[0]) && /\b(?:e\.g|i\.e|etc|vs|approx|incl)$/i.test(t.slice(0, m.index))) continue;
    at = m[0] === "." || m[0] === "!" || m[0] === "?" ? m.index + 1 : m.index;
    break;
  }
  let out = t.slice(0, at);
  const open = out.lastIndexOf("(");
  if (open > from && out.indexOf(")", open) < 0) out = out.slice(0, open);
  return out.replace(/[\s,;:—–-]+$/, "").trim();
}
/**
 * What a row leads with (r20; r21, both critics: the whole action). A leading date label is dropped (it is the due cue, or the subtitle); the
 * action is the verb phrase with all its objects and recipients, up to the sentence's end ("Edit and send the ATLAS follow-up to Mark and
 * Dominic from your account"). Only context after it is the sheet's: a ";" clause that isn't the user's ("; Harper signs off…"), a spaced dash,
 * "because…". A step written "A, then B" (or "A; then B") is both steps (`steps`). `forms`: what a row may show, best first: the whole action;
 * the same without its brackets (dates, examples, links' notes); for more than one step, "2 steps: A, then …" (the sheet lists them). `keep`:
 * each form's part a cut never enters. `text`: the whole action. Null: not an action.
 */
export type RowAction = { text: string; verb: string; rest: string; prefix: string | null; steps: string[]; forms: { text: string; keep: string }[] };
/** Bracket depth before each character of a text ("(…)", "[…]"). */
const depths = (t: string): number[] => { const d: number[] = []; let n = 0; for (let i = 0; i < t.length; i++) { const c = t[i]; if (c === "(" || c === "[") n++; d.push(n); if ((c === ")" || c === "]") && n > 0) n--; } return d; };
/** Where a "then" joins two steps (r21): ", then", "; then", " and then", or a bare " then " before a verb. */
const THEN = /(?:,|;)?\s+(?:and\s+)?then\s+(?=\S)/gi;
const isThen = (t: string, m: RegExpExecArray): boolean => /^[,;]|\band\s/i.test(m[0]) || ACTION_VERBS.test(t.slice(m.index + m[0].length));
/** A ";" clause that is a step the user does before the rest ("; listen to 2 Jacobs clips first"). */
const FIRST_CLAUSE = /^;\s*([^;.!?]*\bfirst)(?=[.;!?]|$)/i;
/** Where the action ends (r21): the sentence's end, or the first ";" (not "; then", not "; … first"), spaced dash or "because" outside brackets. */
function actionEnd(t: string): number {
  const d = depths(t);
  for (let i = 0; i < t.length; i++) {
    if (d[i] !== 0) continue;
    const c = t[i]; const after = t.slice(i);
    if ((c === "." || c === "!" || c === "?") && (i + 1 === t.length || /\s/.test(t[i + 1]))) {
      if (c === "." && /\b(?:e\.g|i\.e|etc|vs|approx|incl)$/i.test(t.slice(0, i))) continue;
      // a question carried on by the next ("…browser share? And keep logged-in sessions or log out after each job?") is one ask
      const more = c === "?" ? /^\s+(?:and|or|also)\b[^.!?]*\?/i.exec(t.slice(i + 1)) : null;
      if (more) { i += more[0].length - 1; continue; }
      return c === "." ? i : i + 1;
    }
    if (c === ";") {
      if (/^;\s*(?:and\s+)?then\s/i.test(after)) continue;
      const f = FIRST_CLAUSE.exec(after);
      if (f && ACTION_VERBS.test(f[1].trim())) { i += f[0].length - 1; continue; }
      // r22 (both critics): "…from your account; fill the opening, sign-off and next-review date" is the user's too: a clause that leads with
      // a work verb stays in the action ("; Harper signs off…", "; yes/no on…" are context, the sheet's)
      if (ACTION_VERBS.test(after.slice(1).trim())) continue;
      return i;
    }
    if (/^\s[—–-]\s/.test(after) || /^,?\s+because\s/i.test(after)) return i;
  }
  return t.length;
}
/** The action's steps (r21), in the order they are done ("A; B first" is B, then A). */
function stepsOf(region: string): string[] {
  const d = depths(region);
  const out: string[] = []; let from = 0;
  THEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = THEN.exec(region))) { if (d[m.index] === 0 && isThen(region, m)) { out.push(region.slice(from, m.index)); from = m.index + m[0].length; } }
  out.push(region.slice(from));
  const steps = out.map((x) => x.replace(/^[\s,;:]+|[\s,;:—–-]+$/g, "").trim()).filter(Boolean);
  // "…; listen to 2 Jacobs clips first": that clause is the first step
  const last = steps.length ? steps[steps.length - 1] : "";
  const semi = last.lastIndexOf(";");
  if (semi > 0 && depths(last)[semi] === 0) { const f = FIRST_CLAUSE.exec(last.slice(semi)); if (f) return [capFirst(f[1].trim()), ...steps.slice(0, -1), last.slice(0, semi).trim()]; }
  return steps;
}
/** A text without its bracketed parts ("Tell Uni who pays (Techne or Gitcoin Foundation) and how" → "Tell Uni who pays and how"). */
export const withoutBrackets = (t: string): string => { const d = depths(t); let out = ""; for (let i = 0; i < t.length; i++) if (d[i] === 0 && t[i] !== ")" && t[i] !== "]") out += t[i]; return out.replace(/\s+([,;:.!?])/g, "$1").replace(/\s+/g, " ").trim(); };
/** The row's form for more than one step that doesn't fit whole (r21): "2 steps: A, then …". */
export const stepsLine = (steps: readonly string[]): string => `${steps.length} steps: ${withoutBrackets(steps[0])}, then …`;
/** r22: past this many characters (links read as their hosts) a row's action is shortened with words, never with an ellipsis. */
export const ROW_ACTION_MAX = 160;
/** A row's action (r22): the whole action; when longer than `ROW_ACTION_MAX`, without its brackets, then with each link as "the link". */
export function rowForm(text: string): string {
  const len = (t: string) => withHosts(t).length;
  if (len(text) <= ROW_ACTION_MAX) return text;
  const a = withoutBrackets(text);
  if (len(a) <= ROW_ACTION_MAX) return a;
  return a.replace(/https?:\/\/[^\s)]+|\bwww\.[^\s)]+/g, "the link").replace(/\s+/g, " ").trim();
}
/** The folded strip's one line for an action of more than one step (r22): step 1 and how many there are, never "then …". */
export const firstOfSteps = (steps: readonly string[]): string => `${withoutBrackets(steps[0])} (step 1 of ${steps.length})`;
export function rowAction(next: string | null | undefined): RowAction | null {
  const lead = actionLead(next);
  if (!lead) return null;
  return actionOf(lead, datePrefix(plainStep(next)).prefix);
}
/** The whole action of a step already known to be one (r21): its text, steps and forms. */
export function actionOf(lead: string, prefix: string | null = null): RowAction {
  const at = actionEnd(lead);
  const text = lead.slice(0, at).replace(/[\s,;:—–-]+$/, "").trim() || lead;
  const verb = verbPhrase(text);
  const steps = stepsOf(text);
  const forms: { text: string; keep: string }[] = [];
  const add = (f: string, keep: string) => { if (f && !forms.some((x) => x.text === f)) forms.push({ text: f, keep }); };
  // what a cut never enters: the verb phrase and the rest of its first clause ("Send the SOW to Casey when convenient", never "…to Mark…")
  const main = (t: string) => { const v = verbPhrase(t); const c = firstClause(t, Math.min(v.length, t.length)); return c.length >= v.length ? c : v; };
  // r22 (both critics): one form, the whole action, every step ("A, then B") and every verb phrase; never clamped, never "then …". Past
  // `ROW_ACTION_MAX` characters it is shortened with words: its brackets, then its links' addresses, go to the sheet
  void main;
  const f = rowForm(text);
  add(f, f);
  return { text, verb, rest: lead.slice(text.length).replace(/^[\s.,;:—–-]+/, "").trim(), prefix, steps, forms };
}
const sig = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !/^(?:the|and|for|with|from|your|this|that|into|onto)$/.test(w));
/** Whether a title mostly says again what the action says ("Send the ATLAS Oct 12 follow-up email" under "Edit and send the ATLAS follow-up…"). */
export function repeats(title: string, action: string): boolean {
  const a = new Set(sig(action).map((w) => w.replace(/s$/, "")));
  const t = sig(title).map((w) => w.replace(/s$/, ""));
  if (!t.length) return true;
  return t.filter((w) => a.has(w)).length / t.length >= 0.5;
}
/** A title short and whole enough to say where an action belongs ("COhere opens Oct 15"); a long or cut one is vague. */
export const SUB_TITLE_MAX = 40;
/**
 * A row's subtitle (r20): the due cue ("due today", "was due Oct 13"; else the step's date label), after where it belongs: the task's own title
 * when it is short, whole and says something the action doesn't, else its area when the row is shown outside it. Never a cut or vague title
 * ("Companion Today redesign…"), never one that repeats the action. Null: nothing to add.
 */
export function rowSub(t: Pick<Task, "title" | "due">, action: RowAction, area: string | null = null, today = localDay()): string | null {
  const { where, when } = rowSubParts(t, action, area, today);
  return [where, when].filter(Boolean).join(" · ") || null;
}
/** The subtitle's two parts (r20): where it belongs (a row may cut this) and the due cue (a row never cuts it). */
export function rowSubParts(t: Pick<Task, "title" | "due">, action: RowAction, area: string | null = null, today = localDay()): { where: string | null; when: string | null } {
  const where = titleSays(t.title, action.text) ?? area;
  return { where, when: dueLine(t.due, today) ?? action.prefix };
}
/** A task's title when it is short, whole and says something its action doesn't (r20): else null. */
export function titleSays(raw: string, action: string): string | null {
  const tt = taskTitle(raw);
  const title = tt.rest.replace(/\s+/g, " ").trim();
  return title && !tt.cut && title.length <= SUB_TITLE_MAX && !repeats(title, action) ? title : null;
}
/** A title as plain words for a quiet line (r20): no "Decision (default yes):" label, no cut tail ("…feature 4, the"), sentence-cased. */
export const titleWords = (rest: string): string => { const w = wholeWords(rest.replace(/^decision\s*(\([^)]*\))?\s*[:\-–—]\s*/i, "")); return w ? capFirst(w) : rest; };
