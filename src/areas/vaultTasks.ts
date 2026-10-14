// The Parachute API for tasks (the node view's data layer). Every read is an indexed `query-notes` (one `near` request per kind), every write one
// vault call: `state_transition` for state (an atomic compare-and-set), a guarded metadata merge for snooze.
// Nothing is cached here beyond one session's memory; the node view reconciles with each server answer.
import { invoke } from "@tauri-apps/api/core";
import { buildTaskTree, failureKind, groupOf, LIVE_STATES, nodeFilterKeys, parseNodes, parseTask, subtreePaths, type AnyState, type FailureKind, type Priority, type RawNote, type Task, type TaskTree } from "./taskCore.ts";
import { ROOT } from "./treeCore.ts";
import { taskTitle } from "./whereCore.ts";
import { askFromContent, askOrder, closedBy, isListLine, linkedRefs, needsYou, questionCount, questionsFrom, stepText, type SourceRef, type Support } from "./simpleCore.ts";
import { activeProfile } from "./profile.ts";

export type Call = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
const LIMIT = 200;
/** A list longer than this many pages (2000 notes) is read no further and said to be incomplete. */
const MAX_PAGES = 10;

/**
 * Read a list page by page (200 at a time) until a short page. `complete` only when that last page came back short: a list that stops at
 * MAX_PAGES, or a vault that ignores `offset` (a page with nothing new), is incomplete, never taken for the whole.
 */
export async function allPages(page: (offset: number) => Promise<RawNote[]>): Promise<{ rows: RawNote[]; complete: boolean }> {
  const rows: RawNote[] = []; const seen = new Set<string>();
  for (let i = 0; i < MAX_PAGES; i++) {
    const got = await page(i * LIMIT);
    let fresh = 0;
    for (const r of Array.isArray(got) ? got : []) {
      const id = typeof r.id === "string" ? r.id : null;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      rows.push(r); fresh++;
    }
    if (!Array.isArray(got) || got.length < LIMIT) return { rows, complete: true };
    if (!fresh) return { rows, complete: false };
  }
  return { rows, complete: false };
}
const ASK_READS = 40;
const ASK_PARALLEL = 6;
const ASK_KEEP = 150;

