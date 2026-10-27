// T-302: the work model from the vault the app already reads. Pure: notes in, areas, projects, sessions and the gaps out.
//
// - Areas are the `node` notes tagged `area` (Areas/<Name>), each with its room (`channel`).
// - Projects are the `node` notes tagged `project`. A project's area is the first area up its `parent` chain (one, never a list:
//   `links` to other places don't make it live there too). Its folder is `metadata.folder` (the reviewed mapping), else `repo`. A
//   project the model refuses (no area, no folder) is a gap: named, never shown as if it were whole.
// - Sessions are the `run` notes mts writes. A run belongs to the project its `project`, its `node`, its task's node or (last) its
//   repo `folder` names. What it is doing now is `doing_now` (mts writes it while it runs); words, never ids.
import type { RawNote } from "../areas/taskCore.ts";
import { isPrivateName } from "../areas/treeRooms.ts";
import { END_WHYS, isFolder, makeProject, ModelError, type Area, type EndWhy, type Project, type ProjectStatus, type Session, type SessionEnd, type SessionState, type Work } from "./model.ts";

/** A project the model can't take, named so it is never silently missing. `areaPath`: the area it sits under (even one with no room), so
 *  that area's strip can name it. */
export type Gap = { name: string; area: string | null; areaPath: string | null; why: "no folder" | "no area" | "area has no room" };
export type LiveArea = Area & { private: boolean };
export type LiveWork = Work & { areas: LiveArea[]; gaps: Gap[] };
export type Sources = { nodes: readonly RawNote[]; runs: readonly RawNote[]; tasks: readonly RawNote[] };

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const meta = (n: RawNote): Record<string, unknown> => (n.metadata && typeof n.metadata === "object" ? (n.metadata as Record<string, unknown>) : {});
const tagsOf = (n: RawNote): string[] => (Array.isArray(n.tags) ? n.tags.filter((t): t is string => typeof t === "string") : []);
const time = (v: unknown): number | null => { const s = str(v); const t = s ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : null; };
const lastName = (path: string) => path.split("/").pop() ?? path;
const unlink = (ref: string) => ref.replace(/^\[\[|\]\]$/g, "");
/** One spelling for a folder: `~/` for a home folder, no trailing slash (mts writes `~/Code/x`; a note may hold `/home/u/Code/x/`). */
export const folderKey = (f: string) => f.trim().replace(/^\/(?:home|Users)\/[^/]+\//, "~/").replace(/\/+$/, "");

/** The vault's words for a project's state, as the model's three. */
export function statusOf(v: unknown): ProjectStatus {
  const s = (str(v) ?? "").toLowerCase();
  if (/^(archived|done|closed|retired|superseded|merged)/.test(s)) return "archived";
  if (/^(dormant|incubating|resting|paused|parked|someday)/.test(s)) return "resting";
  return "active";
}

/** The run note's state as the session's. */
export function sessionState(v: unknown): SessionState {
  switch (str(v)) {
    case "running": case "queued": case "stalled": return "running";
    case "done": return "finished";
    case "blocked": case "decision": return "waiting";
    case "failed": case "lost": return "failed";
    default: return "stopped";
  }
}

/** A task number, a run id, a resume tag or a copy number never reaches the screen: what is left is the words. */
export function plainTitle(raw: string): string {
  return raw
    .replace(/\((?:resume|resumes|fork)\s+[a-z0-9]{8}\)/gi, "")
    .replace(/\(\d+\)\s*$/, "")
    .replace(/\bT-\d+[a-z]?\b:?/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s·:–—-]+|[\s·:–—-]+$/g, "")
    .trim();
}

