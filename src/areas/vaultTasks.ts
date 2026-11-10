// The Parachute API for tasks (the node view's data layer). Every read is an indexed `query-notes` (one `near` request per kind), every write one
// vault call: `state_transition` for state (an atomic compare-and-set), a guarded metadata merge for snooze.
// Nothing is cached here beyond one session's memory; the node view reconciles with each server answer.
import { invoke } from "@tauri-apps/api/core";
import { buildTaskTree, isTaskRow, failureKind, groupOf, nodeFilterKeys, parseNodes, parseTask, subtreePaths, type AnyState, type FailureKind, type Priority, type RawNote, type Task, type TaskTree } from "./taskCore.ts";
import { ROOT } from "./treeCore.ts";
import { taskTitle } from "./whereCore.ts";
import { askFromContent, askOrder, closedBy, hasDeps, isListLine, linkedRefs, questionCount, questionsFrom, refName, stepText, taskDeps, needsYou, type Assessed, type CheckRecord, type CheckState, type SourceRef, type SourceStamp } from "./simpleCore.ts";

/** A supporting note couldn't be read (r19): the row says "Couldn't check · Retry", never "nothing there". */
export class Unavailable extends Error {}
import { activeProfile } from "./profile.ts";
import { allPages, createReader, LIMIT, reader as appReader, type Call, type Reader } from "../vault/reader.ts";


// (the paging read lives with the one reader now: src/vault/reader.ts)
export { allPages };
/** Reads of supporting notes and questions run this many at a time (r20: bounded in concurrency, never in coverage: the whole queue is read). */
const ASK_PARALLEL = 6;
const ASK_KEEP = 150;

/** The record a sheet has open (r20): its reads go first in every queue. */
let urgent: string | null = null;
/** Put this task's reads first (its sheet is open); null: none. */
export const prioritize = (id: string | null) => { urgent = id; };
/** Run `f` over every item, `n` at a time, the open sheet's first whenever it is still waiting (r20). */
export async function pool<T extends { id: string }>(items: readonly T[], n: number, f: (t: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const take = () => { const i = urgent ? queue.findIndex((x) => x.id === urgent) : -1; return queue.splice(i >= 0 ? i : 0, 1)[0]; };
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => { while (queue.length) await f(take()); }));
}
/** A question read for a decision (r20): the words found ("" when the note holds none) at the revision read, or the read failed. */
export type AskRead = { ask: string; at: string | null; failed?: boolean };

const WRITER_KEY = "uni.tasks.writer.v1";
/** Who this app writes as in the vault (the `lastUpdatedBy` its own writes come back with), so a task changed from here can say "you". */
export const ownWriter = (): string | null => { try { return localStorage.getItem(WRITER_KEY); } catch { return null; } };
/** Who changed a task last, in words: "you" for this app's own writes, "Uni" for a write through the vault's MCP door; null when the app can't tell (never an id). */
export function changedBy(t: Pick<Task, "lastUpdatedBy" | "lastUpdatedVia">, me: string | null = ownWriter()): string | null {
  if (me && t.lastUpdatedBy === me) return "you";
  return t.lastUpdatedVia === "mcp" ? "Uni" : null;
}
const ok = (note: unknown): WriteResult => {
  // a write landed: the next read of any list goes to the vault, not to what this tick already read
  appReader.invalidate();
  const st = stamp(note);
  if (st.lastUpdatedBy) try { localStorage.setItem(WRITER_KEY, st.lastUpdatedBy); } catch { /* this session only */ }
  return { ok: true, ...st };
};

export type WriteResult = { ok: true; updatedAt: string | null; lastUpdatedBy: string | null; lastUpdatedVia: string | null } | { ok: false; kind: FailureKind; message: string };

const stamp = (note: unknown) => {
  const n = (note ?? {}) as RawNote;
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  return { updatedAt: s(n.updatedAt), lastUpdatedBy: s(n.lastUpdatedBy), lastUpdatedVia: s(n.lastUpdatedVia) };
};

