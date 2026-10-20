// T-204: "Download .md" for a note: the system Save dialog on desktop, Downloads
// on Android, plus Share there. The small menu beside it holds Share and the
// front matter toggle (off by default, remembered).
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { announce } from "./clipboard";
import { currentUserAgent, platformName } from "./interface/selftest/gate";
import { downloadName, frontmatterPref, markdownFile, setFrontmatterPref, type NoteDates } from "./noteDownload";

export type DownloadableNote = NoteDates & { id: string; content?: string };

export default function NoteDownload({ note, title }: { note: DownloadableNote; title: string }) {
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
      announce(`Couldn't save: ${String(e)}`);
    } finally { setBusy(false); }
  }

  async function share() {
    setOpen(false);
    try { await invoke("note_share", { ...file(), title }); } catch (e) { announce(`Couldn't share: ${String(e)}`); }
  }

  return <div className="note-download" ref={box}>
    <button className="note-action note-download-go" disabled={busy} onClick={() => void download()}>Download .md</button>
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
