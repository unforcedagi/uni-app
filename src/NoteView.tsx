import NoteEditor from "./NoteEditor";
import { readDraft, clearDraft } from "./noteDrafts";
import { editableExtension, beginEdit, isDirty } from "./noteEdit";
import { backlinks } from "./backlinks";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { NoteRenderer, type LinkComponentProps, type NoteRendererProps } from "@openparachute/surface-render";
import type { NoteHit } from "./Search";
import type { Note } from "@openparachute/surface-client";
import { safeHref } from "./markdown";
import { copyText } from "./clipboard";
import NoteDownload from "./NoteDownload";
import { isMarkdownNote } from "./noteFile";
import { bodyWithoutTitle, noteMeta, noteTitle } from "./noteText";
import { inline, PLAYER_TAG, publishedFromNote, rehypePublished } from "./publishedMedia";
import { PublishedInNote, PublishedMedia, usePublishOrigins } from "./PublishedPlayer";
import { refCandidates, isNoteNotFound, noteUrl, parseNoteRoute, parseNoteUrl, wikilinkResolver, type VaultRef } from "./vaultlinks";

type VaultNote = { hub: string; vault: string; note: Note & { extension?: string } };

/** T-260: the player a published link in the body becomes (see rehypePublished). */
const MEDIA_COMPONENTS = { [PLAYER_TAG]: PublishedInNote } as NoteRendererProps["components"];

function openExternal(url: string) {
  void invoke("open_link", { url }).catch(() => {});
}

