// T-301: the work model, small and explicit. Pure data and rules, no React, no storage.
//
// - An Area is a room: one area, one room, seven of them. The conversation is the area's heart.
// - A Project lives in exactly one area, and always has a folder on disk where its work happens.
// - A Session is one Claude Code worker run on a project. A project holds any number of sessions, and any number of them may be live
//   at once. A session runs, then finishes (with a result) or is stopped. Retiring a session puts it away for good: it is no longer
//   one of the project's sessions to look at or pick up, and a live one is stopped as it is retired.

export type Area = {
  id: string;
  name: string;
  /** The area's node in the vault (`Areas/<Name>`): how the room shell finds it. */
  path: string;
  /** The area's room (its chat channel id). */
  room: string;
};

export type ProjectStatus = "active" | "resting" | "done";

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
};

export type SessionState = "running" | "finished" | "stopped";

/** One step of a session's story, in plain words. */
export type Step = { at: number; text: string };

export type Session = {
  id: string;
  project: string;
  state: SessionState;
  /** Put away for good (see the top of this file). Independent of `state`: a finished or stopped session may be retired. */
  retired: boolean;
  /** What the session was asked to do, in one line. */
  ask: string;
  /** What it is doing now (live), or the last thing it did. */
  now: string;
  startedAt: number;
  endedAt: number | null;
  story: Step[];
  /** What came back (finished sessions). */
  result: string | null;
  /** A walkthrough video, when the session left one. */
  video: string | null;
};

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
    if (Array.isArray(p.area as unknown)) out.push(`${p.name} lives in more than one area`);
    else if (!areaIds.has(p.area)) out.push(`${p.name} is in no known area`);
    if (!isFolder(p.folder)) out.push(`${p.name} has no folder`);
  }
  for (const s of w.sessions) {
    if (!projectIds.has(s.project)) out.push(`session ${s.id} belongs to no project`);
    if (s.state === "running" && s.endedAt !== null) out.push(`session ${s.id} is running but has ended`);
    if (s.state !== "running" && s.endedAt === null) out.push(`session ${s.id} has stopped running but has no end`);
  }
  return out;
}

export const isLive = (s: Session) => s.state === "running";
export const projectsIn = (w: Work, area: string) => w.projects.filter((p) => p.area === area);
export const areaOf = (w: Work, project: Project) => w.areas.find((a) => a.id === project.area) ?? null;
export const liveSessions = (w: Work, project: string) => w.sessions.filter((s) => s.project === project && isLive(s));
export const liveInArea = (w: Work, area: string) => {
  const here = new Set(projectsIn(w, area).map((p) => p.id));
  return w.sessions.filter((s) => here.has(s.project) && isLive(s));
};

/** A project's sessions in the order a person reads them: live ones first (newest first), then the rest by when they ended; retired ones are left out. */
export function sessionsOf(w: Work, project: string): Session[] {
  const mine = w.sessions.filter((s) => s.project === project && !s.retired);
  const live = mine.filter(isLive).sort((a, b) => b.startedAt - a.startedAt);
  const done = mine.filter((s) => !isLive(s)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  return [...live, ...done];
}
export const retiredOf = (w: Work, project: string) => w.sessions.filter((s) => s.project === project && s.retired).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));

const put = (w: Work, id: string, change: (s: Session) => Session): Work => {
  if (!w.sessions.some((s) => s.id === id)) throw new ModelError(`no session ${id}`);
  return { ...w, sessions: w.sessions.map((s) => (s.id === id ? change(s) : s)) };
};

