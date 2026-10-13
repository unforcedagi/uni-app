// T-124: the room's quiet companion. Not a page: one sentence on where the room stands, at most three things that need the user, and what is
// running (only when something is). Desktop: a side panel that folds to a thin rail. Phone: a one-line strip at the top of the room that opens
// downward. Each item opens its task sheet; "Everything here" goes one level deeper, to the full node page. The fold is remembered per device.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cleanText } from "../interface/contract";
import { dueText } from "./NodeWork";
import { isMe } from "./taskCore";
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
  /** The node's name, so the way deeper says what it opens ("All of COhere's work"). */
  nodeName: string;
  onTask: (t: Task) => void; onDecide: (t: Task, option: string) => void; onEverything: () => void;
};
/** Options shown inline on a decision; more are behind the item. */
const OPTS_SHOWN = 3;
const URL_RE = /https?:\/\/\S+|\bwww\.\S+/g;
/** One line of detail: no raw links (they stay in the opened item), whitespace squeezed, no dangling separators. */
export const plainDetail = (s: string): string => s.replace(URL_RE, "").replace(/\s+/g, " ").replace(/\s*[·,;:(\[-]+\s*$/, "").replace(/\(\s*\)/g, "").trim();
/** Running rows shown; the rest are behind the footer link. */
const RUNS_SHOWN = 2;
/** Whole questions or none: how many needs-you items fit a window this tall (a decision's ask wraps in full). */
export const needsFit = (h: number): number => (h >= 820 ? 3 : h >= 640 ? 2 : 1);
function useViewportHeight(): number {
  const [h, setH] = useState(() => (typeof window === "undefined" ? 900 : window.innerHeight));
  useEffect(() => { const f = () => setH(window.innerHeight); window.addEventListener("resize", f); return () => window.removeEventListener("resize", f); }, []);
  return h;
}
type Fold = { open: boolean; onToggle: (v: boolean) => void };

/** The ask itself: the "Decision (default yes):" style label a decision's title carries is left to the opened item. */
export const askOf = (rest: string): string => { const t = plainDetail(rest) || rest; return t.replace(/^decision\s*(\([^)]*\))?\s*[:\-–—]\s*/i, "").trim() || t; };

/** What Aaron does with it: a decision is decided, a task waiting on him says so, else its next step. */
function actionOf(t: Task): string | null {
  if (t.kind === "decision") return null;
  if (isMe(t.waitingOn)) return t.next ? `Waiting on you · ${t.next}` : "Waiting on you";
  return t.next || null;
}

/** "All of X's work", or "All work" when the name doesn't fit the line. Measured, not guessed: the long form is tried first. */
function FootLabel({ name }: { name: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const fit = () => { el.textContent = `All of ${name}'s work`; if (el.scrollWidth > el.clientWidth + 1) el.textContent = "All work"; };
    fit();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    ro?.observe(el.parentElement ?? el);
    return () => ro?.disconnect();
  }, [name]);
  return <span ref={ref} className="cp-all-t" title={`All of ${name}'s work`} />;
}

function Body({ stands, ready, needs, runs, nodeName, onTask, onDecide, onEverything }: Props) {
  const active = runs.filter((r) => ACTIVE.has(r.state));
  const hiddenRuns = Math.max(0, active.length - RUNS_SHOWN);
  const shownNeeds = needs.slice(0, needsFit(useViewportHeight()));
  return <div className="cp-body">
    {!ready ? <p className="cp-lede">Loading…</p> : stands && <p className="cp-lede" title={stands.text}><span className="cp-stands">{stands.text}</span>{stands.ago && <small className="cp-ago">{stands.ago}</small>}</p>}
    {shownNeeds.length > 0 && <section aria-label="Needs you" className="cp-sec">
      <h3 className="cp-h">Needs you</h3>
      <ul className="cp-list">{shownNeeds.map((t) => {
        const { id, rest: full } = splitTitle(cleanText(t.title));
        const rest = askOf(full);
        const meta = plainDetail([actionOf(t), dueText(t.due)].filter(Boolean).join(" · "));
        const opts = t.kind === "decision" ? t.options : [];
        const isDecision = t.kind === "decision";
        return <li key={t.id} className="cp-item">
          <button type="button" className={`cp-need${isDecision ? " decision" : ""}`} data-id={id ?? undefined} onClick={() => onTask(t)}>
            <span className="cp-title">{rest}{isDecision && opts.length === 0 && <span className="cp-go" aria-hidden="true"> ›</span>}</span>{meta && <small className="cp-detail">{meta}</small>}</button>
          {isDecision && opts.length > 0 && <div className="cp-opts" role="group" aria-label={`Decide: ${rest}`}>
            {opts.slice(0, OPTS_SHOWN).map((o) => <button key={o} type="button" className="cp-opt" onClick={() => onDecide(t, o)}>{cleanText(o)}</button>)}
            {opts.length > OPTS_SHOWN && <button type="button" className="cp-opt more" onClick={() => onTask(t)}>More…</button>}
          </div>}
        </li>;
      })}</ul>
    </section>}
    {active.length > 0 && <section aria-label="Running" className="cp-sec">
      <h3 className="cp-h">Running</h3>
      <ul className="cp-list">{active.slice(0, RUNS_SHOWN).map((r) => <li key={r.id} className="cp-run" data-state={r.state}><i aria-hidden="true" /><span>{cleanText(r.what)}</span><small>{r.state}</small></li>)}</ul>
    </section>}
    <div className="cp-foot"><button type="button" className="cp-all" onClick={onEverything}><FootLabel name={nodeName} />{hiddenRuns > 0 && <span className="cp-all-more">+{hiddenRuns} more running</span>}<span className="cp-all-arrow" aria-hidden="true">→</span></button></div>
  </div>;
}

/** The side panel (wide screens). `open` and `onToggle` come from `useCompanionOpen("side")`. */
export function CompanionSide({ open, onToggle, ...p }: Props & Fold) {
  return <aside className={`cp side ${open ? "open" : "folded"}`} aria-label="Where this stands">
    {open
      ? <>
        <button type="button" className="cp-top" aria-expanded="true" aria-label="Hide where this stands" title="Hide where this stands" onClick={() => onToggle(false)}><span>Where this stands</span><span className="cp-fold" aria-hidden="true">›</span></button>
        <Body {...p} />
      </>
      : <button type="button" className="cp-unfold" aria-expanded="false" aria-label="Show where this stands" title="Show where this stands" onClick={() => onToggle(true)}>
        <span aria-hidden="true">‹</span>{p.needs.length > 0 && <i className="cp-dot" role="img" aria-label="Needs you" title="Needs you" />}</button>}
  </aside>;
}

/** The phone's strip: one line, tap to open. */
export function CompanionStrip({ open, onToggle, ...p }: Props & Fold) {
  return <section className={`cp strip ${open ? "open" : ""}`} aria-label="Where this stands">
    <button type="button" className="cp-line" aria-expanded={open} onClick={() => onToggle(!open)}>
      <span className="cp-line-text" title={p.stands?.text}>{open ? "Where this stands" : p.ready ? p.stands?.text ?? "Where this stands" : "Loading…"}</span>
      {p.needs.length > 0 && <i className="cp-dot" role="img" aria-label="Needs you" title="Needs you" />}
      <span className="cp-chev" aria-hidden="true">{open ? "⌃" : "⌄"}</span>
    </button>
    {open && <Body {...p} />}
  </section>;
}