export default function NoteView({ target, hub, onOpen, onBack, backLabel, onTitle, startEditing = false, onDirty, onCreate, onResolved, onRendered, onSearch, readOnly = false, backIcon = "←", actions, compact = false }: {
  /** T-200: a note beside the chat closes rather than goes back (×), carries the pane's own buttons, and keeps to reading and editing:
   *  no New note or Copy markdown in its narrow bar (Open as page has them). T-204: Download .md stays, in short form. */
  backIcon?: string;
  actions?: ReactNode;
  compact?: boolean;
  /** r21 (Codex 5): a page that reads, not a document to edit (For you): no Edit, New note or Copy markdown until "Open as a note". */
  readOnly?: boolean;
  onSearch: (query: string) => void;
  onResolved: (id: string) => void;
  onRendered?: (note: VaultNote["note"]) => void;
  startEditing?: boolean;
  onDirty: (dirty: boolean) => void;
  onCreate: (folder: string) => void;
  target: VaultRef;
  /** Configured hub origin (fallback URL when the note can't be read). */
  hub: string | null;
  onOpen: (ref: VaultRef, href: string | null) => void;
  onBack: () => void;
  /** Where Back goes: the chat name, or the previous note's title. */
  backLabel: string;
  /** Reports the loaded title so a deeper note can label its Back with it. */
  onTitle?: (title: string) => void;
}) {
  const [editing, setEditing] = useState(startEditing);
  /** r21: a read-only page opened as its note (an explicit choice): the note's own tools appear */
  const [asNote, setAsNote] = useState(false);
  const tools = !readOnly || asNote;
  const [data, setData] = useState<VaultNote | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [missing, setMissing] = useState(false);
  /** r18: Retry reads the note again in place (a failed read is no dead end). */
  const [attempt, setAttempt] = useState(0);
  const [hits, setHits] = useState<NoteHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchQuery = target.ref.split("/").pop() || target.ref;

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    setMissing(false);
    setHits([]);
    setSearching(false);
    setSearchError(null);
    async function load() {
      const candidates = [target.ref, ...(target.recover ? refCandidates(target.ref) : [])];
      for (const noteRef of candidates) {
        if (!live) return;
        try {
          const d = await invoke<VaultNote>("vault_note", { vault: target.vault, noteRef });
          if (!live) return;
          onResolved(d.note.id);
          setData(d);
          const dirty = isDirty(beginEdit(d.note.content ?? "", d.note.updatedAt ?? null, readDraft(d.vault, d.note.id)));
          if (dirty) setEditing(true);
          else clearDraft(d.vault, d.note.id);
          onDirty(dirty);
          return;
        } catch (e) {
          if (!live) return;
          if (!isNoteNotFound(e)) { setError(String(e)); return; }
        }
      }
      if (!live) return;
      setMissing(true);
      setSearching(true);
      try {
        const rows = await invoke<NoteHit[]>("vault_search", { query: searchQuery, limit: 8, mode: "keyword", vault: target.vault, pathPrefix: null });
        if (live) setHits(rows.slice(0, 8));
      } catch (e) { if (live) setSearchError(String(e)); }
      finally { if (live) setSearching(false); }
    }
    void load();
    return () => { live = false; };
  }, [target.vault, target.ref, attempt]);

  // Report only after React commits the loaded note to the view.
  useEffect(() => { if (data) onRendered?.(data.note); }, [data]);

  const origin = data?.hub ?? target.hub ?? hub;
  const webUrl = origin ? noteUrl(origin, data?.vault ?? target.vault, data?.note.id ?? target.ref) : null;

  const resolve = useMemo(() => data ? wikilinkResolver(data.note, data.vault) : undefined, [data]);

  // Links inside the note: wikilinks and note URLs stay in the app; web and
  // mail links go to the system browser; anything else is inert text.
  const Link = useMemo(() => function NoteLink({ href, className, children }: LinkComponentProps) {
    const route = parseNoteRoute(href);
    const safe = route ? null : safeHref(href);
    const note = route ?? (safe ? parseNoteUrl(safe) : null);
    if (!note && !safe) return <span className={className}>{children}</span>;
    return <a href={safe ?? href} className={className} rel="noreferrer noopener" onClick={(e) => {
      e.preventDefault();
      if (note) onOpen(route ? { ...note, recover: true } : note, safe);
      else if (safe) openExternal(safe);
    }}>{children}</a>;
  }, [onOpen]);

  const note = data?.note;
  const heading = note ? noteTitle(note.content, note.path, note.id) : target.ref.split("/").pop() || target.ref;
  useEffect(() => { if (note) onTitle?.(heading); }, [note, heading, onTitle]);
  // The H1 is the page title; render the rest so it isn't shown twice.
  const shown = useMemo(() => note ? { ...note, content: bodyWithoutTitle(note.content ?? "") } : null, [note]);
  const tags = note?.tags ?? [];
  // T-260: a Published note plays its own file (its metadata) at the top; a published video, audio or image the body links plays
  // where it is linked, once; pages and PDFs stay links
  const origins = usePublishOrigins();
  const own = useMemo(() => { const p = note ? publishedFromNote(note, origins) : null; return p && inline(p.kind) ? p : null; }, [note, origins]);
  const rehype = useMemo(() => [[rehypePublished, { origins, shown: own ? [own.url] : [] }]] as NoteRendererProps["rehypePlugins"], [origins, own]);
  const inbound = backlinks(note?.id ?? "", note?.links);

  return <div className="note-view">
    <header className="note-bar">
      <button className="note-back" onClick={onBack} aria-label={backIcon === "←" ? `Back to ${backLabel}` : backLabel}>
        <span className="note-back-arrow" aria-hidden="true">{backIcon}</span><span className="note-back-label">{backLabel}</span>
      </button>
      {note && !tools && <button className="note-action quiet" onClick={() => setAsNote(true)}>Open as a note</button>}
      {note && tools && !editing && editableExtension(note.extension) && <button className="note-action" onClick={() => setEditing(true)}>Edit</button>}
      {note && tools && !compact && <button className="note-action" onClick={() => onCreate(note.path?.includes("/") ? note.path.slice(0, note.path.lastIndexOf("/")) : "")}>New note</button>}
      {note && tools && !editing && !compact && <button className="note-action" onClick={() => void copyText(note.content ?? "", "Copied markdown")}>Copy markdown</button>}
      {note && tools && !editing && isMarkdownNote(note.extension) && <NoteDownload note={note} title={heading} compact={compact} />}
      {actions}
    </header>
    {note && editing ? <NoteEditor vault={data!.vault} note={note} onDirty={onDirty} onCancel={() => setEditing(false)} onSaved={(updated) => { setData({ ...data!, note: { ...data!.note, ...updated } }); setEditing(false); }} /> : <div className="note-scroll">
      <article className="note-page">
        <h1 className="note-title">{heading}</h1>
        {tools && <p className="note-meta-line">{note ? noteMeta(data!.vault, note.path, note.updatedAt ?? note.createdAt) : `${target.vault} · ${error || missing ? "unavailable" : "opening…"}`}</p>}
        {tools && tags.length > 0 && <p className="note-tags">{tags.map((t) => <span key={t} className="note-tag">#{t}</span>)}</p>}
        {!data && !error && !missing && <OpeningNote key={attempt} onRetry={() => setAttempt((n) => n + 1)} onBack={onBack} backLabel={backLabel} />}
        {missing && <div className="note-error">
          <p role="status">No note named {target.ref} in {target.vault}</p>
          {searching && <p>Searching notes…</p>}
          {hits.map((hit) => <button className="vault-note" key={`${hit.vault}:${hit.id}`} onClick={() => onOpen({ hub: null, vault: hit.vault, ref: hit.id }, null)}>{hit.path || hit.id}<small>{hit.snippet}</small></button>)}
          {!searching && !hits.length && !searchError && <p>No matching notes in this vault.</p>}
          {searchError && <p role="alert">Couldn't search this vault: {searchError}</p>}
          <button className="pairing-secondary" onClick={() => onSearch(searchQuery)}>Search all vaults</button>
        </div>}
        {/* r18: a failed read says so in words, with Retry and the way back; the technical reason and the web route are details */}
        {error && <div className="note-error" role="alert">
          <p>Couldn't open this note just now.</p>
          <p className="note-error-go"><button className="task-do primary" onClick={() => setAttempt((n) => n + 1)}>Retry</button><button className="task-do quiet" onClick={onBack}>Back to {backLabel}</button></p>
          <details className="note-error-more"><summary>Details</summary>
            <p className="note-error-detail">{error}</p>
            {webUrl && <button className="pairing-secondary" onClick={() => openExternal(webUrl)}>Open in Parachute ↗</button>}
          </details>
        </div>}
        {shown && <>
          {own && <PublishedMedia m={own} />}
          <NoteRenderer note={shown} className="md note-body" resolve={resolve} linkComponent={Link} rehypePlugins={rehype} components={MEDIA_COMPONENTS} />
          {tools && <details className="note-backlinks"><summary>Linked from ({inbound.length})</summary>
            {inbound.map((link) => <button className="vault-note" key={JSON.stringify([link.id, link.relationship])} onClick={() => onOpen({ hub: null, vault: data!.vault, ref: link.id }, null)}>{link.path} <small>· {link.relationship}</small></button>)}
          </details>}
          {tools && <footer className="note-footer">
            {webUrl && <button className="note-quiet" onClick={() => openExternal(webUrl)}>Open in Parachute ↗</button>}
          </footer>}
        </>}
      </article>
    </div>}
  </div>;
}

/** r21 (Codex 7): a note slow to open says so after 8 seconds, with Retry and the way back, never "Opening note…" for good. */
function OpeningNote({ onRetry, onBack, backLabel }: { onRetry: () => void; onBack: () => void; backLabel: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => { const t = setTimeout(() => setSlow(true), 8000); return () => clearTimeout(t); }, []);
  if (!slow) return <p className="empty">Opening note…</p>;
  return <div className="note-error" role="status">
    <p>Still opening this note.</p>
    <p className="note-error-go"><button className="task-do primary" onClick={onRetry}>Retry</button><button className="task-do quiet" onClick={onBack}>Back to {backLabel}</button></p>
  </div>;
}
