// T-335 the shape: what the shell decides about rooms before home draws them, and the open decisions the chat links to. Pure: no React,
// no Tauri (unit-tested in scripts/shape.test.ts).
// - A retired or folded room (the rooms registry, vault note System/Rooms) is not a room any more: home leaves it out.
// - A private room (private by the registry, or by its name: src/shape/privacy.ts) is still a room, but its asks are drawn only inside it
//   (home shows a wordless mark), and its runs nowhere (src/projects/live.ts gives a private run no room).
import { privateWords, strings, unreadable } from "./privateWords.ts";
import type { KnownDecision } from "../decisionLinks.ts";
import { metaOf, type Note } from "../vault/reader.ts";
import { isPrivateName, isPrivatePath, isPrivateRoom, roomCluePrivate, roomView } from "./privacy.ts";
import { buildTree, ROOT, type Tree } from "../areas/treeCore.ts";
import { parseArea, parseProject, type Area } from "../areas/areasCore.ts";
import { pathResolver } from "../areas/refs.ts";
import type { RawNote } from "../vault/rawNote.ts";
import { canonRoom, isPrivateRoomName, successorOf, type RoomsRegistry } from "../areas/roomsRegistry.ts";
import { refPath, roomKey, splitTitle } from "./asksCore.ts";
import type { Ask, ShapeRoom } from "./types.ts";

/** The rooms home leaves out: a channel the registry folded (into another room, or into none), or a name it lists only as retired. */
export function hiddenRooms(rooms: readonly ShapeRoom[], reg: RoomsRegistry | null): Set<string> {
  const out = new Set<string>();
  if (!reg) return out;
  const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
  for (const r of rooms) {
    // the room's whole name (`dev/build` is its own room, whatever became of `dev`)
    const id = r.id.toLowerCase(), name = roomKey(r.name);
    if (has(reg.foldedIds, id)) { out.add(r.id); continue; }
    if (has(reg.rooms, name)) continue;
    if (has(reg.retired, name)) { out.add(r.id); continue; }
    // an old name of a retired room is retired too (the registry's own rule, canonRoom; a sub-room's name is only its own)
    if (name.includes("/")) continue;
    const c = canonRoom(reg, name);
    if (c === "" || (has(reg.retired, c) && !has(reg.rooms, c))) out.add(r.id);
  }
  return out;
}

/**
 * The rooms whose runs, asks and approvals stay inside them: private by the registry, by a private name (any segment of `a/b`), or (with the
 * node tree) a room a private place owns or names, under any name (privacy.ts isPrivateRoom). `uniRoom`: Uni's room's id (borrowing it
 * never makes it private).
 */
