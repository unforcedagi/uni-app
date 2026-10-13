// T-124 "Simple first" (pure, unit-tested in scripts/steer.test.ts): what the room's quiet companion says. One sentence for where
// the room stands, at most three things that need the user (Now first), the chat composer's placeholder.
import { PRIORITIES, type Task } from "./taskCore.ts";
import type { Where } from "./whereCore.ts";

export const NEEDS_SHOWN = 3;
const LEDE_MAX = 170;

/** The first sentence of the level's lede, as plain text, cut at a word when it runs long. */
export function firstSentence(text: string | null | undefined): string {
  const plain = (text ?? "").replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2").replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
  if (!plain) return "";
  const m = /^.*?[.!?](?=\s|$)/.exec(plain);
  const one = m ? m[0] : plain;
  if (one.length <= LEDE_MAX) return one;
  const cut = one.slice(0, LEDE_MAX).replace(/\s+\S*$/, "");
  return `${cut}…`;
}

/**
 * What needs the user, at most `max`: the open decisions on this very node first (they carry option buttons), then everything else by
 * priority (Now, Soon, Someday). No count of the rest: "Everything here" is the way to the rest.
 */
export function topNeeds(w: Where, path: string, max = NEEDS_SHOWN): Task[] {
  const all = PRIORITIES.flatMap((p) => w.needs[p].rows);
  const own = all.filter((t) => t.kind === "decision" && t.node === path);
  return [...own, ...all.filter((t) => !own.includes(t))].slice(0, max);
}

/** How long ago, quietly: "today", "yesterday", "3 days ago", "2 weeks ago", else the month and day. Empty for a missing or future time. */
export function quietAgo(iso: string | null | undefined, nowMs: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t) || t > nowMs + 60_000) return "";
  const days = Math.floor((nowMs - t) / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

type Recent = Pick<Task, "title" | "state" | "kind" | "updatedAt" | "options">;
const plainTitle = (t: string) => t.replace(/^T-\d+\s+/, "");

/**
 * Where the room stands, in one sentence and never a count. The node's own `stands` (with `stands_at` as a quiet time); without it the
 * newest decision, else the newest task change, in plain words; else nothing.
 */
export function standsLine(stands: { text: string; at: string | null } | null | undefined, tasks: readonly Recent[], nowMs: number): { text: string; ago: string } | null {
  const text = firstSentence(stands?.text);
  if (text) return { text, ago: quietAgo(stands?.at, nowMs) };
  const stamped = tasks.filter((t) => t.updatedAt && !Number.isNaN(Date.parse(t.updatedAt))).sort((a, b) => Date.parse(b.updatedAt!) - Date.parse(a.updatedAt!));
  const pick = stamped.find((t) => t.kind === "decision") ?? stamped[0];
  if (!pick) return null;
  const what = plainTitle(pick.title);
  const line = pick.kind === "decision" ? `Waiting on a decision: ${what}.` : pick.state === "doing" ? `${what} is underway.` : pick.state === "waiting" ? `${what} is waiting.` : `Latest: ${what}.`;
  return { text: line, ago: quietAgo(pick.updatedAt, nowMs) };
}

/** `Message #atlas/build`; a node held by a room says whose (`Message #atlas`); no room, the node's name. */
export function chatPlaceholder(a: { name: string; slash: string | null; heldBy: string | null }): string {
  if (a.slash) return `Message #${a.slash}`;
  if (a.heldBy) return `Message #${a.heldBy.replace(/^#/, "")}`;
  return `Message ${a.name}`;
}
