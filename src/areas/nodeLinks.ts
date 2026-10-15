// T-140: the node graph. A node's metadata `links` lists node ids; a link is two-way (A is linked to B when A lists B or B lists A), Uni links to
// everything implicitly, and for the migration window `metadata.parent` still counts as one more link. Pure, unit-tested in scripts/links.test.ts.
// The tree the app draws is read from it: an area's children are the projects linked to it, a project linked to two areas is under both, a
// project linked to no area is top level, and links between projects or between areas only link (no nesting). Nothing here can loop.
// One legacy exception: a project whose only tie is an old `parent` naming a project inherits that project's areas (see `inherited`).
import { pathResolver, refKey } from "./refs.ts";

export const ROOT_PATH = "";
export type LinkNode = { id: string; path: string; name: string; kind: "area" | "project"; parent: string | null; links?: readonly string[] };

/** `metadata.links` as written: a list (or one string) of ids, paths or `[[links]]`. */
export function linksOf(metadata: Record<string, unknown> | null | undefined): string[] {
  const raw = metadata?.links;
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  return [...new Set(list.map(refKey).filter((k): k is string => !!k))];
}

export type LinkGraph = {
  /** Every node's linked nodes (paths, both ways, no self, only live nodes), by name. Areas and projects alike. */
  links: Map<string, string[]>;
  /** The areas a node links to (an area: none), by name. */
  areasOf: Map<string, string[]>;
  /** A node's primary parent: its first linked area by name, else the top level (ROOT_PATH). Areas are always top level. */
  parent: Map<string, string>;
  /** area path -> the projects linked to it by name; ROOT_PATH -> the areas, then the projects with no area. */
  children: Map<string, string[]>;
};

/**
 * `live`: the nodes the tree shows. `known`: every node a reference may name (archived ones too), so a link to a node that is gone is simply
 * dropped. An id or path that names nothing, the node itself, or a node outside `live` is ignored, never an error.
 */
export function linkGraph(live: readonly LinkNode[], known: readonly { id: string; path: string }[] = live): LinkGraph {
  const resolve = pathResolver(known);
  const byPath = new Map(live.map((n) => [n.path, n]));
  const sets = new Map<string, Set<string>>(live.map((n) => [n.path, new Set<string>()]));
  for (const n of live) {
    for (const ref of [n.parent, ...(n.links ?? [])]) {
      const p = resolve(ref);
      if (!p || p === n.path || !byPath.has(p)) continue;
      sets.get(n.path)!.add(p); sets.get(p)!.add(n.path);
    }
  }
  const byName = (a: string, b: string) => byPath.get(a)!.name.localeCompare(byPath.get(b)!.name, undefined, { sensitivity: "base" }) || a.localeCompare(b);
  // Legacy `parent` only (before the migration): a project filed under a project that sits in an area is shown in that area too, so the old
  // nesting (COhere 2026 under COhere under Boulder) does not drop to the top level while the window is open. A walk with a repeat guard.
  const direct = new Map<string, string[]>();
  for (const [path, set] of sets) direct.set(path, byPath.get(path)!.kind === "project" ? [...set].filter((p) => byPath.get(p)!.kind === "area") : []);
  const inherited = (n: LinkNode): string[] => {
    const seen = new Set<string>([n.path]);
    for (let at: LinkNode | undefined = n; at; ) {
      const up = resolve(at.parent);
      const next = up ? byPath.get(up) : undefined;
      if (!next || seen.has(next.path) || next.kind !== "project") return [];
      seen.add(next.path);
      const areas = direct.get(next.path) ?? [];
      if (areas.length) return areas;
      at = next;
    }
    return [];
  };
  const links = new Map<string, string[]>(), areasOf = new Map<string, string[]>(), parent = new Map<string, string>();
  const children = new Map<string, string[]>([[ROOT_PATH, []]]);
  for (const [path, set] of sets) {
    const all = [...set].sort(byName);
    links.set(path, all);
    const own = direct.get(path)!;
    const areas = own.length || byPath.get(path)!.kind !== "project" ? [...own].sort(byName) : [...new Set(inherited(byPath.get(path)!))].sort(byName);
    areasOf.set(path, areas);
    parent.set(path, areas[0] ?? ROOT_PATH);
    if (areas.length) for (const a of areas) children.set(a, [...(children.get(a) ?? []), path]);
  }
  const top = [...byPath.keys()].filter((p) => parent.get(p) === ROOT_PATH);
  children.set(ROOT_PATH, [...top.filter((p) => byPath.get(p)!.kind === "area").sort(byName), ...top.filter((p) => byPath.get(p)!.kind === "project").sort(byName)]);
  for (const [a, list] of children) if (a !== ROOT_PATH) children.set(a, list.sort(byName));
  return { links, areasOf, parent, children };
}
