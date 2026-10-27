// T-304: the steps of one session, read from the note mts keeps beside its run note (`feed` on the run note names it). Read through the
// same signed door as every note (`vault_note`), every FEED_MS while a live session's view is open and the window is visible, once for an
// ended one. Why the vault and not an endpoint of its own: every device the app runs on (Android, Daylight, Mac) already reads the vault
// through that door, with the same identity; an endpoint on the tailnet would be a second server, a second auth and a second way in.
//
// Like the work (store.ts), the steps belong to one identity on one vault: the store sets the owner, and a change of owner or Forget drops
// every step read so far and any read still out. Steps are kept in memory only, never on the device.
//
// T-319: the whole session. mts keeps every line (numbered from the session's first, for good) and closes them into part notes, and the
// steps note lists those parts. A view holds one run of lines: the steps note's, and the earlier parts loaded before them on asking
// (loadEarlier), each through parseFeed (the one redactor) like the steps note itself. A new read of the steps note keeps what was held
// when it reaches the note's first line, so lines don't vanish when a part closes. A note from before T-319 is read as before.
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";
import type { RawNote } from "../areas/taskCore";
import { feedPages, parseFeed, partBefore, withHead, withPart, type FeedItem, type FeedPages, type Held } from "./sessionWords";

export type FeedState = { items: FeedItem[]; ready: boolean; error: string | null;
  /** When it was last read. */ at: number | null;
  /** T-319: what the steps note says of the whole session (null: a note from before), and the run of lines held. */ pages: FeedPages | null; held: Held | null;
  /** Loading an earlier part: under way, or why it failed; `gone`: a part mts has since reused for later lines (nothing before its end
   *  can be loaded until the steps note stops listing it). */ earlier: { loading: boolean; error: string | null; gone: number | null } };
/** How often an open live view reads the steps again (mts writes them at most every 15 s). */
export const FEED_MS = 10_000;

const NONE: FeedState = { items: [], ready: false, error: null, at: null, pages: null, held: null, earlier: { loading: false, error: null, gone: null } };
let owner: string | null = null;
let vault = "";
let generation = 0;
let feeds = new Map<string, FeedState>();
const inflight = new Map<string, Promise<void>>();
// Codex zwmejvyc P2: a session's steps are kept only while a view shows them. Each view holds its note (holdFeed); when the last lets go,
// its lines are dropped, and a read still out for them lands nowhere (the note's epoch moved on).
const users = new Map<string, number>();
const epochs = new Map<string, number>();
const epoch = (id: string) => epochs.get(id) ?? 0;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

/** Whose steps these are (the store calls it on every change of identity or vault, and on Forget with null): another owner's are dropped. */
export function setFeedOwner(next: string | null, nextVault: string) {
  if (next === owner && nextVault === vault) return;
  owner = next; vault = nextVault;
  generation++;
  feeds = new Map();
  inflight.clear();
  // told just after: the store may set the owner during a render (a vault change), when nothing may be told at once
  queueMicrotask(emit);
}

/** Reads a steps note again (one read at a time per note). A failed read keeps what was shown and says so. */
export function readFeed(id: string): Promise<void> {
  if (!owner) return Promise.resolve();
  const running = inflight.get(id);
  if (running) return running;
  const mine = generation, from = vault, ep = epoch(id);
  let p: Promise<void> | undefined;
  p = (async () => {
    try {
      const r = await invoke<{ note: RawNote & { content?: string } }>("vault_note", { vault: from, noteRef: id });
      if (mine !== generation || ep !== epoch(id)) return;
      const was = feeds.get(id) ?? NONE;
      const pages = feedPages(r?.note?.metadata);
      const lines = parseFeed(r?.note?.content ?? "", pages?.first ?? 0);
      // what was held is read against the note as it is now (the earlier parts loaded meanwhile stay)
      const held = pages ? withHead(was.held, lines, pages) : null;
      feeds = new Map(feeds).set(id, { ...was, items: held ? held.items : lines, ready: true, error: null, at: Date.now(), pages, held });
    } catch (e) {
      if (mine !== generation || ep !== epoch(id)) return;
      const was = feeds.get(id) ?? NONE;
      feeds = new Map(feeds).set(id, { ...was, ready: true, error: String(e) });
    } finally {
      if (mine === generation && inflight.get(id) === p) inflight.delete(id);
      if (mine === generation) emit();
    }
  })();
  inflight.set(id, p);
  return p!;
}

