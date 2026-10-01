import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { buildVaultTree, restoreExpanded, type NotePath, type VaultTree } from "./vaultTree";

import { cachedPaths, loadPaths, invalidatePaths, watchPaths } from "./vaultPaths";

export default function VaultBrowser({ vault, onOpen, onCreate, onSearch, onBack }: {
  vault: string; onOpen: (note: NotePath) => void; onCreate: (folder: string) => void;
  onSearch: (prefix: string) => void; onBack: () => void;
}) {
  const [paths, setPaths] = useState<NotePath[]>(() => cachedPaths(vault) ?? []);
  const [filter, setFilter] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const key = `uni.vaultExpanded.v1:${vault}`;
  const [expanded, setExpanded] = useState(() => { try { return restoreExpanded(localStorage.getItem(key)); } catch { return new Set<string>(); } });
  useEffect(() => watchPaths(() => setRefresh((n) => n + 1)), []);
  useEffect(() => {
    let live = true;
    setLoading(!cachedPaths(vault)); setError(null);
    loadPaths(vault, () => invoke<NotePath[]>("vault_paths", { vault })).then((rows) => { if (live) setPaths(rows); })
      .catch((e) => { if (live) setError(String(e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [vault, refresh]);
  function toggle(path: string) {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path); else next.add(path);
    setExpanded(next);
    try { localStorage.setItem(key, JSON.stringify([...next])); } catch { /* session still works */ }
  }
  const deferredFilter = useDeferredValue(filter);
  const expandMatches = deferredFilter.trim().length >= 2;
  const tree = useMemo(() => buildVaultTree(paths, deferredFilter), [paths, deferredFilter]);
  const actions = (folder: string) => <span className="vault-folder-actions">
    <button onClick={() => onCreate(folder)}>New note here</button>
    <button onClick={() => onSearch(folder ? `${folder}/` : "")}>Search in this folder</button>
  </span>;
  let rendered = 0;
  let capped = false;
  const noteRows = (node: VaultTree) => node.notes.map((note) => {
    if (rendered >= 2000) { capped = true; return null; }
    rendered++;
    const label = node.notes.length > 1 ? `${node.name}.${note.extension ?? "md"} (${note.id})` : node.name;
    return <button key={note.id} className="vault-note" onClick={() => onOpen(note)}>{label}{node.folder && <small> · index</small>}</button>;
  });
  function rows(nodes: VaultTree[]) {
    return <ul className="vault-tree">{nodes.map((node) => {
      if (rendered >= 2000) { capped = true; return null; }
      rendered++;
      const open = expandMatches || expanded.has(node.path);
      return <li key={node.path}>{node.folder ? <>
        <div className="vault-folder"><button aria-expanded={open} onClick={() => toggle(node.path)}>{open ? "▾" : "▸"} {node.name}</button>{node.path !== "(unfiled)" && actions(node.path)}</div>
        {open && <>{noteRows(node)}{rows(node.children)}</>}
      </> : noteRows(node)}</li>;
    })}</ul>;
  }
  const renderedTree = rows(tree);
  return <section className="vault-browser" aria-label={`Vault ${vault}`}>
    <header className="note-bar"><button className="note-action" onClick={onBack}>← Vaults</button><strong>{vault}</strong><button className="note-action" disabled={loading} onClick={() => invalidatePaths(vault)}>Refresh</button></header>
    <div className="vault-toolbar"><input type="search" aria-label="Filter paths" placeholder="Filter paths" value={filter} onChange={(e) => setFilter(e.target.value)} />{actions("")}</div>
    <div className="vault-scroll">{loading && <p role="status">Loading paths…</p>}{error && <p className="error" role="alert">{error}</p>}
      {paths.length >= 20_000 && <p>Showing the first 20,000 notes. Use folder search for more.</p>}
      {!loading && !error && tree.length === 0 && <p className="empty">{filter ? "No matching paths." : "This vault is empty."}</p>}{renderedTree}{capped && <p>Showing up to 2,000 rows; refine your filter to see more.</p>}</div>
  </section>;
}
