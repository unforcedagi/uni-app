// T-335 one home: the one rooms registry, as the app reads it (pure, unit-tested in scripts/shape.test.ts). The registry is kept by
// uni-tasks (rooms.json) and published to the vault note `System/Rooms` (its metadata `registry`): the live rooms (channel id, area, whether
// private, old names), retired room names (where their work went, or `none`: the name means no room, so an item naming it belongs to its
// node's room) and archived channel ids. The app keeps no room list, private-room list or channel id of its own; this module only reads that
// note's shape. With no registry read yet, every answer is "don't know" (null / false), and the callers keep their tree-based rules.

export type RegistryRoom = { id?: string; area?: string; private?: boolean; own?: boolean; was?: string[] };
export type RetiredRoom = { none?: boolean; into?: string | null; private?: boolean; was?: string[] };
export type RoomsRegistry = { home: string | null; rooms: Record<string, RegistryRoom>; retired: Record<string, RetiredRoom>; foldedIds: Record<string, string | null> };

/** The vault note that holds it (written by uni-tasks `rooms.py publish`, every 5 minutes when rooms.json changed). */
export const REGISTRY_NOTE = "System/Rooms";

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null);
const words = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim().toLowerCase()) : []);

/** The registry from the note's metadata (`{registry: {...}}`, or the registry itself); null when it isn't one. */
export function parseRegistry(meta: unknown): RoomsRegistry | null {
  const m = obj(meta);
  const r = obj(m?.registry) ?? m;
  const rooms = obj(r?.rooms);
  if (!r || !rooms) return null;
  const out: RoomsRegistry = { home: typeof r.home === "string" ? r.home : null, rooms: {}, retired: {}, foldedIds: {} };
  for (const [name, v] of Object.entries(rooms)) {
    const x = obj(v) ?? {};
    out.rooms[name.toLowerCase()] = { id: typeof x.id === "string" ? x.id : undefined, area: typeof x.area === "string" ? x.area : undefined, private: x.private === true, own: x.own === true, was: words(x.was) };
  }
  for (const [name, v] of Object.entries(obj(r.retired) ?? {})) {
    const x = obj(v) ?? {};
    out.retired[name.toLowerCase()] = { none: x.none === true, into: typeof x.into === "string" ? x.into.toLowerCase() : null, private: x.private === true, was: words(x.was) };
  }
  for (const [id, into] of Object.entries(obj(r.folded_ids) ?? {})) out.foldedIds[id.toLowerCase()] = typeof into === "string" ? into.toLowerCase() : null;
  return out;
}

/** A room as written anywhere (`#Dev`, `room:dev`, `atlas/build`) -> its bare lowercase name. */
export const roomKey = (x: string | null | undefined): string => {
  let r = (x ?? "").trim().replace(/^#/, "").toLowerCase();
  if (r.startsWith("room:")) r = r.slice(5);
  return r.split("/")[0].trim();
};

function aliasOf(reg: RoomsRegistry, key: string): string {
  for (const [name, r] of Object.entries(reg.rooms)) if (r.was?.includes(key)) return name;
  for (const [name, r] of Object.entries(reg.retired)) if (r.was?.includes(key)) return name;
  return key;
}

/** The room a name (or channel id) means now: an old name gives the room it became; "" for no room (a name the registry marks `none`, such
 *  as the old main room, or an archived channel whose work went nowhere). The same rule as uni-tasks rooms.canon. */
export function canonRoom(reg: RoomsRegistry, x: string | null | undefined): string {
  const k = roomKey(x);
  if (!k) return "";
  if (k in reg.foldedIds) return reg.foldedIds[k] ?? "";
  const byId = Object.entries(reg.rooms).find(([, r]) => r.id?.toLowerCase() === k)?.[0];
  if (byId) return byId;
  const a = aliasOf(reg, k);
  return reg.retired[a]?.none ? "" : a;
}

/** Whether a room is private: by its own name, an old name of a private room, or the room an old name now means. */
export function isPrivateRoomName(reg: RoomsRegistry, x: string | null | undefined): boolean {
  const k = roomKey(x);
  if (!k) return false;
  const priv = (n: string) => !!(reg.rooms[n]?.private || reg.retired[n]?.private);
  return priv(k) || priv(aliasOf(reg, k)) || priv(canonRoom(reg, k));
}

/** A retired room's live successor by name (its old name, or where its work went), when the registry says; null otherwise. */
export function successorOf(reg: RoomsRegistry, x: string | null | undefined): string | null {
  const c = canonRoom(reg, x);
  if (!c) return null;
  if (reg.rooms[c]) return c;
  const into = reg.retired[c]?.into;
  return into && reg.rooms[into] ? into : null;
}