export function privateRooms(rooms: readonly ShapeRoom[], reg: RoomsRegistry | null, tree: Tree | null = null, uniRoom: string | null = null): Set<string> {
  const out = new Set<string>();
  const refs = rooms.map((r) => ({ id: r.id, name: r.name }));
  const uni = refs.find((r) => r.id === uniRoom) ?? null;
  for (const r of rooms) {
    const name = r.name.trim().replace(/^#/, "");
    if (name.split("/").some((w) => isPrivateName(w.trim())) || (!!reg && isPrivateRoomName(reg, name)) || (!!tree && isPrivateRoom(tree, r.id, refs, uni))) out.add(r.id);
  }
  return out;
}

/**
 * The asks by room, after what only the registry can tell: an ask naming a private room by a name this device has no room for (an old
 * name, a retired private room) fell back to Uni's room, and is dropped. A private room's own ask (`private`, placed in that room by
 * asksFrom) stays: it is drawn there in full, and on home without words.
 */
export function keepAsks<A extends Ask & { roomName: string | null }>(byRoom: ReadonlyMap<string, A[]>, reg: RoomsRegistry | null): Map<string, A[]> {
  const out = new Map<string, A[]>();
  for (const [room, list] of byRoom) {
    const keep = list.filter((a) => a.private || !(reg && a.roomName && isPrivateRoomName(reg, a.roomName)));
    if (keep.length) out.set(room, keep);
  }
  return out;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const tagsOf = (n: RawNote): string[] => (Array.isArray(n.tags) ? n.tags.filter((t): t is string => typeof t === "string") : []);

/** The areas and projects from the vault's `node` notes, as the work store reads them (src/projects/live.ts): odd notes are skipped. */
export function nodeTree(nodes: readonly RawNote[]): Tree {
  return buildTree(nodes.flatMap((n): Area[] => {
    if (typeof n.path !== "string" || typeof n.id !== "string") return [];
    try { const a = parseArea({ ...n, tags: tagsOf(n) } as never) ?? parseProject({ ...n, tags: tagsOf(n) } as never); return a ? [a] : []; } catch { return []; }
  }));
}

/**
 * The open decisions (the older `Decisions/` notes, read through the one reader) as the chat names them: their id, their title's T-number,
 * the task each decides, and their room: the one the decision names (`room`, by name or id), else the room that stewards its node (its own,
 * else an ancestor's), as the old shell placed them. A decision in a private place is left out: its node inside a private area (by the
 * tree, however it is linked there), a private name on its path or room, or a private room.
 */
export function decisionsFrom(notes: readonly Note<"decision">[], rooms: readonly ShapeRoom[], priv: ReadonlySet<string>, tree: Tree | null = null, uniRoom: string | null = null,
  o: { reg?: RoomsRegistry | null; hidden?: ReadonlySet<string> } = {}): KnownDecision[] {
  const live = o.hidden?.size ? rooms.filter((r) => !o.hidden!.has(r.id)) : rooms;
  const byName = new Map(rooms.map((r) => [roomKey(r.name), r.id]));
  // a node's steward is a room home shows (a folded or retired channel is never where a decision is listed)
  const refs = live.map((r) => ({ id: r.id, name: r.name }));
  const uni = refs.find((r) => r.id === uniRoom) ?? null;
  const resolve = tree ? pathResolver([...tree.nodes.values(), ...tree.archived]) : null;
  /** The channel ids the registry gives a room name (its own name or one it was known by). */
  const regIds = (nm: string): string[] => (o.reg ? Object.entries(o.reg.rooms).filter(([k, v]) => !!v.id && (roomKey(k) === roomKey(nm) || (v.was ?? []).some((w) => roomKey(w) === roomKey(nm)))).map(([, v]) => v.id!) : []);
  /** A room's name says private: the app's one rule for clues, the registry, or a private place owning the channel the registry gives that
   *  name (a room this device doesn't have). */
  const clue = (nm: string) => roomCluePrivate(tree, nm, refs, uni) || (!!o.reg && isPrivateRoomName(o.reg, nm)) || (!!tree && regIds(nm).some((c) => isPrivateRoom(tree, c, refs, uni)));
  // the one conservative judge: any spelling, any number of moves (privateWords.ts)
  const words = privateWords({ tree, reg: o.reg ?? null, rooms: rooms.map((r) => ({ id: r.id, name: r.name })), uni, known: priv });
  const out: KnownDecision[] = [];
  for (const n of notes) {
    const id = str(n.id), path = refPath(n.path);
    if (!id || !path) continue;
    const m = metaOf(n, "decision") as Record<string, unknown>;
    if (str(m.state) && str(m.state) !== "open") continue;
    const ref = refPath(m.node);
    // (the node however it is written: `[[Projects/X|alias]]`, `.md`, an id)
    const node = m.node !== undefined && m.node !== null ? resolve?.(m.node) ?? ref : null;
    if ([ref, node, path].some((p) => !!p && p.split("/").some((w) => isPrivateName(w)))) continue;
    if (tree && node && node !== ROOT && isPrivatePath(tree, node)) continue;
    // every word in the room and node fields, whatever their shape, is judged; a field that can't be read counts as private
    if (words.room(m.room) || words.ref(m.node) || words.ref(m.card) || [m.room, m.node, m.card].some(unreadable)) continue;
    const named = strings(m.room)[0]?.replace(/^#/, "") ?? null;
    // a room clue is private by the app's one rule for clues (a private name, a room a private place owns or names) or by the registry
    if (named && (clue(named) || words.room(named))) continue;
    if (words.ref(m.node)) continue;
    const found = named ? rooms.find((r) => r.id === named)?.id ?? byName.get(roomKey(named)) ?? null : null;
    // a retired room is no place for it: it goes to the room the registry says its work went to, else where its node's room is
    // (looked up whether or not this device ever had the retired room)
    const successor = o.reg && named && !(found && !o.hidden?.has(found)) ? (found ? successorOf(o.reg, found) : null) ?? successorOf(o.reg, named) : null;
    // where it moved is private (whether or not this device has that room): it is listed nowhere, never in its node's room or Uni's
    if (successor && (clue(successor) || words.room(successor))) continue;
    const own = found && !o.hidden?.has(found) ? found : successor ? byName.get(roomKey(successor)) ?? null : null;
    // (no node, or one the tree doesn't have: the chain ends at Uni's room, where an account still has one)
    const channel = own ?? (tree ? roomView(tree, node ?? ROOT, refs, uni).target?.id ?? null : null);
    if (channel && priv.has(channel)) continue;
    const task = str(m.task);
    out.push({ id, tid: splitTitle(path).tid, forTask: task ? task.toUpperCase() : null, channel });
  }
  return out;
}

/** What "Forget this device key" sweeps that the old home kept (an older version's areas, task list, asks, titles and layout, written by
 *  src/areas/areasCache.ts, savedTasks.ts, vaultTasks.ts, noteRefs.tsx, homeLayout.ts) and the rooms registry this shell keeps (useShape.ts). */
const OLD_KEYS = [
  /^uni\.areas\.cache\.v\d+(:|$)/, /^uni\.tasks\.saved\.v\d+$/, /^uni\.(asks|checks|support)\.v\d+:/, /^uni\.noteTitles\./, /^uni\.home\.layout\.v\d+$/,
  /^uni\.rooms\.registry\.v\d+:/,
];
export function sweepOldKeys(store: Pick<Storage, "length" | "key" | "removeItem">): void {
  for (let i = store.length - 1; i >= 0; i--) { const k = store.key(i); if (k && OLD_KEYS.some((r) => r.test(k))) store.removeItem(k); }
}