/** What a finished run left, in words, from the launcher's closing line ("mts x: completed, evidence: file …/SHAPE.md"). */
export function resultWords(summary: unknown, state: SessionState): string | null {
  const s = str(summary);
  if (!s) return null;
  const file = /evidence: file (\S+)/.exec(s)?.[1];
  if (file) return `Left ${lastName(file)}.`;
  if (/evidence: commit [0-9a-f]{6,}/.test(s)) return "Left a commit.";
  if (/^unverified:/.test(s)) return "Says it finished; nothing it left could be checked yet.";
  if (/unit gone/.test(s)) return "Its worker was gone; closed when the old runs were tidied.";
  // the launcher's bare state line says nothing the state word doesn't
  if (/^mts [a-z0-9]{8}: \w+$/.test(s)) return null;
  const words = plainTitle(s.replace(/\bmts [a-z0-9]{8}:?\s*/g, "").replace(/\brun=[a-z0-9]{8}\b/g, ""));
  return words && state !== "running" ? words : null;
}

/** T-304: why a run ended, from what its note says: mts's `ended` word (since T-304), else the launcher's closing line ("mts x: stopped",
 *  "unverified: …") and the note's state, for notes written before. Null when it says nothing (or it is still running). */
export function endWhy(ended: unknown, summary: unknown, state: SessionState): EndWhy | null {
  const e = str(ended);
  if (e && (END_WHYS as readonly string[]).includes(e)) return e as EndWhy;
  if (state === "running") return null;
  const s = str(summary) ?? "";
  if (/^unverified:/.test(s)) return "unverified";
  const word = /^mts [a-z0-9]{8}: (\w+)/.exec(s)?.[1];
  if (word === "stopped" || word === "killed") return word;
  if (word === "unknown") return "lost";
  if (word === "failed_to_start") return "never_started";
  if (state === "finished") return "done";
  if (state === "waiting") return "blocked";
  if (state === "failed") return "failed";
  return null;
}

/** T-304: a run note's end: why (endWhy), the report mts copied onto it (its four parts, each plain text) and when it picks up again. */
export function sessionEnd(m: Record<string, unknown>, state: SessionState): SessionEnd | null {
  if (state === "running") return null;
  const rep = m.report && typeof m.report === "object" && !Array.isArray(m.report) ? (m.report as Record<string, unknown>) : {};
  // a part that says "none" says nothing
  const part = (v: unknown) => { const t = str(v); return t && !/^[^\p{L}\p{N}]*(none|n\/?a|nothing)?[^\p{L}\p{N}]*$/iu.test(t) ? t : null; };
  const end: SessionEnd = { why: endWhy(m.ended, m.summary, state), note: str(m.end_note), resumesAt: time(m.resumes_at),
    did: part(rep.summary), left: part(rep.artifacts), checks: part(rep.checks), needs: part(rep.open) };
  return Object.values(end).some((v) => v !== null) ? end : null;
}

/** A running note's worker counts as working while it was heard from this recently (mts writes `doing_at` at least once a minute while
 *  tools run; one long command can hold it quiet a while), or, before it has said anything, this long after it started. */
export const HEARD_MS = 2 * 3_600_000;
export const UNHEARD_START_MS = 3 * 3_600_000;

