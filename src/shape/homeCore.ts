// T-335 the shape: home's pure logic (unit-tested in scripts/home.test.ts). One row per room, newest first; the approvals about to
// expire, pinned over the rooms; the clock words; the count on the bar; a room's last line and its glyph. No React, no Tauri.
import { commandLine, type Approval } from "../approvals.ts";
import { markdownToText } from "../markdown.ts";
import { jobFingerprint, sealedFence, sealedProse, waitingTitle } from "../sealedCardCore.ts";
import type { Ask, HomeRow, Pin, RoomRuns, ShapeRoom } from "./types.ts";

const NO_RUNS: RoomRuns = { moving: null, waiting: null };

/**
 * One row per room (`hidden` ones left out), newest first by `at`: the room's last message, its newest ask, or the start of a run
 * that waits on you, whichever is latest (an ask lifts a quiet room). A room where nothing was ever said sorts last, by name. Stable.
 */
export function homeRows(rooms: readonly ShapeRoom[], runs: ReadonlyMap<string, RoomRuns>, asks: ReadonlyMap<string, Ask[]>, opts: { hidden?: ReadonlySet<string> } = {}): HomeRow[] {
  const rows = rooms.filter((r) => !opts.hidden?.has(r.id)).map((room): HomeRow => {
    const rr = runs.get(room.id) ?? NO_RUNS;
    const all = asks.get(room.id) ?? [];
    let at = room.last_ts ?? 0;
    for (const a of all) at = Math.max(at, a.updatedAt);
    if (rr.waiting?.startedAt) at = Math.max(at, rr.waiting.startedAt);
    // a private room's asks stay inside it: its row only knows how many (a wordless mark), never what they say
    const as = all.filter((a) => !a.private), hushed = all.length - as.length;
    return { room, at, runs: rr, asks: as, ...(hushed ? { hushed } : {}), unread: room.unread ?? 0, mention: !!room.mentions };
  });
  return rows.sort((a, b) => (a.at > 0 || b.at > 0 ? b.at - a.at : a.room.name.localeCompare(b.room.name)));
}

/** Approvals this close to their end are pinned over the rooms (seconds). */
export const PIN_WINDOW_S = 15 * 60;

/** What a pinned approval says: Uni's card by its reach or title and its class; a Hermes prompt by its command and why it was flagged. */
function pinWords(a: Approval): { what: string; detail: string | null } {
  if (a.kind === "sealed" && a.sealed) {
    const w = a.sealed;
    const what = waitingTitle(w);
    if (w.kind === "morning") return { what, detail: "Answer on the card" };
    return { what, detail: `${w.class === "powerful" ? "Powerful: hold to approve" : "Routine"} · job ${jobFingerprint(w.fingerprint)}` };
  }
  const cmd = commandLine(a);
  if (a.kind === "sealed") return { what: cmd, detail: null };
  const why = a.why?.trim() || null;
  return a.kind === "smart-deny"
    ? { what: `Override: OK to run ${cmd}?`, detail: why }
    : { what: `OK to run ${cmd}?`, detail: why };
}

/** The approvals that end within the window from `now` (and haven't ended), soonest first. `roomName` null: "a room". */
export function pinsFrom(approvals: readonly Approval[], roomName: (id: string) => string | null, now: number): Pin[] {
  return approvals
    .filter((a) => a.deadline !== null && a.deadline > now && a.deadline - now <= PIN_WINDOW_S)
    .sort((a, b) => a.deadline! - b.deadline!)
    .map((a) => ({ ref: a.ref, room: a.channel, roomName: roomName(a.channel)?.replace(/^#/, "") || "a room", ...pinWords(a), expires: a.deadline!, sealed: a.kind === "sealed" }));
}

/** "expires in 8:59", "expires in 0:05", or "expired" (seconds). */
export function countdown(expires: number, now: number): string {
  const s = Math.ceil(expires - now);
  if (s <= 0) return "expired";
  return `expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * The bar's count: what wants you. Each ask (a private room's too), each pinned approval, and a run that waits on you in a row with no asks (where there
 * are asks the row shows them instead of the run, so the run is one of them and isn't counted twice).
 */
export function wantsCount(rows: readonly HomeRow[], pins: readonly Pin[]): number {
  let n = pins.length;
  // (a private room's asks want you too: counted, though home shows none of their words)
  for (const r of rows) n += (r.asks.length + (r.hushed ?? 0)) || (r.runs.waiting ? 1 : 0);
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
