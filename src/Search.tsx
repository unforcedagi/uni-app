// "Ask everything": one search surface. Messages come from the local SQLite
// FTS index (current text — edits applied, deletions excluded). Notes live in
// the Parachute vault, which this app holds no credentials for (by design), so
// the Notes section hands the query to Uni instead. See docs/ask-everything.md.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { groupByRoom, hitTarget, snippetSegments } from "./search";

export type SearchHit = {
  message: { ref: string; channel: string; author: string; author_name: string; ts: number; body: string; root: string | null; edited: boolean };
  channel_name: string;
  snippet: string;
};

const DEBOUNCE_MS = 250;
const when = (ts: number) => new Date(ts * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function Snippet({ text }: { text: string }) {
  // React text nodes only: message text is data, never HTML.
  return <>{snippetSegments(text).map((s, i) => s.hit ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>)}</>;
}

export default function Search({ onOpen, onAskUni, onClose }: {
  onOpen: (target: { channel: string; root: string | null; focus: string }) => void;
  /** Hand a notes query to Uni in #Uni; resolves true once posted. */
  onAskUni: (query: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [state, setState] = useState<"idle" | "searching" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
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
    <div className="search-results" aria-live="polite">
      {!q && <div className="search-empty">
        <p><strong>Ask everything.</strong> Search the messages cached on this phone — every room and thread, including edits.</p>
        <p>Your Parachute notes are searched by meaning through Uni.</p>
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
        <h2 className="search-section">Notes <span className="search-soon">coming soon</span></h2>
        <div className="search-notes">
          <p>Meaning search over your Parachute vault isn't on this device yet — the app holds no vault key. Uni can search it for you and reply in #Uni.</p>
          <button className="send" onClick={() => void ask()} disabled={asking || asked === q}>{asked === q ? "✓ Asked Uni" : asking ? "Asking…" : "✦ Ask Uni to search my notes"}</button>
        </div>
      </>}
    </div>
  </section>;
}
