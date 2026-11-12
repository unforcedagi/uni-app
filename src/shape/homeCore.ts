// T-335 the shape: home's pure logic (unit-tested in scripts/home.test.ts). One row per room, newest first, each with its asks (T-335 one
// ask: the one list's cards, approvals among them); the clock words; the count on the bar; a room's last line and its glyph. No React, no Tauri.
import { markdownToText } from "../markdown.ts";
import { sealedFence, sealedProse } from "../sealedCardCore.ts";
import { withoutAskBlocks, type Card } from "./oneAsk.ts";
import type { HomeRow, RoomRuns, ShapeRoom } from "./types.ts";

const NO_RUNS: RoomRuns = { moving: null, waiting: null };

/**
 * One row per room (`hidden` ones left out), newest first by `at`: the room's last message, its newest ask, or the start of a run
 * that waits on you, whichever is latest (an ask lifts a quiet room). A room where nothing was ever said sorts last, by name. Stable.
 */
export function homeRows(rooms: readonly ShapeRoom[], runs: ReadonlyMap<string, RoomRuns>, asks: ReadonlyMap<string, Card[]>, opts: { hidden?: ReadonlySet<string> } = {}): HomeRow[] {
  const rows = rooms.filter((r) => !opts.hidden?.has(r.id)).map((room): HomeRow => {
    const rr = runs.get(room.id) ?? NO_RUNS;
    const all = asks.get(room.id) ?? [];
    let at = room.last_ts ?? 0;
    for (const a of all) at = Math.max(at, a.at);
    if (rr.waiting?.startedAt) at = Math.max(at, rr.waiting.startedAt);
    // a private room's asks stay inside it: its row only knows how many (a wordless mark), never what they say
    const as = all.filter((a) => !a.private), hushed = all.length - as.length;
    return { room, at, runs: rr, asks: as, ...(hushed ? { hushed } : {}), unread: room.unread ?? 0, mention: !!room.mentions };
  });
  return rows.sort((a, b) => (a.at > 0 || b.at > 0 ? b.at - a.at : a.room.name.localeCompare(b.room.name)));
}

/**
 * The bar's count: what wants you, by the one list's rule (T-335 one ask): every card on a room's row, a private room's wordless ones too.
 * The same cards home draws, so the count and the rows can't disagree. (A run that waits is not an ask: its room asks if it needs you.)
 */
export function wantsCount(rows: readonly HomeRow[]): number {
  let n = 0;
  for (const r of rows) n += r.asks.length + (r.hushed ?? 0);
  return n;
}

const DAY_FMT = new Intl.DateTimeFormat("en", { weekday: "short" });
const DATE_FMT = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
/** "now", "3m", "2h", "Yesterday", "Tue", then "Nov 3" from a week on (seconds). */
export function ago(ts: number, now: number): string {
  const m = Math.floor((now - ts) / 60);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  if (h < 48) return "Yesterday";
  if (h < 24 * 7) return DAY_FMT.format(new Date(ts * 1000));
  return DATE_FMT.format(new Date(ts * 1000));
}

/** A row's last line is cut here (the row ellipsises it anyway; this keeps a long message out of the DOM). */
const LAST_MAX = 160;
/** "**Mira Okafor:** text" (a relayed message names its writer first, in bold). */
const LEAD_NAME = /^\*\*([^*\n]{1,40}?):\*\*\s*|^\*\*([^*\n]{1,40}?)\*\*:\s*/;

/**
 * The row's last line from `last_message`, as one plain line, and who wrote it when known: the room's `last_author` if the host
 * gives one, else a bold name the message opens with. An approval card says so instead of its fenced block.
 */
export function lastLine(room: Pick<ShapeRoom, "last_message"> & { last_author?: string | null }): { who: string | null; text: string } {
  let body = room.last_message ?? "";
  let who = room.last_author?.trim() || null;
  if (sealedFence(body)) body = sealedProse(body) || "Uni asks for your OK on a card";
  // an ask, an answer or a close says its words, never its data block (T-335 one ask)
  body = withoutAskBlocks(body);
  const lead = LEAD_NAME.exec(body);
  if (lead) { who ??= (lead[1] ?? lead[2]).trim(); body = body.slice(lead[0].length); }
  let text = markdownToText(body);
  if ([...text].length > LAST_MAX) text = [...text].slice(0, LAST_MAX - 1).join("") + "…";
  return { who, text };
}

// no ◆: that shape is the "wants you" mark
const GLYPHS = ["◇", "❦", "▢", "△", "✎", "⌂"];
/** U+FE0E: draw the symbol as text, never as a colour emoji. */
const TEXT = "︎";
/** A room's glyph: Uni's ring for Uni's room, else one of a few shapes picked by a stable hash of the name. */
export function roomGlyph(name: string): string {
  const n = name.trim().replace(/^#/, "");
  if (n.toLowerCase() === "uni") return "◎" + TEXT;
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < n.length; i++) h = Math.imul(h ^ n.charCodeAt(i), 0x01000193) >>> 0;
  return GLYPHS[h % GLYPHS.length] + TEXT;
}
