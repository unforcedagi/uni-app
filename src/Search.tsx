// T-335 the shape: search starts where you are. Messages come from this device's SQLite FTS index (current text:
// edits applied, deletions excluded); notes from the Parachute vaults, signed with this device's Nostr key (NIP-98).
// What it finds is grouped by place, each place saying where it lives; matches in other places are never blended in,
// only counted under "Also in". Nothing here: Ask Uni. See docs/ask-everything.md and src/shape/searchScope.ts.
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { markParts, SNIPPET_START, snippetSegments } from "./searchCore";
import type { NoteHit, SearchHit } from "./searchCore";
import { ANY_VAULT, group, hereNotes, scopeOf, split } from "./shape/searchScope";
import type { Hit, SearchCtx, Where } from "./shape/searchScope";
import type { NavRecent } from "./navContext";
import "./shape/search.css";

export type { NoteHit, SearchHit } from "./searchCore";
export type { Where } from "./shape/searchScope";

const DEBOUNCE_MS = 250;
const NOTE_DEBOUNCE_MS = 450;
/** Hits shown per place before "N more". */
const PER_PLACE = 5;
const when = (ts: number) => new Date(ts * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const HOME: Where = { kind: "home" };
const NO_ROOMS: readonly { id: string; name: string }[] = [];

/** React text and <mark> nodes only: message and note text is data, never HTML. */
function Marked({ text, q }: { text: string; q: string }) {
  const parts = text.includes(SNIPPET_START) ? snippetSegments(text) : markParts(text, q);
  return <>{parts.map((s, i) => s.hit ? <mark key={i}>{s.text}</mark> : <Fragment key={i}>{s.text}</Fragment>)}</>;
}

const KEY_ITEMS = ".sh-find-back, .search-hit, .sh-find-more, .search-recent button, .sh-find-also-place, .sh-find-ask-btn";
/** ↑ and ↓ move between the results (and from the field to the first); Enter opens the one in focus. */
function moveFocus(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  // only from the query field or a result: the mode buttons keep their own keys
  if (!(e.target instanceof HTMLElement) || !e.target.matches(KEY_ITEMS + ", input[type=search]")) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>(KEY_ITEMS)];
  if (!items.length) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  const field = e.currentTarget.querySelector<HTMLInputElement>("input[type=search]");
  e.preventDefault();
  if (e.key === "ArrowUp" && at <= 0) { field?.focus(); return; }
  items[e.key === "ArrowDown" ? Math.min(items.length - 1, at + 1) : at - 1]?.focus();
}

