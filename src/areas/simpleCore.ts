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

/** What needs the user, Now first, and how many more there are than shown. */
export function topNeeds(w: Where, max = NEEDS_SHOWN): { rows: Task[]; more: number } {
  const all = PRIORITIES.flatMap((p) => w.needs[p].rows);
  return { rows: all.slice(0, max), more: Math.max(0, w.you - Math.min(max, all.length)) };
}

/** `Message #atlas/build`; a node held by a room says whose (`Message #atlas`); no room, the node's name. */
export function chatPlaceholder(a: { name: string; slash: string | null; heldBy: string | null }): string {
  if (a.slash) return `Message #${a.slash}`;
  if (a.heldBy) return `Message #${a.heldBy.replace(/^#/, "")}`;
  return `Message ${a.name}`;
}
