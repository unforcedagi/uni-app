// T-301/T-302: the work model, small and explicit. Pure data and rules, no React, no storage.
//
// - An Area is a room: one area, one room, seven of them. The conversation is the area's heart.
// - A Project lives in exactly one area, and always has a folder on disk where its work happens.
// - A Session is one Claude Code worker run on a project. A project holds any number of sessions, and any number of them may be live
//   at once. A session runs, then finishes (with a result), stops, or ends waiting on you. A session that has ended is the project's
//   history; there is no separate "retire".
// - Archiving is for projects only: an archived project leaves its room's strip, keeps its folder and history, can be brought back,
//   takes no new sessions, and has no live ones (archiving one with live sessions asks to stop them first).
// - No session is ever without a place: one with no project sits in its area's home ("Other sessions"), and one with no area either in
//   the one Unfiled home. A home is held as a Project with `kind: "home"`, but is no project: no folder, no archive, no new sessions.

export type Area = {
  id: string;
  name: string;
  /** The area's node in the vault (`Areas/<Name>`): how the room shell finds it. */
  path: string;
  /** The area's room (its chat channel id). */
  room: string;
};

export type ProjectStatus = "active" | "resting" | "archived";

export type Project = {
  id: string;
  /** The one area this project lives in. Never a list. */
  area: string;
  name: string;
  /** Where the project lives on disk (absolute, or under `~/`). Every project has one. */
  folder: string;
  status: ProjectStatus;
  /** One line on what the project is. */
  about: string;
  /** Not a project but a home: the sessions of an area that are in no project, or (UNFILED) the ones with no area either. */
  kind?: "home";
};

/** The home of the sessions that say neither their project nor their area. */
export const UNFILED = "home:unfiled";
export const isHome = (p: Pick<Project, "kind">) => p.kind === "home";

/** `waiting`: it ended needing you (blocked, or a decision); `failed`: it ended without finishing; `silent`: its note still says running,
 *  but nothing has been heard from it for hours (its end is the last time it was heard from; it is not counted as working). */
export type SessionState = "running" | "finished" | "stopped" | "waiting" | "failed" | "silent";

export type Session = {
  id: string;
  project: string;
  state: SessionState;
  /** What the session was asked to do, in one line. */
  ask: string;
  /** What it is doing now (live), or the last thing it did; null when it hasn't said. */
  now: string | null;
  /** When `now` was last said (live sessions). */
  nowAt: number | null;
  startedAt: number;
  endedAt: number | null;
  /** How many steps it has taken (the ticks). */
  steps: number;
  /** What came back (finished sessions). */
  result: string | null;
  /** A walkthrough video, when the session left one. */
  video: string | null;
  /** Why it started, when its run note says (round 2): a fresh start of an earlier session, a pick-up where one stopped, or one more beside
   *  others that were working. `of` is the earlier session's id (never shown: its one line is). */
  why: SessionWhy | null;
  /** T-304: what its run note says of its end (mts writes it when the run ends); null while it runs, or on a note that says nothing. */
  end: SessionEnd | null;
  /** T-304: the note holding its steps (mts keeps it while the session works); null when there is none. */
  feed: string | null;
  /** T-335 runs visible: a waiting session's who and what (mts writes them from its report: `waiting_on`, `waiting_for`); `on` is "aaron"
   *  when it waits on you, else the room or agent it waits on. Left out or null: it says no one. */
  waiting?: SessionWait | null;
  /** T-335 shape: the room the run note names (`channel`, else `starter_channel`; the first id of a list), so a room no area owns can
   *  still show its runs. Only on a run no private clue touches and whose rooms are read; left out or null otherwise. */
  channel?: string | null;
};

export type SessionWait = { on: string; what: string | null };

/** Why a session ended, in mts's one word: `done` (with something to show for it), `unverified` (says it finished; nothing it left could
 *  be checked), `blocked` (stopped to ask you), `stopped` (on purpose), `killed` (cut off), `limit` (the account's session limit), `turns`
 *  (every turn it was given), `context` (its conversation grew too long), `failed`, `lost` (its worker was gone), `never_started`. */
export type EndWhy = "done" | "unverified" | "blocked" | "stopped" | "killed" | "limit" | "turns" | "context" | "failed" | "lost" | "never_started";
export const END_WHYS: readonly EndWhy[] = ["done", "unverified", "blocked", "stopped", "killed", "limit", "turns", "context", "failed", "lost", "never_started"];

