// "Ask everything": one search surface. Messages come from the local SQLite
// FTS index (current text — edits applied, deletions excluded). Notes are
// searched by meaning in the Parachute vault, signed with this device's Nostr
// key (NIP-98) — the same door as the Journal. Uni is the fallback when the
// hub can't be reached. See docs/ask-everything.md.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { groupByRoom, hitTarget, plainSnippet, snippetSegments } from "./searchCore";
import type { NavRecent } from "./navContext";

export type NoteHit = { vault: string; id: string; path: string; snippet: string; score: number | null; mode: "meaning" | "keyword" };

export type SearchHit = {
  message: { ref: string; channel: string; author: string; author_name: string; ts: number; body: string; root: string | null; edited: boolean };
  channel_name: string;
  snippet: string;
};

const DEBOUNCE_MS = 250;
const NOTE_DEBOUNCE_MS = 450;
const when = (ts: number) => new Date(ts * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function Snippet({ text }: { text: string }) {
  // React text nodes only: message text is data, never HTML.
  return <>{snippetSegments(text).map((s, i) => s.hit ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>)}</>;
}

/** T-335 glow-up: ↑ and ↓ move between the results (and from the field to the first); Enter opens the one in focus. */
function moveFocus(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  // only from the query field or a result: the Narrow controls (a select, the folder field) keep their own arrow keys
  if (!(e.target instanceof HTMLElement) || !e.target.matches("input[type=search], .search-hit, .search-recent button")) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>(".search-hit, .search-recent button")];
  if (!items.length) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  const field = e.currentTarget.querySelector<HTMLInputElement>("input[type=search]");
  e.preventDefault();
  if (e.key === "ArrowUp" && at <= 0) { field?.focus(); return; }
  items[e.key === "ArrowDown" ? Math.min(items.length - 1, at + 1) : at - 1]?.focus();
}