/** Starts a fresh session on a project. The project's other sessions, live or not, are left as they are. */
export function startSession(w: Work, project: string, ask: string, at: number, id: string): Work {
  const p = w.projects.find((x) => x.id === project);
  if (!p) throw new ModelError(`no project ${project}`);
  if (p.status === "done") throw new ModelError(`${p.name} is done; open it again before starting a session`);
  if (!ask.trim()) throw new ModelError("a session needs something to do");
  if (w.sessions.some((s) => s.id === id)) throw new ModelError(`a session ${id} already exists`);
  const s: Session = { id, project, state: "running", retired: false, ask: ask.trim(), now: "Reading the brief and the folder.", startedAt: at, endedAt: null, story: [{ at, text: "Started in " + p.folder + "." }], result: null, video: null };
  return { ...w, sessions: [...w.sessions, s] };
}

/** A live session takes a step: the story grows and its one line says what it is doing now. A session that isn't live takes none. */
export const stepSession = (w: Work, id: string, text: string, at: number): Work =>
  put(w, id, (s) => (isLive(s) ? { ...s, now: text, story: [...s.story, { at, text }] } : s));

/** Stops a live session where it is. Stopping one that isn't live changes nothing. */
export const stopSession = (w: Work, id: string, at: number): Work =>
  put(w, id, (s) => (isLive(s) ? { ...s, state: "stopped", endedAt: at, now: "Stopped by you.", story: [...s.story, { at, text: "Stopped by you." }] } : s));

/** A live session finishes with what it came back with. */
export const finishSession = (w: Work, id: string, at: number, result: string, video: string | null = null): Work =>
  put(w, id, (s) => (isLive(s) ? { ...s, state: "finished", endedAt: at, now: result, result, video, story: [...s.story, { at, text: "Finished." }] } : s));

/** Retires a session: a live one is stopped first, then it is put away. */
export const retireSession = (w: Work, id: string, at: number): Work => {
  const stopped = stopSession(w, id, at);
  return put(stopped, id, (s) => ({ ...s, retired: true }));
};

/** Brings a retired session back to the project's list, as it was when it was retired (a session stopped on retiring stays stopped). */
export const restoreSession = (w: Work, id: string): Work => put(w, id, (s) => ({ ...s, retired: false }));

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
  return s.state === "finished" ? `Finished ${when}` : `Stopped ${when}`;
}

/** Sessions that ran at the same time each get a lane of their own (the first lane free when it started). */
function lanes(sessions: readonly Session[], to: number) {
  const ends: number[] = [];
  return [...sessions].sort((a, b) => a.startedAt - b.startedAt).map((s) => {
    let lane = ends.findIndex((e) => e <= s.startedAt);
    if (lane < 0) lane = ends.length;
    ends[lane] = s.endedAt ?? to;
    return { s, lane };
  });
}

/**
 * The thin timeline under a project: when its sessions ran, against when the room talked. Everything is placed as a fraction of the
 * window [from, to], clipped to it.
 */
export function timeline(sessions: readonly Session[], talk: readonly number[], from: number, to: number) {
  const len = Math.max(1, to - from);
  const at = (t: number) => Math.min(1, Math.max(0, (t - from) / len));
  return {
    runs: lanes(sessions.filter((s) => (s.endedAt ?? to) >= from && s.startedAt <= to), to).map(({ s, lane }) => ({ id: s.id, live: isLive(s), lane, x: at(s.startedAt), w: Math.max(0.006, at(s.endedAt ?? to) - at(s.startedAt)) })),
    talk: talk.filter((t) => t >= from && t <= to).map(at),
  };
}

const HOUR = 3_600_000;
/**
 * The window the timeline shows: the last 8 hours when a session ran in them; otherwise back to the latest session's start (with a
 * little before it), never more than 4 days.
 */
export function timelineWindow(sessions: readonly Session[], now: number, recent = 8 * HOUR, longest = 96 * HOUR): { from: number; to: number } {
  if (sessions.some((s) => (s.endedAt ?? now) >= now - recent)) return { from: now - recent, to: now };
  const latest = [...sessions].sort((a, b) => (b.endedAt ?? now) - (a.endedAt ?? now))[0];
  if (!latest) return { from: now - recent, to: now };
  return { from: Math.max(now - longest, Math.min(now - recent, latest.startedAt - HOUR / 2)), to: now };
}
