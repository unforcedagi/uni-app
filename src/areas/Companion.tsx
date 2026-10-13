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
/** Below this width the side panel starts folded: the conversation gets the space. */
export const SIDE_OPEN_MIN = 1100;
const read = (key: string, open: boolean): boolean => { try { const v = localStorage.getItem(key); return v === null ? open : v === "1"; } catch { return open; } };

const defaultOpen = (variant: "side" | "strip") => variant === "side" && (typeof window === "undefined" || window.innerWidth >= SIDE_OPEN_MIN);

/** Whether the companion is open on this device: open by default beside the chat on a wide window (folded under 1100px), folded by default as a phone strip. */
export function useCompanionOpen(variant: "side" | "strip"): [boolean, (v: boolean) => void] {
  const key = KEYS[variant];
  const [open, setOpen] = useState(() => read(key, defaultOpen(variant)));
  useEffect(() => { setOpen(read(key, defaultOpen(variant))); }, [key, variant]);
  return [open, (v) => { setOpen(v); try { localStorage.setItem(key, v ? "1" : "0"); } catch { /* this session only */ } }];
}

const ACTIVE: ReadonlySet<Run["state"]> = new Set(["queued", "running", "stalled", "blocked"]);

type Props = {
  /** Where this stands: the sentence and, quietly, when it was written. Null: nothing to say. */
  stands: { text: string; ago: string } | null; ready: boolean;
  needs: readonly Task[];
  runs: readonly Run[];
  onTask: (t: Task) => void; onDecide: (t: Task, option: string) => void; onEverything: () => void;
};
type Fold = { open: boolean; onToggle: (v: boolean) => void };

/** What Aaron does with it: a decision is decided, a task waiting on him says so, else its next step. */
function actionOf(t: Task): string | null {
  if (t.kind === "decision") return "Decide";
  if (t.waitingOn === activeProfile().me) return t.next ? `Waiting on you · ${t.next}` : "Waiting on you";
  return t.next || null;
}

function Body({ stands, ready, needs, runs, onTask, onDecide, onEverything }: Props) {
  const active = runs.filter((r) => ACTIVE.has(r.state));
  return <div className="cp-body">
    {!ready ? <p className="cp-lede">Loading…</p> : stands && <p className="cp-lede">{stands.text}{stands.ago && <small className="cp-ago">{stands.ago}</small>}</p>}
    {needs.length > 0 && <section aria-label="Needs you" className="cp-sec">
      <h3 className="cp-h">Needs you</h3>
      <ul className="cp-list">{needs.map((t) => {
        const { id, rest } = splitTitle(cleanText(t.title));
        const meta = [actionOf(t), dueText(t.due)].filter(Boolean).join(" · ");
        return <li key={t.id} className="cp-item">
          <button type="button" className="cp-need" data-id={id ?? undefined} onClick={() => onTask(t)}>
            <span className="cp-title">{rest}</span>{meta && <small>{meta}</small>}</button>
          {t.kind === "decision" && t.options.length > 0 && <div className="cp-opts" role="group" aria-label="Decide">{t.options.map((o) => <button key={o} type="button" className="cp-opt" onClick={() => onDecide(t, o)}>{cleanText(o)}</button>)}</div>}
        </li>;
      })}</ul>
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
        <span aria-hidden="true">‹</span>{p.needs.length > 0 && <i className="cp-dot" aria-label="Needs you" />}</button>}
  </aside>;
}

/** The phone's strip: one line, tap to open. */
export function CompanionStrip({ open, onToggle, ...p }: Props & Fold) {
  return <section className={`cp strip ${open ? "open" : ""}`} aria-label="Where this stands">
    <button type="button" className="cp-line" aria-expanded={open} onClick={() => onToggle(!open)}>
      <span className="cp-line-text">{open ? "Where this stands" : p.ready ? p.stands?.text ?? "Where this stands" : "Loading…"}</span>
      {p.needs.length > 0 && <i className="cp-dot" aria-label="Needs you" />}
      <span className="cp-chev" aria-hidden="true">{open ? "⌃" : "⌄"}</span>
    </button>
    {open && <Body {...p} />}
  </section>;
}
