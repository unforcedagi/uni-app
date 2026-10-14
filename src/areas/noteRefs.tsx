// T-124 r9: a `uni:<ULID>` or bare ULID in a task's title or next step reads as the linked note's title (read once, cached), never as the id.
// r15: keyed by vault and id, read from and opened in the same vault; a renamed note re-reads (a known title is checked again in the
// background), a failed read is tried again, and the cache keeps the newest 300.
import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { capped, refKey, settle, shouldRead, splitRefs, titleOfPath, titlesKey, KEEP, type NoteRef, type TitleEntry } from "./noteRefsCore";

/** r18: titles are kept per signed-in identity (keyed by vault and note inside), never shared across identities, and cleared by Forget. */
const OWNER_KEY = "uni.noteTitles.owner";
/** The identity whose titles were kept last: the first paint shows them before the identity is confirmed (another one clears them at once). */
let owner = (() => { try { return localStorage.getItem(OWNER_KEY) ?? ""; } catch { return ""; } })();
const stored = (): [string, TitleEntry][] => {
  try {
    const v = JSON.parse(localStorage.getItem(titlesKey(owner)) ?? "[]");
    return Array.isArray(v) ? v.filter((e): e is [string, TitleEntry] => Array.isArray(e) && typeof e[0] === "string" && !!e[1] && typeof e[1].title === "string").slice(-KEEP) : [];
  } catch { return []; }
};
// Titles read before are kept on this device: the next launch shows the title on the first paint instead of a placeholder that flips.
const titles = new Map<string, TitleEntry>(owner ? stored() : []);
const keep = () => { try { localStorage.setItem(titlesKey(owner), JSON.stringify([...titles].filter(([, e]) => e.title))); } catch { /* this session only */ } };
/** The signed-in identity whose titles these are: another one starts from its own kept list. */
export function setTitleOwner(who: string) {
  if (who === owner) return;
  owner = who; titles.clear(); seen.clear();
  try { localStorage.setItem(OWNER_KEY, who); } catch { /* this session only */ }
  for (const [k, e] of stored()) titles.set(k, e);
  listeners.forEach((f) => f());
}
/** Forget (r18): every identity's kept titles go, with the old unscoped list. */
export function forgetTitles() {
  titles.clear(); seen.clear();
  try { for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k && /^uni\.noteTitles\./.test(k)) localStorage.removeItem(k); } } catch { /* nothing kept */ }
  listeners.forEach((f) => f());
}
/** Notes whose title was checked this session (a title kept from the last launch is checked once, in the background). */
const seen = new Set<string>();
const reading = new Set<string>();
const listeners = new Set<() => void>();
const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };

/** Title reads in flight at once (r16): a room full of note links queues its reads instead of crowding out the task list's. */
const PARALLEL = 4;
let inFlight = 0;
const waiting: (() => void)[] = [];
const slot = () => (inFlight < PARALLEL ? (inFlight++, Promise.resolve()) : new Promise<void>((go) => waiting.push(() => { inFlight++; go(); })));
const release = () => { inFlight--; waiting.shift()?.(); };

function load(r: NoteRef) {
  const k = refKey(r);
  if (reading.has(k) || !shouldRead(titles.get(k), Date.now(), seen.has(k))) return;
  seen.add(k); reading.add(k);
  slot().then(() => invoke<{ note?: { path?: string; updatedAt?: string } } | null>("vault_note", { vault: r.vault, noteRef: r.id }).finally(release))
    .then((n) => ({ title: titleOfPath(n?.note?.path), at: typeof n?.note?.updatedAt === "string" ? n.note.updatedAt : null }), () => null)
    .then((read) => {
      const prev = titles.get(k);
      const next = settle(prev, read, Date.now());
      titles.delete(k); titles.set(k, next); capped(titles);
      if (next.title && (next.title !== prev?.title || next.at !== prev?.at)) keep();
    })
    .finally(() => { reading.delete(k); listeners.forEach((f) => f()); });
}

/** Read (or check again) the titles of the notes a text mentions, ahead of showing it: called with every refresh of the work. */
export function warmTitles(texts: readonly string[], vault: string) { for (const t of texts) for (const p of splitRefs(t, vault)) if ("id" in p) load(p); }

/** A linked note's title; `null` while it is first being read (callers show a quiet neutral, never a placeholder that later flips), "a note"
 *  when it can't be read (tried again on the next look after a short wait). */
export function useNoteTitle(r: NoteRef): string | null {
  const k = refKey(r);
  const e = useSyncExternalStore(subscribe, () => titles.get(k));
  // r18: also when the entry goes (another identity's titles were cleared), so it is read again for this one
  useEffect(() => { load(r); }, [k, e === undefined]); // eslint-disable-line react-hooks/exhaustive-deps
  return e === undefined ? null : e.title || "a note";
}
/** r18: the last read of this note failed, so its title is the last one known (said quietly, and read again shortly). */
export function useNoteUnread(r: NoteRef): boolean {
  const k = refKey(r);
  return useSyncExternalStore(subscribe, () => !!titles.get(k)?.failed);
}

export function RefName({ r, onNote }: { r: NoteRef; onNote?: (ref: NoteRef) => void }) {
  const t = useNoteTitle(r);
  const off = useNoteUnread(r);
  if (t === null) return <span className="cp-ref-wait">the linked note</span>;
  const hint = off ? "Couldn't read this note just now; this is its last known title" : undefined;
  return onNote ? <button type="button" className={`cp-ref${off ? " cp-ref-off" : ""}`} title={hint} onClick={() => onNote(r)}>{t}</button> : <span className={off ? "cp-ref-off" : undefined} title={hint}>{t}</span>;
}

/** Plain text with its note ids as titles (buttons when `onNote` is given). `vault`: where the text lives, for an id written without one. */
export function RefText({ text, vault, onNote }: { text: string; vault: string; onNote?: (ref: NoteRef) => void }) {
  return <>{splitRefs(text, vault).map((p, i) => "id" in p ? <RefName key={i} r={p} onNote={onNote} /> : <span key={i}>{p.text}</span>)}</>;
}
