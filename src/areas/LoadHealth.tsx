// T-124 r14: the task list's health, said the same way everywhere it is read (the companion, the work view, the tree, and below 900px the
// room itself, outside the drawer): a failed first load, a failed refresh that keeps the rows, a list that may be missing items, and a task
// tree that could not be read. Styling is in tree.css.
import type { TaskLoad } from "./Companion";

const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** What is wrong, in the order it matters; empty when the list read cleanly and whole. */
export function loadIssues(load: TaskLoad | undefined, ready: boolean): { key: string; text: string; detail?: string; alert: boolean }[] {
  if (!load) return [];
  if (load.error && !ready) return [{ key: "load", text: "Couldn't load what needs you", alert: true }];
  const out: { key: string; text: string; detail?: string; alert: boolean }[] = [];
  if (load.error) out.push({ key: "refresh", text: "Couldn't refresh", detail: load.lastOk ? `Showing what was read at ${clock(load.lastOk)}.` : undefined, alert: false });
  if (load.treeError) out.push({ key: "tree", text: "Couldn't read where tasks belong; some may be under the wrong place", alert: false });
  if (!load.complete) out.push({ key: "partial", text: "More work exists than the app could read, so counts may be low", alert: false });
  return out;
}

/** A count that may be missing items says so: "29+" (read "at least 29"). */
export const countText = (n: number, load?: TaskLoad): string => (load && (!load.complete || load.error) ? `${n}+` : String(n));
export const countLabel = (n: number, load?: TaskLoad): string => (load && (!load.complete || load.error) ? `at least ${n}` : String(n));

export function LoadHealth({ load, ready, className = "" }: { load?: TaskLoad; ready: boolean; className?: string }) {
  const issues = loadIssues(load, ready);
  if (!load || !issues.length) return null;
  return <div className={`lh ${className}`} data-health={issues.map((i) => i.key).join(" ")}>
    {issues.map((i) => <p key={i.key} className={`lh-line${i.alert ? " bad" : ""}`} role={i.alert ? "alert" : "status"}>
      {i.text} · <button type="button" className="cp-retry" onClick={load.retry}>Retry</button>{i.detail && <small className="lh-detail"> {i.detail}</small>}</p>)}
  </div>;
}