/** T-319: loads the part of the session just before the lines held (one load at a time per note). A part that no longer holds those
 *  lines (mts reuses its oldest part's note past the lines it keeps) is not shown: the steps note is read again for the parts it lists. */
export function loadEarlier(id: string): Promise<void> {
  const key = `earlier:${id}`;
  const running = inflight.get(key);
  if (running) return running;
  const cur = feeds.get(id);
  const part = cur ? nextPart(cur) : null;
  if (!owner || !cur || !part) return Promise.resolve();
  const mine = generation, from = vault, ep = epoch(id);
  const set = (patch: (was: FeedState) => Partial<FeedState>) => { const was = feeds.get(id) ?? NONE; feeds = new Map(feeds).set(id, { ...was, ...patch(was) }); };
  set((was) => ({ earlier: { ...was.earlier, loading: true, error: null } }));
  emit();
  let p: Promise<void> | undefined;
  p = (async () => {
    try {
      const r = await invoke<{ note: RawNote & { content?: string } }>("vault_note", { vault: from, noteRef: part.id });
      if (mine !== generation || ep !== epoch(id)) return;
      const md = (r?.note?.metadata ?? {}) as Record<string, unknown>;
      if (md.first !== part.first) {
        set(() => ({ earlier: { loading: false, error: "Those steps are no longer kept.", gone: part.first + part.n } }));
        void readFeed(id);
        return;
      }
      const lines = parseFeed(r?.note?.content ?? "", part.first);
      set((was) => {
        const held = was.held ? withPart(was.held, part, lines) : null;
        const earlier = { ...was.earlier, loading: false, error: null };
        return held ? { held, items: held.items, earlier } : { earlier };
      });
    } catch {
      if (mine !== generation || ep !== epoch(id)) return;
      set((was) => ({ earlier: { ...was.earlier, loading: false, error: "Couldn't load earlier steps." } }));
    } finally {
      if (mine === generation && inflight.get(key) === p) inflight.delete(key);
      if (mine === generation) emit();
    }
  })();
  inflight.set(key, p);
  return p!;
}

/** The part to load next for this state: the one just before what is held, unless it is one mts has reused since it was listed. */
function nextPart(f: FeedState) {
  const p = f.held ? partBefore(f.pages, f.held.from) : null;
  return p && !(f.earlier.gone !== null && p.first < f.earlier.gone) ? p : null;
}

/** Whether there is an earlier part to load for this state. */
export const hasEarlier = (f: FeedState) => !!nextPart(f);

/** A view holds a steps note while it shows it; the returned function lets go. When no view holds it, its lines are dropped. */
export function holdFeed(id: string): () => void {
  users.set(id, (users.get(id) ?? 0) + 1);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const left = (users.get(id) ?? 1) - 1;
    if (left > 0) { users.set(id, left); return; }
    users.delete(id);
    epochs.set(id, epoch(id) + 1);
    inflight.delete(id); inflight.delete(`earlier:${id}`);
    if (feeds.has(id)) { feeds = new Map(feeds); feeds.delete(id); queueMicrotask(emit); }
  };
}

/** What the screen would see for a steps note now (for the store's own test). */
export const feedSnapshot = (id: string): FeedState => feeds.get(id) ?? NONE;

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** A session's steps (none when it has no steps note), read once, and every FEED_MS while `live` and the window is visible. */
export function useFeed(id: string | null, live: boolean): FeedState {
  // a new owner drops what was read: read again for them
  const gen = useSyncExternalStore(subscribe, () => generation, () => generation);
  useEffect(() => {
    if (!id) return;
    const release = holdFeed(id);
    void readFeed(id);
    if (!live) return release;
    const t = setInterval(() => { if (document.visibilityState === "visible") void readFeed(id); }, FEED_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void readFeed(id); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVisible); release(); };
  }, [id, live, gen]);
  const get = () => (id ? feeds.get(id) ?? NONE : NONE);
  return useSyncExternalStore(subscribe, get, get);
}
