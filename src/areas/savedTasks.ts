// T-124 r16: the task list as last read, kept on the device (unit-tested in scripts/tasks.test.ts), so a launch paints Needs you at once
// with its age and the network only refreshes it. One slot per identity and vault, size-capped, cleared on Forget. Running and Drafts are
// not kept: activity is said as checked or unknown, never shown from an old read as if it were moving now.
import type { Task, TaskTree } from "./taskCore.ts";

export const SAVED_KEY = "uni.tasks.saved.v1";
/** At most this many tasks are kept; a longer list is not saved (the next launch reads it as before). */
export const SAVED_MAX_TASKS = 600;
/** And at most this many characters of JSON (about 1 MB of storage). */
export const SAVED_MAX_CHARS = 500_000;
/** Identities/vaults kept at once (the newest first); another sign-in starts clean rather than reading someone else's. */
const SLOTS = 3;

export type SavedTasks = { at: number; tree: TaskTree & { truncated: boolean }; list: Task[]; truncated: boolean };
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type Wire = { v: 1; owner: string; at: number; truncated: boolean; tree: { byPath: [string, unknown][]; idPath: [string, string][]; children: [string, string[]][]; parent: [string, string][]; rootRefs: string[]; stands: [string, { text: string; at: string | null }][]; truncated: boolean }; list: Task[] };

const toWire = (owner: string, s: SavedTasks): Wire => ({ v: 1, owner, at: s.at, truncated: s.truncated, list: s.list,
  tree: { byPath: [...s.tree.byPath], idPath: [...s.tree.idPath], children: [...s.tree.children], parent: [...s.tree.parent], rootRefs: [...s.tree.rootRefs], stands: [...s.tree.stands], truncated: s.tree.truncated } });

const isTask = (t: unknown): t is Task => { const x = t as Partial<Task> | null; return !!x && typeof x.id === "string" && typeof x.title === "string" && typeof x.node === "string" && typeof x.state === "string" && typeof x.owner === "string" && typeof x.next === "string" && (x.kind === "task" || x.kind === "decision") && Array.isArray(x.options); };
const pairs = (v: unknown): v is [string, unknown][] => Array.isArray(v) && v.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === "string");

function fromWire(w: Wire): SavedTasks | null {
  const t = w.tree;
  if (!t || !pairs(t.byPath) || !pairs(t.idPath) || !pairs(t.children) || !pairs(t.parent) || !Array.isArray(t.rootRefs) || !pairs(t.stands)) return null;
  if (!Array.isArray(w.list) || !w.list.every(isTask) || typeof w.at !== "number") return null;
  return { at: w.at, truncated: !!w.truncated, list: w.list,
    tree: { byPath: new Map(t.byPath) as TaskTree["byPath"], idPath: new Map(t.idPath as [string, string][]), children: new Map(t.children as [string, string[]][]), parent: new Map(t.parent as [string, string][]), rootRefs: new Set(t.rootRefs.filter((r): r is string => typeof r === "string")), stands: new Map(t.stands as [string, { text: string; at: string | null }][]), truncated: !!t.truncated } };
}

export function createSavedTasks(store: Store | null) {
  const all = (): Wire[] => { try { const v = JSON.parse(store?.getItem(SAVED_KEY) ?? "[]"); return Array.isArray(v) ? v.filter((w) => w && w.v === 1 && typeof w.owner === "string") : []; } catch { return []; } };
  return {
    /** The list kept for this identity and vault (`owner`), or null. A slot written for another owner is never read. */
    read(owner: string): SavedTasks | null {
      if (!owner || owner.startsWith("|")) return null; // no identity yet: nothing is anyone's
      const w = all().find((x) => x.owner === owner);
      return w ? fromWire(w) : null;
    },
    /** Keep this read (whole lists only up to the caps; a list over them is not kept, and an older copy is dropped rather than shown as current). */
    write(owner: string, s: SavedTasks): boolean {
      if (!owner || owner.startsWith("|")) return false;
      const rest = all().filter((x) => x.owner !== owner);
      const keep = (slots: Wire[]) => { try { store?.setItem(SAVED_KEY, JSON.stringify(slots)); return true; } catch { return false; } };
      if (s.list.length > SAVED_MAX_TASKS) { keep(rest); return false; }
      const mine = toWire(owner, s);
      if (JSON.stringify(mine).length > SAVED_MAX_CHARS) { keep(rest); return false; }
      return keep([mine, ...rest].slice(0, SLOTS));
    },
    clear(): void { try { store?.removeItem(SAVED_KEY); } catch { /* storage unavailable */ } },
  };
}

export const savedTasks = createSavedTasks(typeof localStorage === "undefined" ? null : localStorage);
