// T-124 r17: one answer mechanism. A chat message never carries answer buttons; where it names a decision that exists as a vault note (a room's
// `[decision T-NN]` marker, or the decision's own id), the chat shows one quiet "Answer in Needs you ›" that opens that decision's sheet.
// The room shell publishes the open decisions it knows and how to open one; the chat reads them. Pure lookup (`decisionIn`) is unit-tested.
import { useSyncExternalStore } from "react";
import { splitMarkers } from "./chatMarkers.ts";

/** An open decision as the chat can name it: its note id, its title's id ("T-12"), and the task it decides (`task: T-130`). */
export type KnownDecision = { id: string; tid: string | null; forTask: string | null };

/**
 * The open decision a message names, or null: a `[decision T-NN]` marker that matches a decision's title id or the task it decides, else the
 * decision's own note id written in the message (bare, `uni:<id>`, or a surface link ending in it). Anything else names no decision here.
 */
export function decisionIn(body: string, known: readonly KnownDecision[]): string | null {
  if (!known.length || !body) return null;
  for (const m of splitMarkers(body).markers) {
    if (m.state !== "decision") continue;
    const hit = known.find((d) => d.tid === m.task || d.forTask === m.task);
    if (hit) return hit.id;
  }
  for (const m of body.matchAll(/\b([0-9A-HJKMNP-TV-Z]{26})\b/g)) {
    const hit = known.find((d) => d.id === m[1]);
    if (hit) return hit.id;
  }
  return null;
}

let known: readonly KnownDecision[] = [];
let opener: ((id: string) => void) | null = null;
let version = 0;
const listeners = new Set<() => void>();
const bump = () => { version++; for (const f of listeners) f(); };

/** The room shell's open decisions (it holds the task list). Unchanged lists don't wake the chat. */
export function publishDecisions(list: readonly KnownDecision[]): void {
  const key = (l: readonly KnownDecision[]) => l.map((d) => `${d.id}|${d.tid}|${d.forTask}`).join("\n");
  if (key(list) === key(known)) return;
  known = list; bump();
}
/** How a decision's sheet is opened (the room shell on screen); null when it goes. */
export function setDecisionOpener(fn: ((id: string) => void) | null): void { opener = fn; bump(); }
export const openDecision = (id: string): void => { opener?.(id); };

const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
/** The chat's view: the decisions it may link to (none while no shell can open them), and a version for its memo. */
export function useDecisionLinks(): { known: readonly KnownDecision[]; version: number } {
  const v = useSyncExternalStore(subscribe, () => version, () => version);
  return { known: opener ? known : [], version: v };
}
