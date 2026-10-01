import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { buildVaultTree, restoreExpanded, type NotePath, type VaultTree } from "./vaultTree";

export default function VaultBrowser({ vault, onOpen, onCreate, onSearch, onBack }: {
  vault: string; onOpen: (note: NotePath) => void; onCreate: (folder: string) => void;
  onSearch: (prefix: string) => void; onBack: () => void;
}) {
  const [paths, setPaths] = useState<NotePath[]>([]);
  const [filter, setFilter] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const key = `uni.vaultExpanded.v1:${vault}`;
  const [expanded, setExpanded] = useState(() => { try { return restoreExpanded(localStorage.getItem(key)); } catch { return new Set<string>(); } });
  useEffect(() => {
    let live = true;
    setLoading(true); setError(null);
    invoke<NotePath[]>("vault_paths", { vault }).then((rows) => { if (live) setPaths(rows); })
      .catch((e) => { if (live) setError(String(e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [vault, refresh]);
  function toggle(path: string) {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path); else next.add(path);
    setExpanded(next);
    try { localStorage.setItem(key, JSON.stringify([...next])); } catch { /* session still works */ }
  }
  const tree = useMemo(() => buildVaultTree(paths, filter), [paths, filter]);
  const actions = (folder: string) => <span className="vault-folder-actions">
    <button onClick={() => onCreate(folder)}>New note here</button>
    <button onClick={() => onSearch(folder ? `${folder}/` : "")}>Search in this folder</button>
  </span>;
  function rows(nodes: VaultTree[]) {
    return <ul className="vault-tree">{nodes.map((node) => <li key={node.path}>
      {node.folder ? <>
        <div className="vault-folder"><button aria-expanded={!!filter || expanded.has(node.path)} onClick={() => toggle(node.path)}>{filter || expanded.has(node.path) ? "▾" : "▸"} {node.name}</button>{actions(node.path)}</div>
        {(filter || expanded.has(node.path)) && <>{node.note && <button className="vault-note" onClick={() => onOpen(node.note!)}>{node.name} <small>· index</small></button>}{rows(node.children)}</>}
      </> : node.note && <button className="vault-note" onClick={() => onOpen(node.note!)}>{node.name}</button>}
    </li>)}</ul>;
  }
  return <section className="vault-browser" aria-label={`Vault ${vault}`}>
    <header className="note-bar"><button className="note-action" onClick={onBack}>← Vaults</button><strong>{vault}</strong><button className="note-action" disabled={loading} onClick={() => setRefresh((n) => n + 1)}>Refresh</button></header>
    <div className="vault-toolbar"><input type="search" aria-label="Filter paths" placeholder="Filter paths" value={filter} onChange={(e) => setFilter(e.target.value)} />{actions("")}</div>
    <div className="vault-scroll">{loading && <p role="status">Loading paths…</p>}{error && <p className="error" role="alert">{error}</p>}
      {paths.length >= 20_000 && <p>Showing the first 20,000 notes. Use folder search for more.</p>}
      {!loading && !error && tree.length === 0 && <p className="empty">{filter ? "No matching paths." : "This vault is empty."}</p>}{rows(tree)}</div>
  </section>;
}