const WRITER_KEY = "uni.tasks.writer.v1";
/** Who this app writes as in the vault (the `lastUpdatedBy` its own writes come back with), so a task changed from here can say "you". */
export const ownWriter = (): string | null => { try { return localStorage.getItem(WRITER_KEY); } catch { return null; } };
/** Who changed a task last, in words: "you" for this app's own writes, "Uni" for a write through the vault's MCP door; null when the app can't tell (never an id). */
export function changedBy(t: Pick<Task, "lastUpdatedBy" | "lastUpdatedVia">, me: string | null = ownWriter()): string | null {
  if (me && t.lastUpdatedBy === me) return "you";
  return t.lastUpdatedVia === "mcp" ? "Uni" : null;
}
const ok = (note: unknown): WriteResult => {
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
export function createVaultTasks(call: Call = (cmd, args) => invoke(cmd, args), vaultOf: string | (() => string) = () => activeProfile().vault) {
  const name = () => (typeof vaultOf === "function" ? vaultOf() : vaultOf);
  /** The whole tree, metadata only: every `node` note (areas, projects, the Uni root). */
  async function loadTree(): Promise<TaskTree & { truncated: boolean }> {
    const { rows, complete } = await allPages((offset) => call("vault_query", { vault: name(), tag: "node", includeContent: false, limit: LIMIT, ...(offset ? { offset } : {}) }) as Promise<RawNote[]>);
    const { nodes, rootPath } = parseNodes(rows);
    return { ...buildTaskTree(nodes, rootPath), truncated: !complete };
  }

  /** Every note with `tag`, metadata only (the dispatch ledger `run`, the `draft` notes). A vault with none, or one that refuses, reads as empty: these are extras on the page. */
  async function loadTagged(tag: string): Promise<RawNote[] | null> {
    // null = the read failed: the caller keeps what it had rather than wiping Running/Drafts on a transient error
    try { return (await allPages((offset) => call("vault_query", { vault: name(), tag, includeContent: false, limit: LIMIT, ...(offset ? { offset } : {}) }) as Promise<RawNote[]>)).rows; } catch { return null; }
  }

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
  async function loadAsks(tasks: readonly Task[]): Promise<Map<string, { ask: string; at: string | null }>> {
    const asks = new Map<string, { ask: string; at: string | null }>();
    // r16: a title whose "(preview: …" tail was dropped also has its question in the note
    const want = tasks.filter((t) => { const tt = taskTitle(t.title); return (t.kind === "decision" || groupOf(t) === "you") && (tt.cut || tt.previewed); });
    for (const t of want) { const a = askFor(t); if (a !== undefined) asks.set(t.id, { ask: a, at: t.updatedAt }); }
    const cut = askOrder(want.filter((t) => !asks.has(t.id))).slice(0, ASK_READS);
    let fresh = 0;
    for (let i = 0; i < cut.length; i += ASK_PARALLEL) {
      await Promise.all(cut.slice(i, i + ASK_PARALLEL).map(async (t) => {
        try {
          const r = (await call("vault_note", { vault: name(), noteRef: t.id })) as { note?: RawNote } | null;
          const ask = askFromContent(typeof r?.note?.content === "string" ? r.note.content : "");
          const at = typeof r?.note?.updatedAt === "string" ? r.note.updatedAt : null;
          if (ask) { asks.set(t.id, { ask, at }); askCache.delete(t.id); askCache.set(t.id, { ask, at }); fresh++; }
        } catch { /* the row opens to decide instead */ }
      }));
    }
    if (fresh) keepAsks();
    return asks;
  }

  // Feature detect once per session: does the vault answer `near` with `direction` and `then`? null = not yet known.
  let nearOk: boolean | null = null;
  const unsupported = (e: unknown) => /unknown|unrecogni[sz]ed|unsupported|not supported|invalid[_ ]?(param|near|query)|bad[_ ]request|\b400\b|"?then"?/i.test(String(e)) && !/not[_ ]found/i.test(String(e));
  const missing = (e: unknown) => /not[_ ]found/i.test(String(e));

  /** The node at `path` and every node beneath it, one request (`near` inbound over `parent`). Paths in `paths`, ids in `ids`. */
  async function loadSubtree(path: string): Promise<{ paths: string[]; ids: string[] }> {
    const rows = (await call("vault_subtree_nodes", { vault: name(), root: path })) as RawNote[];
    const { nodes } = parseNodes(rows);
    const self = nodes.some((n) => n.path === path) ? [] : [path]; // the walk should include its anchor; make sure
    return { paths: [...nodes.map((n) => n.path), ...self], ids: nodes.map((n) => n.id) };
  }

  /**
   * Live tasks and open decisions under `path` (ROOT: everywhere). With the vault's subtree queries, one `near` request per
   * kind (anchored at the node's id, else its path; `parent` inbound, then `node` inbound, `state in [open, doing, waiting]`). A vault that answers with an unknown-parameter
   * error gets the older walk instead: `node in [subtree paths and ids]`, decided once per session. `truncated` says the
   * vault returned a full page (more may exist).
   */
  async function loadTasks(treeIn: TaskTree | Promise<TaskTree>, path: string): Promise<{ tasks: Task[]; truncated: boolean }> {
    // r16: everywhere (ROOT) the reads need no tree, so they start at once and the tree (read alongside) only places the rows at the end
    const finish = async (tasks: RawNote[], decisions: RawNote[], cut = tasks.length >= LIMIT || decisions.length >= LIMIT) => {
      const vault = name();
      const t = await treeIn;
      // r16: a step cut at the writer's 140 characters reads as cut ("…"), never as a phrase left hanging
      const parsed = [...tasks, ...decisions].map((n) => parseTask(n, t)).filter((x): x is Task => !!x).map((x) => { const st = stepText(x.next); return { ...x, vault, next: st.text, ...(st.cut ? { nextCut: true } : {}) }; });
      return { tasks: [...new Map(parsed.map((x) => [x.id, withSupport(withAsk(x))])).values()], truncated: cut };
    };
    const tree = path === ROOT ? null : await treeIn;
    if (tree && nearOk !== false) {
      // The anchor is the node's id when the tree knows it (the vault stores references as ids); the path is still accepted.
      const root = tree.byPath.get(path)?.id ?? path;
      try {
        const [tasks, decisions] = await Promise.all([
          call("vault_subtree_tasks", { vault: name(), tag: "task", root, states: [...LIVE_STATES], limit: LIMIT }) as Promise<RawNote[]>,
          call("vault_subtree_tasks", { vault: name(), tag: "decision", root, states: ["open"], limit: LIMIT }) as Promise<RawNote[]>,
        ]);
        nearOk = true;
        return finish(tasks, decisions);
      } catch (e) {
        if (unsupported(e) && nearOk === null) nearOk = false;
        else if (!missing(e)) throw e; // a network or vault failure is the caller's to show; only "can't do this" falls back
      }
    }
    let keys: string[] | null = null;
    if (tree) {
      const known = subtreePaths(tree, path);
      if (known.length) keys = nodeFilterKeys(tree, known);
      else if (nearOk !== false) { try { const s = await loadSubtree(path); keys = [...s.paths, ...s.ids]; } catch { /* no such subtree */ } }
      if (!keys?.length) return { tasks: [], truncated: false };
    }
    const where = keys ? { node: { in: keys } } : {};
    // past the first 200: every page is read before the list is taken for the whole
    const [tasks, decisions] = await Promise.all([
      allPages((offset) => call("vault_query_meta", { vault: name(), tag: "task", metadata: { ...where, state: { in: [...LIVE_STATES] } }, limit: LIMIT, ...(offset ? { offset } : {}) }) as Promise<RawNote[]>),
      allPages((offset) => call("vault_query_meta", { vault: name(), tag: "decision", metadata: { ...where, state: { in: ["open"] } }, limit: LIMIT, ...(offset ? { offset } : {}) }) as Promise<RawNote[]>),
    ]);
    return finish(tasks.rows, decisions.rows, !tasks.complete || !decisions.complete);
  }

  /**
   * Compare-and-set on `state`, guarded by `ifUpdatedAt` (r16): the revision whose instruction the user saw, checked in the same update. A stale
   * `from`, or a task changed since that revision (a rewritten step, even with the state unchanged), is a conflict: the caller re-reads and
   * says so, it never retries blind.
   */
  async function transition(taskId: string, from: AnyState, to: AnyState, ifUpdatedAt: string): Promise<WriteResult> {
    if (!ifUpdatedAt) return { ok: false, kind: "conflict", message: "no revision: reload the task first" };
    try {
      const note = ((await call("vault_transition", { vault: name(), id: taskId, from, to, ifUpdatedAt })) as RawNote);
      return ok(note);
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
      const note = await call("vault_decide", { vault: name(), id: taskId, from: "open", to: "decided", metadata: { decided: option, decided_at: at, decided_by: by }, ifUpdatedAt });
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

  /** Snooze: `snoozed_until` (a date); `null` clears it. */
  const snooze = (taskId: string, until: string | null, updatedAt: string) => patchMeta(taskId, { snoozed_until: until }, updatedAt);
  /** Priority: now, soon or someday; `null` clears it (back to unsorted). */
  /** A priority picked in the app is a person's call: stamp `priority_by: "hand"` so weigh.py never overwrites it.
   *  Undo passes the previous stamp back (null clears it). */
  const setPriority = (taskId: string, priority: Priority | null, updatedAt: string, by: string | null = "hand") =>
    patchMeta(taskId, { priority, priority_by: priority === null ? null : by }, updatedAt);

  /**
   * Where a task's questions come from (r18), read in each note's own vault. The task's own note, when it holds them explicitly (a structured
   * `questions` field, or a list under a heading that names questions); else a note its step or note links (`uni:<ULID>` in that vault, a bare
   * id or `[[Path]]` in the task's); else a closed task merged into it ("Merged into T-11"), on the same node. A source that is closed or
   * superseded (its own state, never its title's words) is `closed`; a linked note named in the step counts as the step's source even without a
   * list. Nothing explicit: `unclear` (the sheet says "Open the note to answer"). Never a numbered plan or any other list taken for questions.
   */
  async function loadSupport(t: Pick<Task, "id" | "title" | "next" | "vault">, nodeKeys: readonly string[], want: number | null): Promise<Support> {
    const home = t.vault ?? name();
    const read = async (vault: string, ref: string): Promise<RawNote | null> => { try { return ((await call("vault_note", { vault, noteRef: ref })) as { note?: RawNote } | null)?.note ?? null; } catch { return null; } };
    const text = (n: RawNote | null) => (typeof n?.content === "string" ? n.content : "");
    const meta = (n: RawNote | null) => (n?.metadata && typeof n.metadata === "object" ? n.metadata as Record<string, unknown> : null);
    const named = (vault: string, n: RawNote): SourceRef => ({ vault, id: typeof n.id === "string" ? n.id : "", title: taskTitle((typeof n.path === "string" ? n.path : "").split("/").pop() ?? "").rest || "its note" });
    const own = await read(home, t.id);
    const mine = questionsFrom(text(own), want, meta(own));
    if (mine) return mine.status === "list" ? { kind: "list", items: mine.items, from: null } : { kind: "unclear", from: null };
    const inStep = new Set(linkedRefs(t.next).map((r) => `${r.vault ?? home}\n${r.id}`));
    for (const ref of linkedRefs(`${t.next}\n${text(own)}`).filter((r) => r.id !== t.id).slice(0, 4)) {
      const vault = ref.vault ?? home;
      const n = await read(vault, ref.id);
      if (!n) continue;
      const q = questionsFrom(text(n), want, meta(n));
      const done = closedBy(meta(n));
      if (done && (q || inStep.has(`${vault}\n${ref.id}`))) return { kind: "closed", how: done, from: named(vault, n) };
      if (q) return q.status === "list" ? { kind: "list", items: q.items, from: named(vault, n) } : { kind: "unclear", from: named(vault, n) };
    }
    const tid = taskTitle(t.title).id;
    if (tid && nodeKeys.length) {
      let rows: RawNote[] = [];
      try { rows = (await call("vault_query_meta", { vault: home, tag: "task", metadata: { node: { in: [...nodeKeys] }, state: { in: ["done", "archived"] } }, limit: LIMIT })) as RawNote[]; } catch { rows = []; }
      // the id written in a merge note ("Merged into T-11"): an explicit pointer to this task, never a match on its title's words
      const merged = new RegExp(`\\bmerged into ${tid.replace(/[-]/g, "\\-")}\\b`, "i");
      const r = rows.find((x) => typeof x.id === "string" && merged.test(JSON.stringify(x.metadata ?? {})));
      if (r) return { kind: "closed", how: closedBy(meta(r)) ?? "closed", from: named(home, r) };
    }
    return { kind: "unclear", from: null };
  }

  /** Sources already read, by task id, with the revision they were read at: a refresh and the next launch show them at once (per identity). */
  const supportCache = new Map<string, { at: string | null; support: Support }>();
  const supportKey = () => `uni.support.v1:${askOwner}`;
  let supportOwner = "\u0000";
  const supportsLoaded = () => {
    if (supportOwner === askOwner) return;
    supportOwner = askOwner; supportCache.clear();
    try { const v = JSON.parse(localStorage.getItem(supportKey()) ?? "[]"); if (Array.isArray(v)) for (const e of v) if (Array.isArray(e) && typeof e[0] === "string" && e[1]?.support?.kind) supportCache.set(e[0], e[1]); } catch { /* nothing kept */ }
  };
  const keepSupports = () => { try { localStorage.setItem(supportKey(), JSON.stringify([...supportCache].slice(-ASK_KEEP))); } catch { /* this session only */ } };
  /** A task with its source as read at its own revision, when known. */
  const withSupport = (t: Task): Task => { supportsLoaded(); const c = supportCache.get(t.id); return c && c.at === t.updatedAt ? { ...t, support: c.support, supportAt: c.at } : t; };
  /**
   * The sources of the questions the rows in Needs you ask for (r18), read after the list is on screen (a few, six at a time): the row says
   * "Answer N questions ›" only from an explicit list, "Check: … is closed — still needed?" when its source is finished, else "Open the note to answer".
   */
  async function loadSupports(tasks: readonly Task[], keysOf: (t: Task) => readonly string[]): Promise<Map<string, { at: string | null; support: Support }>> {
    supportsLoaded();
    const out = new Map<string, { at: string | null; support: Support }>();
    const want = tasks.filter((t) => t.kind === "task" && needsYou(t) && questionCount(t.next) !== null);
    const todo = want.filter((t) => { const c = supportCache.get(t.id); if (c && c.at === t.updatedAt) { out.set(t.id, c); return false; } return true; }).slice(0, ASK_READS);
    for (let i = 0; i < todo.length; i += ASK_PARALLEL) {
      await Promise.all(todo.slice(i, i + ASK_PARALLEL).map(async (t) => {
        try { const support = await loadSupport(t, keysOf(t), questionCount(t.next)); const e = { at: t.updatedAt, support }; out.set(t.id, e); supportCache.delete(t.id); supportCache.set(t.id, e); } catch { /* the row keeps its step */ }
      }));
    }
    if (todo.length) keepSupports();
    return out;
  }

  return { setAskOwner, loadTree, loadTagged, loadAsks, loadSubtree, loadTasks, loadSupport, loadSupports, transition, decide, snooze, setPriority, nearSupported: () => nearOk };
}

export const vaultTasks = createVaultTasks();
