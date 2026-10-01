import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Note } from "@openparachute/surface-client";
import { copyText } from "./clipboard";
import { beginEdit, changeEdit, draftKey, failedSave, isDirty, savedEdit, serializeDraft, type NoteEdit } from "./noteEdit";

// Keep drafts available across pane unmounts even when browser storage is full.
const memory = new Map<string, string | null>();
export function readDraft(vault: string, id: string): string | null {
  const key = draftKey(vault, id);
  if (memory.has(key)) return memory.get(key) ?? null;
  try { return localStorage.getItem(key); } catch { return null; }
}

export function clearDraft(vault: string, id: string) {
  memory.set(draftKey(vault, id), null);
  try { localStorage.removeItem(draftKey(vault, id)); } catch { /* session copy is cleared */ }
}

export default function NoteEditor({ vault, note, onSaved, onCancel, onDirty }: {
  vault: string; note: Note; onSaved: (note: Note) => void; onCancel: () => void; onDirty: (dirty: boolean) => void;
}) {
  const [edit, setEdit] = useState(() => beginEdit(note.content ?? "", note.updatedAt ?? null, readDraft(vault, note.id)));
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"overwrite" | "cancel" | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const key = draftKey(vault, note.id);
  function persist(next: NoteEdit) {
    setEdit(next);
    const raw = serializeDraft(next);
    memory.set(key, raw);
    try { if (raw === null) localStorage.removeItem(key); else localStorage.setItem(key, raw); }
    catch { setError("Draft is kept for this session only: local storage is unavailable."); }
    onDirty(isDirty(next));
  }
  useLayoutEffect(() => { onDirty(isDirty(edit)); }, [onDirty, edit]);
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    const resize = () => { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [edit.content]);
  async function save(force = false) {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError(null); setConfirm(null);
    try {
      const updated = await invoke<Note>("vault_save", { vault, id: note.id, content: edit.content, ifUpdatedAt: force ? null : edit.updatedAt, force });
      // A new pane may already be editing this note while this request finishes.
      // Never clear a newer draft when a previous pane's save resolves late.
      if (readDraft(vault, note.id) === serializeDraft(edit)) {
        persist(savedEdit(updated.content ?? edit.content, updated.updatedAt ?? null));
      }
      if (mounted.current) onSaved(updated);
    } catch (e) { setEdit((old) => failedSave(old, String(e))); setError(String(e)); }
    finally { saving.current = false; setBusy(false); }
  }
  function cancel() {
    persist(savedEdit(note.content ?? "", note.updatedAt ?? null));
    onCancel();
  }
  async function copyAndReload() {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError(null);
    try {
      if (!await copyText(edit.content, "Copied your draft")) { setError("Could not copy. Your draft is still here."); return; }
      const result = await invoke<{ note: Note }>("vault_note", { vault, noteRef: note.id });
      if (readDraft(vault, note.id) === serializeDraft(edit)) {
        persist(savedEdit(result.note.content ?? "", result.note.updatedAt ?? null));
      }
      if (mounted.current) onSaved(result.note);
    } catch (e) { setError(String(e)); }
    finally { saving.current = false; setBusy(false); }
  }
  return <div className="note-editor" onKeyDown={(e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); e.stopPropagation(); void save(); }
    if (e.key === "Escape") { e.stopPropagation(); if (!isDirty(edit) && !busy) { e.preventDefault(); cancel(); } }
  }}>
    <div className="editor-actions"><button className="note-action" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button><button className="note-action" disabled={busy} onClick={() => isDirty(edit) ? setConfirm("cancel") : cancel()}>Cancel</button></div>
    {edit.restored && <p role="status">Restored unsaved draft</p>}
    {edit.conflict && <div className="note-conflict" role="alert"><p>Changed elsewhere since you opened it</p><button disabled={busy} onClick={() => void copyAndReload()}>Copy mine &amp; reload theirs</button><button disabled={busy} onClick={() => setConfirm("overwrite")}>Overwrite</button></div>}
    {confirm && <div role="alertdialog" aria-label={confirm === "overwrite" ? "Confirm overwrite" : "Discard draft"}><p>{confirm === "overwrite" ? "Overwrite the latest version with your text?" : "Discard your unsaved draft?"}</p><button disabled={busy} onClick={() => confirm === "overwrite" ? void save(true) : cancel()}>{confirm === "overwrite" ? "Confirm overwrite" : "Discard draft"}</button><button onClick={() => setConfirm(null)}>Keep editing</button></div>}
    {error && !error.startsWith("conflict:") && <p className="error" role="alert">{error}</p>}
    <textarea ref={textarea} autoFocus aria-label="Note content" className="note-editor-text" value={edit.content} disabled={busy} spellCheck={false} onChange={(e) => persist(changeEdit(edit, e.target.value))} />
  </div>;
}
