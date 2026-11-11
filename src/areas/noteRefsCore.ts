// T-124 r9/r15 (pure): a linked note's title, read once and cached per vault and note (the cache rules for src/areas/noteRefs.tsx).
/** A note in a vault: what a title is read from and what a tap opens. */
export type NoteRef = { vault: string; id: string };
/** One key per note per vault (the title cache, React keys). */
export const refKey = (r: NoteRef): string => `${r.vault}:${r.id}`;

/** The title of a note: the last segment of its path. */
export const titleOfPath = (path: unknown): string | null => (typeof path === "string" ? path.split("/").pop()?.trim() || null : null);

/** A title read from a note, with the revision it was read at and when (ms). `title` null: the read failed (tried again after `RETRY_MS`). */
export type TitleEntry = { title: string | null; at: string | null; read: number; /** r18: the last read failed; `title` is the last one known */ failed?: boolean };
/** A known title is read again (in the background, keeping the old one on screen) once it is this old: a renamed note shows its new title. */
export const RECHECK_MS = 10 * 60_000;
/** A failed read is tried again after this long, never remembered for the session. */
export const RETRY_MS = 30_000;
/** Titles kept, in memory and on the device: the oldest read is dropped first. */
export const KEEP = 300;

/** Whether to read a note's title now: never read, a failure older than `RETRY_MS`, a title older than `RECHECK_MS`, or a first look this session. */
export function shouldRead(e: TitleEntry | undefined, now: number, seenThisSession: boolean): boolean {
  if (!e) return true;
  if (!e.title) return now - e.read >= RETRY_MS;
  return !seenThisSession || now - e.read >= RECHECK_MS;
}

/** A read's result over what was known: a new revision (or a first title) replaces it; a failure keeps a title already known. */
export function settle(prev: TitleEntry | undefined, read: { title: string | null; at: string | null } | null, now: number): TitleEntry {
  if (read?.title) return { title: read.title, at: read.at, read: now };
  // r18: a failure keeps the readable label, marked as not read this time (retried after RETRY_MS)
  return prev?.title ? { title: prev.title, at: prev.at ?? null, read: now, failed: true } : { title: null, at: null, read: now };
}
/** Whose titles these are (r18): the device keeps one list per signed-in identity, so another identity never sees them. */
export const titlesKey = (owner: string): string => `uni.noteTitles.v3:${owner}`;

/** The newest `keep` entries (a Map keeps insertion order: a re-read moves an entry to the end). */
export function capped<V>(m: Map<string, V>, keep = KEEP): void {
  while (m.size > keep) m.delete(m.keys().next().value!);
}
