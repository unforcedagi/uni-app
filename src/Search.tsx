// "Ask everything": one search surface. Messages come from the local SQLite
// FTS index (current text — edits applied, deletions excluded). Notes are
// searched by meaning in the Parachute vault, signed with this device's Nostr
// key (NIP-98) — the same door as the Journal. Uni is the fallback when the
// hub can't be reached. See docs/ask-everything.md.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { groupByRoom, hitTarget, snippetSegments } from "./searchCore";

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

export default function Search({ onOpen, onOpenNote, onAskUni, onClose, vaults, initialVault = "", initialPathPrefix = "" }: {
  vaults: string[];
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
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [state, setState] = useState<"idle" | "searching" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [notes, setNotes] = useState<NoteHit[]>([]);
  const [noteState, setNoteState] = useState<"idle" | "searching" | "done" | "error">("idle");
  const [noteError, setNoteError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { input.current?.focus(); }, []);

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
  }, [query]);

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
  }, [query, mode, vault, pathPrefix]);

  async function ask() {
    const q = query.trim();
    if (!q || asking) return;
    setAsking(true);
    try { if (await onAskUni(q)) setAsked(q); } finally { setAsking(false); }
  }

  const q = query.trim();
  const groups = groupByRoom(hits);

  return <section className="search-view" aria-label="Ask everything">
    <div className="search-bar">
      <label className="search-field"><span aria-hidden="true">✧</span>
        <input ref={input} type="search" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
          placeholder="Search messages and notes" aria-label="Search messages and notes" autoCapitalize="off" autoCorrect="off" spellCheck={false} maxLength={500} />
      </label>
      <button className="search-cancel" onClick={onClose}>Cancel</button>
    </div>
    <div className="search-filters">
      <div role="group" aria-label="Note search mode">{(["meaning", "keyword"] as const).map((m) => <button key={m} className="note-action" aria-pressed={mode === m} onClick={() => setMode(m)}>{m === "meaning" ? "Meaning" : "Keyword"}</button>)}</div>
      <label>Vault <select value={vault} onChange={(e) => setVault(e.target.value)}><option value="">All vaults</option>{[...new Set([...vaults, ...(initialVault ? [initialVault] : [])])].map((v) => <option key={v} value={v}>{v}</option>)}</select></label>
      <label>Path prefix <input value={pathPrefix} placeholder="Any folder" onChange={(e) => setPathPrefix(e.target.value)} /></label>
    </div>
    <div className="search-results" aria-live="polite">
      {!q && <div className="search-empty">
        <p><strong>Ask everything.</strong> Search the messages cached on this phone — every room and thread, including edits.</p>
        <p>Your Parachute notes are searched by meaning, signed with your Nostr key.</p>
      </div>}
      {q && <>
        <h2 className="search-section">Messages{state === "searching" ? " · searching…" : state === "done" ? ` · ${hits.length}${hits.length >= 60 ? "+" : ""}` : ""}</h2>
        {state === "error" && <p className="error" role="alert">{error}</p>}
        {state === "done" && hits.length === 0 && <p className="search-none">No messages match “{q}”. Only messages cached on this device are searched — refresh or load older history to widen it.</p>}
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
        <h2 className="search-section">Notes{noteState === "searching" ? " · searching…" : noteState === "done" ? ` · ${notes.length}${notes.length && notes.every((n) => n.mode === "keyword") ? " · keyword" : ""}` : ""}</h2>
        {noteState === "done" && notes.length === 0 && <p className="search-none">No notes match “{q}”.</p>}
        {notes.length > 0 && <div className="search-group">
          {notes.map((n) => <button key={`${n.vault}:${n.id}`} className="search-hit" onClick={() => onOpenNote(n)}
            aria-label={`Note ${n.path || n.id} in ${n.vault}`}>
            <span className="search-hit-meta"><strong>{n.path.split("/").pop() || n.id}</strong><span className="search-tag">{n.vault}</span></span>
            <span className="search-snippet">{n.path.includes("/") && <span className="search-path">{n.path.split("/").slice(0, -1).join("/")} · </span>}{n.snippet}</span>
          </button>)}
        </div>}
        {noteState === "error" && <div className="search-notes">
          <p role="alert">Couldn't reach your vault: {noteError}</p>
          <button className="send" onClick={() => void ask()} disabled={asking || asked === q}>{asked === q ? "✓ Asked Uni" : asking ? "Asking…" : "✦ Ask Uni to search my notes"}</button>
        </div>}
      </>}
    </div>
  </section>;
}
