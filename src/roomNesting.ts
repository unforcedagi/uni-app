// The conversation list, nested (T-111): a Buzz room named `parent/child` sits indented under `#parent`. Pure, unit-tested in scripts/treehome.test.ts.
export type Nested<T> = { room: T; /** What the row shows: `build` under `atlas`, the full name otherwise. */ label: string; child: boolean };

const key = (name: string) => name.toLowerCase().replace(/^#/, "").trim();

/** Rooms in their given order, each parent followed by its children. A child whose parent is not in the list stays at the top level with its full name. */
export function nestRooms<T extends { name: string }>(rooms: readonly T[]): Nested<T>[] {
  const parents = new Map<string, T>();
  for (const r of rooms) if (!key(r.name).includes("/") && !parents.has(key(r.name))) parents.set(key(r.name), r);
  const parentOf = (r: T): T | null => { const k = key(r.name), i = k.lastIndexOf("/"); return i > 0 ? parents.get(k.slice(0, i)) ?? null : null; };
  const kids = new Map<T, T[]>();
  for (const r of rooms) { const p = parentOf(r); if (p) kids.set(p, [...(kids.get(p) ?? []), r]); }
  const out: Nested<T>[] = [];
  for (const r of rooms) {
    if (parentOf(r)) continue;
    out.push({ room: r, label: r.name, child: false });
    for (const c of kids.get(r) ?? []) out.push({ room: c, label: c.name.slice(c.name.lastIndexOf("/") + 1), child: true });
  }
  return out;
}