/** `vault` is a name, or a function read on every call (the singleton follows the selected vault's profile). */
/** `call`: the vault door (a test's fake); with none, the app's door and its one reader (shared reads, one poller). */
export function createVaultTasks(callIn?: Call, vaultOf: string | (() => string) = () => activeProfile().vault) {
  const call: Call = callIn ?? ((cmd, args) => invoke(cmd, args));
  // a test's own door gets its own reader, every read going to it (the app's reader shares a tick's reads: src/vault/reader.ts)
  const read: Reader = callIn ? createReader(callIn, undefined, { share: false }) : appReader;
  const name = () => (typeof vaultOf === "function" ? vaultOf() : vaultOf);
  /** The whole tree, metadata only: every `node` note (areas, projects, the Uni root). */
  async function loadTree(): Promise<TaskTree & { truncated: boolean }> {
    const { rows, complete } = await read.nodes(name());
    const { nodes, rootPath } = parseNodes(rows);
    return { ...buildTaskTree(nodes, rootPath), truncated: !complete };
  }

  /**
   * r28 (Codex P1-3): the tasks closed (done or archived) on or after `since` (a day), for the one rule that a closure after a summary was
   * written dims it. Read on its own, never holding the list back. `closed` is not an indexed field in the vault (a range filter on it is
   * refused: found in the real app), so the done and archived tasks are read by `state` and filtered here. null: the read failed (a summary
   * then isn't dimmed by closures it couldn't see).
   */
  async function loadClosed(treeIn: TaskTree | Promise<TaskTree>, since: string): Promise<Task[] | null> {
    try {
      const t = await treeIn;
      const { rows } = await read.closedTasks(name());
      return rows.filter(isTaskRow).map((n) => parseTask(n, t)).filter((x): x is Task => !!x && (x.state === "done" || x.state === "archived") && !!x.closed && x.closed.slice(0, 10) >= since);
    } catch { return null; }
  }

  /** The runs that matter now (every running one, and those started in the last 60 days) and the `draft` notes, metadata only: extras on the
   *  page. null = the read failed: the caller keeps what it had rather than wiping Running/Drafts on a transient error. */
  async function loadRuns(): Promise<RawNote[] | null> { try { return (await read.runs(name())).rows; } catch { return null; } }
  async function loadDrafts(): Promise<RawNote[] | null> { try { return (await read.drafts(name())).rows; } catch { return null; } }

  /** Full questions already read, by note id, with the note's `updatedAt` they were read at: a refresh shows them at once, and so does the next
   *  launch (kept on the device, per identity, newest 150). v2 (r14): v1 kept 280-character previews, which are never taken for the question. */
  const askCache = new Map<string, { ask: string; at: string | null }>();
  let askOwner = "";
  const askKey = () => `uni.asks.v2:${askOwner}`;
  const keepAsks = () => { try { localStorage.setItem(askKey(), JSON.stringify([...askCache].slice(-ASK_KEEP))); } catch { /* this session only */ } };
  /** Whose asks the cache holds: another identity or vault starts clean, the same one picks up what the device kept. */
  function setAskOwner(owner: string) {
    if (owner === askOwner) return;
    askOwner = owner; askCache.clear();
    try {
      const v = JSON.parse(localStorage.getItem(askKey()) ?? "[]");
      if (Array.isArray(v)) for (const e of v) if (Array.isArray(e) && typeof e[0] === "string" && e[1] && typeof e[1].ask === "string" && !isListLine(e[1].ask)) askCache.set(e[0], { ask: e[1].ask, at: typeof e[1].at === "string" ? e[1].at : null });
    } catch { /* nothing kept */ }
  }
  const askFor = (t: Task) => { const c = askCache.get(t.id); return c && c.at === t.updatedAt ? c.ask : undefined; };
  /** A task with the question read at its own revision, when there is one. */
  const withAsk = (t: Task): Task => { const a = askFor(t); return a !== undefined ? { ...t, ask: a, askAt: t.updatedAt } : t; };
  /**
   * The lists carry no content, so a decision or one of the user's tasks whose title was cut short ("…") gets its full question from the first
   * paragraph of its note (one read each, only for those; decisions, Now and the soonest due first, at most 40, six at a time). Each ask comes
   * with the note's `updatedAt` it was read at (r14): it belongs to the row only at that revision. Called after the list is on screen.
   */
  async function loadAsks(tasks: readonly Task[], onEach?: (id: string, a: AskRead) => void): Promise<Map<string, AskRead>> {
    const asks = new Map<string, AskRead>();
    // r16: a title whose "(preview: …" tail was dropped also has its question in the note
    const want = tasks.filter((t) => { const tt = taskTitle(t.title); return (t.kind === "decision" || groupOf(t) === "you") && (tt.cut || tt.previewed); });
    for (const t of want) { const a = askFor(t); if (a !== undefined) asks.set(t.id, { ask: a, at: t.updatedAt }); }
    // r20: every one is read (a decision not read is not owed, so none may be left out), six at a time, an open sheet's first
    const cut = askOrder(want.filter((t) => !asks.has(t.id)));
    let fresh = 0;
    await pool(cut, ASK_PARALLEL, async (t) => {
      let a: AskRead;
      try {
        const r = (await call("vault_note", { vault: name(), noteRef: t.id })) as { note?: RawNote } | null;
        const ask = askFromContent(typeof r?.note?.content === "string" ? r.note.content : "");
        const at = typeof r?.note?.updatedAt === "string" ? r.note.updatedAt : null;
        // r20: a note with no question in it is read too ("" at its revision): it is classified, not left checking
        a = { ask, at }; askCache.delete(t.id); askCache.set(t.id, { ask, at }); fresh++;
      } catch {
        a = { ask: "", at: null, failed: true };
      }
      asks.set(t.id, a); onEach?.(t.id, a);
    });
    if (fresh) keepAsks();
    return asks;
  }

  const missing = (e: unknown) => /not[_ ]found/i.test(String(e));

  /**
   * Live tasks and open decisions under `path` (ROOT: everywhere): one request per kind, `node in [the subtree's paths and ids]` and
   * `state in [open, doing, waiting]`, the subtree taken from the node tree in memory (T-140: links, not a `parent` walk). `truncated` says the
   * vault returned a full page (more may exist).
   */
  async function loadTasks(treeIn: TaskTree | Promise<TaskTree>, path: string): Promise<{ tasks: Task[]; truncated: boolean }> {
    // r16: everywhere (ROOT) the reads need no tree, so they start at once and the tree (read alongside) only places the rows at the end
    const finish = async (tasks: RawNote[], decisions: RawNote[], cut = tasks.length >= LIMIT || decisions.length >= LIMIT) => {
      const vault = name();
      const t = await treeIn;
      // r16: a step cut at the writer's 140 characters reads as cut ("…"), never as a phrase left hanging
      const parsed = [...tasks, ...decisions].map((n) => parseTask(n, t)).filter((x): x is Task => !!x).map((x) => { const st = stepText(x.next); return { ...x, vault, next: st.text, ...(st.cut ? { nextCut: true } : {}) }; });
      return { tasks: [...new Map(parsed.map((x) => [x.id, withAsk(x)])).values()], truncated: cut };
    };
    const tree = path === ROOT ? null : await treeIn;
    // T-140: a node's subtree is computed from the tree already read (an area and the projects linked to it, either end), so one
    // `node in [...]` query per kind answers it whatever the vault's link layout; a vault walk over `parent` would miss every `links` edge.
    let keys: string[] | null = null;
    if (tree) {
      const known = subtreePaths(tree, path);
      if (!known.length) return { tasks: [], truncated: false };
      keys = nodeFilterKeys(tree, known);
    }
    // past the first 200: every page is read before the list is taken for the whole
    const [tasks, decisions] = await Promise.all([read.liveTasks(name(), keys), read.openDecisions(name(), keys)]);
    // (0.3.0: a `tag: task` page may hold old decision-only notes once `decision` is a child of `task`; they come with the decisions)
    return finish(tasks.rows.filter(isTaskRow), decisions.rows, !tasks.complete || !decisions.complete);
  }

  /**
   * Compare-and-set on `state`, guarded by `ifUpdatedAt` (r16): the revision whose instruction the user saw, checked in the same update. A stale
   * `from`, or a task changed since that revision (a rewritten step, even with the state unchanged), is a conflict: the caller re-reads and
   * says so, it never retries blind.
   */
  async function transition(taskId: string, from: AnyState, to: AnyState, ifUpdatedAt: string, answered = false): Promise<WriteResult> {
    if (!ifUpdatedAt) return { ok: false, kind: "conflict", message: "no revision: reload the task first" };
    try {
      // r26: an answer ("I did this") records the revision it answered, in the same compare-and-set write
      const note = ((await call("vault_transition", { vault: name(), id: taskId, from, to, ifUpdatedAt, ...(answered ? { metadata: { answered_rev: ifUpdatedAt } } : {}) })) as RawNote);
      return ok(note);
    } catch (e) {
      const message = String(e);
      return { ok: false, kind: failureKind(message), message };
    }
  }

  /**
   * 0.3.0 For you: answer an ask (CONTRACT "Answering an ask"): one compare-and-set on `state` (`from` -> `done`) with `answer`, `answered_at`,
   * `answered_by` (and `decided*` for a pick) in the same write, guarded by the revision shown. Rust checks the keys (`check_answered_patch`).
   */
  async function answer(taskId: string, from: AnyState, ifUpdatedAt: string, metadata: Record<string, unknown>): Promise<WriteResult> {
    if (!ifUpdatedAt) return { ok: false, kind: "conflict", message: "no revision: reload the ask first" };
    try {
      return ok(await call("vault_transition", { vault: name(), id: taskId, from, to: "done", ifUpdatedAt, metadata }));
    } catch (e) {
      const message = String(e);
      return { ok: false, kind: failureKind(message), message };
    }
  }

  /**
   * Decide an open decision: one update that sets `state` open -> decided (compare-and-set) and writes `decided`, `decided_at`,
   * `decided_by`, guarded by `ifUpdatedAt`, the revision whose question the user read (r14). A decision someone else decided or changed
   * since is a conflict: the caller says so and re-reads, it never retries.
   */
  async function decide(taskId: string, option: string, by: string, ifUpdatedAt: string, at: string = new Date().toISOString()): Promise<WriteResult> {
    try {
      const note = await call("vault_decide", { vault: name(), id: taskId, from: "open", to: "decided", metadata: { decided: option, decided_at: at, decided_by: by, answered_rev: ifUpdatedAt }, ifUpdatedAt });
      return ok(note);
    } catch (e) {
      const message = String(e);
      return { ok: false, kind: failureKind(message), message };
    }
  }

  /** A metadata merge guarded by the `updated_at` the caller read (a stale stamp is a conflict); a `null` value clears its key. */
  async function patchMeta(taskId: string, metadata: Record<string, unknown>, updatedAt: string): Promise<WriteResult> {
    try {
      const note = await call("vault_patch_meta", { vault: name(), id: taskId, metadata, ifUpdatedAt: updatedAt });
      return ok(note);
    } catch (e) {
      const message = String(e);
      return { ok: false, kind: failureKind(message), message };
    }
  }

  /**
   * T-335 Seen: he is aware of an ask. A tell or look ask closes (one compare-and-set on `state`, `from` -> `done`, with `seen_at`, `seen_by`
   * and needs_aaron false); a do or choose ask stays open with its room (a metadata patch on the revision shown). Rust checks the keys.
   */
  async function seen(taskId: string, from: AnyState, ifUpdatedAt: string, closes: boolean, metadata: Record<string, unknown>): Promise<WriteResult> {
    if (!ifUpdatedAt) return { ok: false, kind: "conflict", message: "no revision: reload the ask first" };
    // (the close is the same compare-and-set as an answer's, with Seen's keys: Rust tells them apart)
    return closes ? answer(taskId, from, ifUpdatedAt, metadata) : patchMeta(taskId, metadata, ifUpdatedAt);
  }

  /** Snooze: `snoozed_until` (a date); `null` clears it. */
  const snooze = (taskId: string, until: string | null, updatedAt: string) => patchMeta(taskId, { snoozed_until: until }, updatedAt);
  /** Priority: now, soon or someday; `null` clears it (back to unsorted). */
  /** A priority picked in the app is a person's call: stamp `priority_by: "hand"` so weigh.py never overwrites it.
   *  Undo passes the previous stamp back (null clears it). */
  const setPriority = (taskId: string, priority: Priority | null, updatedAt: string, by: string | null = "hand") =>
    patchMeta(taskId, { priority, priority_by: priority === null ? null : by }, updatedAt);

  /**
   * What a task's action stands on, read now (r19; r18's question sources folded in), each note in its own vault. First the notes it depends on
   * explicitly (`taskDeps`): a note its step links or its `source` names that is closed or superseded (its own state, never its title's words)
   * makes it a Check; a `depends_on` note still open makes it wait. Then, for a step that asks for answers, where the questions are: its own
   * note when it holds them explicitly (a `questions` field, or a list under a heading that names questions); else a note its step or note
   * links; else a closed task merged into it ("Merged into T-11") on the same node. Nothing explicit: `unclear` ("Open the note to answer").
   * A read that fails (other than "not found") throws `Unavailable`: never taken for "nothing there". Returns every note read, at its revision.
   */
  async function assessTask(t: Pick<Task, "id" | "title" | "next" | "vault" | "kind"> & Partial<Pick<Task, "sourceRef" | "dependsOn" | "questions">>, nodeKeys: readonly string[], wantIn?: number | null): Promise<{ result: Assessed; sources: SourceStamp[] }> {
    const home = t.vault ?? name();
    const sources: SourceStamp[] = [];
    const memo = new Map<string, Promise<RawNote | null>>();
    const read = (vault: string, ref: string): Promise<RawNote | null> => {
      const key = `${vault}\n${ref}`;
      if (!memo.has(key)) memo.set(key, (async () => {
        try {
          const n = ((await call("vault_note", { vault, noteRef: ref })) as { note?: RawNote } | null)?.note ?? null;
          sources.push({ vault, id: ref, rev: typeof n?.updatedAt === "string" ? n.updatedAt : null });
          return n;
        } catch (e) {
          if (missing(e)) { sources.push({ vault, id: ref, rev: null }); return null; }
          throw new Unavailable(String(e));
        }
      })());
      return memo.get(key)!;
    };
    const text = (n: RawNote | null) => (typeof n?.content === "string" ? n.content : "");
    const meta = (n: RawNote | null) => (n?.metadata && typeof n.metadata === "object" ? n.metadata as Record<string, unknown> : null);
    const named = (vault: string, n: RawNote): SourceRef => ({ vault, id: typeof n.id === "string" ? n.id : "", title: taskTitle((typeof n.path === "string" ? n.path : "").split("/").pop() ?? "").rest || "its note" });
    const deps = taskDeps({ ...t, kind: t.kind ?? "task" });
    const done = (result: Assessed) => ({ result, sources });
    // the notes it stands on, read together
    const firm = deps.refs.map((r) => ({ ...r, vault: r.vault ?? home }));
    const notes: (RawNote | null)[] = new Array(firm.length).fill(null);
    await pool(firm.map((r, i) => ({ ...r, id: r.id, i })), ASK_PARALLEL, async (r) => { notes[r.i] = await read(r.vault, r.id); });
    for (let i = 0; i < firm.length; i++) {
      const n = notes[i];
      // r20: a note it stands on that the vault doesn't have is unresolved: never read past as if it were clear
      if (!n) return done({ kind: "missing", ref: refName({ vault: firm[i].vault === home ? null : firm[i].vault, id: firm[i].id }) });
      const how = closedBy(meta(n));
      if (how && firm[i].role !== "after") return done({ kind: "closed", how, from: named(firm[i].vault, n) });
      if (!how && firm[i].role === "after") return done({ kind: "waits", from: named(firm[i].vault, n) });
    }
    if (t.kind === "decision") return done({ kind: "ok" });
    const want = wantIn !== undefined && wantIn !== null ? wantIn : t.questions?.length ? null : questionCount(t.next);
    if (t.questions?.length) {
      const q = questionsFrom("", questionCount(t.next), { questions: t.questions });
      return done(q?.status === "list" ? { kind: "list", items: q.items, from: null } : { kind: "unclear", from: null });
    }
    if (want === null) return done({ kind: "ok" });
    const own = await read(home, t.id);
    const mine = questionsFrom(text(own), want, meta(own));
    if (mine) return done(mine.status === "list" ? { kind: "list", items: mine.items, from: null } : { kind: "unclear", from: null });
    const inStep = new Set(linkedRefs(t.next).map((r) => `${r.vault ?? home}\n${r.id}`));
    for (const ref of linkedRefs(`${t.next}\n${text(own)}`).filter((r) => r.id !== t.id).slice(0, 4)) {
      const vault = ref.vault ?? home;
      const n = await read(vault, ref.id);
      if (!n) continue;
      const q = questionsFrom(text(n), want, meta(n));
      const how = closedBy(meta(n));
      if (how && (q || inStep.has(`${vault}\n${ref.id}`))) return done({ kind: "closed", how, from: named(vault, n) });
      if (q) return done(q.status === "list" ? { kind: "list", items: q.items, from: named(vault, n) } : { kind: "unclear", from: named(vault, n) });
    }
    const tid = taskTitle(t.title).id;
    if (tid && nodeKeys.length) {
      let rows: RawNote[];
      try { rows = (await call("vault_query_meta", { vault: home, tag: "task", metadata: { node: { in: [...nodeKeys] }, state: { in: ["done", "archived"] } }, limit: LIMIT })) as RawNote[]; } catch (e) { throw new Unavailable(String(e)); }
      // the id written in a merge note ("Merged into T-11"): an explicit pointer to this task, never a match on its title's words
      const merged = new RegExp(`\\bmerged into ${tid.replace(/[-]/g, "\\-")}\\b`, "i");
      const r = (Array.isArray(rows) ? rows : []).filter(isTaskRow).find((x) => typeof x.id === "string" && merged.test(JSON.stringify(x.metadata ?? {})));
      if (r) { sources.push({ vault: home, id: String(r.id), rev: typeof r.updatedAt === "string" ? r.updatedAt : null }); return done({ kind: "closed", how: closedBy(meta(r)) ?? "closed", from: named(home, r) }); }
    }
    return done({ kind: "unclear", from: null });
  }
  /** r18's entry point, kept for its callers: what reading the task's supporting notes came to (throws `Unavailable` when a read fails). */
  async function loadSupport(t: Parameters<typeof assessTask>[0], nodeKeys: readonly string[], want?: number | null): Promise<Assessed> {
    return (await assessTask(t, nodeKeys, want)).result;
  }

  /**
   * Checks kept per identity (r19), each with the {vault, id, revision} of every note it read and when it was verified: a refresh and the next
   * launch paint them at once while they are within CHECK_TTL, and every list refresh reads the sources again (so a source that closes, reopens
   * or changes its questions while the task stays the same is seen). A failed read is never kept as a result.
   */
  const checkCache = new Map<string, CheckRecord>();
  const checkKey = () => `uni.checks.v1:${askOwner}`;
  let checkOwner = "\u0000";
  const checksLoaded = () => {
    if (checkOwner === askOwner) return;
    checkOwner = askOwner; checkCache.clear();
    try {
      const v = JSON.parse(localStorage.getItem(checkKey()) ?? "[]");
      if (Array.isArray(v)) for (const e of v) if (Array.isArray(e) && typeof e[0] === "string" && e[1]?.result?.kind && typeof e[1].at === "number" && Array.isArray(e[1].sources)) checkCache.set(e[0], e[1]);
    } catch { /* nothing kept */ }
  };
  const keepChecks = () => { try { localStorage.setItem(checkKey(), JSON.stringify([...checkCache].slice(-ASK_KEEP))); } catch { /* this session only */ } };
  /** What this device already verified, for the list to paint at once (it still reads every source again). */
  const cachedChecks = (): Map<string, CheckState> => { checksLoaded(); return new Map([...checkCache].map(([id, rec]) => [id, { rec, failedAt: null }])); };
  /**
   * Read the supporting notes of every row in Needs you that stands on any (r19), after the list is on screen (a few at a time, at most 40):
   * on every list refresh, whatever is kept. Each task's outcome: a fresh record, or (the read failed) `failedAt` and no record (r21: the old one is invalidated).
   * `onEach` hears each outcome as it lands, so one slow note doesn't hold the others back.
   */
  async function loadChecks(tasks: readonly Task[], keysOf: (t: Task) => readonly string[], onEach?: (id: string, s: CheckState) => void): Promise<Map<string, CheckState>> {
    checksLoaded();
    const out = new Map<string, CheckState>();
    // r20: every ask that needs the user (needs_aaron) and stands on a note, the whole queue (six at a time, an open sheet's first)
    const todo = tasks.filter((t) => needsYou(t) && hasDeps(taskDeps(t)));
    let kept = false;
    await pool(todo, ASK_PARALLEL, async (t) => {
        let s: CheckState;
        // verified as of when the reads began (a read that started earlier never outranks one that started later)
        const started = Date.now();
        try {
          const { result, sources } = await assessTask(t, keysOf(t));
          const rec: CheckRecord = { taskRev: t.updatedAt, at: started, result, sources };
          const had = checkCache.get(t.id);
          if (!had || had.at <= started) { checkCache.delete(t.id); checkCache.set(t.id, rec); kept = true; }
          s = { rec, failedAt: null };
        } catch {
          // r21 (Codex P1-1): a failed read invalidates what this device verified before: it is no longer painted as current on the next launch
          const had = checkCache.get(t.id);
          if (had && had.at <= started) { checkCache.delete(t.id); kept = true; }
          s = { rec: null, failedAt: started };
        }
        out.set(t.id, s); onEach?.(t.id, s);
    });
    if (kept) keepChecks();
    return out;
  }

  /** Forget (r19): every identity's kept questions and checks go from the device (and r18's per-task source cache), with this session's. */
  function forgetKept() {
    askCache.clear(); checkCache.clear(); askOwner = ""; checkOwner = "\u0000";
    try { for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k && /^uni\.(asks|checks|support)\.v\d+:/.test(k)) localStorage.removeItem(k); } } catch { /* nothing kept */ }
  }
  return { prioritize, forgetKept, setAskOwner, loadTree, loadRuns, loadDrafts, loadClosed, loadAsks, loadTasks, loadSupport, assessTask, loadChecks, cachedChecks, transition, answer, seen, decide, snooze, setPriority };
}

export const vaultTasks = createVaultTasks();
