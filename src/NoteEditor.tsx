import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Note } from "@openparachute/surface-client";
import { copyText } from "./clipboard";
import { beginEdit, changeEdit, draftKey, failedSave, isDirty, savedEdit, serializeDraft, type NoteEdit } from "./noteEdit";

import { draftWriter, settleDraft, readDraft } from "./noteDrafts";
import { invalidatePaths } from "./vaultPaths";

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
  const dirtyCallback = useRef(onDirty);
  dirtyCallback.current = onDirty;
  const writer = useMemo(() => draftWriter(key, () => {
    if (mounted.current) setError("Draft is kept for this session only: local storage is unavailable.");
  }), [key]);
  const flush = writer.flush;
  useEffect(() => {
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
      dirtyCallback.current(!!readDraft(vault, note.id));
    };
  }, [key]);
  function persist(next: NoteEdit) {
    setEdit(next);
    const raw = serializeDraft(next);
    writer.write(raw);
    onDirty(isDirty(next));
  }
  useLayoutEffect(() => { onDirty(!!readDraft(vault, note.id)); }, [onDirty, edit, vault, note.id]);
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
    flush();
    saving.current = true; setBusy(true); setError(null); setConfirm(null);
    try {
      const updated = await invoke<Note>("vault_save", { vault, id: note.id, content: edit.content, ifUpdatedAt: force ? null : edit.updatedAt, force });
      invalidatePaths(vault);
      // A new pane may already be editing this note while this request finishes.
      // Never clear a newer draft when a previous pane's save resolves late.
      onDirty(settleDraft(vault, note.id, serializeDraft(edit)));
      flush();
      if (mounted.current) onSaved(updated);
    } catch (e) { setEdit((old) => failedSave(old, String(e))); setError(String(e)); }
    finally { saving.current = false; setBusy(false); }
  }
  function cancel() {
    persist(savedEdit(note.content ?? "", note.updatedAt ?? null));
    flush();
    onDirty(!!readDraft(vault, note.id));
    onCancel();
  }
  async function copyAndReload() {
    if (saving.current) return;
    flush();
    saving.current = true; setBusy(true); setError(null);
    try {
      if (!await copyText(edit.content, "Copied your draft")) { setError("Could not copy. Your draft is still here."); return; }
      const result = await invoke<{ note: Note }>("vault_note", { vault, noteRef: note.id });
      onDirty(settleDraft(vault, note.id, serializeDraft(edit)));
      flush();
      if (mounted.current) onSaved(result.note);
    } catch (e) { setError(String(e)); }
    finally { saving.current = false; setBusy(false); }
  }
  return <div className="note-editor" onKeyDown={(e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); e.stopPropagation(); if (!edit.updatedAt) setConfirm("overwrite"); else void save(); }
    if (e.key === "Escape") { e.stopPropagation(); if (!isDirty(edit) && !busy) { e.preventDefault(); cancel(); } }
  }}>
    <div className="editor-actions"><button className="note-action" disabled={busy} onClick={() => edit.updatedAt ? void save() : setConfirm("overwrite")}>{busy ? "Saving…" : "Save"}</button><button className="note-action" disabled={busy} onClick={() => isDirty(edit) ? setConfirm("cancel") : cancel()}>Cancel</button></div>
    {edit.restored && <p role="status">Restored unsaved draft</p>}
    {!edit.updatedAt && !edit.conflict && <p role="status">This note has no revision timestamp. <button disabled={busy} onClick={() => setConfirm("overwrite")}>Overwrite</button></p>}
    {edit.conflict && <div className="note-conflict" role="alert"><p>Changed elsewhere since you opened it</p><button disabled={busy} onClick={() => void copyAndReload()}>Copy mine &amp; reload theirs</button><button disabled={busy} onClick={() => setConfirm("overwrite")}>Overwrite</button></div>}
    {confirm && <div role="alertdialog" aria-label={confirm === "overwrite" ? "Confirm overwrite" : "Discard draft"}><p>{confirm === "overwrite" ? "Overwrite the latest version with your text?" : "Discard your unsaved draft?"}</p><button disabled={busy} onClick={() => confirm === "overwrite" ? void save(true) : cancel()}>{confirm === "overwrite" ? "Confirm overwrite" : "Discard draft"}</button><button onClick={() => setConfirm(null)}>Keep editing</button></div>}
    {error && !error.startsWith("conflict:") && <p className="error" role="alert">{error}</p>}
    <textarea onBlur={flush} ref={textarea} autoFocus aria-label="Note content" className="note-editor-text" value={edit.content} disabled={busy} spellCheck={false} onChange={(e) => persist(changeEdit(edit, e.target.value))} />
  </div>;
}
