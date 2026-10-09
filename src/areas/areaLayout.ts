// Pure decisions for the area view's chat pane (unit-tested): where it goes,
// how wide it is, which messages are new, how many are unread.

import type { ChatLayout } from "../interface/manifest.ts";

export type ChatMode = ChatLayout;
/** Desktop starts here (CSS px). */
export const DESKTOP_MIN = 900;
export const DEFAULT_CHAT_WIDTH = 380;
export const MIN_CHAT_WIDTH = 300;
/** Never take more than this share of the area view. */
const MAX_SHARE = 0.6;
/** The interface keeps at least this much, so a narrow container shrinks the chat first. */
const MIN_INTERFACE = 240;
export const CHAT_WIDTH_KEY = "uni.area.chatWidth.v1";

/** The manifest hint wins, but side by side needs a desktop: on a phone `side` is the sheet. */
export function chatMode(hint: unknown, desktop: boolean): ChatMode {
  if (hint === "hidden" || hint === "sheet") return hint;
  return desktop ? "side" : "sheet";
}

export function clampChatWidth(width: unknown, container: number): number {
  const w = typeof width === "number" && Number.isFinite(width) ? width : DEFAULT_CHAT_WIDTH;
  const max = Math.max(0, Math.min(container * MAX_SHARE, container - MIN_INTERFACE));
  const min = Math.min(MIN_CHAT_WIDTH, max);
  return Math.round(Math.min(Math.max(w, min), max));
}

export function parseStoredWidth(raw: string | null): number | undefined {
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Which messages are new since the last look. The first list only sets the
 * baseline (the room as it was when the area opened); after that every ref
 * not seen before comes out once, oldest first. Older pages that load later
 * (refs from before the baseline) are recorded but never come out.
 */
export function createSeen() {
  let seen: Set<string> | null = null;
  let first: string | null = null;
  return {
    fresh<T extends { ref: string; ts: number }>(list: readonly T[]): T[] {
      if (seen === null) { seen = new Set(list.map((m) => m.ref)); first = list[0]?.ref ?? null; return []; }
      // Position, not time: timestamps are the sender's. Anything listed before the first message we recorded is an older page loaded later.
      const from = first === null ? 0 : Math.max(0, list.findIndex((m) => m.ref === first));
      const unseen = list.filter((m, i) => i >= from && !seen!.has(m.ref));
      for (const m of list) seen.add(m.ref);
      return unseen.sort((a, b) => a.ts - b.ts);
    },
    reset() { seen = null; first = null; },
  };
}

/** Other people's messages after `marker` (everything when the marker is missing or gone). */
export function unreadAfter(list: readonly { ref: string; author: string }[], marker: string | null, me: string | null): number {
  const at = marker === null ? -1 : list.findIndex((m) => m.ref === marker);
  return list.slice(at + 1).filter((m) => m.author !== me).length;
}

/** The room an area shows: the user's pick when the area still has it, else the first; null for an area with no room. */
export function pickRoom(channels: readonly string[], selected: string | null | undefined): string | null {
  return selected && channels.includes(selected) ? selected : channels[0] ?? null;
}
