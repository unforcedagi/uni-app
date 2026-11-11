// T-335 the shape: what is moving in a room and what waits on you, per room (channel id), and a run's story for its sheet. Pure.
//
// - A run shows in its area's room (the room the area note names), as the old room list did. A run no area holds (the Unfiled home) shows
//   in the room its own note names (`Session.channel`, which live.ts fills only for a run no private clue touches and whose rooms are read).
// - Privacy, as before: a private area's runs show nothing at all, not even a line with no words (the old room list drew no run line on a
//   private door, and the room head drew none in a private room). A run a private clue touches never carries a channel (live.ts), and a
//   sealed run (private with no private area, or rooms not read yet) is in the Unfiled home with no channel: it shows nowhere.
// - Moving: the newest live run (its line: the step it is on now, else what it was asked to do). Waiting: the newest run waiting on you
//   (waitsOnYou: one waiting on Uni or another room is not yours). Finished, stopped, superseded and silent runs show nothing.
import type { RoomRun, RoomRuns, ShapeRoom } from "./types.ts";
import { isLive, waitsOnYou, type Session } from "../projects/model.ts";
import type { LiveArea, LiveWork } from "../projects/live.ts";
import { redactRaw, type FeedItem } from "../projects/sessionWords.ts";

/** live.ts's plainWords (no task numbers, first letter up), here so this file pulls in nothing that reaches Tauri (live.ts reads the vault). */
function plainWords(text: string): string {
  const t = text.replace(/\s*\((?:T-\d+[a-z]?(?:,\s*)?)+\)/gi, "").replace(/\bT-\d+[a-z]?\b:?\s*/gi, "").replace(/\s{2,}/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const secs = (ms: number | null) => (ms === null ? null : Math.floor(ms / 1000));

/** The room a session's line belongs in, or null: its area's room (none at all for a private area), else its own channel. */
export function roomOfSession(work: { areas: readonly LiveArea[]; projects: LiveWork["projects"] }, s: Session, has: (room: string) => boolean): string | null {
  const project = work.projects.find((p) => p.id === s.project);
  const area = project ? work.areas.find((a) => a.id === project.area) : undefined;
  if (area?.private) return null;
  if (area && has(area.room)) return area.room;
  return s.channel && has(s.channel) ? s.channel : null;
}

const toRun = (s: Session, state: RoomRun["state"]): RoomRun => ({
  id: s.id, state, title: s.ask,
  line: state === "moving" ? s.now ?? s.ask : s.waiting?.what ?? s.ask,
  startedAt: secs(s.startedAt),
  task: s.task ?? null,
});

/** Each room's runs (only rooms that have one), keyed by channel id. */
export function runsByRoom(work: LiveWork, rooms: readonly ShapeRoom[]): Map<string, RoomRuns> {
  const ids = new Set(rooms.map((r) => r.id));
  const out = new Map<string, RoomRuns>();
  // newest first, so the first of each kind a room meets is the one it keeps
  for (const s of [...work.sessions].sort((a, b) => b.startedAt - a.startedAt)) {
    const kind = isLive(s) ? "moving" : waitsOnYou(s) ? "waiting" : null;
    if (!kind) continue;
    const room = roomOfSession(work, s, (r) => ids.has(r));
    if (!room) continue;
    const here = out.get(room) ?? { moving: null, waiting: null };
    if (!here[kind]) here[kind] = toRun(s, kind);
    out.set(room, here);
  }
  return out;
}

export type StoryStep = { /** Seconds; null when the line has no time. */ at: number | null; text: string; now: boolean };
export type Story = { title: string; lead: string | null; steps: StoryStep[]; summary: string | null; open: string[]; made: string[] };

/** The most steps the sheet shows (the newest). */
export const STORY_STEPS = 8;

/** One piece of the body as a person reads it: no bold marks, backticks or (inert) wiki brackets, no task numbers, "you" for the owner. */
function words(text: string): string {
  const t = text.replace(/\*\*|__|`/g, "").replace(/\[ ?\[|\] ?\]/g, "").replace(/\bWaiting on Aaron\b/g, "Waiting on you").replace(/\s+/g, " ").trim();
  return t ? plainWords(t) : "";
}
const items = (block: string) => block.split("\n").map((l) => words(l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ""))).filter((l) => l && !/^(none|n\/?a|nothing)\.?$/i.test(l));

/**
 * What a run's sheet shows, from its note's body as mts writes it ("# Title", then the heart in bold ("**Blocked after 60 min. Waiting on
 * Aaron:** …" or "**Working now:** …"), the summary, "## Open", "## What it made", then "---" and the "Run on [[…]]" line) and, when given,
 * the session (the truth on whether it is still live, and its title) and its steps note's lines. Anything it can't read becomes the lead,
 * as plain text. The body goes through redactRaw first, like every word of a run note.
 */
export function runStory(noteBody: string, session?: Session, feed?: readonly FeedItem[]): Story {
  let body = redactRaw(noteBody ?? "").replace(/\r\n?/g, "\n");
  body = body.replace(/^---\n[\s\S]*?\n---\n/, "");                       // a front matter block, if the body carries one
  const lines = body.split("\n");
  const head = lines.findIndex((l) => /^# /.test(l));
  const heading = head >= 0 ? words(lines[head].slice(2)) : "";
  if (head >= 0) lines.splice(head, 1);
  // the origin footer: a "---" rule and everything after it, when it is tasks.py's "Run on [[…]]" line
  const rule = lines.map((l) => l.trim()).lastIndexOf("---");
  if (rule >= 0 && lines.slice(rule + 1).every((l) => !l.trim() || /^Run on /.test(l.trim()))) lines.splice(rule);
  // sections: the part before any "## " heading, then each heading's
  const parts: { head: string | null; text: string[] }[] = [{ head: null, text: [] }];
  for (const l of lines) { const h = /^##\s+(.*)$/.exec(l); if (h) parts.push({ head: h[1].trim().toLowerCase(), text: [] }); else parts[parts.length - 1].text.push(l); }
  const paras = parts[0].text.join("\n").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  let lead: string | null = null, working: string | null = null;
  const rest: string[] = [];
  for (const [i, p] of paras.entries()) {
    if (i === 0 && /^\*\*/.test(p)) {
      // "Working now: X" is the current step, not a lead (and stale words once the run has stopped)
      if (/^\*\*Working now\b/.test(p)) working = words(p.replace(/^\*\*Working now[:.]?\*\*[:.]?|^\*\*Working now:?/, "")) || "";
      else lead = words(p);
      continue;
    }
    rest.push(words(p));
  }
  let open: string[] = [], made: string[] = [];
  for (const part of parts.slice(1)) {
    const text = part.text.join("\n").trim();
    if (!text) continue;
    if (/^open\b/.test(part.head!)) open = [...open, ...items(text)];
    else if (/^what it made\b|^artifacts?\b|^made\b/.test(part.head!)) made = [...made, ...items(text)];
    else rest.push(words(text));
  }
  let summary: string | null = rest.filter(Boolean).join("\n\n") || null;
  // nothing it knows: the plain text is the lead
  if (lead === null && working === null && !open.length && !made.length && summary) { lead = summary; summary = null; }
  const live = session ? isLive(session) : working !== null;
  const steps: StoryStep[] = (feed ?? []).slice(-STORY_STEPS).map((f) => ({ at: secs(f.at), text: f.text, now: false }));
  if (live) {
    const nowText = session?.now ?? (working || null);
    const last = steps[steps.length - 1];
    if (last && (!nowText || last.text === nowText)) last.now = true;
    else if (nowText) { if (steps.length >= STORY_STEPS) steps.shift(); steps.push({ at: secs(session?.nowAt ?? null), text: nowText, now: true }); }
  }
  return { title: session?.ask || heading || "A run", lead, steps, summary, open, made };
}
