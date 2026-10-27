// T-302 round 3: the Claude accounts note, read for both places that show it (the Settings card and the front door's line). It is read
// when shown, again every few minutes while it is, and whenever the window comes back to view or focus, so the numbers and the account new
// work goes to don't sit hours old. Forget drops the device copy and what is in memory.
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { USAGE_NOTE, USAGE_VAULT } from "./usageCore";

export type UsageNote = { id: string; path?: string; metadata?: unknown; updatedAt?: string };
const CACHE_KEY = "uni.usage.v1";
/** How often a shown reading is read again (the launcher writes the note every few minutes). */
export const USAGE_REFRESH_MS = 5 * 60_000;

function cached(): UsageNote | null {
  try { const n = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null"); return n && typeof n.id === "string" ? n : null; } catch { return null; }
}
let note: UsageNote | null | undefined; // undefined: not read from the device yet
let generation = 0;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const get = () => (note === undefined ? (note = cached()) : note);

/** Reads the note again; resolves to it, or null when it can't be read (offline, no note: what was shown stays). */
export async function loadUsage(): Promise<UsageNote | null> {
  const mine = generation;
  try {
    const r = await invoke<{ note: UsageNote }>("vault_note", { vault: USAGE_VAULT, noteRef: USAGE_NOTE });
    const n = r?.note && typeof r.note.id === "string" ? r.note : null;
    if (mine !== generation || !n) return null; // forgotten meanwhile: a late answer doesn't come back
    note = n;
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ id: n.id, path: n.path, metadata: n.metadata, updatedAt: n.updatedAt })); } catch { /* unavailable storage */ }
    emit();
    return n;
  } catch { return null; }
}

/** Forget: the device copy, what is in memory, and any read still out. */
export function forgetUsage() {
  generation++;
  note = null;
  try { localStorage.removeItem(CACHE_KEY); } catch { /* private storage */ }
  emit();
}

/** The note, read on mount, every USAGE_REFRESH_MS while shown, and on focus or when the window becomes visible. */
export function useUsageNote(): { note: UsageNote | null; load: () => Promise<UsageNote | null> } {
  const n = useSyncExternalStore(subscribe, get, get);
  useEffect(() => {
    void loadUsage();
    const t = window.setInterval(() => { if (document.visibilityState === "visible") void loadUsage(); }, USAGE_REFRESH_MS);
    const back = () => { if (document.visibilityState === "visible") void loadUsage(); };
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    return () => { window.clearInterval(t); document.removeEventListener("visibilitychange", back); window.removeEventListener("focus", back); };
  }, []);
  const load = useCallback(() => loadUsage(), []);
  return { note: n ?? null, load };
}

/** T-319: a refresh asked for by hand (the line's and the card's Refresh): reads the note again now, and says while it does and when it
 *  couldn't. */
export function useUsageRefresh(): { busy: boolean; failed: boolean; refresh: () => void } {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  // any read that lands (this one, focus, the timer) clears a failure shown before it
  const n = useSyncExternalStore(subscribe, get, get);
  useEffect(() => { setFailed(false); }, [n]);
  const refresh = useCallback(() => {
    if (busy) return;
    setBusy(true); setFailed(false);
    void loadUsage().then((n) => { if (live.current) { setBusy(false); setFailed(!n); } });
  }, [busy]);
  return { busy, failed, refresh };
}
