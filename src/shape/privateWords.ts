// T-335 the shape: one conservative judge of "does this word point at a private place?", for everything that places a vault note
// in a room (asks, open decisions). A room or a node can be written many ways (`#Seed-Log`, `seed log`, a channel id, an old name,
// `[[Projects/Seed Log|alias]]`, `projects/seed log`), and its work can have moved (a retired room's successor, a folded channel, a
// chain of them). Each caller used to match some spellings and follow some moves; a spelling it missed fell through to Uni's room
// with the note's words. Here every spelling is reduced to the same loose key, every move is followed to its end, and a word that
// could be a private place's IS private: it errs towards private. Pure: no React, no Tauri.
import type { Tree } from "../areas/treeCore.ts";
import type { RoomsRegistry } from "../areas/roomsRegistry.ts";
import { isPrivateName, isPrivatePath, isPrivateRoom, type RoomRef } from "./privacy.ts";

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
/** Letters and digits only: `Seed-Log`, `seed log`, `#seed_log` are one key. */
const squash = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, "");
/** A room as written anywhere (`#Dev`, `room:dev`, `atlas/build`): what is left to match on. */
const roomText = (x: string) => { let r = x.trim().replace(/^#/, "").trim(); if (/^room:/i.test(r)) r = r.slice(5).trim(); return r; };
/** A note reference as written anywhere: `[[Projects/X|alias]]`, `Projects/X.md`, `/projects/x#part`. */
const refText = (x: string) => x.trim().replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0].split("#")[0].trim().replace(/\.md$/i, "").replace(/^\/+|\/+$/g, "");
const segments = (x: string) => x.split("/").map((p) => p.trim()).filter(Boolean);

export type PrivateWords = {
  /** A room clue (a name however spelled, an old name, a channel id) is private: by its own words, the registry, the tree, the
   *  rooms known private, or because its work moved (through any number of steps) to a private room. */
  room(clue: unknown): boolean;
  /** A node or card reference is private: a private word in its path, or it names (by path, by its last part, or by id) a node inside
   *  a private place. */
  ref(clue: unknown): boolean;
};

/**
 * `rooms`: every room this device has (hidden ones too). `known`: channel ids or names already judged private (the caller's own set).
 * A null `tree` or `reg` simply adds nothing: the caller decides what may be drawn before they are read.
 */
export function privateWords(o: { tree: Tree | null; reg: RoomsRegistry | null; rooms: readonly RoomRef[]; uni: RoomRef | null; known?: Iterable<string> }): PrivateWords {
  const { tree, reg, rooms, uni } = o;
  /** Loose keys of private room names, and lowercase private channel ids. */
  const names = new Set<string>(), ids = new Set<string>();
  const addName = (x: unknown) => { const t = text(x); if (!t) return false; const k = squash(roomText(t)); if (!k || names.has(k)) return false; names.add(k); return true; };
  const addId = (x: unknown) => { const t = text(x); if (!t) return false; const k = t.toLowerCase(); if (ids.has(k)) return false; ids.add(k); return true; };
  const wordPrivate = (x: string) => segments(roomText(x)).some((w) => isPrivateName(w));
  const has = (x: unknown): boolean => { const t = text(x); return !!t && (wordPrivate(t) || names.has(squash(roomText(t))) || ids.has(roomText(t).toLowerCase())); };

  for (const k of o.known ?? []) { addName(k); addId(k); }
  // the nodes inside a private place: their names, the rooms they name, the channels they own
  const nodeIds = new Set<string>(), nodePaths = new Set<string>(), nodeLeaves = new Set<string>();
  if (tree) for (const n of [...tree.nodes.values(), ...tree.archived]) {
    if (!isPrivatePath(tree, n.path) && !segments(n.path).some((w) => isPrivateName(w))) continue;
    if (n.id) nodeIds.add(n.id.toLowerCase());
    nodePaths.add(segments(n.path).map(squash).join("/"));
    const leaf = squash(segments(n.path).pop() ?? "");
    if (leaf) nodeLeaves.add(leaf);
    if (n.name) nodeLeaves.add(squash(n.name));
    addName(n.name);
    if (typeof n.metadata.room === "string") addName(n.metadata.room);
    for (const c of [...n.rooms, ...n.channels]) { addId(c); addName(c); }
  }
  // the rooms this device has: private by their words, or because a private place owns them
  for (const r of rooms) if (wordPrivate(r.name) || has(r.id) || has(r.name) || (!!tree && isPrivateRoom(tree, r.id, rooms, uni))) { addId(r.id); addName(r.name); }
  if (reg) {
    for (const [name, r] of Object.entries(reg.rooms)) if (r.private) { addName(name); addId(r.id); for (const w of r.was ?? []) addName(w); }
    for (const [name, r] of Object.entries(reg.retired)) if (r.private) { addName(name); for (const w of r.was ?? []) addName(w); }
    // to a fixpoint: a name and its channel id and its old names are one room; a room whose work moved to a private room is private
    for (let changed = true, guard = 0; changed && guard < 50; guard++) {
      changed = false;
      for (const [name, r] of Object.entries(reg.rooms)) {
        const all = [name, ...(r.was ?? [])];
        if (all.some(has) || has(r.id)) { for (const x of all) changed = addName(x) || changed; changed = addId(r.id) || changed; }
      }
      for (const [name, r] of Object.entries(reg.retired)) {
        const all = [name, ...(r.was ?? [])];
        if (all.some(has) || has(r.into)) for (const x of all) changed = addName(x) || changed;
      }
      for (const [id, into] of Object.entries(reg.foldedIds)) if (has(into) && addId(id)) changed = true;
      // a device room whose id or name just turned private: both forms
      for (const r of rooms) if (has(r.id) || has(r.name)) { changed = addId(r.id) || changed; changed = addName(r.name) || changed; }
    }
  }
  return {
    room: has,
    ref(clue) {
      const t = text(clue);
      if (!t) return false;
      const r = refText(t);
      if (!r) return false;
      const parts = segments(r);
      if (parts.some((w) => isPrivateName(w))) return true;
      if (nodeIds.has(r.toLowerCase())) return true;
      const path = parts.map(squash).join("/"), leaf = squash(parts[parts.length - 1] ?? "");
      return nodePaths.has(path) || (!!leaf && nodeLeaves.has(leaf));
    },
  };
}
