// T-124 "Simple first" (pure, unit-tested in scripts/steer.test.ts): what the room's quiet companion says. One sentence for where
// the room stands, at most three things that need the user (Now first), the chat composer's placeholder.
import { isMe, PRIORITIES, type Task } from "./taskCore.ts";
import { taskTitle, type Where } from "./whereCore.ts";
import { ROOT } from "./treeCore.ts";
import type { Run } from "./steerCore.ts";

/** The first sentence of the level's lede, as plain text and whole (a long one is clamped on screen, never cut here: it opens in full). */
export function firstSentence(text: string | null | undefined): string {
  const plain = (text ?? "").replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2").replace(/[*_`>]/g, "").replace(/(^|\s)#+(?=\s)/g, "$1").replace(/\s+/g, " ").trim(); // r23: a heading's "#" goes, "#38" stays
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
export function wouldNeedYou(t: Pick<Task, "kind" | "owner" | "waitingOn" | "priority" | "state"> & Partial<Pick<Task, "next">>): boolean {
  if (t.state !== "open" && t.state !== "doing" && t.state !== "waiting") return false;
  // r26: a task whose own step says it was superseded is closed, whatever its stored state
  if (superseded(t.next)) return false;
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
export function needsByRow(tasks: readonly Task[], rows: ReadonlySet<string>, parentOf: (path: string) => string | undefined, confOf?: ConfOf, runs: readonly Pick<Run, "node" | "task" | "state">[] = []): Map<string, number> {
  const m = new Map<string, number>();
  const place = (node: string) => {
    let at: string | undefined = node;
    for (let n = 0; at !== undefined && at !== ROOT && !rows.has(at) && n < 64; n++) at = parentOf(at);
    const key = at !== undefined && rows.has(at) ? at : ROOT;
    m.set(key, (m.get(key) ?? 0) + 1);
  };
  const counted = new Set<string>();
  for (const t of tasks) {
    // r28 (Codex P2-6): only confirmed asks count; a recheck or a held-back ask lights no dot
    if (!needsYou(t) || (confOf && confOf(t).state !== "confirmed")) continue;
    const id = taskIdOf(t); if (id) counted.add(id);
    place(t.node);
  }
  // a run waiting on the user's answer is counted once: not when its task is already counted
  for (const r of runs) if (waitingOnYou(r) && !(r.task && counted.has(r.task.toUpperCase()))) place(r.node);
  return m;
}
/** The task's id as a run names it ("T-07"), upper-cased; null when its title has none. */
export const taskIdOf = (t: Pick<Task, "title">): string | null => taskTitle(t.title).id?.toUpperCase() ?? null;

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
  /** r28: asks Uni must recheck (not confirmed): listed apart under "Uni is rechecking N older asks", never in `total` or the dots. */
  recheck?: Task[];
  /** r28: asks whose room's chat is still being read: held back from `total`, "Checking…" for a few seconds at most. */
  checking?: Task[];
  /** r28 (Codex P2-6): runs waiting on the user's answer, deduplicated by task; they are in `total` (one count everywhere). */
  waiting?: Run[];
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
export type ConfOf = (t: Task) => Resolved;
export function needsFeed(tasks: readonly Task[], privateOf: (node: string) => PrivatePlace | null, self: PrivatePlace | null = null, today = localDay(), confOf?: ConfOf): NeedsFeed {
  const owed = rankNeeds(tasks.filter(needsYou), today);
  const stateOf = (t: Task): Confirm => (confOf ? confOf(t).state : "confirmed");
  const all = owed.filter((t) => stateOf(t) === "confirmed");
  const rows: Task[] = [];
  const recheck: Task[] = [];
  const checking: Task[] = [];
  const by = new Map<string, PrivateNeed>();
  for (const t of owed) {
    const p = privateOf(t.node);
    const open = !p || (self && p.path === self.path);
    const st = stateOf(t);
    // a private area's unconfirmed asks are not listed outside it (their words stay inside); they are neither counted nor named
    if (st === "recheck") { if (open) recheck.push(t); continue; }
    if (st === "pending") { if (open) checking.push(t); continue; }
    if (open) { rows.push(t); continue; }
    const g = by.get(p!.path) ?? { key: p!.path, count: 0, place: p!.name, open: { path: p!.path }, actions: [], others: 0 };
    by.set(p!.path, g);
    g.count++;
    const a = privateAction(t);
    if (a) g.actions.push(a); else g.others++;
  }
  const here = (t: Task) => !privateOf(t.node) || privateOf(t.node)?.path === self?.path;
  const tidy = tasks.filter((t) => toTidy(t) && here(t));
  const pending = rankNeeds(tasks.filter((t) => wouldNeedYou(t) && unknownDecision(t) && here(t)), today);
  return { rows, privates: [...by.values()], total: all.length, tidy, pending, recheck, checking, waiting: [] };
}
/**
 * r28 (Codex P2-6): the runs waiting on the user's answer join the feed, so the count, the dots and the strip say the same number. Each is
 * counted once, deduplicated by task: a run whose task is already a confirmed row is not a second item, and an ask in the recheck list whose
 * run is waiting now is not rechecked (the run is the live word).
 */
export function withWaiting(feed: NeedsFeed, runs: readonly Run[]): NeedsFeed {
  const have = new Set(feed.rows.map(taskIdOf).filter(Boolean) as string[]);
  const seen = new Set<string>();
  const waiting = runs.filter(waitingOnYou).filter((r) => {
    const tid = r.task?.toUpperCase() ?? null;
    if (tid && (have.has(tid) || seen.has(tid))) return false;
    if (tid) seen.add(tid);
    return true;
  });
  const names = new Set(waiting.map((r) => r.task?.toUpperCase()).filter(Boolean) as string[]);
  return { ...feed, waiting, total: feed.total + waiting.length, recheck: (feed.recheck ?? []).filter((t) => { const id = taskIdOf(t); return !(id && names.has(id)); }) };
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
  // r28: the waiting runs are shown in the panel itself, so they are not in "Show N more"
  return { ...feed, rows, privates: [], total: feed.total, rest: Math.max(0, feed.total - rows.length - (feed.waiting?.length ?? 0)), privateCount, pending };
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
  if (!a || a.steps.length > 1 || a.prefix || !ACTION_VERBS.test(a.text)) return null;
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
  if (!t || (!ACTION_VERBS.test(t) && !labelAsks(t) && !introducedAction(t))) return null;
  return t[0].toLocaleUpperCase() + t.slice(1);
}
/** r25 (Codex P2 5): "On your phone, look at grove.example.org, then forward Harper the asks" is an action that begins with where or when. */
const INTRO = /^(?:on|at|in|from|when|once|after|before|with|using|via)\b[^,;:.]{1,48},\s+(?=\S)/i;
/** A step without the where/when it begins with ("On your phone, look at …" → "look at …"), for reading its verb. */
export const withoutIntro = (t: string): string => { const m = INTRO.exec(t); return m && ACTION_VERBS.test(t.slice(m[0].length)) ? t.slice(m[0].length) : t; };
const introducedAction = (t: string): boolean => { const m = INTRO.exec(t); return !!m && ACTION_VERBS.test(t.slice(m[0].length)); };
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
 * When a request was made (r23, Codex P1), never the record's last change: `updatedAt` moves when the board is rebalanced, so it is not a
 * request date. An explicit request time reads "asked Oct 6"; without one, when the task was added: "added Oct 11". Null: neither is known.
 */
export type AskedWhen = { at: string; kind: "asked" | "added" };
export function requestDate(t: Partial<Pick<Task, "asked" | "added">>): AskedWhen | null {
  if (t.asked && Number.isFinite(stampMs(t.asked))) return { at: t.asked, kind: "asked" };
  if (t.added && Number.isFinite(stampMs(t.added))) return { at: t.added, kind: "added" };
  return null;
}
/** "asked today", "added Oct 11": a date, never "yesterday", so it reads the same whenever the list is looked at again. */
export function askedLine(w: AskedWhen | null | undefined, today = localDay()): string | null {
  if (!w) return null;
  const ms = stampMs(w.at);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const day = localDay(d);
  if (day === today) return `${w.kind} today`;
  return `${w.kind} ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(day.slice(0, 4) !== today.slice(0, 4) ? { year: "numeric" } : {}) })}`;
}
/**
 * The room's chat has moved on (r22, Codex P1): its last message is more than a day newer than the request (r23: the request's own date,
 * `requestDate`; a date without a time counts from the end of that day). `lastTs` in seconds, as the rooms list has it.
 */
export const MOVED_ON_MS = 24 * 3600_000;
export function chatMovedOn(w: AskedWhen | null | undefined, lastTs: number | null | undefined): boolean {
  if (!w) return false;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(w.at.trim());
  const ms = day ? new Date(`${w.at.trim()}T23:59:59`).getTime() : stampMs(w.at);
  return Number.isFinite(ms) && typeof lastTs === "number" && Number.isFinite(lastTs) && lastTs * 1000 - ms > MOVED_ON_MS;
}
export const MOVED_ON = "Chat has moved on since this was asked";
export const movedOnText = (w: AskedWhen): string => (w.kind === "asked" ? MOVED_ON : "Chat has moved on since this was added");

/**
 * r24 (Codex P1 2, Sonnet line 5): "moved on" means something only when the room has talked about THIS request since it was asked. The
 * request must be room-directed or an approval; the chat counts only when a message after the request names its task id, a `#NN` number from
 * its step, or two of the step's distinctive words.
 */
const KEY_STOP = new Set("about after again also back before being both check could from have here into just like make more need next onto only other over same some that then there these they this those through very want were what when where which while will with without would your their them been done does each first last must still such than well went already skip change changes please today tomorrow yesterday thread letter email draft ready going gets getting being using use used".split(" "));
export type RequestKeys = { ids: string[]; words: string[] };
export function requestKeys(t: { title?: string | null; next?: string | null }): RequestKeys {
  const title = t.title ?? "";
  const next = t.next ?? "";
  const ids = new Set<string>();
  const tid = /\bT-\d+\b/i.exec(title)?.[0];
  if (tid) ids.add(tid.toUpperCase());
  for (const m of `${next} ${title}`.matchAll(/(?:^|[^\w&])#(\d{1,5})\b/g)) ids.add(`#${m[1]}`);
  const words = [...new Set((next.toLowerCase().replace(/\b([\w-]+)(?:\.[\w-]+)+\b/g, "$1").match(/[a-z]{5,}/g) ?? []).filter((w) => !KEY_STOP.has(w) && !/^(?:say|tell|reply|ask|send|copy|approve|approval|message|room|chat)$/.test(w)))];
  return { ids: [...ids], words };
}
/** A request spoken to the room or asking for an approval: "Say …", "Tell Uni …", "Approve …", "go/no-go", a decision. */
export function isApprovalRequest(t: { kind?: string; next?: string | null }, audienceIsRoom: boolean): boolean {
  return t.kind === "decision" || audienceIsRoom || /(?:^|[,;:]\s*|\bthen\s+)(?:approve|say)\b|\bgo\s*\/\s*no[- ]?go\b|\bgo or no\b/i.test(t.next ?? "");
}
export type RoomMsg = { ref?: string; ts: number; body: string };
export type ChatHit = { key: string; ref: string | null; ts: number };
/** The first message after the request (`ts` in seconds) that mentions its key terms, or null. */
export function chatAbout(w: AskedWhen | null | undefined, msgs: readonly RoomMsg[], keys: RequestKeys): ChatHit | null {
  if (!w || !(keys.ids.length || keys.words.length)) return null;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(w.at.trim());
  const from = day ? new Date(`${w.at.trim()}T23:59:59`).getTime() : stampMs(w.at);
  if (!Number.isFinite(from)) return null;
  for (const m of [...msgs].sort((a, b) => a.ts - b.ts)) {
    if (!(m.ts * 1000 > from)) continue;
    const body = m.body.toLowerCase();
    const id = keys.ids.find((k) => (k.startsWith("#") ? new RegExp(`(^|[^\\w&])${k.toLowerCase()}\\b`) : new RegExp(`\\b${k.toLowerCase()}\\b`)).test(body));
    if (id) return { key: id, ref: m.ref ?? null, ts: m.ts };
    const hit = keys.words.filter((k) => new RegExp(`(^|[^a-z-])${k}([^a-z-]|$)`).test(body));
    if (hit.length >= 2) return { key: hit.slice(0, 2).join(" "), ref: m.ref ?? null, ts: m.ts };
  }
  return null;
}
/**
 * r25 (Codex P1 2), r27: what looking in the room's chat came to, in the four states the sheet keeps internally. `found`: related conversation
 * after the record's write, or a read too short to reach back to it (`hit` null: unknown is not "nothing new"). `failed`: the chat couldn't be
 * read. `none`: nothing related after the write. `pending` is a lookup not back yet (`gateOf`). `msgs` null is a lookup that failed. The sheet
 * shows only current, unconfirmed and couldn't-read (`freshnessOf`); "nothing related found" is never shown as a validation.
 */
export type CheckIn = { kind: "found"; hit: ChatHit | null } | { kind: "failed" } | { kind: "none" };
/** The most messages the lookup reads: a read this full that starts after the write has not seen the write's time. */
export const LOOKUP_LIMIT = 200;
export function checkInResult(w: AskedWhen | null | undefined, msgs: readonly RoomMsg[] | null | undefined, keys: RequestKeys, limit = LOOKUP_LIMIT): CheckIn {
  if (!Array.isArray(msgs)) return { kind: "failed" };
  const hit = chatAbout(w, msgs, keys);
  if (hit) return { kind: "found", hit };
  const from = w ? (/^\d{4}-\d{2}-\d{2}$/.test(w.at.trim()) ? new Date(`${w.at.trim()}T23:59:59`).getTime() : stampMs(w.at)) : NaN;
  const oldest = msgs.length ? Math.min(...msgs.map((m) => m.ts)) * 1000 : Infinity;
  // r27: a full read whose oldest message is already newer than the write may have missed what came right after it
  return msgs.length >= limit && Number.isFinite(from) && oldest > from ? { kind: "found", hit: null } : { kind: "none" };
}
export const couldntRead = (room: string): string => `Couldn't read #${room.replace(/^#/, "")}`;
/** The banner over the composer after "Check in": the sheet's question stays in view while the chat is read (r25). */
export const checkingBanner = (step: string): string => `Checking: ${cutWords(withHosts(plainStep(step)), 110, false).replace(/[\s,;:]+$/, "")}`;
export const checkInCue = (room: string, key: string, w: AskedWhen): string => `#${room.replace(/^#/, "")} has talked about ${key} since this was ${w.kind === "asked" ? "asked" : "added"}`;

/**
 * r27 (Codex P1-2): "Where this stands" is a dated account ("As of Oct 14: ...") shown as written, never partly promoted. Two things make the
 * whole of it older than the work: a clause that says something waits on Aaron or on approval that no open item matches (the r26 claim check,
 * now only the trigger: ids it names, else two distinctive words), or a newer change in any task under the node (`updated_at` after the
 * summary's). Either dims the whole summary behind "This summary is older than the latest work · from Oct 14", with "What it said" to open it.
 */
export const WAITS_ON_ME = /\bwaits?\s+on\s+aaron\b|\baaron['’]s\s+(?:go|ok|okay|ask|call|ans|decision|approval|sign-?off)\b|\bneeds?\s+aaron\b|\bfor\s+aaron\s+to\b|\bawaiting\s+aaron\b|\bwaiting\s+(?:on|for)\s+aaron\b|\b(?:awaiting|pending|needs?|needed|requires?)\s+(?:your\s+|aaron['’]s\s+|his\s+)?(?:approval|sign-?off|go-?ahead|ok\b|okay\b|decision)|\bapproval\s+(?:pending|needed|required)\b|\bwaits?\s+on\s+(?:your|his)\s+(?:go|ok|approval|answer|decision)/i;
export type StaleSummary = { from: string | null; /** why: a wait claim nothing open matches, or a newer change in a task on the node */ why: "claim" | "newer" | "closed" };
export const STALE_SUMMARY = "This summary is older than the latest work";
export const staleLine = (s: Pick<StaleSummary, "from">): string => (s.from ? `${STALE_SUMMARY} · from ${s.from}` : STALE_SUMMARY);
/** A stamp as the date a summary is dated by: "Oct 14" (local calendar day). Null when unknown. */
export const asOfDate = (at: string | null | undefined): string | null => { const ms = stampMs(at ?? ""); return Number.isFinite(ms) ? new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null; };
/** The summary as written, with its date in front: "As of Oct 14: COhere 2026 is live…". */
export const asOfPrefix = (asOf: string | null | undefined): string => (asOf ? `As of ${asOf}: ` : "");
const CLAIM_STOP = new Set("aaron aaron's waits waiting awaiting needs needed decision approval prod staging deploy deployed first second their about which where would should could these those after before until still ready today tomorrow there being other under again while review reviews".split(" "));
type Clause = { text: string; sep: string };
/** The summary as clauses: split at sentence ends, ";" and (when both sides are real clauses) ", "; never inside a bracket. */
export function summaryClauses(text: string): Clause[] {
  const t = text.replace(/\s+/g, " ").trim();
  const d = depths(t);
  const out: Clause[] = []; let from = 0;
  const words = (x: string) => x.trim().split(/\s+/).filter(Boolean).length;
  const push = (end: number, sepEnd: number) => { const c = t.slice(from, end).trim(); if (c) out.push({ text: c, sep: t.slice(end, sepEnd) }); from = sepEnd; };
  for (let i = 0; i < t.length; i++) {
    if (d[i] !== 0) continue;
    const c = t[i];
    const sp = /^\s*/.exec(t.slice(i + 1))![0].length;
    if (c === ";") { push(i, i + 1 + sp); i += sp; continue; }
    if ((c === "." || c === "!" || c === "?") && (i + 1 === t.length || /\s/.test(t[i + 1])) && !(c === "." && /\b(?:e\.g|i\.e|etc|vs)$/i.test(t.slice(0, i)))) { push(i, i + 1 + sp); i += sp; continue; }
    if (c === "," && /\s/.test(t[i + 1] ?? "")) {
      const left = t.slice(from, i), right = t.slice(i + 1).replace(/^\s*(?:and\s+)?/i, "");
      const rightClause = right.split(/[;,.]/)[0];
      if (words(left) >= 3 && words(rightClause) >= 3 && !/^[#\d]/.test(right)) { const skip = /^\s*(?:and\s+)?/i.exec(t.slice(i + 1))![0].length; push(i, i + 1 + skip); i += skip; }
    }
  }
  const rest = t.slice(from).trim();
  if (rest) out.push({ text: rest, sep: "" });
  return out;
}
const claimIds = (x: string): string[] => [...new Set([...x.matchAll(/(?:^|[^\w&])(#\d{1,5}|T-\d+)\b/gi)].map((m) => m[1].toLowerCase()).concat([...x.matchAll(/\bPR\s*#?(\d{1,5})\b/gi)].map((m) => `#${m[1]}`)))];
const claimWords = (x: string): string[] => [...new Set((x.toLowerCase().match(/[a-z]{5,}/g) ?? []).filter((w) => !CLAIM_STOP.has(w)))];
export type OpenItem = Partial<Pick<Task, "title" | "next" | "detail">>;
/** Whether one wait clause is some open item: every id it names is in an item, else two distinctive words shared with one item. */
function clauseIsOpen(clause: string, before: string, items: readonly OpenItem[]): boolean {
  if (!items.length) return false;
  const ids = claimIds(clause);
  if (ids.length) {
    const have = new Set(items.flatMap((t) => claimIds([t.title, t.next, t.detail].filter(Boolean).join(" "))));
    return ids.every((id) => have.has(id));
  }
  let words = claimWords(clause);
  // "..., waiting on Aaron": a clause with too few words of its own is read with the clause before it
  if (words.length < 2) words = [...new Set([...words, ...claimWords(before)])];
  return items.some((t) => { const text = [t.title, t.next].filter(Boolean).join(" ").toLowerCase(); return words.filter((w) => new RegExp(`(^|[^a-z])${w}`).test(text)).length >= 2; });
}
/** Whether a clause says something of its own: a verb or a state word ("review done", "email drafted", "class live", "waits on Aaron"). */
const PREDICATE = /\b(?:is|are|was|were|be|been|has|have|had|will|shall|can|may|must|should|waits?|waiting|awaiting|needs?|needed|requires?|done|live|ready|open|closed|green|red|failing|passing|due|blocked|paused|held|quiet|late|stuck|queued|running|underway|complete|completed|signed|approved|shipped|sent|merged|built|staged|deployed|launched|fixed|written|posted|booked|filed|resolved|expected)\b|\w{3,}ed\b/i;
/**
 * "COhere deployment (Wed), ATLAS grading, Techne contract signing need Aaron decisions": the clauses before a wait claim that say nothing of
 * their own are what it is about, so they are part of it (never left standing alone as if they were true).
 */
function mergeSubjects(clauses: Clause[]): Clause[] {
  const out: Clause[] = [];
  const lastComma = (t: string): number => { const d = depths(t); for (let i = t.length - 1; i >= 0; i--) if (t[i] === "," && d[i] === 0) return i; return -1; };
  for (const c of clauses) {
    let cur = c;
    if (WAITS_ON_ME.test(cur.text)) {
      for (let guard = 0; guard < 8 && out.length && out[out.length - 1].sep.startsWith(","); guard++) {
        const prev = out[out.length - 1];
        const at = lastComma(prev.text);
        const chunk = at >= 0 ? prev.text.slice(at + 1).trim() : prev.text;
        if (PREDICATE.test(chunk.replace(WAITS_ON_ME, ""))) break;
        if (at >= 0) { out[out.length - 1] = { text: prev.text.slice(0, at).trim(), sep: prev.sep }; }
        else out.pop();
        cur = { text: `${chunk}, ${cur.text}`, sep: cur.sep };
        if (at < 0) continue;
      }
    }
    out.push(cur);
  }
  return out;
}
export function staleSummary(stands: string | null | undefined, updated: string | null | undefined, open: readonly OpenItem[] = [], asked: readonly (string | null | undefined)[] = [], closed: readonly (string | null | undefined)[] = []): StaleSummary | null {
  if (!stands) return null;
  const ms = stampMs(updated ?? "");
  const from = asOfDate(updated);
  // r28 (Codex P1-3): only a task directly on the node counts. An ask written (`asked_at`) after the summary was written…
  if (Number.isFinite(ms) && asked.some((c) => { const t = stampMs(c ?? ""); return Number.isFinite(t) && t > ms; })) return { from, why: "newer" };
  // …or a task closed on or after the day it was written (`closed` is a day, so the comparison is by day)
  if (Number.isFinite(ms) && closed.some((c) => { const d = (c ?? "").trim().slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= localDay(new Date(ms)); })) return { from, why: "closed" };
  // a wait claim no open item is
  if (!WAITS_ON_ME.test(stands)) return null;
  const clauses = mergeSubjects(summaryClauses(stands));
  const unmatched = clauses.some((c, i) => WAITS_ON_ME.test(c.text) && !clauseIsOpen(c.text, clauses[i - 1]?.text ?? "", open));
  return unmatched ? { from, why: "claim" } : null;
}

/**
 * A step that sends words it doesn't carry (r23, both critics): "Send Ryan the deploy-access message below", "Forward the draft", "Send the
 * message". Only a sending step counts ("Your OK on the draft" or "Edit the draft, …" asks something else of a draft that exists).
 * `noun`: what it points at, for "Ask #room for the message".
 */
export function pointsAt(next: string): { noun: "message" | "draft" } | null {
  const step = datePrefix(next.trim()).rest.trim();
  if (!/^(?:send|forward|paste|post|share|email)\b/i.test(step)) return null;
  const m = /\b(?:(message|draft|text|block|note)\s+below|below|the\s+(?:[\w’'-]+\s+){0,2}?(message|draft))\b/i.exec(step);
  if (!m) return null;
  return { noun: (m[1] ?? m[2] ?? "").toLowerCase() === "draft" ? "draft" : "message" };
}
/**
 * A step that points at words nobody stored (r23): "…the deploy-access message below" with no `detail`, `message` or `draft`, and no link
 * to a note that holds them. The row then asks the room for them: "Ask #techne for the message". Null when the words travel with it.
 */
export function pointsNowhere(t: Pick<Task, "next" | "room"> & Partial<Pick<Task, "detail" | "message" | "hasDraft">>, room: string | null = t.room): string | null {
  const p = pointsAt(t.next);
  if (!p || t.detail || t.message || t.hasDraft) return null;
  if (/https?:\/\/|\[\[|\buni:|\b[0-9A-HJKMNP-TV-Z]{26}\b/.test(t.next)) return null;
  return `Ask ${room ? `#${room.replace(/^#/, "")}` : "Uni"} for the ${p.noun}`;
}
/**
 * r24 (Sonnet line 5): a step that names a block ("#cohere's 'For Harper' block") has inline text only when that text came from the block it
 * names (the detail carries its name). Returns the block's name and the room it names (or null), when the stored detail isn't that block.
 */
export function unresolvedBlock(next: string | null | undefined, detail: string | null | undefined): { name: string; room: string | null } | null {
  const m = /(?:^|[\s(])(?:#([\w./-]*\w)['’]s\s+)?["“‘']([^"”’']{2,60})["”’']\s+block\b/i.exec(next ?? "");
  if (!m) return null;
  const name = m[2].trim();
  if (detail && detail.toLowerCase().includes(name.toLowerCase())) return null;
  return { name, room: m[1] ?? null };
}
/**
 * r24, r25 (Ryan): a step can't point "below" at words that are in its card, and the row has no card to point at: the row and the sheet's
 * heading say the same words, "Send Ryan the deploy-access message", and the message sits directly beneath it in the sheet.
 */
export function belowInCard(next: string, t: Partial<Pick<Task, "detail" | "message" | "hasDraft">>): string {
  if (!pointsAt(next) || !(t.detail || t.message || t.hasDraft)) return next;
  return next.replace(/\s*\((?:in|see|from) the (?:card|detail|details)\)/i, "").replace(/\s+(?:(?:message|draft|text|block|note)\s+)?below\b/i, (m) => m.replace(/\s+below\b/i, ""));
}
/**
 * r25 (Codex P2 5): the one current step a task asks of the user, for its Needs-you row and its sheet's heading alike: "Ask #room for the
 * message" when its words were never stored, else its `next` without a "below" that has nothing under it. Both call this, so they never differ.
 */
export function currentStep(t: Pick<Task, "next" | "room"> & Partial<Pick<Task, "detail" | "message" | "hasDraft">>, room: string | null = t.room): string {
  return stepHeading(pointsNowhere(t, room) ?? belowInCard(t.next.trim(), t));
}
/** The message in a task's `detail`, when it quotes one ("Send this to Ryan: 'Hey Ryan, …'"): the quoted words, whole. */
export function quotedMessage(detail: string | null | undefined): string | null {
  if (!detail) return null;
  for (const para of detail.split(/\n\s*\n/)) {
    const m = /^\s*(['"“‘])([\s\S]{40,})(['"”’])\s*$/.exec(para);
    if (m) return m[2].trim();
  }
  return null;
}

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
export function standsHeading(scope: string | null | undefined, ago: string | null | undefined, asOf: string | null | undefined = null): string {
  const base = scope ? `Where ${scope} stands` : "Where this stands";
  // r27: a written summary carries its own date ("As of Oct 14: …"); the heading adds no second one
  return !asOf && ago && ago !== "today" ? `${base} · ${ago}` : base;
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
  // r23 (both critics): whole sentences, or whole words; never "…" (the sheet has the whole question)
  return out.trim() || cutWords(plain, max, false);
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
  // r23 (both critics): as stored, never "…": the sheet says the note ends here and opens it
  return { text: cutWords(words.join(" "), Infinity, false), cut: true };
}

/**
 * "Where this stands" without raw ids (r23, both critics): a bracket that holds a run number, a hash or a long link goes whole ("(run
 * 38456928492 green)"), and so does a bare one; the words around it stay.
 */
const RAW_ID = /\b(?:run\s+)?\d{7,}\b|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b|https?:\/\/\S{30,}/i;
export function withoutRawIds(text: string): string {
  let t = text.replace(/\s*\(([^()]*)\)/g, (m, inner: string) => (RAW_ID.test(inner) ? "" : m));
  t = t.replace(new RegExp(RAW_ID.source, "gi"), "");
  return t.replace(/\s+([,;:.])/g, "$1").replace(/([,;:])(?=[,;:.])/g, "").replace(/\s{2,}/g, " ").trim();
}
/**
 * A sentence's shorter forms with words, longest first (r23): the whole, then each prefix that ends on a clause (";", ":", a spaced dash,
 * a sentence end), never a cut inside a clause and never "…". The summary shows the longest that fits its three lines.
 */
export function clauseForms(text: string): string[] {
  const t = text.trim();
  const out = [t];
  const re = /(?:;|:|\.(?=\s+\p{Lu})|\s[—–-]\s)/gu;
  const ends: number[] = [];
  const d = depths(t);
  // r26: never inside a bracket ("(new look, members, harvests; notifications off)")
  for (let m; (m = re.exec(t));) if (m.index >= 12 && d[m.index] === 0) ends.push(m.index);
  for (const e of ends.reverse()) {
    const f = t.slice(0, e).replace(/[\s,;:—–-]+$/, "").trim();
    if (f && f !== out[out.length - 1]) out.push(/[.!?]$/.test(f) ? f : `${f}.`);
  }
  return out;
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
  // r25: "On your phone, look at the site": the phrase that begins with where or when stays, then the verb phrase after it
  const intro = INTRO.exec(action);
  if (intro && ACTION_VERBS.test(action.slice(intro[0].length)) && !ACTION_VERBS.test(action)) return `${intro[0]}${verbPhrase(action.slice(intro[0].length))}`.trim();
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
/** r28 (Sonnet): a row's step is always its whole text, wrapped: there is no length past which it is shortened (r22's 160-character shortening is gone). */
export const rowForm = (text: string): string => text;
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
export const SUB_TITLE_MAX = 72;
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
/**
 * A task's title as the row's quiet secondary line (r25, Codex P2 5): the action is the `next` step, and the title says what it belongs to, in
 * whole words and never with "…": a title stored cut ("…flow (3…") loses its tail, a long one is cut at a word. Null when it only says the
 * action again.
 */
export function titleSays(raw: string, action: string): string | null {
  const tt = taskTitle(raw);
  const flat = tt.rest.replace(/\s+/g, " ").trim();
  // r26: a trailing "(...)" that says the action again is dropped
  const tail = /^(.*\S)\s*\(([^()]*)\)$/.exec(flat);
  const title = cutWords(wholeWords(tail && repeatsWords(tail[2], action) ? tail[1] : flat), SUB_TITLE_MAX, false);
  return title && actionableTitle(title) && !repeats(title, action) ? title : null;
}
/** A title as plain words for a quiet line (r20): no "Decision (default yes):" label, no cut tail ("…feature 4, the"), sentence-cased. */
export const titleWords = (rest: string): string => { const w = wholeWords(rest.replace(/^decision\s*(\([^)]*\))?\s*[:\-–—]\s*/i, "")); return w ? capFirst(w) : rest; };

/**
 * r25 (Sonnet, Codex): a Running row's words, whole and never cut: the stored text without a cut mark ("…") or a dangling colon or dash
 * ("Waiting on your answer in #Uni:" → "Waiting on your answer in #Uni"). One function for the panel and the work view.
 */
export function runText(what: string | null | undefined): string {
  const plain = (what ?? "").replace(/\s+/g, " ").trim();
  return plain.replace(/\s*(?:…|\.\.\.)\s*$/, "").replace(/[\s:;,—–-]+$/, "").trim();
}
/** The short form of a run too long for its two lines (r25): the words before its colon, else its first whole words; never "…", never a dangling colon. */
export function runShort(what: string | null | undefined, max = 56): string {
  const full = runText(what);
  const head = /^([^:]{8,}?):\s+\S/.exec(full)?.[1]?.trim();
  if (head && head.length <= max + 24) return runText(head);
  return runText(cutWords(full, max, false));
}

/**
 * r28 (Sonnet): a run that waits on the user's answer, as a Needs-you row: "Waiting on your answer in #Uni: Ship 0.1.46?" is the question
 * ("Ship 0.1.46?") as its step and "in #Uni" as its place; never the lead-in with a trailing colon. With no question after the lead-in, the step
 * is the lead-in's own words ("Waiting on your answer") and the place still "in #Uni".
 */
export function waitingRunParts(what: string | null | undefined): { step: string; place: string | null } {
  const full = runText(what);
  const m = /^(waiting\s+on\s+your\s+\w+|needs\s+your\s+\w+)(?:\s+in\s+(#[\w/-]+))?\s*(?::\s*(\S.*))?$/i.exec(full);
  if (!m) return { step: full, place: null };
  const q = m[3]?.trim().replace(/[\s:;,—–-]+$/, "") ?? "";
  return { step: q ? q[0].toLocaleUpperCase() + q.slice(1) : m[1][0].toLocaleUpperCase() + m[1].slice(1), place: m[2] ? `in ${m[2]}` : null };
}

// ------------------------------------------------------------------------------------------------- r26
/** r26 (Sonnet, Codex): a step that says the task was superseded ("Superseded by T-136 (Aaron, 10-14)") closes it, whatever its stored state. */
export const superseded = (next: string | null | undefined): boolean => /^\s*(?:superseded|obsolete)\b/i.test(next ?? "");
/** r26: a task that is finished, archived or superseded: never in Needs you, Running or any surface that lists what is open. */
export function closedTask(t: Partial<Pick<Task, "state" | "next">>): boolean {
  return t.state === "done" || t.state === "archived" || (t.state as string | undefined) === "decided" || superseded(t.next);
}
/**
 * r26: the runs that are still about something open. A run names its task (`T-13`, or words); one whose task is finished, archived or
 * superseded is history, and so is one whose `T-NN` is in a complete list of the open tasks and decisions yet matches none of them. A run that
 * names no `T-NN`, or is checked against a list that wasn't read in full, stays.
 */
export function liveRuns<R extends { task: string | null }>(runs: readonly R[], tasks: readonly (Partial<Pick<Task, "title" | "state" | "next" | "forTask">>)[], complete: boolean): R[] {
  return runs.filter((r) => {
    const id = /\bT-\d+\b/i.exec(r.task ?? "")?.[0]?.toUpperCase();
    if (!id) return true;
    const mine = tasks.filter((t) => taskTitle(t.title ?? "").id?.toUpperCase() === id || t.forTask?.toUpperCase() === id);
    if (mine.some((t) => closedTask(t) && taskTitle(t.title ?? "").id?.toUpperCase() === id)) return false;
    if (!mine.length) return !complete;
    return mine.some((t) => !closedTask(t));
  });
}

/**
 * r26 (Sonnet line 5): the heading is the current step in full, never the step with a note's name hanging off it ("... cutover plan (Cutover plan —
 * unforced.dev)"). A trailing "(...)" that holds only note links, or whose words the step already said, is dropped; `stepNotes` has the links.
 */
const TAIL_PAREN = /^(.*\S)\s*\(([^()]*)\)\s*([.!?]?)$/;
const refsOnly = (inner: string): boolean => !inner.replace(/\buni:[0-9A-HJKMNP-TV-Z]{26}\b|\[\[[^\]]*\]\]|\b[0-9A-HJKMNP-TV-Z]{26}\b|https?:\/\/\S+|\bwww\.\S+|\band\b/gi, "").replace(/[\s,;·&+|-]+/g, "");
const shortWords = (t: string): string[] => [...new Set((t.toLowerCase().match(/[a-z]{4,}/g) ?? []))];
const repeatsWords = (inner: string, head: string): boolean => { const w = shortWords(inner); if (!w.length) return false; const h = shortWords(head).map((x) => x.slice(0, 5)); return w.filter((x) => h.includes(x.slice(0, 5))).length / w.length >= 0.6; };
/** The list-pointer words a step carries ("... the asks listed in this task's detail", "... the follow-ups below"): the content is shown, not pointed at. */
export const LIST_NOUN = "asks|unknowns|follow-?ups|questions|blanks|gaps|requests|items";
const LIST_REF = new RegExp(`\\b(?:the|these|those|its|his|her|their)\\s+(?:(?:open|remaining|key|listed|following|main)\\s+)?(${LIST_NOUN})\\b`, "i");
const LIST_LOC = /\s+(?:(?:listed|written|described|noted|stated|spelled out)\s+)?(?:below|(?:in|from|on)\s+(?:this task['’]s|the task['’]s|the|this|its)\s+(?:detail|details|card|note|description))\b/i;
function listPointerOff(step: string): string {
  const m = LIST_REF.exec(step);
  if (!m) return step;
  const at = m.index + m[0].length;
  const loc = LIST_LOC.exec(step.slice(at));
  if (!loc || loc.index > 12) return step;
  return (step.slice(0, at) + step.slice(at + loc.index + loc[0].length)).replace(/\s+([,;:.])/g, "$1");
}
export function stepHeading(step: string): string {
  const s = listPointerOff(step);
  const m = TAIL_PAREN.exec(s);
  if (!m) return s;
  return refsOnly(m[2]) || repeatsWords(m[2], m[1]) ? `${m[1].replace(/[\s,;:]+$/, "")}${m[3] === "." ? "" : m[3]}` : s;
}
/** The notes a step's trailing "(...)" pointed at, kept for the quiet line under the heading ("uni:01M3… (Cutover plan)" → that text); null: none. */
export function stepNotes(step: string): string | null {
  const m = TAIL_PAREN.exec(listPointerOff(step));
  return m && refsOnly(m[2]) && m[2].trim() ? m[2].trim() : null;
}

// ------------------------------------------------------------------------------------------------- r26: rows that carry their content
export type Referenced =
  | { kind: "list"; noun: string; label: string | null; items: string[]; rest: string | null }
  /** the step points at a list and nothing in this task's detail is that list */
  | { kind: "none"; noun: string };
const LISTLINE = /^(\s*)(?:[-*+•]|\d+[.)])\s+(.*)$/;
const SYNONYMS: Record<string, RegExp> = {
  ask: /\b(?:asks?|owes?|owed|needed|needs?|requests?|questions?|wants?)\b/i,
  unknown: /\bunknowns?\b/i, followup: /\bfollow-?ups?\b|\bquestions?\b/i, question: /\bquestions?\b/i,
  blank: /\bblanks?\b|\bgaps?\b|\bunknowns?\b/i, gap: /\bgaps?\b|\bblanks?\b|\bunknowns?\b/i, request: /\brequests?\b|\basks?\b|\bneeded\b/i, item: /\bitems?\b/i,
};
const nounKey = (n: string): string => n.toLowerCase().replace(/-/g, "").replace(/s$/, "");
const tidyItem = (s: string): string => cleanItem(s).replace(/^[\s;,]+|[\s;,.]+$/g, "").replace(/^and\s+/i, "").trim();
type DetailList = { label: string | null; items: string[]; rest: string };
/** The lists a task's `detail` holds: numbered or bulleted lines, and "(1) ...; (2) ..." run into a paragraph; each with the label before it and the detail without it. */
export function detailLists(detail: string | null | undefined): DetailList[] {
  const text = (detail ?? "").replace(/\r\n?/g, "\n");
  if (!text.trim()) return [];
  const lines = text.split("\n");
  const out: DetailList[] = [];
  const without = (drop: Set<number>, extra?: { at: number; text: string }) => lines.map((l, i) => (extra && i === extra.at ? extra.text : drop.has(i) ? null : l)).filter((l) => l !== null).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  // lists written one item to a line
  for (let i = 0; i < lines.length; i++) {
    const li = LISTLINE.exec(lines[i]);
    if (!li || li[1].length >= 2) continue;
    const items: string[] = []; const drop = new Set<number>();
    let j = i;
    for (; j < lines.length; j++) {
      const m = LISTLINE.exec(lines[j]);
      if (m && m[1].length < 2) { items.push(m[2]); drop.add(j); continue; }
      if (items.length && lines[j].trim() && /^\s{2,}/.test(lines[j])) { items[items.length - 1] += ` ${LISTLINE.exec(lines[j])?.[2] ?? lines[j].trim()}`; drop.add(j); continue; }
      break;
    }
    let k = i - 1; while (k >= 0 && !lines[k].trim()) k--;
    const lab = k >= 0 ? lines[k].trim() : "";
    const label = /:$/.test(lab) ? lab.replace(/:$/, "").trim() : /^#{1,6}\s+/.test(lab) ? lab.replace(/^#{1,6}\s+/, "").trim() : null;
    if (label) drop.add(k);
    out.push({ label, items: items.map(tidyItem).filter(Boolean), rest: without(drop) });
    i = j - 1;
  }
  // "(1) ...; (2) ...; (3) ..." inside a paragraph
  lines.forEach((line, at) => {
    if (LISTLINE.test(line)) return;
    const marks = [...line.matchAll(/\((\d{1,2})\)\s+/g)];
    const seq: RegExpMatchArray[] = [];
    for (const m of marks) if (Number(m[1]) === seq.length + 1) seq.push(m);
    if (seq.length < 2) return;
    const first = seq[0].index ?? 0;
    const prefix = line.slice(0, first);
    const lab = /([^.!?\n]*?):\s*$/.exec(prefix);
    const label = lab ? lab[1].trim() : null;
    const before = (label !== null ? prefix.slice(0, prefix.length - lab![0].length) : prefix).trim();
    const items: string[] = [];
    let after = "";
    seq.forEach((m, n) => {
      const from = (m.index ?? 0) + m[0].length;
      const to = n + 1 < seq.length ? (seq[n + 1].index ?? line.length) : line.length;
      let chunk = line.slice(from, to);
      if (n + 1 === seq.length) { const d = depths(chunk); const e = [...chunk.matchAll(/[.!?](?=\s+\p{Lu})/gu)].find((x) => d[x.index ?? 0] === 0); if (e) { after = chunk.slice((e.index ?? 0) + 1).trim(); chunk = chunk.slice(0, (e.index ?? 0) + 1); } }
      items.push(tidyItem(chunk));
    });
    out.push({ label, items: items.filter(Boolean), rest: without(new Set(), { at, text: [before, after].filter(Boolean).join(" ") }) });
  });
  return out.filter((l) => l.items.length);
}
/**
 * r26 (Sonnet, Codex line 5): a step that points at a list ("... the asks listed in this task's detail", "fill the unknowns", "answer the
 * follow-ups below") has that list, from this task's own detail only: a list under a heading that names it, or, when the step says where it
 * is ("listed in this task's detail", "below"), the detail's only list. Nothing resolving is `none`. Null: the step points at no list.
 */
export function referencedItems(next: string | null | undefined, detail: string | null | undefined): Referenced | null {
  const step = (next ?? "").replace(/\s+/g, " ").trim();
  const m = LIST_REF.exec(step);
  if (!m || questionCount(step) !== null) return null;
  const noun = m[1].toLowerCase();
  const located = !!LIST_LOC.exec(step.slice(m.index + m[0].length)) || /\blisted\b/i.test(step);
  const verbed = new RegExp(`\\b(?:fill(?: in)?|answer|resolve|settle|cover|address|work through|go through|forward|send|share|review|close|clear|handle)\\s+(?:(?:in|all|all of|each of|any of)\\s+)?${m[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(step);
  if (!located && !verbed) return null;
  const lists = detailLists(detail);
  const key = nounKey(noun);
  const re = SYNONYMS[key] ?? new RegExp(`\\b${key}`, "i");
  const hit = lists.find((l) => l.label && re.test(l.label)) ?? (located && lists.length === 1 ? lists[0] : undefined);
  return hit ? { kind: "list", noun, label: hit.label, items: hit.items, rest: hit.rest || null } : { kind: "none", noun };
}
/** "The asks aren't written down in this task": nothing in the task is the list its step points at. */
export const notWrittenDown = (noun: string): string => `The ${noun.toLowerCase()} aren't written down in this task`;
/** How many of a referenced list's items a row shows at most. */
export const ROW_ITEMS = 2;
/** The most lines one item may take on a row. */
export const ITEM_LINES = 2;
/** The sentence ends in a text, outside brackets: the positions just after "." / "!" / "?" that are followed by a new sentence. */
function sentenceEnds(t: string): number[] {
  const d = depths(t); const out: number[] = [];
  for (const m of t.matchAll(/[.!?](?=\s+\p{Lu})/gu)) if (d[m.index ?? 0] === 0 && !/\b(?:e\.g|i\.e|etc|vs)$/i.test(t.slice(0, m.index ?? 0))) out.push((m.index ?? 0) + 1);
  return out;
}
/**
 * r27 (both critics): one item as a row may show it, best first, every form a whole clause. An item led by a count ("3 answers: Spanish versions
 * of 'What is COhere?' …") shows the clause that follows the colon, never the label alone; any other label stays with its clause ("Nonprofit
 * details: 501(c)(3) status, …") and is dropped only when the whole doesn't fit. Then each form without its brackets, then the first sentences
 * that end whole. The row draws the first form that fits its two lines; when none does, the item is not shown (the row says "and N more"):
 * a cut item is never shown.
 */
const COUNT_LABEL = /^(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i;
/** A text without its asides: a bracket group set off by a space ("… lines (notifications, email)"), never one inside a word ("501(c)(3)"). */
const withoutAsides = (t: string): string => { let x = t; for (let i = 0; i < 4; i++) { const y = x.replace(/\s+\([^()]*\)/g, ""); if (y === x) break; x = y; } return x.replace(/\s+([,;:.!?])/g, "$1").replace(/\s+/g, " ").trim(); };
export function itemForms(item: string): string[] {
  const t = item.replace(/\s+/g, " ").trim().replace(/[\s,;:]+$/, "").replace(/\.$/, "");
  if (!t) return [];
  const lab = /^([^:()\[\]'"“‘]{2,40}):\s+(\S.*)$/.exec(t);
  const clause = lab && lab[2].trim().split(/\s+/).length >= 3 ? lab[2].trim().replace(/\.$/, "") : null;
  const counted = !!lab && !!clause && COUNT_LABEL.test(lab[1]);
  const out: string[] = [];
  const add = (f: string) => { const x = f.replace(/[\s,;:]+$/, "").trim(); if (x && !out.includes(x)) out.push(x); };
  const bases = counted ? [clause!] : clause ? [t, clause] : [t];
  for (const base of bases) { add(base); const bare = withoutAsides(base); if (bare && bare.length < base.length) add(bare); }
  const last = bases[bases.length - 1];
  const tail = withoutAsides(last);
  const sentences = tail && tail.length < last.length ? tail : last;
  for (const e of sentenceEnds(sentences).reverse()) add(sentences.slice(0, e).replace(/\.$/, ""));
  return out;
}

// ------------------------------------------------------------------------------------------------- r26: a check that gates answers
/** The lookup of the room's chat: asked and not back yet, related talk found, couldn't be read, or nothing related. */
export type Gate = "pending" | "found" | "failed" | "none";
export const gateOf = (applies: boolean, look: CheckIn | null): Gate => (!applies ? "none" : look === null ? "pending" : look.kind);
/**
 * r28 (Codex P1-1, P1-2): an ask is *confirmed* only when its own `asked_at` says so: within the last 3 days, not in the future (a clock a few
 * minutes ahead is skew; more is a wrong date), and no related chat in its room is newer than it. With no `asked_at` the ask is unconfirmed:
 * `updated_at` is never a fallback, because any unrelated edit renews it. Confirmation is resolved in the feed, before a row shows. States:
 * `confirmed` (counted, in Needs you), `recheck` (Uni's to recheck: listed apart, never counted), `pending` (its room's chat is still being read:
 * held back, "Checking…", for at most `CONFIRM_WAIT_MS`).
 */
export const CONFIRM_DAYS = 3;
export const CONFIRM_SKEW_MS = 5 * 60_000;
export const CONFIRM_WAIT_MS = 4000;
export type Confirm = "confirmed" | "recheck" | "pending";
export type AskStamp = "none" | "old" | "future" | "recent";
export function askStamp(askedAt: string | null | undefined, nowMs = Date.now()): AskStamp {
  const t = stampMs(askedAt ?? "");
  if (!Number.isFinite(t)) return "none";
  if (/^\d{4}-\d{2}-\d{2}$/.test((askedAt ?? "").trim())) { const day = (askedAt ?? "").trim(); const today = localDay(new Date(nowMs)); if (day > today) return "future"; }
  else if (t - nowMs > CONFIRM_SKEW_MS) return "future";
  return nowMs - t > CONFIRM_DAYS * 86_400_000 ? "old" : "recent";
}
/** Why an ask is not confirmed, for the log and the tests. */
export type RecheckWhy = "no-date" | "old" | "future" | "no-room" | "chat-since" | "read-failed";
export type Resolved = { state: Confirm; why: RecheckWhy | null; /** the related message that came after the ask, when that is why */ hit: ChatHit | null; /** the room's chat couldn't be read */ failed: boolean };
/** Whether the room's chat has to be read to tell: only an ask whose own date is recent and that has a room to be checked in. */
export const needsRead = (hasRoom: boolean, askedAt: string | null | undefined, nowMs = Date.now()): boolean => hasRoom && askStamp(askedAt, nowMs) === "recent";
export function confirmationOf(hasRoom: boolean, askedAt: string | null | undefined, look: CheckIn | null, nowMs = Date.now()): Resolved {
  const stamp = askStamp(askedAt, nowMs);
  if (stamp !== "recent") return { state: "recheck", why: stamp === "none" ? "no-date" : stamp, hit: null, failed: false };
  if (!hasRoom) return { state: "recheck", why: "no-room", hit: null, failed: false };
  if (look === null) return { state: "pending", why: null, hit: null, failed: false };
  if (look.kind === "failed") return { state: "recheck", why: "read-failed", hit: null, failed: true };
  if (look.kind === "found") return { state: "recheck", why: "chat-since", hit: look.hit, failed: false };
  return { state: "confirmed", why: null, hit: null, failed: false };
}
/** A task whose record isn't asked about (or any task the feed hasn't resolved): unconfirmed, with no date to go on. */
export const UNRESOLVED: Resolved = { state: "recheck", why: "no-date", hit: null, failed: false };
/** The one quiet line over an unconfirmed request: "Asked Oct 13 · not confirmed since" (with no date: "Not confirmed since it was written"). */
export const unconfirmedLine = (asked: string | null | undefined): string => (asked ? `${asked[0].toLocaleUpperCase()}${asked.slice(1)} · not confirmed since` : "Not confirmed since it was written");
/** Whether the approval answers (and "I did this") are offered as ready: only when the ask is confirmed, or after "Answer anyway". */
export const answersReady = (c: Confirm, anyway: boolean): boolean => c === "confirmed" || anyway;
export const ANSWER_ANYWAY = "Answer anyway";
export const checkingRoom = (room: string): string => `Checking #${room.replace(/^#/, "")}…`;
/** The task changed since the sheet loaded: the revision it was opened at is not the list's now. */
export const revisionMoved = (opened: string | null | undefined, now: string | null | undefined): boolean => !!opened && !!now && opened !== now;
export const CHANGED_SINCE = "This changed since you opened it";

/** r27: a body that only says its heading or its title again ("Ship the Boulder Votes AI chat?" under "Ship the Boulder Votes AI chat? (preview: …)"). */
const sameWords = (t: string): string => t.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
export function repeatsHeading(body: string | null | undefined, ...others: readonly (string | null | undefined)[]): boolean {
  const b = sameWords(body ?? "");
  if (!b) return true;
  return others.some((o) => { const x = sameWords(o ?? ""); return !!x && (x === b || x.startsWith(b)); });
}

/** r26 (Codex 6): a run's state as a person reads it, the same in the companion and the work view (never the raw "decision"). */
export const RUN_STATE_LABEL: Record<string, string> = { running: "Working", queued: "Queued", stalled: "Stalled", blocked: "Blocked", decision: "Waiting on you", done: "Done", failed: "Failed" };
export const runStateLabel = (state: string): string => RUN_STATE_LABEL[state] ?? state;
/** r27 (Codex P2-5): a run that waits on Aaron's answer is Needs you, never Running ("not waiting on you"). */
export const waitingOnYou = (r: { state: string }): boolean => r.state === "decision";
