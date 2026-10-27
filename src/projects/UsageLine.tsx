// T-302: one quiet line on the front door: how much of each Claude account's week is used, and where new work goes. It reads the same
// note the Settings card does (System/Claude accounts, over the signed vault door) and opens that card in place. No note: no line.
import { useEffect, useRef, useState } from "react";
import { openDialog } from "../areas/focusTrap";
import ClaudeUsage from "../usage/ClaudeUsage";
import { usageLineText, usageView } from "../usage/usageCore";
import { useUsageNote, useUsageRefresh } from "../usage/usageNote";

export function UsageLine() {
  // T-302 round 3: read again every few minutes while shown and on focus/visibility (useUsageNote); the clock keeps "as of" true.
  // T-319: and on asking (Refresh beside the line).
  const { note } = useUsageNote();
  const { busy, failed, refresh } = useUsageRefresh();
  const [now, setNow] = useState(() => new Date());
  const [open, setOpen] = useState(false);
  useEffect(() => { const t = window.setInterval(() => setNow(new Date()), 60_000); return () => window.clearInterval(t); }, []);
  useEffect(() => { setNow(new Date()); }, [note]);
  const view = note ? usageView(note.metadata, now) : null;
  const line = usageLineText(view, now);
  if (!line) return null;
  return <>
    <div className="fd-usage-row">
      <button type="button" className={`fd-usage ${view?.stale || view?.someStale ? "stale" : ""}`} aria-haspopup="dialog" onClick={() => setOpen(true)}>{line}</button>
      <button type="button" className="fd-usage-refresh" aria-label="Refresh Claude usage" disabled={busy} onClick={refresh}>{busy ? "Checking…" : "Refresh"}</button>
    </div>
    {failed && <p className="fd-status" role="status">Couldn't read the usage note just now; showing the last one read.</p>}
    {open && <UsageSheet onClose={() => setOpen(false)} />}
  </>;
}

function UsageSheet({ onClose }: { onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => (box.current && wrap.current ? openDialog(box.current, () => closeRef.current(), { root: wrap.current, initial: box.current }) : undefined), []);
  return <div ref={wrap} className="pj-wrap fd-usage-wrap">
    <button type="button" className="task-backdrop" aria-label="Close" tabIndex={-1} onClick={onClose} />
    <div ref={box} className="pj fd-usage-sheet" role="dialog" aria-modal="true" aria-label="Claude accounts" tabIndex={-1}>
      <button type="button" className="pj-close" aria-label="Close" onClick={onClose}>×</button>
      <ClaudeUsage />
    </div>
  </div>;
}
