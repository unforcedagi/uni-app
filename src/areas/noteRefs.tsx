// T-124 r9: a `uni:<ULID>` or bare ULID in a task's title or next step reads as the linked note's title (read once, cached), never as the id.
import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { activeProfile } from "./profile";
import { splitRefs, titleOfPath } from "./noteRefsCore";

const titles = new Map<string, string | null>();
const asked = new Set<string>();
const listeners = new Set<() => void>();
const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };

function load(id: string) {
  if (asked.has(id)) return;
  asked.add(id);
  invoke<{ note?: { path?: string } } | null>("vault_note", { vault: activeProfile().vault, noteRef: id })
    .then((r) => titles.set(id, titleOfPath(r?.note?.path)))
    .catch(() => titles.set(id, null))
    .finally(() => listeners.forEach((f) => f()));
}

/** A linked note's title; "a note" until it is read, or when it can't be. */
export function useNoteTitle(id: string): string {
  const t = useSyncExternalStore(subscribe, () => titles.get(id));
  useEffect(() => { load(id); }, [id]);
  return t || "a note";
}

export function RefName({ id, onNote }: { id: string; onNote?: (ref: string) => void }) {
  const t = useNoteTitle(id);
  return onNote ? <button type="button" className="cp-ref" onClick={() => onNote(id)}>{t}</button> : <span>{t}</span>;
}

/** Plain text with its note ids as titles (buttons when `onNote` is given). */
export function RefText({ text, onNote }: { text: string; onNote?: (ref: string) => void }) {
  return <>{splitRefs(text).map((p, i) => "id" in p ? <RefName key={i} id={p.id} onNote={onNote} /> : <span key={i}>{p.text}</span>)}</>;
}
