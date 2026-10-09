// The tree of nodes under Uni (pure, unit-tested in scripts/lifeos.test.ts): the Uni root, area notes, and project
// notes whose `metadata.parent` names their parent's path. Built from the notes of one tagged query and a parent index;
// nothing here fetches.
import { sortAreas, type Area } from "./areasCore.ts";

/** The Uni root's key in `children`. Never a note path. */
export const ROOT = "";
export const UNI_CHANNEL = "1b667c1f-95c8-45e5-a7cc-1df13b7d0e2a";

export type Tree = {
  /** Every node by path. */
  nodes: Map<string, Area>;
  /** A node's children (ROOT: the top level), foreground first, then by name. */
  children: Map<string, Area[]>;
  /** A node's parent path after validation (ROOT: top level). */
  parent: Map<string, string>;
};

/** Parent links that survive: a parent that is missing, the node itself, or part of a cycle means "top level" for that link. */
function resolveParents(nodes: Map<string, Area>): Map<string, string> {
  const parent = new Map<string, string>();
  for (const [path, n] of nodes) parent.set(path, n.parent && n.parent !== path && nodes.has(n.parent) ? n.parent : ROOT);
  // A cycle is broken at its smallest path, so the same data always gives the same tree.
  for (const start of [...nodes.keys()].sort()) {
    const seen: string[] = [];
    let at = start;
    while (at !== ROOT && !seen.includes(at)) { seen.push(at); at = parent.get(at) ?? ROOT; }
    if (at !== ROOT) { const cycle = seen.slice(seen.indexOf(at)); parent.set([...cycle].sort()[0], ROOT); }
  }
  return parent;
}

/** Nodes in, tree out. Duplicate paths keep the most recently updated note. */
export function buildTree(list: readonly Area[]): Tree {
  const nodes = new Map<string, Area>();
  for (const a of list.filter((n) => n.status !== "archived" && n.status !== "done" && n.metadata.status !== "archived" && n.metadata.status !== "done")) { const old = nodes.get(a.path); if (!old || (a.updatedAt ?? "") >= (old.updatedAt ?? "")) nodes.set(a.path, a); }
  const parent = resolveParents(nodes);
  const kids = new Map<string, Area[]>();
  for (const [path, n] of nodes) { const p = parent.get(path)!; kids.set(p, [...(kids.get(p) ?? []), n]); }
  // A room a child claims is shown on the child, not repeated on the parent (unless that would leave the parent with none).
  for (const [path, n] of [...nodes]) {
    const claimed = new Set((kids.get(path) ?? []).flatMap((c) => c.channels));
    const own = n.channels.filter((c) => !claimed.has(c));
    nodes.set(path, { ...n, rooms: own.length ? own : n.channels });
  }
  const children = new Map<string, Area[]>();
  for (const [p, list] of kids) children.set(p, sortAreas(list.map((c) => nodes.get(c.path)!)));
  return { nodes, children, parent };
}

export const childrenOf = (tree: Tree, path: string): Area[] => tree.children.get(path) ?? [];

/** From the top level down to `path` (inclusive); empty for an unknown path. */
export function trail(tree: Tree, path: string): Area[] {
  const out: Area[] = [];
  let at: string | undefined = path;
  while (at && at !== ROOT && tree.nodes.has(at) && out.length <= tree.nodes.size) { out.unshift(tree.nodes.get(at)!); at = tree.parent.get(at); }
  return tree.nodes.has(path) ? out : [];
}

/** The path a node's Back goes to: its parent, or Uni (ROOT). */
export const parentPath = (tree: Tree, path: string): string => tree.parent.get(path) ?? ROOT;

/** The Uni root as a node, so the same page component draws it. */
export function rootNode(rooms: readonly string[]): Area {
  return {
    id: "uni-root", path: ROOT, name: "Uni", purpose: "What is going on.", status: "foreground",
    channels: [...rooms], rooms: [...rooms], since: null, title: "Uni", body: "", metadata: {}, updatedAt: null, kind: "area", parent: null,
  };
}

export const isRoot = (a: Pick<Area, "path">) => a.path === ROOT;
