// In-app view of one Parachute vault note, rendered with Parachute's own
// surface-render so a note looks the same here as in the Parachute app.
// Read-only (Step 0 of "Uni app — surface architecture"): the note comes from
// the Rust `vault_note` command over the hub's NIP-98 /mcp door; no token or
// key reaches the WebView. Vault media (/api/storage/…) is not wired yet.

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { NoteRenderer, type LinkComponentProps } from "@openparachute/surface-render";
import type { Note } from "@openparachute/surface-client";
import { safeHref } from "./markdown";
import { noteUrl, parseNoteRoute, parseNoteUrl, wikilinkResolver, type VaultRef } from "./vaultlinks";

type VaultNote = { hub: string; vault: string; note: Note };

function openExternal(url: string) {
  void invoke("open_link", { url }).catch(() => {});
}

function title(note: Note): string {
  const h1 = /^#\s+(.+)$/m.exec(note.content ?? "")?.[1]?.trim();
  return h1 || note.path?.split("/").pop() || note.id;
}

export default function NoteView({ target, hub, onOpen, onBack, depth }: {
  target: VaultRef;
  /** Configured hub origin (fallback URL when the note can't be read). */
  hub: string | null;
  onOpen: (ref: VaultRef, href: string | null) => void;
  onBack: () => void;
  /** How many notes deep we are (back label). */
  depth: number;
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
  const tags = note?.tags ?? [];
  const when = note?.updatedAt ?? note?.createdAt;

  return <>
    <header className="conversation-header">
      <button className="back icon-button" onClick={onBack} aria-label={depth > 1 ? "Back to previous note" : "Back"}>‹</button>
      <div><strong>{note ? title(note) : target.ref.split("/").pop()}</strong><small>{note?.path ? `${data!.vault} · ${note.path}` : `${target.vault} · ${note ? "note" : "opening…"}`}</small></div>
      {webUrl && <button className="icon-button" onClick={() => openExternal(webUrl)} aria-label="Open in Parachute" title="Open in Parachute">↗</button>}
    </header>
    <div className="note-scroll">
      <article className="note-page">
        {!data && !error && <p className="empty">Opening note…</p>}
        {error && <div className="note-error" role="alert">
          <p>Couldn't open this note from the app.</p>
          <p className="note-error-detail">{error}</p>
          {webUrl && <button className="pairing-secondary" onClick={() => openExternal(webUrl)}>Open in Parachute</button>}
        </div>}
        {note && <>
          {(tags.length > 0 || when) && <p className="note-meta">
            {tags.map((t) => <span key={t} className="note-tag">#{t}</span>)}
            {when && <time>{new Date(when).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</time>}
          </p>}
          <NoteRenderer note={note} className="md note-body" resolve={resolve} linkComponent={Link} />
          <footer className="note-footer">
            {webUrl && <button className="pairing-secondary" onClick={() => openExternal(webUrl)}>Open in Parachute ↗</button>}
          </footer>
        </>}
      </article>
    </div>
  </>;
}
