// T-335 the shape: one conservative judge of "does this word point at a private place?", for everything that places a vault note
// in a room (asks, open decisions). A room or a node can be written many ways (`#Seed-Log`, `seed log`, a channel id, an old name,
// `[[Projects/Seed Log|alias]]`, `projects/seed log`), and its work can have moved (a retired room's successor, a folded channel, a
// chain of them). Each caller used to match some spellings and follow some moves; a spelling it missed fell through to Uni's room
// with the note's words. Here every spelling is reduced to the same loose key, every move is followed to its end, and a word that
// could be a private place's IS private: it errs towards private. Pure: no React, no Tauri.
import type { Tree } from "../areas/treeCore.ts";
import type { RoomsRegistry } from "../areas/roomsRegistry.ts";
import { isPrivateName, isPrivatePath, isPrivateRoom, type RoomRef } from "./privacy.ts";

/** Every string a field's value holds, whatever its shape: a string, a list (of anything), an object's values, a number. */
export function strings(v: unknown, depth = 0): string[] {
  if (typeof v === "string") return v.trim() ? [v] : [];
  if (typeof v === "number" && Number.isFinite(v)) return [String(v)];
  if (depth > 3 || !v || typeof v !== "object") return [];
  return (Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)).flatMap((x) => strings(x, depth + 1));
}
/** One written word made plain: composed one way (NFKC: full-width letters, accents typed either way), `\\` as `/`, `%20` read. */
const plain = (x: string) => { let t = x.normalize("NFKC").replace(/\\/g, "/"); if (/%[0-9a-f]{2}/i.test(t)) { try { t = decodeURIComponent(t); } catch { /* as written */ } } return t; };
/** The letters and digits of any script, lowercase: `Seed-Log`, `seed log`, `#seed_log` are one key. */
const squash = (x: string) => plain(x).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
/** A room or a note as written anywhere (`#Dev`, `room:dev`, `[[Projects/X|alias]]`, `Projects/X.md`, `/projects/x#part`): what is left to match on. */
const bare = (x: string) => {
  let r = plain(x).trim().replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0].trim().replace(/^#+/, "").split("#")[0].trim();
  if (/^room:/i.test(r)) r = r.slice(5).trim();
  return r.replace(/\.md$/i, "").replace(/^\/+|\/+$/g, "");
};
const segments = (x: string) => x.split("/").map((p) => p.trim()).filter(Boolean);
/** Each thing a value names: every string in it, and every part of a `a, b` list. */
const parts = (v: unknown): string[] => strings(v).flatMap((t) => t.split(",")).map(bare).filter(Boolean);

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
  const addName = (x: unknown) => { let grew = false; for (const t of parts(x)) { const k = squash(t); if (k && !names.has(k)) { names.add(k); grew = true; } } return grew; };
  const addId = (x: unknown) => { let grew = false; for (const t of parts(x)) { const k = t.toLowerCase(); if (!ids.has(k)) { ids.add(k); grew = true; } } return grew; };
  const wordPrivate = (t: string) => segments(t).some((w) => isPrivateName(w) || isPrivateName(w.normalize("NFKC")));
  /** One bare word as a room: its own words, a private room's name (whole, or its first part: `area/room`), a private channel id. */
  const roomWord = (t: string) => wordPrivate(t) || names.has(squash(t)) || names.has(squash(segments(t)[0] ?? "")) || ids.has(t.toLowerCase());
  const has = (x: unknown): boolean => parts(x).some(roomWord);

  for (const k of o.known ?? []) { addName(k); addId(k); }
  // the nodes inside a private place: their names, the rooms they name, the channels they own
  const nodeIds = new Set<string>(), nodePaths = new Set<string>(), nodeLeaves = new Set<string>();
  if (tree) for (const n of [...tree.nodes.values(), ...tree.archived]) {
    if (!isPrivatePath(tree, n.path) && !segments(n.path).some((w) => isPrivateName(w))) continue;
    if (n.id) nodeIds.add(n.id.toLowerCase());
    const path = segments(n.path).map(squash);
    // (a part with no letters or digits at all keys nothing: it must never match every such name)
    if (path.every(Boolean)) nodePaths.add(path.join("/"));
    for (const leaf of [squash(segments(n.path).pop() ?? ""), squash(n.name ?? "")]) if (leaf) nodeLeaves.add(leaf);
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
    // (the sets only grow and are bounded by the words there are, so it ends)
    for (let changed = true; changed;) {
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
  /** One bare word as a note: a private word in its path, or a node inside a private place by id, by path, or by its last part. */
  const refWord = (t: string) => {
    const segs = segments(t);
    if (segs.some((w) => isPrivateName(w) || isPrivateName(w.normalize("NFKC"))) || nodeIds.has(t.toLowerCase())) return true;
    const path = segs.map(squash), leaf = path[path.length - 1] ?? "";
    return (path.every(Boolean) && nodePaths.has(path.join("/"))) || (!!leaf && nodeLeaves.has(leaf));
  };
  return {
    // a room field may hold a note's link (`[[Projects/X]]`, `projects/x`): it is judged as a note too
    room: (clue) => parts(clue).some((t) => roomWord(t) || refWord(t)),
    ref: (clue) => parts(clue).some(refWord),
  };
}
