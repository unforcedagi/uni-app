// Pure decisions for an area's room (unit-tested): which messages are new to its app, and which room it shows. (r14: the app's own chat
// layouts, side by side and as a sheet, are gone; an area's app is a view inside the room shell.)

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

/** The room an area shows: the user's pick when the area still has it, else the first; null for an area with no room. */
export function pickRoom(channels: readonly string[], selected: string | null | undefined): string | null {
  return selected && channels.includes(selected) ? selected : channels[0] ?? null;
}