export default function Search({ onOpen, onOpenNote, onAskUni, askIn = null, onClose, vaults, initialQuery = "", initialVault = "", initialPathPrefix = "", onQuery, recent = [],
  where, rooms = NO_ROOMS, journal = null, primaryVault = null, showCancel = false }: {
  vaults: string[];
  /** Each change of the query, so Find can open on it again. */
  onQuery?: (query: string) => void;
  /** The places visited lately, shown before anything is typed. */
  recent?: readonly NavRecent[];
  initialQuery?: string;
  /** Old way to open on a vault (and folder): used only when `where` is not given. */
  initialVault?: string;
  initialPathPrefix?: string;
  /** T-335 the shape: where the person is; search starts there. Default: home (rooms and the journal). */
  where?: Where;
  /** The rooms on this device, for room names and the home scope. */
  rooms?: readonly { id: string; name: string }[];
  /** The journal's vault and path prefix ("Journal/"); null: the journal isn't a place of its own. */
  journal?: { vault: string; prefix: string } | null;
  /** The vault called "your main vault". */
  primaryVault?: string | null;
  /** A Cancel button beside the field (the new shell); off where a frame already has Close. */
  showCancel?: boolean;
  onOpen: (target: { channel: string; root: string | null; focus: string }) => void;
  onOpenNote: (hit: NoteHit) => void;
  /** Hand a query to the Uni of the room you were last in; resolves true once posted. */
  onAskUni: (query: string) => Promise<boolean>;
  /** That room's name (no #), or null: no room to ask in. */ askIn?: string | null;
  onClose: () => void;
}) {
  const here: Where = where ?? (initialVault ? { kind: "vault", vault: initialVault, pathPrefix: initialPathPrefix || null } : HOME);
  const ctx: SearchCtx = useMemo(() => ({ rooms, vaults, journal, primaryVault, here }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rooms, vaults.join("\n"), journal?.vault, journal?.prefix, primaryVault, here.kind, "id" in here ? here.id : "", "vault" in here ? here.vault : "", "pathPrefix" in here ? here.pathPrefix : ""]);
  // An old caller (no `where`, no journal) searched every room and every note: keep that scope for it.
  const legacy = !where && journal === null && !initialVault;
  const scope = legacy ? { label: "rooms and notes", placeIds: [...scopeOf(here, ctx).placeIds, ANY_VAULT] } : scopeOf(here, ctx);
  const narrow = hereNotes(here, ctx);
  const narrowKey = narrow ? `${narrow.vault}\n${narrow.pathPrefix ?? ""}` : "";
  // In one room, the message search still spans every room on this device (the store has no room filter), so it asks
  // for more and keeps that room's hits on the client; elsewhere 60 is plenty.
  const msgLimit = here.kind === "room" ? 200 : 60;

  const [mode, setMode] = useState<"meaning" | "keyword">("meaning");
  const [query, setQuery] = useState(initialQuery);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [state, setState] = useState<"idle" | "searching" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [notes, setNotes] = useState<NoteHit[]>([]);
  const [noteState, setNoteState] = useState<"idle" | "searching" | "done" | "error">("idle");
  /** the query each answer was for: state stays "done" through the wait before the next search */
  const [msgFor, setMsgFor] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  /** the search across every vault came back full (its limit), so counts from it may be short */
  const [notesCapped, setNotesCapped] = useState(false);
  const [retry, setRetry] = useState(0);
  /** a place tapped under "Also in": its matches show, with a way back */
  const [focus, setFocus] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { input.current?.focus(); }, []);
  // a query Find was opened with (from a note, the vault) is the one it reopens on too
  useEffect(() => { if (initialQuery) onQuery?.(initialQuery); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setOpen(new Set()); }, [query, focus]);

  useEffect(() => {
    const q = query.trim();
    if (!q) { setHits([]); setState("idle"); setError(null); return; }
    let current = true;
    const t = setTimeout(() => {
      setState("searching");
      invoke<SearchHit[]>("search", { query: q, limit: msgLimit })
        .then((rows) => { if (current) { setHits(rows); setState("done"); setError(null); setMsgFor(q); } })
        .catch((e) => { if (current) { setError(String(e)); setState("error"); } });
    }, DEBOUNCE_MS);
    return () => { current = false; clearTimeout(t); };
  }, [query, retry, msgLimit]);

  // Vault search is a network round-trip (embedding + fan-out), so it waits a little longer than the local index.
  // One call across every vault (vault: null; the hub fans out) counts "also in"; when the scope is narrower (the
  // journal, an applet's folder, one vault) a second call asks that place alone, so its matches aren't crowded out of
  // the shared top 20. Two calls at most per query; one when the scope has no notes (a room).
  useEffect(() => {
    const q = query.trim();
    if (!q) { setNotes([]); setNoteState("idle"); setNoteError(null); return; }
    let current = true;
    const t = setTimeout(() => {
      setNoteState("searching");
      const all = invoke<NoteHit[]>("vault_search", { query: q, limit: 20, mode, vault: null, pathPrefix: null });
      const mine = narrow ? invoke<NoteHit[]>("vault_search", { query: q, limit: 20, mode, vault: narrow.vault, pathPrefix: narrow.pathPrefix }) : Promise.resolve([]);
      Promise.allSettled([mine, all]).then(([a, b]) => {
        if (!current) return;
        const rows = [...(a.status === "fulfilled" ? a.value : []), ...(b.status === "fulfilled" ? b.value : [])];
        // the call that feeds what shows here decides the error; the other only counts "also in"
        const failed = narrow ? a : b;
        setNotes(rows); setNotesCapped(b.status === "fulfilled" && b.value.length >= 20); setNoteFor(q);
        if (failed.status === "rejected") { setNoteError(String(failed.reason)); setNoteState("error"); } else { setNoteError(null); setNoteState("done"); }
      });
    }, NOTE_DEBOUNCE_MS);
    return () => { current = false; clearTimeout(t); };
  }, [query, mode, narrowKey, retry]); // eslint-disable-line react-hooks/exhaustive-deps

  async function ask() {
    const q = query.trim();
    if (!q || asking) return;
    setAsking(true);
    try { if (await onAskUni(q)) setAsked(q); } finally { setAsking(false); }
  }

  const q = query.trim();
  const groups = useMemo(() => group({ messages: hits, notes }, ctx), [hits, notes, ctx]);
  const focused = focus ? groups.find((g) => g.place.id === focus) ?? null : null;
  const shown = split(groups, scope.placeIds, focused ? focus : null);
  const label = focused ? focused.place.name : scope.label;
  const notesInScope = legacy || !!narrow || (!!focused && !focused.place.id.startsWith("room:"));
  const msgSettled = (state === "done" && msgFor === q) || state === "error";
  const notesSettled = noteState === "error" || (noteState === "done" && noteFor === q);
  const settled = msgSettled && notesSettled;
  /** a search that feeds this scope failed: "nothing here" would not be true */
  const unsure = state === "error" || (noteState === "error" && notesInScope);
  const msgCapped = hits.length >= msgLimit;
  const byWords = mode === "meaning" && shown.here.some((g) => g.hits.some((h) => h.open.kind === "note")) && shown.here.every((g) => g.hits.every((h) => h.open.kind !== "note" || h.open.note.mode === "keyword"));

  /** a count from a search that hit its limit is a floor, shown "N+" */
  const capped = (id: string) => id.startsWith("room:") ? msgCapped : notesCapped;

  function openHit(h: Hit) {
    if (h.open.kind === "message") onOpen(h.open.target); else onOpenNote(h.open.note);
  }

  const askBlock = (primary: boolean) => <div className={`sh-find-ask${primary ? " search-nothing" : ""}`}>
    <p>{!primary ? "Not what you meant?" : unsure ? <>Couldn't search all of {label}. Uni can look for “{q}”.</> : <>Nothing in {label} for “{q}”.</>}</p>
    {askIn ? <button type="button" className={`sh-find-ask-btn${primary ? " is-primary" : ""}`} title={`Ask Uni in #${askIn}`} onClick={() => void ask()} disabled={asking || asked === q}>
      {asked === q ? `✓ Asked in #${askIn}` : asking ? "Asking…" : "Ask Uni"}</button>
      : primary && <small>Open a room, and its Uni can look for you there.</small>}
  </div>;

  return <section className="search-view sh-find" aria-label="Search" onKeyDown={moveFocus}>
    <div className="search-bar sh-find-top">
      <label className="search-field"><span aria-hidden="true">✧</span>
        <input ref={input} type="search" value={query} onChange={(e) => { setQuery(e.target.value); setFocus(null); onQuery?.(e.target.value); }} onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
          placeholder={`Search ${label}`} aria-label={`Search ${label}`} autoCapitalize="off" autoCorrect="off" spellCheck={false} maxLength={500} />
      </label>
      {showCancel && <button type="button" className="sh-find-cancel" onClick={onClose}>Cancel</button>}
    </div>
    <p className="sh-find-scope">Searching <b>{label}</b>{byWords && " · by exact words"}</p>
    {notesInScope && <details className="search-narrow sh-find-mode" open={mode !== "meaning" || undefined}>
      <summary>How notes match</summary>
      <div className="search-filters" role="group" aria-label="How notes match">{(["meaning", "keyword"] as const).map((m) => <button key={m} type="button" className="note-action" aria-pressed={mode === m} onClick={() => setMode(m)}>{m === "meaning" ? "Similar meaning" : "Exact words"}</button>)}</div>
    </details>}
    <div className="search-results sh-find-results" aria-live="polite">
      {focused && <button type="button" className="sh-find-back" onClick={() => setFocus(null)}>‹ Back to {scope.label}</button>}
      {!q && recent.length > 0 && <>
        <h2 className="search-recent-h">Recent places</h2>
        <ul className="search-recent">{recent.slice(0, 5).map((r) => <li key={r.key}><button type="button" onClick={() => { r.go(); onClose(); }}>{r.title}</button></li>)}</ul>
      </>}
      {q && <>
        {state === "error" && <div className="note-error" role="alert"><p>Couldn't search messages just now. <button type="button" className="cp-retry" onClick={() => setRetry((n) => n + 1)}>Retry</button></p>
          {error && <details className="note-error-more"><summary>Details</summary><p className="note-error-detail">{error}</p></details>}</div>}
        {noteState === "error" && notesInScope && <div className="note-error search-notes" role="alert"><p>Couldn't reach your vaults just now. <button type="button" className="cp-retry" onClick={() => setRetry((n) => n + 1)}>Retry</button></p>
          {noteError && <details className="note-error-more"><summary>Details</summary><p className="note-error-detail">{noteError}</p></details>}</div>}
        {!settled && !shown.here.length && state !== "error" && <p className="sh-find-wait" role="status">Searching…</p>}
        {shown.here.map((g) => {
          const all = open.has(g.place.id), list = all ? g.hits : g.hits.slice(0, PER_PLACE);
          return <div key={g.place.id} className="search-group sh-find-group">
            <h3 className="sh-find-head"><b>{g.place.name}</b>{g.place.where && <span>{g.place.where}</span>}</h3>
            {list.map((h) => <button key={h.key} type="button" className="search-hit sh-find-hit" onClick={() => openHit(h)}
              aria-label={h.open.kind === "message" ? `${h.title} in ${g.place.name}${h.meta.includes("in thread") ? " thread" : ""}${h.ts ? `, ${when(h.ts)}` : ""}` : `Note ${h.open.note.path || h.open.note.id} in ${g.place.name}`}>
              <span className="search-hit-meta sh-find-hit-title"><strong><Marked text={h.title} q={q} /></strong>
                {h.open.kind === "message" && h.meta.map((m) => <span key={m} className="search-tag">{m}</span>)}
                {h.ts !== null && <time>{when(h.ts)}</time>}</span>
              {h.open.kind === "note" && h.meta[0] && <span className="search-path">{h.meta[0]}</span>}
              <span className="search-snippet"><Marked text={h.text} q={q} /></span>
            </button>)}
            {g.hits.length > PER_PLACE && !all && <button type="button" className="sh-find-more" onClick={() => setOpen(new Set([...open, g.place.id]))}>{g.hits.length - PER_PLACE} more in {g.place.name}</button>}
          </div>;
        })}
        {shown.also.length > 0 && <div className="sh-find-also"><span>Also in:</span>
          {shown.also.map((a, i) => <Fragment key={a.place.id}>{i > 0 && <span aria-hidden="true">·</span>}
            <button type="button" className="sh-find-also-place" aria-label={`${a.place.name}, ${a.count}${capped(a.place.id) ? " or more" : ""} ${a.count === 1 ? "match" : "matches"}`} onClick={() => setFocus(a.place.id)}>{a.place.name} <b>{a.count}{capped(a.place.id) && "+"}</b></button></Fragment>)}
        </div>}
        {settled && (shown.here.length ? !shown.also.length && askBlock(false) : askBlock(true))}
      </>}
    </div>
    <p className="search-keys" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd>move</span><span><kbd>↵</kbd>open</span><span><kbd>esc</kbd>close</span></p>
  </section>;
}
