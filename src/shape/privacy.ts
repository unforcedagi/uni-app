// T-335 the shape: the privacy rules that outlive the areas tree (moved here from src/areas/treeRooms.ts and talkCore.ts, which the
// old home used; they re-export these names until they are deleted). A private area is recognised by a hash of its name, never named
// (the T-111 rule; app/CLAUDE.md). Pure: no React, no Tauri. Tested through scripts/privacy.test.ts and scripts/asks.test.ts.
import type { Area } from "../areas/areasCore.ts";
import { ancestry, ROOT, type Tree } from "../areas/treeCore.ts";
import { pathResolver } from "../areas/refs.ts";

// ── Who stewards a node (from talkCore): its own room, else the nearest ancestor's, else Uni's where an account still has one
export type RoomRef = { id: string; name: string };
export type RoomNode = { path: string; name?: string; room: string | null; channels: readonly string[] };

// A name with a "/" (`atlas/build`) is matched segment by segment, so `atlasbuild` or `atlas-build` never stands in for it.
const slug = (s: string) => s.toLowerCase().replace(/^#/, "").trim().split("/").map((p) => p.replace(/[^a-z0-9]+/g, "")).join("/");
export const roomByName = (rooms: readonly RoomRef[], name: string | null | undefined): RoomRef | null => {
  const want = name ? slug(name) : "";
  return want ? rooms.find((r) => slug(r.name) === want) ?? null : null;
};

/** The room a node names itself, if it exists: a channel id first (a renamed room keeps its id), else the `room` name. */
export function ownRoom(n: Pick<RoomNode, "room" | "channels">, rooms: readonly RoomRef[]): RoomRef | null {
  const id = n.channels.find((c) => rooms.some((r) => r.id === c));
  return (id ? rooms.find((r) => r.id === id)! : null) ?? roomByName(rooms, n.room);
}

/** `own`: the node's room; `inherited`: an ancestor's (`from` is that ancestor); `uni`: nothing on the way, so #Uni (null when there is none). */
export type Steward = { room: RoomRef | null; via: "own" | "inherited" | "uni"; from: RoomNode | null };

/** `chain` runs from the node up to the top level. A named room that does not exist is skipped, not an error. */
export function steward(chain: readonly RoomNode[], rooms: readonly RoomRef[], uni: RoomRef | null): Steward {
  for (let i = 0; i < chain.length; i++) {
    const room = ownRoom(chain[i], rooms);
    if (room) return { room, via: i === 0 ? "own" : "inherited", from: chain[i] };
  }
  return { room: uni, via: "uni", from: null };
}

/** A room as the app writes it after "#": its real channel name, exactly (r13: never lowercased or re-spaced), without a leading "#". */
export const roomSlug = (name: string) => name.trim().replace(/^#/, "");

/** Nodes whose words and titles are never shown in a new place, only counts (the T-111 privacy rule). "sanctum" is the fixtures'
 *  private area; the owner's own are kept as hashes of their lowercased names, so this public repo doesn't name them (T-190).
 *  T-293: the life area that absorbed the older private areas is the second hash; the older entries stay for notes not yet moved. */
const PRIVATE = new Set(["relationships", "sanctum"]);
const PRIVATE_HASHED = new Set([0x4c19dafd, 0x251215f1]);
/** 32-bit FNV-1a: enough to recognise one known name, not to hide it from someone who guesses it. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (const c of s) { h ^= c.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}
export const isPrivateName = (name: string): boolean => { const n = name.toLowerCase(); return PRIVATE.has(n) || PRIVATE_HASHED.has(fnv1a(n)); };
export const isPrivateNode = (tree: Tree, path: string): boolean => ancestry(tree, path).some((n) => isPrivateName(n.name));
/** The private area a node sits in (the outermost one, itself included), or null: the feed names private items by this place only. */
export function privateRoot(tree: Tree, path: string): { path: string; name: string } | null {
  const hit = ancestry(tree, path).filter((n) => isPrivateName(n.name)).pop();
  return hit ? { path: hit.path, name: hit.name } : null;
}

const closures = new WeakMap<Tree, { all: Set<string>; under: Set<string> }>();
/** A way of writing a reference, reduced: no brackets, alias, anchor, extension, outer slashes or case. Used only to err towards private. */
const looseRef = (ref: unknown): string | null => {
  if (typeof ref !== "string") return null;
  const s = ref.trim().replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0].split("#")[0].trim().replace(/\.md$/i, "").replace(/^\/+|\/+$/g, "").toLowerCase();
  return s || null;
};
/**
 * T-335: every node inside a private place, read from everything known, done and archived nodes included. The tree's walk stops at a node that isn't live,
 * and treats a reference it can't resolve as no link, so a live project under a done one under a private area, or linked to an archived private area, would
 * look top-level and public. Here a reference counts however it is written. It starts from every node named privately, filed under a privately named path,
 * pointing at one, or private by the tree's own walk, and spreads through projects over two-way links, and into an area only by that area's own `parent`: an
 * area is never made private by what it links to. It errs towards private: a project linked to a private one counts.
 */
function privateClosure(tree: Tree): { all: Set<string>; under: Set<string> } {
  const hit = closures.get(tree);
  if (hit) return hit;
  const known = [...tree.nodes.values(), ...tree.archived];
  const byPath = new Map(known.map((n) => [n.path, n]));
  const exact = pathResolver(known);
  const loose = new Map<string, Set<string>>();
  const index = (k: string, path: string) => { const key = k.toLowerCase(); (loose.get(key) ?? loose.set(key, new Set()).get(key)!).add(path); };
  for (const n of known) { index(n.path, n.path); index(n.id, n.path); index(n.name, n.path); index(n.path.split("/").pop()!, n.path); }
  const targets = (ref: unknown): string[] => {
    const hit1 = exact(ref), key = looseRef(ref);
    return [...new Set([...(hit1 && byPath.has(hit1) ? [hit1] : []), ...(key ? loose.get(key) ?? [] : [])])];
  };
  const refsOf = (n: Area): unknown[] => [n.parent, ...(n.kind === "area" ? [] : n.links ?? [])];
  const near = new Map<string, Set<string>>();
  const join = (a: string, b: string) => { if (a === b) return; (near.get(a) ?? near.set(a, new Set()).get(a)!).add(b); (near.get(b) ?? near.set(b, new Set()).get(b)!).add(a); };
  for (const n of known) for (const ref of [n.parent, ...(n.links ?? [])]) for (const to of targets(ref)) join(n.path, to);
  const parents = new Map(known.map((n) => [n.path, new Set(targets(n.parent))]));
  const namesPrivate = (ref: unknown) => !!looseRef(ref)?.split("/").some(isPrivateName);
  const out = new Set(known.filter((n) => isPrivateName(n.name) || n.path.split("/").some(isPrivateName) || refsOf(n).some(namesPrivate) || (tree.nodes.has(n.path) && isPrivateNode(tree, n.path))).map((n) => n.path));
  const stack = [...out];
  while (stack.length) {
    const at = stack.pop()!;
    for (const next of near.get(at) ?? []) {
      if (out.has(next) || (byPath.get(next)?.kind === "area" && !parents.get(next)?.has(at))) continue;
      out.add(next); stack.push(next);
    }
  }
  // really under a private place, not only linked to something that is: by the seeds, a `parent` chain, or a two-way link with a privately named area
  const under = new Set(known.filter((n) => isPrivateName(n.name) || n.path.split("/").some(isPrivateName) || refsOf(n).some(namesPrivate) || (tree.nodes.has(n.path) && isPrivateNode(tree, n.path))).map((n) => n.path));
  for (let grew = true; grew;) {
    grew = false;
    for (const n of known) {
      if (under.has(n.path)) continue;
      const byParent = [...(parents.get(n.path) ?? [])].some((p) => under.has(p));
      const byArea = [...(near.get(n.path) ?? [])].some((p) => { const a = byPath.get(p); return !!a && a.kind === "area" && isPrivateName(a.name); });
      if (byParent || (n.kind !== "area" && byArea)) { under.add(n.path); grew = true; }
    }
  }
  const both = { all: out, under };
  closures.set(tree, both);
  return both;
}
/** T-335: is this node inside a private place, however it got there? */
export const isPrivatePath = (tree: Tree, path: string): boolean => privateClosure(tree).all.has(path) || isPrivateNode(tree, path);
/**
 * T-335: does this room belong to a private place? A room named privately does, whoever claims it. So does one a private node names (a done or archived one
 * too: a session can still wait in its room), or owns. Never a room it only borrows: a private area with no room of its own talks in Uni's, and that doesn't
 * make Uni's private. Nor a public area's own room, because a project sharing it is linked to something private; a project really under the private place does count.
 */
export function isPrivateRoom(tree: Tree, channel: string, rooms: readonly RoomRef[], uni: RoomRef | null): boolean {
  const room = rooms.find((r) => r.id === channel);
  if (room && roomSlug(room.name).split("/").some(isPrivateName)) return true;
  const names = (n: Area) => [...n.rooms, ...n.channels, ...(typeof n.metadata.room === "string" ? [n.metadata.room] : [])].some((c) => c === channel || (!!room && roomSlug(c).toLowerCase() === roomSlug(room.name).toLowerCase()));
  const { under } = privateClosure(tree);
  const publicAreaHas = [...tree.nodes.values()].some((n) => n.kind === "area" && !isPrivatePath(tree, n.path) && (names(n) || (() => { const v = roomView(tree, n.path, rooms, uni); return v.own && v.target?.id === channel; })()));
  const counts = (n: Area) => !publicAreaHas || under.has(n.path);
  for (const n of tree.nodes.values()) {
    if (!isPrivatePath(tree, n.path) || !counts(n)) continue;
    const v = roomView(tree, n.path, rooms, uni);
    if ((v.own && v.target?.id === channel) || names(n)) return true;
  }
  return tree.archived.some((a) => isPrivatePath(tree, a.path) && counts(a) && names(a));
}

/** The ways a note may have written one room: as it is, without a "(…)" note after it, and each "a", "a/b" of a sub-room; also in lower case. */
function roomForms(part: string): string[] {
  const bare = part.replace(/\s*\(.*$/, "").trim();
  const words = bare.split("/");
  const out = [part, bare, ...words.map((_, i) => words.slice(0, i + 1).join("/").trim())].filter(Boolean);
  return [...new Set(out.flatMap((f) => [f, f.toLowerCase()]))];
}
const namesIn = (v: unknown): string[] => (typeof v === "string" ? v.split(",").map((x) => roomSlug(x).replace(/\s*\(.*$/, "").trim().toLowerCase()).filter(Boolean) : []);
// not room_fallback: that is a room it only borrows
const ROOM_NAMES = ["room", "rooms", "room_was", "room_renamed_from"];
const nodeRoomNames = (n: Area) => ROOM_NAMES.flatMap((k) => namesIn(n.metadata[k]));

/** What a run is checked against, kept per tree: the node resolver, the rooms' other names (old and sub ones) and the folders really under a private place. */
type RunFacts = { node: (ref: unknown) => string | null; rooms: Set<string>; folders: Set<string>;
  /** The projects a run's node can name: the ones with a folder, as the sessions hold them. */ projects: Set<string>; clues: WeakMap<readonly RoomRef[], Map<string, boolean>> };
const runFacts = new WeakMap<Tree, RunFacts>();
const folderKey = (v: unknown) => (typeof v === "string" ? v.trim().replace(/^\/(?:home|Users)\/[^/]+\//, "~/").replace(/\/+$/, "") : "");
function factsOf(tree: Tree): RunFacts {
  const hit = runFacts.get(tree);
  if (hit) return hit;
  const known = [...tree.nodes.values(), ...tree.archived];
  const { under } = privateClosure(tree);
  // a name a public area also goes by doesn't make a run private: that room is the public area's
  const open = new Set(known.filter((n) => n.kind === "area" && !isPrivatePath(tree, n.path)).flatMap(nodeRoomNames));
  const inside = known.filter((n) => under.has(n.path));
  const facts: RunFacts = { node: pathResolver(known), clues: new WeakMap(),
    projects: new Set(known.filter((n) => n.kind === "project" && (folderKey(n.metadata.folder) || folderKey(n.metadata.repo))).map((n) => n.path)),
    rooms: new Set(inside.flatMap(nodeRoomNames).filter((r) => !open.has(r))),
    folders: new Set(inside.flatMap((n) => [folderKey(n.metadata.folder), folderKey(n.metadata.repo)]).filter(Boolean)) };
  runFacts.set(tree, facts);
  return facts;
}

/**
 * Does a run's room clue (a room's id or name, however a note wrote it: "#x", "x/build", "x (old)", "x, y", a list) touch a private place? Any one part is enough: a
 * run launched from a private room stays private even when it also names a public room or sits on a public node. With no tree, only private names can be recognised.
 */
export function roomCluePrivate(tree: Tree | null, clue: unknown, rooms: readonly RoomRef[], uni: RoomRef | null): boolean {
  const facts = tree ? factsOf(tree) : null;
  // answers hold only for these rooms: the rooms arrive after the tree, and an answer read without them says nothing about them
  const memo = facts ? facts.clues.get(rooms) ?? new Map<string, boolean>() : null;
  if (facts && memo) facts.clues.set(rooms, memo);
  const key = `${uni?.id ?? ""}|${JSON.stringify(clue ?? null)}`;
  const known = memo?.get(key);
  if (known !== undefined) return known;
  const parts = (Array.isArray(clue) ? clue : [clue]).filter((v): v is string => typeof v === "string").flatMap((v) => v.split(",")).map((v) => roomSlug(v)).filter(Boolean);
  // a room's id is read as the room's name too: a note may hold only the id
  const named = parts.flatMap((p) => { const r = rooms.find((x) => x.id === p); return r ? [p, roomSlug(r.name)] : [p]; });
  const out = named.some((p) => p.split("/").some((w) => isPrivateName(w.replace(/\s*\(.*$/, "").trim())) || (!!tree && roomForms(p).some((f) => facts!.rooms.has(f) || isPrivateRoom(tree, f, rooms, uni))));
  memo?.set(key, out);
  return out;
}

/** Every clue a run carries on where it belongs. `folder`: only when no node says, since a folder can be shared. */
export type RunClues = { rooms: readonly unknown[]; nodes: readonly unknown[]; folder?: unknown };
/** The one rule for whether a run is a private place's, used everywhere runs are shown: any private clue is enough, whatever public clue it also carries. */
export function runIsPrivate(tree: Tree, run: RunClues, rooms: readonly RoomRef[], uni: RoomRef | null): boolean {
  const facts = factsOf(tree);
  if (run.rooms.some((c) => roomCluePrivate(tree, c, rooms, uni))) return true;
  if (run.nodes.some((ref) => { const at = facts.node(ref); return (!!at && isPrivatePath(tree, at)) || !!looseRef(ref)?.split("/").some(isPrivateName); })) return true;
  return facts.folders.has(folderKey(run.folder));
}
/** The runs a level other than a private place doesn't list. Before the areas and rooms are read nothing can be told of a run's clues, so every run waits (as tasks do, r21);
 *  and before the tasks are read, any run naming a task. */
export function privateRunIds(tree: Tree | null, runs: readonly { id: string; node: string; task: string | null; rooms?: readonly unknown[]; project?: string | null; folder?: string | null }[], nodeOfTask: ReadonlyMap<string, string>, rooms: readonly RoomRef[], uni: RoomRef | null, tasksKnown = true): Set<string> {
  return new Set(runs.filter((r) => {
    if (!tasksKnown && r.task) return true;
    if (!tree) return true;
    const id = (/\bT-\d+[a-z]?\b/i.exec(r.task ?? "")?.[0] ?? r.task)?.toUpperCase();
    const nodes = [r.project, r.node, id ? nodeOfTask.get(id) : null];
    // as the sessions do: a folder counts only when no node says which project the run belongs to
    const facts = factsOf(tree);
    const named = nodes.some((ref) => { const at = facts.node(ref); return !!at && facts.projects.has(at); });
    return runIsPrivate(tree, { rooms: r.rooms ?? [], nodes, folder: named ? null : r.folder }, rooms, uni);
  }).map((r) => r.id));
}

/** r21: the same, read from the task tree (its nodes and parents), for while the areas aren't read yet: privacy never waits on them. */
export function privateRootIn(tasks: { byPath: ReadonlyMap<string, { path: string; name: string }>; parent: ReadonlyMap<string, string> }, path: string): { path: string; name: string } | null {
  let hit: { path: string; name: string } | null = null;
  const seen = new Set<string>();
  for (let at: string | undefined = path; at && !seen.has(at); at = tasks.parent.get(at)) {
    seen.add(at);
    const n = tasks.byPath.get(at); if (!n) break;
    if (isPrivateName(n.name)) hit = { path: n.path, name: n.name };
  }
  return hit;
}

/**
 * A node as the steward rule reads it. A room marked `room_status: archived|missing` is skipped: the node's `room_fallback`
 * (a room name or id) stands in for it, and with none the walk simply continues to the ancestors.
 */
export function roomNodeOf(n: Area): RoomNode {
  const room = typeof n.metadata.room === "string" ? n.metadata.room : null;
  const status = typeof n.metadata.room_status === "string" ? n.metadata.room_status.toLowerCase() : "";
  if (status === "archived" || status === "missing") {
    const fb = typeof n.metadata.room_fallback === "string" ? n.metadata.room_fallback.replace(/^#/, "").trim() : "";
    return { path: n.path, name: n.name, room: fb || null, channels: fb ? [fb] : [] };
  }
  return { path: n.path, name: n.name, room, channels: n.rooms };
}
export const fellBack = (n: Area): boolean => /^(archived|missing)$/i.test(String(n.metadata.room_status ?? ""));

export type RoomView = {
  /** Where a note to this node goes: its own room, else an ancestor's, else #Uni if there is one (archived: usually none). */
  target: RoomRef | null;
  /** The room's own name (`cohere`, `atlas/build`): shown when the node has a room of its own. */
  slash: string | null;
  /** The ancestor's room that holds a node with none of its own. */
  heldBy: RoomRef | null;
  own: boolean;
  /** The name of the node whose room holds this one (`Boulder`), so a held row never reads as the room's own. */
  heldNode: string | null;
};

/** Whether a node beneath `path` names `roomId` as its own room. */
function claimedBelow(tree: Tree, path: string, roomId: string, rooms: readonly RoomRef[]): boolean {
  // the start is seen: a cycle of links that comes back to it is not a descendant's claim (Codex 0.1.47 review 3)
  const stack = [...(tree.scope.get(path) ?? [])]; const seen = new Set<string>([path]);
  while (stack.length) {
    const n = stack.pop()!;
    if (seen.has(n.path)) continue;
    seen.add(n.path);
    if (ownRoom(roomNodeOf(n), rooms)?.id === roomId) return true;
    stack.push(...(tree.scope.get(n.path) ?? []));
  }
  return false;
}

/** `rooms`: every known room; `uni`: the Uni room. A node with a live room of its own that an ancestor also uses is held by that ancestor. */
export function roomView(tree: Tree, path: string, rooms: readonly RoomRef[], uni: RoomRef | null): RoomView {
  if (path === ROOT) return { target: uni, slash: uni ? roomSlug(uni.name) : null, heldBy: null, own: !!uni, heldNode: null };
  const chain = ancestry(tree, path);
  const nodes = chain.map(roomNodeOf);
  // A room belongs to the deepest node that names it: when a descendant claims the very room an ancestor's channel points at (Boulder -> #cohere),
  // the ancestor keeps only the room its own `room` name finds, else none.
  // The same goes for every ancestor on the way up, so the deepest node does not read as sharing with them (COhere under Boulder).
  for (let i = 0; i < nodes.length; i++) {
    const channelRoom = ownRoom(nodes[i], rooms);
    if (channelRoom && claimedBelow(tree, chain[i].path, channelRoom.id, rooms)) nodes[i] = { ...nodes[i], channels: [] };
  }
  const s = steward(nodes, rooms, uni);
  const mine = chain[0] ? ownRoom(nodes[0], rooms) : null;
  const sharedWithAncestor = mine ? nodes.slice(1).some((n) => ownRoom(n, rooms)?.id === mine.id) : false;
  // An archived room's fallback is a room the node borrows, not one it owns.
  const own = !!mine && !sharedWithAncestor && !(chain[0] && fellBack(chain[0]));
  // A node's room line is the room's own name (`cohere`, `atlas/build`), exactly as the rooms list has it: never a path built from the tree.
  if (own) return { target: s.room, slash: s.room ? roomSlug(s.room.name) : null, heldBy: null, own: true, heldNode: null };
  const holder = s.room ? nodes.slice(1).find((n) => ownRoom(n, rooms)?.id === s.room!.id) : undefined;
  return { target: s.room, slash: null, heldBy: s.room, own: false, heldNode: holder?.name ?? (s.room && s.room.id === uni?.id ? "Uni" : null) };
}