/** A session's end as its run note keeps it: why, a short note on what went wrong, when it picks up again, and its report's four parts
 *  (what it did, what it left, how it checked, what it needs). */
export type SessionEnd = { why: EndWhy | null; note: string | null; resumesAt: number | null; did: string | null; left: string | null; checks: string | null; needs: string | null };

export type SessionWhy = { kind: "fresh" | "resume"; of: string | null } | { kind: "alongside"; others: number };

export type Work = { areas: Area[]; projects: Project[]; sessions: Session[] };

export class ModelError extends Error {}

/** A folder is a real path: absolute, or under the home folder. */
export const isFolder = (f: unknown): f is string => typeof f === "string" && /^(\/|~\/)\S/.test(f.trim());

/**
 * Makes a project, holding the two rules a project can break: it lives in exactly one area (one id, and an area that exists), and it
 * has a folder.
 */
export function makeProject(input: { id: string; area: string | string[]; name: string; folder?: string | null; status?: ProjectStatus; about?: string }, areas: readonly Area[]): Project {
  const { area } = input;
  if (Array.isArray(area)) throw new ModelError(`${input.name}: a project lives in exactly one area, not ${area.length}`);
  if (!areas.some((a) => a.id === area)) throw new ModelError(`${input.name}: no area "${area}"`);
  if (!isFolder(input.folder)) throw new ModelError(`${input.name}: a project needs a folder (an absolute path or one under ~/)`);
  if (!input.name.trim()) throw new ModelError("a project needs a name");
  return { id: input.id, area, name: input.name.trim(), folder: input.folder.trim(), status: input.status ?? "active", about: input.about ?? "" };
}

/** Every rule the whole model must hold, as plain sentences (empty: it holds). */
export function problems(w: Work): string[] {
  const out: string[] = [];
  const areaIds = new Set(w.areas.map((a) => a.id));
  const rooms = new Map<string, string>();
  for (const a of w.areas) {
    if (rooms.has(a.room)) out.push(`${a.name} and ${rooms.get(a.room)} share a room`);
    rooms.set(a.room, a.name);
  }
  const projectIds = new Set<string>();
  for (const p of w.projects) {
    if (projectIds.has(p.id)) out.push(`two projects are called ${p.id}`);
    projectIds.add(p.id);
    if (isHome(p)) { if (p.id !== UNFILED && !areaIds.has(p.area)) out.push(`${p.name} is the home of no known area`); continue; }
    if (Array.isArray(p.area as unknown)) out.push(`${p.name} lives in more than one area`);
    else if (!areaIds.has(p.area)) out.push(`${p.name} is in no known area`);
    if (!isFolder(p.folder)) out.push(`${p.name} has no folder`);
  }
  for (const s of w.sessions) {
    if (!projectIds.has(s.project)) out.push(`session ${s.id} belongs to no project`);
    if (s.state === "running" && s.endedAt !== null) out.push(`session ${s.id} is running but has ended`);
    if (s.state !== "running" && s.endedAt === null) out.push(`session ${s.id} has stopped running but has no end`);
  }
  for (const p of w.projects) if (p.status === "archived" && liveSessions(w, p.id).length) out.push(`${p.name} is archived but has live sessions`);
  return out;
}

export const isLive = (s: Session) => s.state === "running";
export const liveSessions = (w: Work, project: string) => w.sessions.filter((s) => s.project === project && isLive(s));
/** T-335 runs visible: a session waiting on you (blocked on you, or a decision that is yours). */
export const waitsOnYou = (s: Session) => s.state === "waiting" && s.waiting?.on === "aaron";
/** How long, said plainly: "4 min", "1 h 10 min", "5 h", "2 days" (minutes only while they matter). */
export function span(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 3) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  if (Math.round(m / 60) < 24) return `${Math.round(m / 60)} h`;
  const d = Math.round(h / 24);
  return d === 1 ? "1 day" : `${d} days`;
}

/** "just now", "5 min ago", "3 days ago". */
export const ago = (ms: number) => { const s = span(ms); return s === "just now" ? s : `${s} ago`; };

/** A session's state in one or two words, for a person (never an id). */
export function stateWords(s: Session, now: number): string {
  if (isLive(s)) return `Working · ${span(now - s.startedAt)}`;
  const when = s.endedAt ? ago(now - s.endedAt) : "";
  const word = { running: "Working", finished: "Finished", stopped: "Stopped", waiting: "Needs you · ended", failed: "Didn't finish ·", silent: "Silent · last heard" }[s.state];
  return `${word} ${when}`.trim();
}
