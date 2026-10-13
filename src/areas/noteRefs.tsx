// T-124 r9: a `uni:<ULID>` or bare ULID in a task's title or next step reads as the linked note's title (read once, cached), never as the id.
import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { activeProfile } from "./profile";
import { splitRefs, titleOfPath } from "./noteRefsCore";

const KEY = "uni.noteTitles.v1";
const KEEP = 300;
const stored = (): Record<string, string> => { try { const v = JSON.parse(localStorage.getItem(KEY) ?? "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; } };
// Titles read before are kept on this device: the next launch shows the title on the first paint instead of a placeholder that flips.
const titles = new Map<string, string | null>(Object.entries(stored()));
const keep = () => { try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries([...titles].filter(([, t]) => t).slice(-KEEP)))); } catch { /* this session only */ } };
const asked = new Set<string>();
const listeners = new Set<() => void>();
const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };

function load(id: string) {
  if (asked.has(id)) return;
  asked.add(id);
  invoke<{ note?: { path?: string } } | null>("vault_note", { vault: activeProfile().vault, noteRef: id })
    .then((r) => { const t = titleOfPath(r?.note?.path); if (t) { titles.delete(id); titles.set(id, t); keep(); } else titles.set(id, titles.get(id) ?? null); })
    .catch(() => { if (!titles.get(id)) titles.set(id, null); })
    .finally(() => listeners.forEach((f) => f()));
}

/** Read the titles of the notes a text mentions, ahead of showing it. */
export function warmTitles(texts: readonly string[]) { for (const t of texts) for (const p of splitRefs(t)) if ("id" in p) load(p.id); }

/** A linked note's title; `null` while it is still being read (callers show a quiet neutral, never a placeholder that later flips), "a note" only when it can't be read. */
export function useNoteTitle(id: string): string | null {
  const t = useSyncExternalStore(subscribe, () => titles.get(id));
  useEffect(() => { load(id); }, [id]);
  return t === undefined ? null : t || "a note";
}

export function RefName({ id, onNote }: { id: string; onNote?: (ref: string) => void }) {
  const t = useNoteTitle(id);
  if (t === null) return <span className="cp-ref-wait">the linked note</span>;
  return onNote ? <button type="button" className="cp-ref" onClick={() => onNote(id)}>{t}</button> : <span>{t}</span>;
}

/** Plain text with its note ids as titles (buttons when `onNote` is given). */
export function RefText({ text, onNote }: { text: string; onNote?: (ref: string) => void }) {
  return <>{splitRefs(text).map((p, i) => "id" in p ? <RefName key={i} id={p.id} onNote={onNote} /> : <span key={i}>{p.text}</span>)}</>;
}
