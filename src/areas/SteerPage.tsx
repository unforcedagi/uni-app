// The full node page's Running and Drafts (T-122), read from `run` and `draft` notes. Since T-124 the room opens to its conversation and
// this page is one level deeper ("Everything here"); the steering bar, the Log strip and the steer effect are gone. Pure parts are in steerCore.ts.
import { cleanText } from "../interface/contract";
import { Changed } from "./Changed";
import { ownerLabel } from "./NodeWork";
import { agoLabel } from "./treeRooms";
import { refKey } from "./refs";
import type { Draft, Mark, Run } from "./steerCore";


// ---------------------------------------------------------------------------------------------- Running and Drafts

const STATE_MARK: Record<Run["state"], string> = { queued: "◌", running: "●", stalled: "▲", blocked: "▲", decision: "◆", done: "✓", failed: "✕" };

/** The dispatch ledger under this node. Nothing at all when there are no runs. */
export function RunSection({ runs, nowMs, onOpenNote }: { runs: readonly Run[]; nowMs: number; onOpenNote: (ref: string) => void }) {
  if (!runs.length) return null;
  const nowSec = Math.floor(nowMs / 1000);
  return <section className="ss ss-run" aria-label="Running"><h3 className="wr-h"><span>Running</span><em>{runs.filter((r) => r.state !== "done" && r.state !== "failed").length}</em></h3>
    <ul className="sl">{runs.map((r) => {
      const at = Date.parse(r.updated ?? "");
      return <li key={r.id} className="run" data-state={r.state}>
        <span className="run-chip" data-state={r.state}><i aria-hidden="true">{STATE_MARK[r.state]}</i>{r.state}</span>
        <span className="run-what">{r.task && <b className="wr-id">{r.task}</b>}<span>{cleanText(r.what)}</span>
          <small>{[r.by && ownerLabel(cleanText(r.by)), Number.isNaN(at) ? null : `${agoLabel(nowSec, Math.floor(at / 1000))}`].filter(Boolean).join(" · ")}</small></span>
        {r.result && refKey(r.result) && <button type="button" className="th-link" onClick={() => onOpenNote(refKey(r.result)!)} aria-label={`Open the result of: ${cleanText(r.what)}`}>Open</button>}
      </li>;
    })}</ul></section>;
}

/** Notes being drafted for a task (read-only): Open shows the note. Nothing at all when there are none. */
export function DraftSection({ drafts, marks, nowMs, onOpenNote }: { drafts: readonly Draft[]; marks: ReadonlyMap<string, readonly Mark[]>; nowMs: number; onOpenNote: (ref: string) => void }) {
  if (!drafts.length) return null;
  return <section className="ss ss-draft" aria-label="Drafts"><h3 className="wr-h"><span>Drafts</span><em>{drafts.length}</em></h3>
    <ul className="sl">{drafts.map((d) => <li key={d.id} className={`draft ${marks.get(d.id)?.length ? "changed" : ""}`} data-status={d.status}>
      <span className="run-chip" data-state={d.status === "ready" ? "done" : "running"}><i aria-hidden="true">{d.status === "ready" ? "✓" : "✎"}</i>{d.status}</span>
      <span className="run-what">{d.task && <b className="wr-id">{d.task}</b>}<span>{cleanText(d.title)}</span><Changed marks={marks.get(d.id)} nowMs={nowMs} /></span>
      <button type="button" className="th-link" onClick={() => onOpenNote(d.id)} aria-label={`Open draft: ${cleanText(d.title)}`}>Open</button>
    </li>)}</ul></section>;
}
