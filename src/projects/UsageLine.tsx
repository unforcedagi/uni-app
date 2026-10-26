// T-302: one quiet line on the front door: how much of each Claude account's week is used, and where new work goes. It reads the same
// note the Settings card does (System/Claude accounts, over the signed vault door) and opens that card in place. No note: no line.
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { openDialog } from "../areas/focusTrap";
import ClaudeUsage from "../usage/ClaudeUsage";
import { USAGE_NOTE, USAGE_VAULT, usageView } from "../usage/usageCore";

type Note = { id: string; metadata?: unknown };
const CACHE_KEY = "uni.usage.v1";
const cached = (): Note | null => { try { const n = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null"); return n && typeof n.id === "string" ? n : null; } catch { return null; } };

/** "Claude: A 34% of the week · B 12% · new work to B" (a full account says so). */
export function usageLine(metadata: unknown, now: Date): string | null {
  const v = usageView(metadata, now);
  if (!v || !v.rows.length) return null;
  const parts = v.rows.map((r) => `${r.name.toUpperCase()} ${r.missing ? "no reading" : r.week.full || r.session.full ? "full" : `${r.week.text} of the week`}`);
  return `Claude: ${parts.join(" · ")}${v.next ? ` · new work to ${v.next.label.replace(/^Account /, "")}` : ""}`;
}

export function UsageLine() {
  const [note, setNote] = useState<Note | null>(cached);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    invoke<{ note: Note }>("vault_note", { vault: USAGE_VAULT, noteRef: USAGE_NOTE })
      .then((r) => { if (live && r?.note && typeof r.note.id === "string") setNote(r.note); })
      .catch(() => { /* offline or no note: keep what we had */ });
    return () => { live = false; };
  }, [open]);
  const line = note ? usageLine(note.metadata, new Date()) : null;
  if (!line) return null;
  return <>
    <button type="button" className="fd-usage" aria-haspopup="dialog" onClick={() => setOpen(true)}>{line}</button>
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
