// T-212: the decision notes the chat's cards show, read once per vault and note and shared by every card of a decision (pure; the read
// is passed in, so scripts/decisionCard.test.ts drives it). Forget empties it, and a read still under way when it does is dropped, so a
// card never shows what an earlier identity could read.
import { parseDecisionNote, type DecisionView } from "./decisionView.ts";

export type Entry = { view: DecisionView | null; error: string | null; read: number; vault: string; id: string };
/** An error as one line, without the "Error:" a thrown string or an invoke rejection may carry. */
export const msg = (e: unknown): string => (typeof e === "string" ? e : (e as Error)?.message ?? "failed").replace(/^Error:\s*/, "");

export function makeDecisionStore(read: (vault: string, id: string) => Promise<unknown>, now: () => number = Date.now) {
  const entries = new Map<string, Entry>();
  const loading = new Map<string, Promise<void>>();
  const listeners = new Set<() => void>();
  let version = 0, generation = 0;
  const key = (vault: string, id: string) => `${vault}\u0000${id}`;
  const bump = () => { version++; for (const f of listeners) f(); };
  const put = (vault: string, id: string, e: Omit<Entry, "vault" | "id">) => { entries.set(key(vault, id), { ...e, vault, id }); bump(); };
  function load(id: string, vault: string): Promise<void> {
    const k = key(vault, id), busy = loading.get(k);
    if (busy) return busy;
    const g = generation;
    const p = read(vault, id)
      .then((note) => { if (g === generation) put(vault, id, { view: parseDecisionNote(note), error: null, read: now() }); })
      .catch((e) => { if (g === generation && !entries.get(k)?.view) put(vault, id, { view: null, error: msg(e), read: now() }); })
      .finally(() => { if (loading.get(k) === p) loading.delete(k); });
    loading.set(k, p);
    return p;
  }
  /** Open decisions and failed reads older than `ms`: what coming back to the app reads again. */
  const stale = (ms: number) => [...entries.values()].flatMap((e) => (e.view?.state === "open" || (!e.view && e.error)) && now() - e.read > ms ? [e] : []);
  return {
    get: (id: string, vault: string) => entries.get(key(vault, id)),
    /** Store what a tap returned, unless Forget came in between (`gen` is the generation the tap started in). */
    put: (id: string, vault: string, e: Omit<Entry, "vault" | "id">, gen: number) => { if (gen === generation) put(vault, id, e); },
    /** Which identity's store this is: a tap captures it before it goes out and drops its answer when it changed. */
    generation: () => generation,
    load,
    /** Re-read the open and failed ones older than `ms` (focus). */
    refresh: (ms: number) => { for (const e of stale(ms)) void load(e.id, e.vault); },
    /** Re-read these ids where they are open (the shell stopped listing them: decided elsewhere). */
    gone: (ids: readonly string[]) => { for (const e of [...entries.values()]) if (e.view?.state === "open" && ids.includes(e.id)) void load(e.id, e.vault); },
    /** Forget (a new identity): nothing read before shows again, and reads under way are dropped. */
    forget: () => { generation++; entries.clear(); loading.clear(); bump(); },
    subscribe: (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; },
    version: () => version,
  };
}
