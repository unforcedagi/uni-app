export type NotePath = { id: string; path: string; updatedAt?: string | null };
export type VaultTree = { name: string; path: string; folder: boolean; note?: NotePath; children: VaultTree[] };

/** A path may be both a note and a folder: retain the note as its index. */
export function buildVaultTree(notes: NotePath[], filter = ""): VaultTree[] {
  const root: VaultTree = { name: "", path: "", folder: true, children: [] };
  const byPath = new Map<string, VaultTree>();
  for (const note of notes) {
    if (!note.path.toLowerCase().includes(filter.toLowerCase())) continue;
    const segments = note.path.split("/").filter(Boolean);
    let parent = root;
    segments.forEach((name, i) => {
      const path = segments.slice(0, i + 1).join("/");
      let node = byPath.get(path);
      if (!node) {
        node = { name, path, folder: false, children: [] };
        byPath.set(path, node);
        parent.children.push(node);
      }
      if (i < segments.length - 1) node.folder = true;
      else node.note = note;
      parent = node;
    });
  }
  const sort = (nodes: VaultTree[]) => {
    nodes.sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.name.localeCompare(b.name));
    nodes.forEach((n) => sort(n.children));
  };
  sort(root.children);
  return root.children;
}

export function restoreExpanded(raw: string | null): Set<string> {
  try { const value: unknown = JSON.parse(raw ?? "[]"); return new Set(Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : []); }
  catch { return new Set(); }
}
