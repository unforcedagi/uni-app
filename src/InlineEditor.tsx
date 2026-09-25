import { useEffect, useRef, useState } from "react";
import { DELETE_CONFIRM_MS, editOutcome, editorKeyAction } from "./ownMessages";

/** Replaces a message body while editing your own message. Enter saves,
 * Shift+Enter inserts a newline, Esc cancels. `onSave` rejects on failure,
 * which keeps the editor open with the text intact (the caller shows the
 * error). */
export function InlineEditor({ initial, onSave, onCancel }: {
  initial: string;
  onSave: (text: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  async function save() {
    if (saving) return;
    const outcome = editOutcome(initial, text);
    if (outcome === "unchanged") { onCancel(); return; }
    if (outcome === "empty") return;
    setSaving(true);
    try { await onSave(text.trim()); } catch { /* caller surfaced it; keep editing */ }
    finally { setSaving(false); }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const action = editorKeyAction(e.key, e.shiftKey, e.nativeEvent.isComposing);
    if (!action) return;
    e.preventDefault();
    if (action === "cancel") onCancel(); else void save();
  }

  return <div className="inline-editor">
    <textarea ref={ref} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} maxLength={65536} rows={Math.min(8, Math.max(2, text.split("\n").length))} aria-label="Edit message" disabled={saving} />
    <div className="inline-editor-actions">
      <button className="send" onClick={() => void save()} disabled={saving || editOutcome(initial, text) === "empty"}>{saving ? "Saving…" : "Save"}</button>
      <button className="pairing-secondary" onClick={onCancel} disabled={saving}>Cancel</button>
      <small>Enter to save · Esc to cancel · Shift+Enter for a new line</small>
    </div>
  </div>;
}

/** Two-tap delete (window.confirm is unreliable in the Android WebView): the
 * first tap arms it, a second tap within DELETE_CONFIRM_MS deletes. */
export function DeleteButton({ onDelete, label }: { onDelete: () => Promise<void>; label: string }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), DELETE_CONFIRM_MS);
    return () => clearTimeout(t);
  }, [armed]);

  async function tap() {
    if (busy) return;
    if (!armed) { setArmed(true); return; }
    setArmed(false);
    setBusy(true);
    try { await onDelete(); } finally { setBusy(false); }
  }

  return <button className={armed ? "danger" : ""} onClick={() => void tap()} disabled={busy} aria-label={armed ? `Tap again to delete ${label}` : `Delete ${label}`}>{busy ? "Deleting…" : armed ? "Tap again to delete" : "Delete"}</button>;
}