/** Words a room wrote for a person, without the task numbers in them ("T-265 civic data…", "(T-257)"). */
export function plainWords(text: string): string {
  const t = text.replace(/\s*\((?:T-\d+[a-z]?(?:,\s*)?)+\)/gi, "").replace(/\bT-\d+[a-z]?\b:?\s*/gi, "").replace(/\s{2,}/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Whether a running session is still heard from at `now`: its last word (`nowAt`, from doing_at) within HEARD_MS, or, before it has said
 *  anything, its start within UNHEARD_START_MS. */
export const heardFrom = (s: Pick<Session, "nowAt" | "startedAt">, now: number) => (s.nowAt !== null ? now - s.nowAt < HEARD_MS : now - s.startedAt < UNHEARD_START_MS);

/** The work as it stands at `now`: a running session no one has heard from is silent, not working (its end is the last time it was heard
 *  from). Applied to every read and, on a timer, to what is on screen, so a copy kept while offline ages the way the vault would. Returns
 *  the same object when nothing changed. */
export function freshen<W extends Work>(w: W, now = Date.now()): W {
  if (!w.sessions.some((s) => s.state === "running" && !heardFrom(s, now))) return w;
  return { ...w, sessions: w.sessions.map((s) => (s.state === "running" && !heardFrom(s, now) ? { ...s, state: "silent" as const, endedAt: s.nowAt ?? s.startedAt, now: null } : s)) };
}

/** Areas, projects and sessions from the vault's node, run and task notes. Nothing here throws on odd data: odd notes are skipped or gaps. */
export function workFrom(src: Sources, now = Date.now()): LiveWork {
  const byKey = new Map<string, RawNote>();
  for (const n of src.nodes) { const id = str(n.id), path = str(n.path); if (id) byKey.set(id, n); if (path) byKey.set(path, n); }
  const keyOf = (n: RawNote) => str(n.id) ?? str(n.path) ?? "";
  const areaNotes = src.nodes.filter((n) => tagsOf(n).includes("area") && /^Areas\/[^/]+$/.test(str(n.path) ?? ""));
  const areas: LiveArea[] = [];
  const seenRooms = new Set<string>();
  for (const n of areaNotes) {
    const room = str(meta(n).channel);
    const name = lastName(str(n.path)!);
    if (!room || seenRooms.has(room)) continue;
    seenRooms.add(room);
    areas.push({ id: keyOf(n), name, path: str(n.path)!, room, private: isPrivateName(name) });
  }
  const areaIds = new Set(areas.map((a) => a.id));
  /** Every area note by key, with or without a room (review finding 7: one without is still where its projects sit). */
  const areaPathOf = new Map(areaNotes.map((n) => [keyOf(n), str(n.path)!]));
  /** The first area note up a node's parent chain (a project under a project lives in its parent's area). */
  const areaUp = (n: RawNote): string | null => {
    const seen = new Set<string>();
    let cur: RawNote | undefined = n;
    while (cur && !seen.has(keyOf(cur))) {
      seen.add(keyOf(cur));
      if (areaPathOf.has(keyOf(cur))) return keyOf(cur);
      const up = str(meta(cur).parent);
      cur = up ? byKey.get(unlink(up)) : undefined;
    }
    return null;
  };
  const projects: Project[] = [];
  const gaps: Gap[] = [];
  for (const n of src.nodes) {
    const tags = tagsOf(n), path = str(n.path);
    if (!path || !tags.includes("project") || tags.includes("area")) continue;
    const m = meta(n);
    if (str(m.merged_into)) continue;
    const name = lastName(path), up = areaUp(n);
    const area = up && areaIds.has(up) ? up : null;
    const areaPath = up ? areaPathOf.get(up) ?? null : null;
    const folder = str(m.folder) ?? (isFolder(m.repo) ? str(m.repo) : null);
    if (up && !area) { if (statusOf(m.status) !== "archived") gaps.push({ name, area: null, areaPath, why: "area has no room" }); continue; }
    try {
      projects.push(makeProject({ id: keyOf(n), area: area ?? "", name, folder, status: statusOf(m.status), about: plainWords(str(m.summary) ?? "") }, areas));
    } catch (e) {
      if (!(e instanceof ModelError)) throw e;
      if (statusOf(m.status) !== "archived") gaps.push({ name, area, areaPath, why: area ? "no folder" : "no area" });
    }
  }
  const projectIds = new Set(projects.map((p) => p.id));
  const projectOfNode = (ref: string | null): string | null => {
    if (!ref) return null;
    const n = byKey.get(unlink(ref));
    if (!n) return null;
    // the node itself, or the nearest project up its chain (a run filed on a project's part)
    const seen = new Set<string>();
    let cur: RawNote | undefined = n;
    while (cur && !seen.has(keyOf(cur))) {
      seen.add(keyOf(cur));
      if (projectIds.has(keyOf(cur))) return keyOf(cur);
      if (areaIds.has(keyOf(cur))) return null;
      const up = str(meta(cur).parent);
      cur = up ? byKey.get(unlink(up)) : undefined;
    }
    return null;
  };
  const byFolder = new Map<string, string[]>();
  for (const p of projects) byFolder.set(folderKey(p.folder), [...(byFolder.get(folderKey(p.folder)) ?? []), p.id]);
  const taskNode = new Map<string, string>();
  const taskTitle = new Map<string, string>();
  for (const t of src.tasks) {
    const path = str(t.path) ?? "";
    const id = /^Tasks\/(T-\d+[a-z]?)\b/i.exec(path)?.[1]?.toUpperCase();
    if (!id) continue;
    const node = str(meta(t).node);
    if (node) taskNode.set(id, node);
    taskTitle.set(id, plainTitle(path.replace(/^Tasks\//, "").replace(/∕/g, "/")));
  }
  const sessions: Session[] = [];
  const byAttempt = new Map<string, string>();
  const asked = new Map<string, { kind: "fresh" | "resume"; attempt: string }>();
  /** The mts run id a run note belongs to: its `attempt`, else the run id in an mts worker unit `mts-<run>`. */
  const attemptOf = (m: Record<string, unknown>) => str(m.attempt) ?? /^mts-([a-z0-9]{8})$/.exec(str(m.worker) ?? "")?.[1] ?? null;
  for (const r of src.runs) {
    const m = meta(r), id = keyOf(r);
    const startedAt = time(m.started_at);
    if (!id || startedAt === null) continue;
    const task = str(m.task)?.toUpperCase() ?? null;
    const folder = str(m.folder);
    const viaFolder = folder ? byFolder.get(folderKey(folder)) : undefined;
    const project = projectOfNode(str(m.project)) ?? projectOfNode(str(m.node)) ?? (task ? projectOfNode(taskNode.get(task) ?? null) : null)
      ?? (viaFolder?.length === 1 ? viaFolder[0] : null);
    if (!project) continue;
    // a run stopped by hand closes as failed with the launcher's "stopped" line: it was stopped, not a failure
    // a note marked running stays "running" here with its heartbeat (nowAt); freshen() below decides, from the clock, whether it is
    // still heard from (the same rule re-applied to a saved copy, so a cached session can't stay "working" forever)
    const state = sessionState(m.state) === "failed" && /: stopped$/.test(str(m.summary) ?? "") ? "stopped" : sessionState(m.state);
    const live = state === "running";
    const ended = live ? null : time(m.ended_at) ?? time(r.updatedAt) ?? startedAt;
    const title = plainTitle((str(r.path) ?? "").replace(/^Runs\/\d{4}-\d{2}-\d{2}\s*/, ""));
    const ask = title || (task ? taskTitle.get(task) : null) || "A session";
    const steps = typeof m.steps === "number" && Number.isFinite(m.steps) ? Math.max(0, Math.floor(m.steps)) : 0;
    sessions.push({
      id, project, state, ask,
      now: live && str(m.doing_now) ? plainWords(str(m.doing_now)!) : null, nowAt: live ? time(m.doing_at) : null,
      startedAt, endedAt: ended, steps,
      result: live ? null : resultWords(m.summary, state),
      video: str(m.video) && /^https:\/\//.test(str(m.video)!) ? str(m.video) : null,
      why: null,
      end: sessionEnd(m, state),
      feed: str(m.feed),
    });
    const att = attemptOf(m);
    if (att) byAttempt.set(att, id);
    const fresh = str(m.fresh_from), resumes = str(m.resumes) ?? /\(resume ([a-z0-9]{8})\)/.exec(str(r.path) ?? "")?.[1] ?? null;
    if (fresh || resumes) asked.set(id, { kind: fresh ? "fresh" : "resume", attempt: (fresh ?? resumes)! });
  }
  // round 2: why each session started. The run note's fresh_from / resumes name an earlier attempt; otherwise, one that started while
  // others were working on the same project is one more beside them.
  for (const s of sessions) {
    const a = asked.get(s.id);
    if (a) { s.why = { kind: a.kind, of: byAttempt.get(a.attempt) ?? null }; continue; }
    const others = sessions.filter((o) => o !== s && o.project === s.project && o.startedAt < s.startedAt && (o.endedAt ?? Infinity) > s.startedAt).length;
    if (others) s.why = { kind: "alongside", others };
  }
  return freshen({ areas, projects, sessions, gaps }, now);
}
