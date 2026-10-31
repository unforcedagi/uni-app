// T-335: a re-read of the store (a live event, a sync tick) answers with new objects for every row, changed or not, and the whole room redrew
// from them: every message's markdown parsed again, each time. On a slow phone, with Uni busy in the room, that kept the screen busy long
// enough that typed keys waited seconds to show. `keepSame` hands back the rows that didn't change as the very objects already drawn (and the
// list already drawn when nothing changed), so the memoized message parts skip them and a re-read redraws only what is new.

const seen = new WeakMap<object, string>();
const text = (row: object): string => {
  let t = seen.get(row);
  if (t === undefined) { t = JSON.stringify(row); seen.set(row, t); }
  return t;
};

/** `next`, with each row equal (same JSON) to the previous row of the same key replaced by that previous row; `prev` itself if nothing changed. */
export function keepSame<T extends object>(prev: readonly T[], next: readonly T[], key: (row: T) => string): T[] {
  if (prev === next) return prev as T[];
  const before = new Map<string, T>();
  for (const row of prev) before.set(key(row), row);
  let same = prev.length === next.length;
  const out = next.map((row, i) => {
    const old = before.get(key(row));
    if (old !== undefined && text(old) === text(row)) { if (prev[i] !== old) same = false; return old; }
    same = false;
    return row;
  });
  return same ? prev as T[] : out;
}
