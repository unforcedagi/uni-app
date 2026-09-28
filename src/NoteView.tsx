// In-app view of one Parachute vault note, rendered with Parachute's own
// surface-render so a note looks the same here as in the Parachute app.
// Read-only (Step 0 of "Uni app — surface architecture"): the note comes from
// the Rust `vault_note` command over the hub's NIP-98 /mcp door; no token or
// key reaches the WebView. Vault media (/api/storage/…) is not wired yet.
//
// Shown as a sheet over the chat (App keeps the chat mounted underneath, so
// Back returns to the exact scroll position).

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { NoteRenderer, type LinkComponentProps } from "@openparachute/surface-render";
import type { Note } from "@openparachute/surface-client";
import { safeHref } from "./markdown";
import { copyText } from "./clipboard";
import { bodyWithoutTitle, noteMeta, noteTitle } from "./noteText";
import { noteUrl, parseNoteRoute, parseNoteUrl, wikilinkResolver, type VaultRef } from "./vaultlinks";

type VaultNote = { hub: string; vault: string; note: Note };

function openExternal(url: string) {
  void invoke("open_link", { url }).catch(() => {});
}

export default function NoteView({ target, hub, onOpen, onBack, backLabel, onTitle }: {
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
  const [data, setData] = useState<VaultNote | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    invoke<VaultNote>("vault_note", { vault: target.vault, noteRef: target.ref })
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [target.vault, target.ref]);

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
      if (note) onOpen(note, safe);
      else if (safe) openExternal(safe);
    }}>{children}</a>;
  }, [onOpen]);

  const note = data?.note;
  const heading = note ? noteTitle(note.content, note.path, note.id) : target.ref.split("/").pop() || target.ref;
  useEffect(() => { if (note) onTitle?.(heading); }, [note, heading, onTitle]);
  // The H1 is the page title; render the rest so it isn't shown twice.
  const shown = useMemo(() => note ? { ...note, content: bodyWithoutTitle(note.content ?? "") } : null, [note]);
  const tags = note?.tags ?? [];

  return <div className="note-view">
    <header className="note-bar">
      <button className="note-back" onClick={onBack} aria-label={`Back to ${backLabel}`}>
        <span className="note-back-arrow" aria-hidden="true">←</span><span className="note-back-label">{backLabel}</span>
      </button>
      {note && <button className="note-action" onClick={() => void copyText(note.content ?? "", "Copied markdown")}>Copy markdown</button>}
    </header>
    <div className="note-scroll">
      <article className="note-page">
        <h1 className="note-title">{heading}</h1>
        <p className="note-meta-line">{note ? noteMeta(data!.vault, note.path, note.updatedAt ?? note.createdAt) : `${target.vault} · ${error ? "unavailable" : "opening…"}`}</p>
        {tags.length > 0 && <p className="note-tags">{tags.map((t) => <span key={t} className="note-tag">#{t}</span>)}</p>}
        {!data && !error && <p className="empty">Opening note…</p>}
        {error && <div className="note-error" role="alert">
          <p>Couldn't open this note from the app.</p>
          <p className="note-error-detail">{error}</p>
          {webUrl && <button className="pairing-secondary" onClick={() => openExternal(webUrl)}>Open in Parachute ↗</button>}
        </div>}
        {shown && <>
          <NoteRenderer note={shown} className="md note-body" resolve={resolve} linkComponent={Link} />
          <footer className="note-footer">
            <button className="note-quiet" onClick={() => void copyText(note!.content ?? "", "Copied markdown")}>Copy markdown</button>
            {webUrl && <button className="note-quiet" onClick={() => openExternal(webUrl)}>Open in Parachute ↗</button>}
          </footer>
        </>}
      </article>
    </div>
  </div>;
}
