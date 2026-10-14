// T-124 r14: the task list's health, said the same way everywhere it is read (the companion, the work view, the tree, and below 900px the
// room itself, outside the drawer): a failed first load, a failed refresh that keeps the rows, a list that may be missing items, and a task
// tree that could not be read. Styling is in tree.css.
// r15: a failed refresh promises nothing about the count: "29 as of 3:12 PM · Couldn't refresh". "At least" is only for a read that
// succeeded but could not read every page.
// r16: rows from the device's copy say how old they are while they are read again ("As of 3:12 PM · refreshing"), and a read that runs past
// 8 seconds says "Still loading · Retry", never an endless "Loading…".
import type { TaskLoad } from "./Companion";

/** When the kept rows were read: the time, with the date when it was not today. */
export function asOf(ms: number, now = Date.now()): string {
  const d = new Date(ms); const today = new Date(now);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === today.toDateString() ? time : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

/** What is wrong, in the order it matters; empty when the list read cleanly and whole. `count`: what the kept rows add up to. `retry`: the
 *  line offers Retry (a saved copy being read again does not, until the read is slow). */
export function loadIssues(load: TaskLoad | undefined, ready: boolean, count?: number): { key: string; text: string; alert: boolean; retry: boolean }[] {
  if (!load) return [];
  if (load.error && !ready) return [{ key: "load", text: "Couldn't load what needs you", alert: true, retry: true }];
  if (!ready) return load.slow ? [{ key: "slow", text: "Still loading what needs you", alert: false, retry: true }] : [];
  const out: { key: string; text: string; alert: boolean; retry: boolean }[] = [];
  const kept = (at: number) => `${count !== undefined ? `${count} as of` : "As of"} ${asOf(at)}`;
  if (load.error) out.push({ key: "refresh", text: load.lastOk ? `${kept(load.lastOk)} · Couldn't refresh` : "Couldn't refresh", alert: false, retry: true });
  else if (load.savedAt) out.push({ key: "saved", text: `${kept(load.savedAt)} · ${load.slow ? "Still loading" : "refreshing…"}`, alert: false, retry: !!load.slow });
  else if (load.slow) out.push({ key: "slow", text: load.lastOk ? `${kept(load.lastOk)} · Still loading` : "Still loading", alert: false, retry: true });
  if (load.treeError) out.push({ key: "tree", text: "Couldn't read where tasks belong; some may be under the wrong place", alert: false, retry: true });
  if (!load.complete) out.push({ key: "partial", text: "More work exists than the app could read, so counts may be low", alert: false, retry: true });
  return out;
}

/** A count from a read that could not get every page says so: "29+" (read "at least 29"). After a failed refresh it is the kept count, as of its read. */
export const countText = (n: number, load?: TaskLoad): string => (load && !load.complete ? `${n}+` : String(n));
export const countLabel = (n: number, load?: TaskLoad): string => (load && !load.complete ? `at least ${n}` : load?.error && load.lastOk ? `${n} as of ${asOf(load.lastOk)}` : load?.savedAt ? `${n} as of ${asOf(load.savedAt)}` : String(n));

export function LoadHealth({ load, ready, count, className = "", skip }: { load?: TaskLoad; ready: boolean; count?: number; className?: string; /** r23: lines said elsewhere on screen ("saved": "18 as of 1:44 PM · refreshing") */ skip?: readonly string[] }) {
  const issues = loadIssues(load, ready, count).filter((i) => !skip?.includes(i.key));
  if (!load || !issues.length) return null;
  return <div className={`lh ${className}`} data-health={issues.map((i) => i.key).join(" ")}>
    {issues.map((i) => <p key={i.key} className={`lh-line${i.alert ? " bad" : ""}`} role={i.alert ? "alert" : "status"}>
      {i.text}{i.retry && <> · <button type="button" className="cp-retry" onClick={load.retry}>Retry</button></>}</p>)}
  </div>;
}
