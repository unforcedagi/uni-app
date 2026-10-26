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
import { isFolder, makeProject, ModelError, type Area, type Project, type ProjectStatus, type Session, type SessionState, type Work } from "./model.ts";

export type Gap = { name: string; area: string | null; why: "no folder" | "no area" };
export type LiveArea = Area & { private: boolean };
export type LiveWork = Work & { areas: LiveArea[]; gaps: Gap[] };
export type Sources = { nodes: readonly RawNote[]; runs: readonly RawNote[]; tasks: readonly RawNote[] };

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const meta = (n: RawNote): Record<string, unknown> => (n.metadata && typeof n.metadata === "object" ? (n.metadata as Record<string, unknown>) : {});
const tagsOf = (n: RawNote): string[] => (Array.isArray(n.tags) ? n.tags.filter((t): t is string => typeof t === "string") : []);
const time = (v: unknown): number | null => { const s = str(v); const t = s ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : null; };
const lastName = (path: string) => path.split("/").pop() ?? path;

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
    case "failed": return "failed";
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
  // the launcher's bare state line says nothing the state word doesn't
  if (/^mts [a-z0-9]{8}: \w+$/.test(s)) return null;
  const words = plainTitle(s.replace(/\bmts [a-z0-9]{8}:?\s*/g, "").replace(/\brun=[a-z0-9]{8}\b/g, ""));
  return words && state !== "running" ? words : null;
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
  /** The first area up a node's parent chain (a project under a project lives in its parent's area). */
  const areaUp = (n: RawNote): string | null => {
    const seen = new Set<string>();
    let cur: RawNote | undefined = n;
    while (cur && !seen.has(keyOf(cur))) {
      seen.add(keyOf(cur));
      if (areaIds.has(keyOf(cur))) return keyOf(cur);
      const up = str(meta(cur).parent);
      cur = up ? byKey.get(up.replace(/^\[\[|\]\]$/g, "")) : undefined;
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
    const name = lastName(path), area = areaUp(n);
    const folder = str(m.folder) ?? (isFolder(m.repo) ? str(m.repo) : null);
    try {
      projects.push(makeProject({ id: keyOf(n), area: area ?? "", name, folder, status: statusOf(m.status), about: str(m.summary) ?? "" }, areas));
    } catch (e) {
      if (!(e instanceof ModelError)) throw e;
      if (statusOf(m.status) !== "archived") gaps.push({ name, area, why: area ? "no folder" : "no area" });
    }
  }
  const projectIds = new Set(projects.map((p) => p.id));
  const projectOfNode = (ref: string | null): string | null => {
    if (!ref) return null;
    const n = byKey.get(ref.replace(/^\[\[|\]\]$/g, ""));
    if (!n) return null;
    // the node itself, or the nearest project up its chain (a run filed on a project's part)
    const seen = new Set<string>();
    let cur: RawNote | undefined = n;
    while (cur && !seen.has(keyOf(cur))) {
      seen.add(keyOf(cur));
      if (projectIds.has(keyOf(cur))) return keyOf(cur);
      if (areaIds.has(keyOf(cur))) return null;
      const up = str(meta(cur).parent);
      cur = up ? byKey.get(up) : undefined;
    }
    return null;
  };
  const byFolder = new Map<string, string[]>();
  for (const p of projects) byFolder.set(p.folder, [...(byFolder.get(p.folder) ?? []), p.id]);
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
  for (const r of src.runs) {
    const m = meta(r), id = keyOf(r);
    const startedAt = time(m.started_at);
    if (!id || startedAt === null) continue;
    const task = str(m.task)?.toUpperCase() ?? null;
    const folder = str(m.folder);
    const viaFolder = folder ? byFolder.get(folder) : undefined;
    const project = projectOfNode(str(m.project)) ?? projectOfNode(str(m.node)) ?? (task ? projectOfNode(taskNode.get(task) ?? null) : null)
      ?? (viaFolder?.length === 1 ? viaFolder[0] : null);
    if (!project) continue;
    // a run stopped by hand closes as failed with the launcher's "stopped" line: it was stopped, not a failure
    const said = time(m.doing_at);
    const heard = said !== null ? now - said < HEARD_MS : now - startedAt < UNHEARD_START_MS;
    const noted = sessionState(m.state) === "failed" && /: stopped$/.test(str(m.summary) ?? "") ? "stopped" : sessionState(m.state);
    const state = noted === "running" && !heard ? "silent" : noted;
    const live = state === "running";
    const ended = live ? null : state === "silent" ? said ?? startedAt : time(m.ended_at) ?? time(r.updatedAt) ?? startedAt;
    const title = plainTitle((str(r.path) ?? "").replace(/^Runs\/\d{4}-\d{2}-\d{2}\s*/, ""));
    const ask = title || (task ? taskTitle.get(task) : null) || "A session";
    const steps = typeof m.steps === "number" && Number.isFinite(m.steps) ? Math.max(0, Math.floor(m.steps)) : 0;
    sessions.push({
      id, project, state, ask,
      now: live ? str(m.doing_now) : null, nowAt: live ? time(m.doing_at) : null,
      startedAt, endedAt: ended, steps,
      result: live ? null : resultWords(m.summary, state),
      video: str(m.video) && /^https:\/\//.test(str(m.video)!) ? str(m.video) : null,
    });
  }
  return { areas, projects, sessions, gaps };
}
