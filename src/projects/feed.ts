// T-304: the steps of one session, read from the note mts keeps beside its run note (`feed` on the run note names it). Read through the
// same signed door as every note (`vault_note`), every FEED_MS while a live session's view is open and the window is visible, once for an
// ended one. Why the vault and not an endpoint of its own: every device the app runs on (Android, Daylight, Mac) already reads the vault
// through that door, with the same identity; an endpoint on the tailnet would be a second server, a second auth and a second way in.
//
// Like the work (store.ts), the steps belong to one identity on one vault: the store sets the owner, and a change of owner or Forget drops
// every step read so far and any read still out. Steps are kept in memory only, never on the device.
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";
import type { RawNote } from "../areas/taskCore";
import { parseFeed, type FeedItem } from "./sessionWords";

export type FeedState = { items: FeedItem[]; ready: boolean; error: string | null;
  /** When it was last read. */ at: number | null };
/** How often an open live view reads the steps again (mts writes them at most every 15 s). */
export const FEED_MS = 10_000;

const NONE: FeedState = { items: [], ready: false, error: null, at: null };
let owner: string | null = null;
let vault = "";
let generation = 0;
let feeds = new Map<string, FeedState>();
const inflight = new Map<string, Promise<void>>();
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
  const mine = generation, from = vault;
  let p: Promise<void> | undefined;
  p = (async () => {
    try {
      const r = await invoke<{ note: RawNote & { content?: string } }>("vault_note", { vault: from, noteRef: id });
      if (mine !== generation) return;
      feeds = new Map(feeds).set(id, { items: parseFeed(r?.note?.content ?? ""), ready: true, error: null, at: Date.now() });
    } catch (e) {
      if (mine !== generation) return;
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

/** What the screen would see for a steps note now (for the store's own test). */
export const feedSnapshot = (id: string): FeedState => feeds.get(id) ?? NONE;

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** A session's steps (none when it has no steps note), read once, and every FEED_MS while `live` and the window is visible. */
export function useFeed(id: string | null, live: boolean): FeedState {
  // a new owner drops what was read: read again for them
  const gen = useSyncExternalStore(subscribe, () => generation, () => generation);
  useEffect(() => {
    if (!id) return;
    void readFeed(id);
    if (!live) return;
    const t = setInterval(() => { if (document.visibilityState === "visible") void readFeed(id); }, FEED_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void readFeed(id); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVisible); };
  }, [id, live, gen]);
  const get = () => (id ? feeds.get(id) ?? NONE : NONE);
  return useSyncExternalStore(subscribe, get, get);
}
