// T-124: the room's quiet companion. Not a page: one sentence on where the room stands, at most three things that need the user, and what is
// running (only when something is). Desktop: a side panel that folds to a thin rail. Phone: a one-line strip at the top of the room that opens
// downward. Each item opens its task sheet; "Everything here" goes one level deeper, to the full node page. The fold is remembered per device.
import { useEffect, useState } from "react";
import { cleanText } from "../interface/contract";
import { dueText } from "./NodeWork";
import { activeProfile } from "./profile";
import type { Run } from "./steerCore";
import type { Task } from "./taskCore";
import { splitTitle } from "./whereCore";

const KEYS = { side: "uni.companion.side.v1", strip: "uni.companion.strip.v1" } as const;
const read = (key: string, open: boolean): boolean => { try { const v = localStorage.getItem(key); return v === null ? open : v === "1"; } catch { return open; } };

/** Whether the companion is open on this device: open by default beside the chat, folded by default as a phone strip. */
export function useCompanionOpen(variant: "side" | "strip"): [boolean, (v: boolean) => void] {
  const key = KEYS[variant];
  const [open, setOpen] = useState(() => read(key, variant === "side"));
  useEffect(() => { setOpen(read(key, variant === "side")); }, [key, variant]);
  return [open, (v) => { setOpen(v); try { localStorage.setItem(key, v ? "1" : "0"); } catch { /* this session only */ } }];
}

const ACTIVE: ReadonlySet<Run["state"]> = new Set(["queued", "running", "stalled"]);

type Props = {
  lede: string; ready: boolean;
  needs: readonly Task[]; more: number;
  runs: readonly Run[];
  onTask: (t: Task) => void; onEverything: () => void;
};
type Fold = { open: boolean; onToggle: (v: boolean) => void };

function Body({ lede, ready, needs, more, runs, onTask, onEverything }: Props) {
  const active = runs.filter((r) => ACTIVE.has(r.state));
  return <div className="cp-body">
    <p className="cp-lede">{ready ? lede : "Loading…"}</p>
    {needs.length > 0 && <section aria-label="Needs you" className="cp-sec">
      <h3 className="cp-h">Needs you</h3>
      <ul className="cp-list">{needs.map((t) => {
        const { id, rest } = splitTitle(cleanText(t.title));
        const meta = [t.kind === "decision" ? "Decide" : t.waitingOn === activeProfile().me ? "Waiting on you" : null, dueText(t.due)].filter(Boolean).join(" · ");
        return <li key={t.id}><button type="button" className="cp-need" data-id={id ?? undefined} onClick={() => onTask(t)}>
          <span className="cp-title">{rest}</span>{meta && <small>{meta}</small>}</button></li>;
      })}</ul>
      {more > 0 && <button type="button" className="cp-more" onClick={onEverything}>+{more} more</button>}
    </section>}
    {active.length > 0 && <section aria-label="Running" className="cp-sec">
      <h3 className="cp-h">Running</h3>
      <ul className="cp-list">{active.map((r) => <li key={r.id} className="cp-run" data-state={r.state}><i aria-hidden="true" /><span>{cleanText(r.what)}</span><small>{r.state}</small></li>)}</ul>
    </section>}
    <button type="button" className="cp-all" onClick={onEverything}>Everything here <span aria-hidden="true">→</span></button>
  </div>;
}

/** The side panel (wide screens). `open` and `onToggle` come from `useCompanionOpen("side")`. */
export function CompanionSide({ open, onToggle, ...p }: Props & Fold) {
  return <aside className={`cp side ${open ? "open" : "folded"}`} aria-label="Where this stands">
    {open
      ? <>
        <div className="cp-top"><span>Where this stands</span><button type="button" className="cp-fold" aria-expanded="true" aria-label="Hide where this stands" onClick={() => onToggle(false)}>›</button></div>
        <Body {...p} />
      </>
      : <button type="button" className="cp-unfold" aria-expanded="false" aria-label="Show where this stands" onClick={() => onToggle(true)}>
        <span aria-hidden="true">‹</span>{p.needs.length > 0 && <i className="cp-dot" aria-label={`${p.needs.length + p.more} need you`} />}</button>}
  </aside>;
}

/** The phone's strip: one line, tap to open. */
export function CompanionStrip({ open, onToggle, ...p }: Props & Fold) {
  return <section className={`cp strip ${open ? "open" : ""}`} aria-label="Where this stands">
    <button type="button" className="cp-line" aria-expanded={open} onClick={() => onToggle(!open)}>
      <span className="cp-line-text">{open ? "Where this stands" : p.ready ? p.lede : "Loading…"}</span>
      {p.needs.length > 0 && <i className="cp-dot" aria-label={`${p.needs.length + p.more} need you`} />}
      <span className="cp-chev" aria-hidden="true">{open ? "⌃" : "⌄"}</span>
    </button>
    {open && <Body {...p} />}
  </section>;
}
