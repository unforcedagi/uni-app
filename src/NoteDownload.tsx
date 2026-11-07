// T-204: "Download .md" for a note: the system Save dialog on desktop, Downloads
// on Android, plus Share there. The small menu beside it holds Share and the
// front matter toggle (off by default, remembered).
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { announce } from "./clipboard";
import { currentUserAgent, platformName } from "./interface/selftest/gate";
import { downloadName, frontmatterPref, markdownFile, setFrontmatterPref, type NoteDates } from "./noteFile";

export type DownloadableNote = NoteDates & { id: string; content?: string };

/** The error as the user reads it: Rust's own "Couldn't save …" as it is, anything else after "Couldn't <what>:". */
const said = (e: unknown, what: string) => /^Couldn't /.test(String(e)) ? String(e) : `Couldn't ${what}: ${String(e)}`;

/** `compact`: T-200's note beside the chat, whose bar is narrow: a short label, the same name for screen readers. */
export default function NoteDownload({ note, title, compact = false, extra, markdown = true }: { note: DownloadableNote; title: string; compact?: boolean;
  /** 0.2: the note page's other tools, in one More menu with Download (and Share on Android); `markdown`: a note that downloads as .md */ extra?: { label: string; run: () => void }[]; markdown?: boolean }) {
  const android = platformName(currentUserAgent()) === "android";
  const [frontmatter, setFrontmatter] = useState(frontmatterPref);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  const file = () => ({ name: downloadName(title, note.id), text: markdownFile(note.content ?? "", note, frontmatter) });

  async function download() {
    setBusy(true);
    try {
      const saved = await invoke<string | null>("note_download", file());
      if (saved) announce(`Saved to ${saved}`);
    } catch (e) {
      announce(said(e, "save"));
    } finally { setBusy(false); }
  }

  async function share() {
    setOpen(false);
    try { await invoke("note_share", { ...file(), title }); } catch (e) { announce(said(e, "share")); }
  }

  // 0.2: one quiet "More" beside Edit holds the note's other tools (a new note beside it, Copy, Download, Share, the front matter toggle)
  if (extra) return <div className="note-download note-more" ref={box}>
    <button className="note-action note-more-go" aria-label="More for this note" title="More" aria-expanded={open} onClick={() => setOpen((o) => !o)}><span aria-hidden="true">⋯</span></button>
    {open && <div className="note-download-menu note-more-menu" role="group" aria-label="Note actions">
      {extra.map((x) => <button key={x.label} onClick={() => { setOpen(false); x.run(); }}>{x.label}</button>)}
      {markdown && <button disabled={busy} onClick={() => { setOpen(false); void download(); }}>Download .md</button>}
      {markdown && android && <button onClick={() => void share()}>Share…</button>}
      {markdown && <label className="note-download-toggle">
        <input type="checkbox" checked={frontmatter} onChange={(e) => { setFrontmatter(e.target.checked); setFrontmatterPref(e.target.checked); }} />
        Add path and dates (front matter)
      </label>}
    </div>}
  </div>;
  return <div className="note-download" ref={box}>
    <button className="note-action note-download-go" disabled={busy} onClick={() => void download()} aria-label="Download .md" title="Download .md">{compact ? "↓ .md" : <><span className="only-wide">Download .md</span><span className="only-narrow">↓ .md</span></>}</button>
    <button className="note-action note-download-more" aria-label="Download options" aria-expanded={open} onClick={() => setOpen((o) => !o)}>▾</button>
    {open && <div className="note-download-menu" role="group" aria-label="Download settings">
      {android && <button onClick={() => void share()}>Share…</button>}
      <label className="note-download-toggle">
        <input type="checkbox" checked={frontmatter} onChange={(e) => { setFrontmatter(e.target.checked); setFrontmatterPref(e.target.checked); }} />
        Add path and dates (front matter)
      </label>
    </div>}
  </div>;
}
