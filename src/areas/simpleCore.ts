// T-124 "Simple first" (pure, unit-tested in scripts/steer.test.ts): what the room's quiet companion says. One sentence for where
// the room stands, at most three things that need the user (Now first), the chat composer's placeholder.
import { PRIORITIES, type Task } from "./taskCore.ts";
import type { Where } from "./whereCore.ts";

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
 * The needs-you feed (T-124 r7): only what the user must do. Their tasks (owner, or waiting on them) that are live and not snoozed (the
 * caller's `Where` has already dropped those, and anything done or archived), at priority Now or Soon (unsorted counts as Soon), plus open
 * decisions; Someday is not here. Now before Soon, then by due date (undated last), then a decision before a task, then by title.
 */
export function topNeeds(w: Where, _path?: string, max = Infinity, today = localDay()): Task[] {
  const rank = (t: Task) => (isOverdue(t.due, today) ? -1 : t.priority === "now" ? 0 : t.priority === "someday" ? 2 : 1);
  const all = PRIORITIES.flatMap((p) => w.needs[p].rows).filter((t) => t.kind === "decision" || t.priority !== "someday");
  return all.sort((a, b) => rank(a) - rank(b) || (a.due ?? "9999").localeCompare(b.due ?? "9999") || Number(b.kind === "decision") - Number(a.kind === "decision") || a.title.localeCompare(b.title)).slice(0, max);
}

/** Today as YYYY-MM-DD, local. */
export const localDay = (d = new Date()): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** A due date (YYYY-MM-DD) before today. */
export const isOverdue = (due: string | null | undefined, today = localDay()): boolean => !!due && due < today;
/** "due Oct 14", or "was due Oct 12" once it has passed. Null without a date. */
export function dueLine(due: string | null | undefined, today = localDay()): string | null {
  if (!due) return null;
  const d = new Date(`${due}T12:00:00`);
  if (Number.isNaN(d.getTime())) return due;
  return `${isOverdue(due, today) ? "was due" : "due"} ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

/** A title says what to do when it has words beyond its id; "T-12" or one bare word does not. */
export function actionableTitle(rest: string): boolean {
  return rest.trim().split(/\s+/).filter(Boolean).length >= 2;
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

/** A title that was cut short on the way into the vault ("…", "..."), so the real question is in the note's content. */
export const isCutTitle = (rest: string): boolean => /(…|\.\.\.)\s*$/.test(rest.trim());

const ASK_MAX = 280;
/**
 * The full question of a decision (or task) whose title is cut: the first real line of its content, without `_Converted from …_` lines or
 * the "Decision (default yes):" label, kept to whole sentences (the first one or two) and at most 280 characters. "" when there is nothing.
 */
export function askFromContent(content: string | null | undefined): string {
  const line = (content ?? "").split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/^_?converted from\b/i.test(l.replace(/^[*_>\s]+/, "")) && !/^#{1,6}\s/.test(l) && !/^---+$/.test(l));
  if (!line) return "";
  const plain = line.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`>]/g, "").replace(/^decision\s*(\([^)]*\))?\s*[:\-–—]\s*/i, "").replace(/\s+/g, " ").trim();
  if (plain.length <= ASK_MAX) return plain;
  const sentences = plain.match(/[^.!?]+[.!?]+(?=\s|$)/g) ?? [];
  let out = "";
  for (const sen of sentences) { if ((out + sen).length > ASK_MAX) break; out = `${out}${sen}`.replace(/\s*$/, " "); }
  if (out.trim()) return out.trim();
  return `${plain.slice(0, ASK_MAX).replace(/\s+\S*$/, "")}…`;
}
