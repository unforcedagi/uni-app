// The tree of nodes under Uni (pure, unit-tested in scripts/lifeos.test.ts): the Uni root, area notes, and project
// notes whose `metadata.parent` names their parent's path. Built from the notes of one tagged query and a parent index;
// nothing here fetches.
import { sortAreas, type Area } from "./areasCore.ts";
import { linkGraph } from "./nodeLinks.ts";

/** The Uni root's key in `children`. Never a note path. */
export const ROOT = "";
export const UNI_CHANNEL = "1b667c1f-95c8-45e5-a7cc-1df13b7d0e2a";

export type Tree = {
  /** Every node by path. */
  nodes: Map<string, Area>;
  /** A node's children (ROOT: the top level), foreground first, then by name. An area's children are the projects linked to it (either end); a project linked to two areas is a child of both. */
  children: Map<string, Area[]>;
  /** A node's primary parent after validation (ROOT: top level): a project's first linked area by name. Back and the breadcrumb use it unless you came through another area. */
  parent: Map<string, string>;
  /** Legacy-aware ancestry (rooms, privacy): an old `parent` project still counts as the way up until the node has `links`. */
  chain: Map<string, string>;
  /** Everything a node holds for rooms: its children plus legacy-parent children and projects that link to it. */
  scope: Map<string, Area[]>;
  /** T-140: every node's linked nodes (two-way; `parent` counts as a link), by name. Project-to-project links are noted here only. */
  links: Map<string, string[]>;
  /** The areas a node is linked to, by name; the node appears under each. */
  areasOf: Map<string, string[]>;
  /** Archived and done nodes: not drawn, but their rooms are known to be retired. */
  archived: Area[];
};

/** Nodes in, tree out. Duplicate paths keep the most recently updated note. */
export function buildTree(list: readonly Area[]): Tree {
  const nodes = new Map<string, Area>();
  const archived: Area[] = [];
  for (const a of list) { if (a.status === "archived" || a.status === "done") { archived.push(a); continue; } const old = nodes.get(a.path); if (!old || (a.updatedAt ?? "") >= (old.updatedAt ?? "")) nodes.set(a.path, a); }
  const live = [...nodes.values()];
  const g = linkGraph(live.map((n) => ({ id: n.id, path: n.path, name: n.name, kind: n.kind, parent: n.parent, links: n.links })), [...live, ...archived]);
  const kids = new Map<string, Area[]>();
  // Claims follow the task scope (display children plus legacy parent children), so a parent-only project keeps its rooms as in 0.1.46.
  for (const [p, paths] of g.scope) kids.set(p, paths.map((c) => nodes.get(c)!));
  // A room a child claims is shown on the child, not repeated on the parent (unless that would leave the parent with none).
  for (const [path, n] of [...nodes]) {
    const claimed = new Set((kids.get(path) ?? []).flatMap((c) => c.channels));
    const own = n.channels.filter((c) => !claimed.has(c));
    nodes.set(path, { ...n, rooms: own.length ? own : n.channels });
  }
  const children = new Map<string, Area[]>();
  for (const [p, paths] of g.children) children.set(p, sortAreas(paths.map((c) => nodes.get(c)!)));
  const scope = new Map<string, Area[]>();
  for (const [p, paths] of g.scope) scope.set(p, paths.map((c) => nodes.get(c)!));
  return { nodes, children, parent: g.parent, chain: g.chain, scope, links: g.links, areasOf: g.areasOf, archived };
}

export const childrenOf = (tree: Tree, path: string): Area[] => tree.children.get(path) ?? [];

/** The area `path` is reached through: `via` when the node is linked to it, else its primary parent (its first linked area by name). */
export const upFrom = (tree: Tree, path: string, via?: string | null): string => via && tree.areasOf.get(path)?.includes(via) ? via : tree.parent.get(path) ?? ROOT;

/** From the top level down to `path` (inclusive), through the area `via` when the node sits in it; empty for an unknown path. */
export function trail(tree: Tree, path: string, via?: string | null): Area[] {
  const out: Area[] = [];
  let at: string | undefined = path;
  for (let first = true; at && at !== ROOT && tree.nodes.has(at) && out.length <= tree.nodes.size; first = false) { out.unshift(tree.nodes.get(at)!); at = upFrom(tree, at, first ? via : null); }
  return tree.nodes.has(path) ? out : [];
}

/** The node and its ancestors up to the top level, nearest first. Stops at a repeat, so bad data cannot loop. */
export function ancestry(tree: Tree, path: string): Area[] {
  const out: Area[] = [];
  const seen = new Set<string>();
  for (let at: string | undefined = path; at && at !== ROOT && !seen.has(at) && tree.nodes.has(at); at = tree.chain.get(at)) { seen.add(at); out.push(tree.nodes.get(at)!); }
  return out;
}

/** The path a node's Back goes to: the area it was reached through (else its first area), or Uni (ROOT). */
export const parentPath = (tree: Tree, path: string, via?: string | null): string => upFrom(tree, path, via);

/** The Uni root as a node, so the same page component draws it. */
export function rootNode(rooms: readonly string[]): Area {
  return {
    id: "uni-root", path: ROOT, name: "Uni", purpose: "What is going on.", status: "foreground",
    channels: [...rooms], rooms: [...rooms], since: null, title: "Uni", body: "", metadata: {}, updatedAt: null, kind: "area", parent: null,
  };
}

export const isRoot = (a: Pick<Area, "path">) => a.path === ROOT;