export default function Search({ onOpen, onOpenNote, onAskUni, onClose, vaults, initialQuery = "", initialVault = "", initialPathPrefix = "", onQuery, recent = [] }: {
  vaults: string[];
  /** T-335 glow-up: each change of the query, so Find can open on it again */
  onQuery?: (query: string) => void;
  /** T-335 glow-up: the places visited lately, shown before anything is typed */
  recent?: readonly NavRecent[];
  initialQuery?: string;
  initialVault?: string;
  initialPathPrefix?: string;
  onOpen: (target: { channel: string; root: string | null; focus: string }) => void;
  onOpenNote: (hit: NoteHit) => void;
  /** Hand a notes query to Uni in #Uni; resolves true once posted. */
  onAskUni: (query: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"meaning" | "keyword">("meaning");
  const [vault, setVault] = useState(initialVault);
  const [pathPrefix, setPathPrefix] = useState(initialPathPrefix);
  const [query, setQuery] = useState(initialQuery);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [state, setState] = useState<"idle" | "searching" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [notes, setNotes] = useState<NoteHit[]>([]);
  const [noteState, setNoteState] = useState<"idle" | "searching" | "done" | "error">("idle");
  const [noteError, setNoteError] = useState<string | null>(null);
  /** r21 (Codex 7): Retry after a failed search runs both searches again */
  const [retry, setRetry] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { input.current?.focus(); }, []);
  // T-335 glow-up: a query Find was opened with (from a note, the vault) is the one it reopens on too
  useEffect(() => { if (initialQuery) onQuery?.(initialQuery); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const q = query.trim();
    if (!q) { setHits([]); setState("idle"); setError(null); return; }
    let current = true;
    const t = setTimeout(() => {
      setState("searching");
      invoke<SearchHit[]>("search", { query: q, limit: 60 })
        .then((rows) => { if (current) { setHits(rows); setState("done"); setError(null); } })
        .catch((e) => { if (current) { setError(String(e)); setState("error"); } });
    }, DEBOUNCE_MS);
    return () => { current = false; clearTimeout(t); };
  }, [query, retry]);

  // Vault search is a network round-trip (embedding + fan-out), so it waits a
  // little longer than the local index before firing.
  useEffect(() => {
    const q = query.trim();
    if (!q) { setNotes([]); setNoteState("idle"); setNoteError(null); return; }
    let current = true;
    const t = setTimeout(() => {
      setNoteState("searching");
      invoke<NoteHit[]>("vault_search", { query: q, limit: 20, mode, vault: vault.trim() || null, pathPrefix: pathPrefix || null })
        .then((rows) => { if (current) { setNotes(rows); setNoteState("done"); setNoteError(null); } })
        .catch((e) => { if (current) { setNotes([]); setNoteError(String(e)); setNoteState("error"); } });
    }, NOTE_DEBOUNCE_MS);
    return () => { current = false; clearTimeout(t); };
  }, [query, mode, vault, pathPrefix, retry]);

  async function ask() {
    const q = query.trim();
    if (!q || asking) return;
    setAsking(true);
    try { if (await onAskUni(q)) setAsked(q); } finally { setAsking(false); }
  }

  const q = query.trim();
  const groups = groupByRoom(hits);

  // r15: inside the utility frame (its title and Close are the frame's): one field that shrinks with the panel, plain words, and the
  // narrowing (how notes match, which vault, which folder) folded under "Narrow" so a narrow panel never scrolls sideways
  const narrowed = mode !== "meaning" || !!vault || !!pathPrefix;
  return <section className="search-view" aria-label="Search conversations and notes" onKeyDown={moveFocus}>
    <div className="search-bar">
      <label className="search-field"><span aria-hidden="true">✧</span>
        <input ref={input} type="search" value={query} onChange={(e) => { setQuery(e.target.value); onQuery?.(e.target.value); }} onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
          placeholder="Conversations and notes" aria-label="Search conversations and notes" autoCapitalize="off" autoCorrect="off" spellCheck={false} maxLength={500} />
      </label>
    </div>
    <details className="search-narrow" open={narrowed || undefined}>
      <summary>Filters</summary>
      <div className="search-filters"><div role="group" aria-label="How notes match">{(["meaning", "keyword"] as const).map((m) => <button key={m} className="note-action" aria-pressed={mode === m} onClick={() => setMode(m)}>{m === "meaning" ? "Similar meaning" : "Exact words"}</button>)}</div>
      <label>Vault <select value={vault} onChange={(e) => setVault(e.target.value)}><option value="">All vaults</option>{[...new Set([...vaults, ...(initialVault ? [initialVault] : [])])].map((v) => <option key={v} value={v}>{v}</option>)}</select></label>
      <label>Folder <input value={pathPrefix} placeholder="Any folder" onChange={(e) => setPathPrefix(e.target.value)} /></label></div>
    </details>
    <div className="search-results" aria-live="polite">
      {!q && recent.length > 0 && <>
        <h2 className="search-recent-h">Recent places</h2>
        <ul className="search-recent">{recent.slice(0, 5).map((r) => <li key={r.key}><button type="button" onClick={() => { r.go(); onClose(); }}>{r.title}</button></li>)}</ul>
      </>}
      {!q && !recent.length && <p className="search-empty">Every room on this device, and your notes.</p>}
      {q && <>
        {/* one line when nothing is found anywhere, a section only for what has something to show */}
        {state === "done" && noteState === "done" && hits.length === 0 && notes.length === 0 ? <div className="search-nothing"><p>Nothing here for “{q}”.</p><small>Only rooms already on this device are searched; older history may not be here yet.</small><button type="button" className="note-action" onClick={() => void ask()} disabled={asking || asked === q}>{asked === q ? "✓ Asked Uni" : asking ? "Asking…" : "Ask Uni to look"}</button></div>
        : (state !== "done" || hits.length > 0) && <h2 className="search-section">Messages{state === "searching" ? " · searching…" : state === "done" ? ` · ${hits.length}${hits.length >= 60 ? "+" : ""}` : ""}</h2>}
        {/* r21 (Codex 7): a failed search says so in words, with Retry; the technical reason is a detail */}
        {state === "error" && <div className="note-error" role="alert"><p>Couldn't search messages just now. <button type="button" className="cp-retry" onClick={() => setRetry((n) => n + 1)}>Retry</button></p>
          {error && <details className="note-error-more"><summary>Details</summary><p className="note-error-detail">{error}</p></details>}</div>}
                {groups.map((g) => <div key={g.channel} className="search-group">
          <h3>#{g.name}</h3>
          {g.hits.map((h) => {
            const t = hitTarget(h.message);
            return <button key={h.message.ref} className="search-hit" onClick={() => onOpen(t)}
              aria-label={`${h.message.author_name} in ${g.name}${t.root ? " thread" : ""}, ${when(h.message.ts)}`}>
              <span className="search-hit-meta"><strong>{h.message.author_name}</strong>{t.root && <span className="search-tag">in thread</span>}{h.message.edited && <span className="search-tag">edited</span>}<time>{when(h.message.ts)}</time></span>
              <span className="search-snippet"><Snippet text={h.snippet} /></span>
            </button>;
          })}
        </div>)}
        {(noteState !== "done" || notes.length > 0) && <h2 className="search-section">Notes{noteState === "searching" ? " · searching…" : noteState === "done" ? ` · ${notes.length}` : ""}</h2>}
                {notes.length > 0 && <div className="search-group">
          {notes.map((n) => <button key={`${n.vault}:${n.id}`} className="search-hit" onClick={() => onOpenNote(n)}
            aria-label={`Note ${n.path || n.id} in ${n.vault}`}>
            <span className="search-hit-meta"><strong>{n.path.split("/").pop() || n.id}</strong><span className="search-tag">{n.vault}</span></span>
            {n.path.includes("/") && <span className="search-path">{n.path.split("/").slice(0, -1).join(" › ")}</span>}<span className="search-snippet">{plainSnippet(n.snippet)}</span>
          </button>)}
        </div>}
        {noteState === "error" && <div className="search-notes">
          <p role="alert">Couldn't reach your vault just now. <button type="button" className="cp-retry" onClick={() => setRetry((n) => n + 1)}>Retry</button></p>
          {noteError && <details className="note-error-more"><summary>Details</summary><p className="note-error-detail">{noteError}</p></details>}
          <button className="send" onClick={() => void ask()} disabled={asking || asked === q}>{asked === q ? "✓ Asked Uni" : asking ? "Asking…" : "✦ Ask Uni to search my notes"}</button>
        </div>}
      </>}
    </div>
    <p className="search-keys" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd>move</span><span><kbd>↵</kbd>open</span><span><kbd>esc</kbd>close</span></p>
  </section>;
}
