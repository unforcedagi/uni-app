// T-302: Stop, Fresh start, Add a session, Archive and Bring back go through the room, not a control channel of their own. Each is a
// plain message posted in the area's room as you; the room's Uni reads it and does it with mts. One path for authority, no new server.
// The words name the project and the session's one line (never a task number or a run id), and when it started, so two sessions on
// the same project can't be mistaken for each other.
import { invoke } from "@tauri-apps/api/core";
import { findUniMember } from "../uniActions.ts";
import type { Member } from "../mentions.ts";
import type { Project, Session } from "./model.ts";

export type Action =
  | { kind: "stop"; project: Project; session: Session }
  | { kind: "fresh"; project: Project; session: Session }
  | { kind: "add"; project: Project; ask: string }
  | { kind: "archive"; project: Project; live: readonly Session[] }
  | { kind: "restore"; project: Project };

const clock = (t: number, now: number) => {
  const d = new Date(t), today = new Date(now);
  const hm = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase().replace(/\s/g, " ");
  return d.toDateString() === today.toDateString() ? hm : `${d.toLocaleDateString("en-US", { weekday: "short" })} ${hm}`;
};
const quoted = (s: string) => `“${s.replace(/\s+/g, " ").trim()}”`;
const which = (s: Session, now: number) => `the session on ${quoted(s.ask)} (started ${clock(s.startedAt, now)})`;

/** The message an action posts in the area's room, word for word. */
export function actionMessage(a: Action, now = Date.now()): string {
  const p = a.project.name;
  switch (a.kind) {
    case "stop":
      return `Stop ${which(a.session, now)} on ${p}.`;
    case "fresh":
      return `Fresh start on ${p}: end ${which(a.session, now)} and start a new session on the same project, with a short handoff of where it got to.`;
    case "add":
      return `Add a session on ${p}, in ${a.project.folder}, alongside any already running: ${a.ask.replace(/\s+/g, " ").trim()}`;
    case "archive":
      return a.live.length
        ? `Archive the project ${p}. It has ${a.live.length} live session${a.live.length === 1 ? "" : "s"}: stop ${a.live.length === 1 ? "it" : "them"} first. Keep its folder and its history.`
        : `Archive the project ${p}. Keep its folder and its history.`;
    case "restore":
      return `Bring back the project ${p} from the archive.`;
  }
}

/** What the button says before it posts. */
export const actionLabel: Record<Action["kind"], string> = { stop: "Stop", fresh: "Fresh start", add: "Add a session", archive: "Archive", restore: "Bring back" };

/** Posts the action's message in the room as you, addressed to the room's Uni (when it is there). Resolves when the relay took it. */
export async function postAction(room: string, a: Action): Promise<void> {
  // the room's Uni is addressed (as every message to it is); a roster that can't be read stops the post rather than send it to no one
  const roster = await invoke<Member[]>("get_members", { channel: room });
  const uni = findUniMember(roster);
  await invoke("post_message", { channel: room, body: actionMessage(a), replyTo: null, recipients: uni ? [uni.pubkey] : [] });
}
