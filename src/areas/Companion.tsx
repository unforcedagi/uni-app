// T-124: the room's quiet companion. Not a page: one sentence on where the room stands, at most three things that need the user, and what is
// running (only when something is). Desktop: a side panel that folds to a thin rail. Phone: a one-line strip at the top of the room that opens
// downward. Each item opens its task sheet; "Everything here" goes one level deeper, to the full node page. The fold is remembered per device.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cleanText } from "../interface/contract";
import { RefText } from "./noteRefs";
import { isActiveRun, type Run } from "./steerCore";
import type { Task } from "./taskCore";
import { splitTitle } from "./whereCore";
import { splitLinks } from "./linkText";
import { actionableTitle, askLead, dueLine, isOverdue, lineBudget, rowAsk } from "./simpleCore";

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


export type CompanionProps = {
  /** Where this stands: the sentence and, quietly, when it was written. Null: nothing to say. */
  stands: { text: string; ago: string } | null; ready: boolean;
  /** Said in place of a node's state (a room no node owns: "Not filed under an area yet."); there is then no Needs you and no way deeper. */
  note?: string | null;
  /** The task list's health: a failed first load (never an endless "Loading…"), a failed refresh (the rows stay), and whether every page was read. */
  load?: TaskLoad;
  /** Items here that need you but may not be named (a private area), counted. */
  hidden?: number;
  needs: readonly Task[];
  runs: readonly Run[];
  /** The node's name, so the way deeper says what it opens ("All of COhere's work"). */
  nodeName: string;
  onTask: (t: Task) => void; onDecide: (t: Task, option: string) => void;
  /** "All of X's work" (null: none, for a room no node owns). */
  onEverything: (() => void) | null;
  /** Opens a linked note (by id) from a title or next step. */
  onNote?: (ref: string) => void;
};
export type TaskLoad = { error: string | null; refreshing: boolean; lastOk: number | null; complete: boolean; retry: () => void };

/** Options shown inline on a decision; more are behind the item. */
const OPTS_SHOWN = 3;
const URL_RE = /https?:\/\/\S+|\bwww\.\S+/g;
/** One line of detail: no raw links (they stay in the opened item), whitespace squeezed, no dangling separators. */
export const plainDetail = (s: string): string => s.replace(URL_RE, "").replace(/\s+/g, " ").replace(/\s*[·,;:(\[-]+\s*$/, "").replace(/\(\s*\)/g, "").trim();
/** Running rows shown; the rest are behind the footer link. */
const RUNS_SHOWN = 2;
type Fold = { open: boolean; onToggle: (v: boolean) => void };

/** The ask itself: the "Decision (default yes):" style label a decision's title carries is left to the opened item. */
export const askOf = (rest: string): string => { const t = plainDetail(rest) || rest; return t.replace(/^decision\s*(\([^)]*\))?\s*[:\-–—]\s*/i, "").trim() || t; };

const openLink = (e: React.MouseEvent, url: string) => { e.preventDefault(); void invoke("open_link", { url }).catch(() => {}); };

/** A task's next step, in full: wraps up to 6 lines, then "More" opens the rest in place. Links read as their domain and stay clickable; note ids read as the note's title. */
export function NextText({ text, onNote, lines, open: openProp, onOpen, onClamp }: { text: string; onNote?: (ref: string) => void; lines?: number; open?: boolean; onOpen?: (v: boolean) => void; onClamp?: (v: boolean) => void }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [openOwn, setOpenOwn] = useState(false);
  const open = openProp ?? openOwn;
  const setOpen = onOpen ?? setOpenOwn;
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const measure = () => { if (!open) { const c = el.scrollHeight > el.clientHeight + 1; setClamped(c); onClamp?.(c); } };
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [text, open, lines]);
  if (lines !== undefined && lines <= 0 && !open) return null;
  return <div className="cp-next-wrap">
    <p ref={ref} className={`cp-next ${open ? "open" : ""}`} style={!open && lines !== undefined ? { WebkitLineClamp: lines, lineClamp: lines, maxHeight: `${(lines * 13.5 * 1.45).toFixed(2)}px` } as React.CSSProperties : undefined}>{splitLinks(cleanText(text)).map((p, i) => "url" in p
      ? <a key={i} className="cp-link" href={p.url} title={p.url} rel="noreferrer noopener" onClick={(e) => openLink(e, p.url)}>{p.label}</a>
      : <RefText key={i} text={p.text} onNote={onNote} />)}</p>
    {!onOpen && (clamped || open) && <button type="button" className="cp-more-next" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Less" : "More"}</button>}
  </div>;
}

/** The whole sentence, clamped at 3 lines on screen only; "More" (a real button) shows all of it. */
function Stands({ text, ago }: { text: string; ago: string }) {
  const [full, setFull] = useState(false);
  const [clamped, setClamped] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const measure = () => { if (!full) setClamped(el.scrollHeight > el.clientHeight + 1); };
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [text, full]);
  return <p className={`cp-lede ${full ? "full" : ""}`}><span ref={ref} className="cp-stands">{text}</span>
    {(clamped || full) && <button type="button" className="cp-more-next cp-stands-more" aria-expanded={full} onClick={() => setFull(!full)}>{full ? "Less" : "More"}</button>}
    {ago && <small className="cp-ago">{ago}</small>}</p>;
}

/** A decision's question as every surface shows it (r12): its whole ask, sentence-cased, with "Your call:" when it does not ask; or, when no
 *  whole question exists anywhere, "Open to see the question" and nothing to answer yet. */
export function decisionAsk(t: Task): { text: string; yourCall: boolean; answerable: boolean } {
  const { rest } = splitTitle(cleanText(t.title));
  const a = rowAsk(askOf(rest), t.ask, true, !!t.next.trim());
  if (a.openToDecide) return { text: a.text, yourCall: false, answerable: false };
  const l = askLead(a.text);
  return { text: l.text, yourCall: l.yourCall, answerable: true };
}

/**
 * The one way a decision is closed (r12): its options, or Yes and No when it has none. A tap records the answer (`decided`) through the
 * vault's compare-and-set; nothing closes a decision without one. The companion, the task sheet and the work page all use this.
 */
export function DecisionAnswer({ t, label, onDecide, max = Infinity, onMore, className = "" }: { t: Task; label: string; onDecide: (t: Task, option: string) => void; max?: number; onMore?: () => void; className?: string }) {
  const opts = t.options.length ? t.options.map((o) => ({ label: cleanText(o), value: o })) : [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }];
  return <div className={`cp-opts ${t.options.length ? "" : "cp-yesno"} ${className}`} role="group" aria-label={`Decide: ${label}`}>
    {opts.slice(0, max).map((o) => <button key={o.value} type="button" className="cp-opt" onClick={() => onDecide(t, o.value)}>{o.label}</button>)}
    {opts.length > max && onMore && <button type="button" className="cp-opt more" onClick={onMore}>More…</button>}
  </div>;
}

/** A Needs-you row: the ask, then when it was due, then the next step, action first; a tap on More shows all of it. A decision is its whole question with its answers. */
function NeedRow({ t, onTask, onDecide, onNote }: { t: Task; onTask: (t: Task) => void; onDecide: (t: Task, option: string) => void; onNote?: (ref: string) => void }) {
  const { id, rest: full } = splitTitle(cleanText(t.title));
  const isDecision = t.kind === "decision";
  const next = t.next.trim();
  const due = dueLine(t.due);
  const ask = rowAsk(askOf(full), t.ask, isDecision, !!next);
  // a decision is its whole question, sentence-cased and never clamped, beside its answers; with no whole question anywhere, "Open to see the question ›"
  const dq = isDecision ? decisionAsk(t) : null;
  const lead = dq?.answerable ? dq : null;
  const text = dq ? dq.text : ask.text || "Open to see what's needed";
  const titleRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [titleLines, setTitleLines] = useState(1);
  const [titleCut, setTitleCut] = useState(false);
  const [nextCut, setNextCut] = useState(false);
  // an action reads to its object (up to 3 lines beside other lines, 4 alone)
  const titleMax = isDecision ? 99 : next || due ? 3 : 4;
  useLayoutEffect(() => {
    const el = titleRef.current; if (!el) return;
    const measure = () => {
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
      setTitleLines(Math.max(1, Math.round(el.clientHeight / lh)));
      if (!open) setTitleCut(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [text, open, titleMax]);
  const nextLines = lineBudget(Math.min(titleLines, titleMax), !!due, 4).next;
  const more = open || (titleCut && !isDecision) || nextCut || (!!next && nextLines <= 0);
  const clampStyle = open || isDecision ? undefined : ({ WebkitLineClamp: titleMax, lineClamp: titleMax } as React.CSSProperties);
  return <li className="cp-item" data-open={open ? "true" : undefined}>
    <button type="button" className={`cp-need${isDecision ? " decision" : ""}`} data-id={id ?? undefined} onClick={() => onTask(t)}>
      {lead?.yourCall && <small className="cp-call-lead">Your call:</small>}
      <span ref={titleRef} className="cp-title" style={clampStyle}><RefText text={text} />{ask.openToDecide && <span className="cp-go" aria-hidden="true"> ›</span>}</span>
      {due && <small className={`cp-detail${isOverdue(t.due) ? " overdue" : ""}`}>{due}</small>}</button>
    {!next && !isDecision && !actionableTitle(text) && text !== "Open to see what's needed" && <p className="cp-open-to-see">Open to see what's needed</p>}
    {next && <NextText text={next} onNote={onNote} lines={open ? undefined : nextLines} open={open} onOpen={setOpen} onClamp={setNextCut} />}
    {more && <button type="button" className="cp-more-next cp-row-more" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Less" : "More"}</button>}
    {lead && <DecisionAnswer t={t} label={text} onDecide={onDecide} max={OPTS_SHOWN} onMore={() => onTask(t)} />}
  </li>;
}

/**
 * Only whole rows are shown: in the side panel (`fit`) the rows that don't fit above the footer wait behind "+N more ›" rather than being
 * cut or faded at the panel's bottom. Every row is drawn once to be measured (before paint), then the ones that fit stay.
 */
function NeedsList({ needs, fit, onTask, onDecide, onNote }: Pick<CompanionProps, "needs" | "onTask" | "onDecide" | "onNote"> & { fit: boolean }) {
  const [limit, setLimit] = useState(Infinity);
  const [measuring, setMeasuring] = useState(fit);
  const [all, setAll] = useState(false);
  const [size, setSize] = useState("");
  const listRef = useRef<HTMLUListElement>(null);
  const settled = useRef(""); // the list the last measurement was made for
  const remeasured = useRef(0);
  const key = needs.map((t) => `${t.id}\n${t.ask ?? ""}\n${t.next}`).join("\u0000");
  useLayoutEffect(() => {
    const scroller = listRef.current?.closest(".cp.side") as HTMLElement | null;
    if (!fit || !scroller) return;
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => setSize(`${scroller.clientWidth}x${scroller.clientHeight}`));
    ro?.observe(scroller);
    setSize(`${scroller.clientWidth}x${scroller.clientHeight}`);
    return () => ro?.disconnect();
  }, [fit]);
  useLayoutEffect(() => { if (fit) { setAll(false); setLimit(Infinity); setMeasuring(true); } }, [fit, key, size]);
  useLayoutEffect(() => {
    if (!fit || !measuring) return;
    const list = listRef.current; const scroller = list?.closest(".cp.side") as HTMLElement | null; const body = list?.closest(".cp-body") as HTMLElement | null;
    if (!list || !scroller || !body) { setMeasuring(false); return; }
    const rows = [...list.children] as HTMLElement[];
    // room for the list = the panel minus everything that is not the list (heading, sentence, runs, footer) minus the "+N more" line
    // with every row drawn: no overflow means they all fit. Otherwise the body has its natural height, and the panel's own bar sits outside it
    const top = scroller.querySelector<HTMLElement>(".cp-top")?.offsetHeight ?? 0;
    const fits = scroller.scrollHeight <= scroller.clientHeight + 1;
    const budget = scroller.clientHeight - top - (body.scrollHeight - list.offsetHeight) - 40;
    let used = 0; let n = 0;
    for (const r of fits ? [] : rows) { if (n > 0 && used + r.offsetHeight > budget) break; used += r.offsetHeight; n++; }
    setLimit(fits || n >= rows.length ? Infinity : n);
    if (settled.current !== key) remeasured.current = 0;
    settled.current = key;
    setMeasuring(false);
  }, [measuring, fit]); // eslint-disable-line react-hooks/exhaustive-deps
  // a row can change height after it was measured (a full question arrives, a next step wraps): if the panel then overflows, measure
  // again (a few times in a row at most, so this settles)
  useLayoutEffect(() => {
    const list = listRef.current; const scroller = list?.closest(".cp.side") as HTMLElement | null;
    if (!fit || !list || !scroller || measuring || all || typeof ResizeObserver === "undefined") return;
    const check = () => {
      if (settled.current !== key || list.querySelector("[data-open]")) return;
      if (scroller.scrollHeight <= scroller.clientHeight + 1) { remeasured.current = 0; return; }
      if (remeasured.current < 6) { remeasured.current++; setLimit(Infinity); setMeasuring(true); }
    };
    const ro = new ResizeObserver(check);
    ro.observe(list);
    const body = list.closest(".cp-body"); if (body) ro.observe(body); // the sentence or the footer can change height too
    check();
    return () => ro.disconnect();
  }, [fit, measuring, all, limit, needs.length, key]);
  const shown = fit && !measuring && !all ? needs.slice(0, limit) : needs;
  const hidden = needs.length - shown.length;
  return <>
    <ul ref={listRef} className="cp-list">{shown.map((t) => <NeedRow key={t.id} t={t} onTask={onTask} onDecide={onDecide} onNote={onNote} />)}</ul>
    {hidden > 0 && <button type="button" className="cp-more cp-more-rows" onClick={() => setAll(true)}>+{hidden} more ›</button>}
  </>;
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

function Body({ stands, ready, note, load, hidden = 0, needs, runs, nodeName, onTask, onDecide, onEverything, onNote, fit }: CompanionProps & { fit: boolean }) {
  const active = runs.filter(isActiveRun);
  const hiddenRuns = Math.max(0, active.length - RUNS_SHOWN);
  if (note) return <div className="cp-body"><p className="cp-lede cp-note">{note}</p></div>;
  const retry = load && <button type="button" className="cp-retry" onClick={load.retry}>Retry</button>;
  return <div className="cp-body">
    {!ready ? (load?.error ? <p className="cp-lede cp-failed" role="alert">Couldn't load. {retry}</p> : <p className="cp-lede">Loading…</p>) : stands && <Stands text={stands.text} ago={stands.ago} />}
    {ready && <section aria-label="Needs you" className="cp-sec" aria-busy={load?.refreshing || undefined}>
      <h3 className="cp-h">Needs you</h3>
      {needs.length > 0 ? <NeedsList needs={needs} fit={fit} onTask={onTask} onDecide={onDecide} onNote={onNote} /> : !hidden && <p className="cp-none">Nothing needs you here.</p>}
      {hidden > 0 && <p className="cp-none cp-private">{hidden} {needs.length ? "more " : ""}{hidden === 1 ? "needs" : "need"} you here, counted but not named (private).</p>}
      {load?.error && <p className="cp-stale" role="status">Couldn't refresh{load.lastOk ? ` (as of ${clock(load.lastOk)})` : ""} · {retry}</p>}
      {load && !load.error && !load.complete && <p className="cp-stale" role="status">More work exists than the app could read; some may not be listed.</p>}
    </section>}
    {active.length > 0 && <section aria-label="Running" className="cp-sec">
      <h3 className="cp-h">Running</h3>
      <ul className="cp-list">{active.slice(0, RUNS_SHOWN).map((r) => <li key={r.id} className="cp-run" data-state={r.state}><i aria-hidden="true" /><span>{cleanText(r.what)}</span><small>{r.state}</small></li>)}</ul>
    </section>}
    {onEverything && <div className="cp-foot"><button type="button" className="cp-all" onClick={onEverything}><span className="cp-all-t">{`All of ${nodeName}'s work`}</span>{hiddenRuns > 0 && <span className="cp-all-more">+{hiddenRuns} more running</span>}<span className="cp-all-arrow" aria-hidden="true">→</span></button></div>}
  </div>;
}

/** The side panel (wide screens). `open` and `onToggle` come from `useCompanionOpen("side")`. */
export function CompanionSide({ open, onToggle, ...p }: CompanionProps & Fold) {
  return <aside className={`cp side ${open ? "open" : "folded"}`} aria-label="Where this stands">
    {open
      ? <>
        <button type="button" className="cp-top" aria-expanded="true" aria-label="Hide where this stands" title="Hide where this stands" onClick={() => onToggle(false)}><span>Where this stands</span><span className="cp-fold" aria-hidden="true">›</span></button>
        <Body {...p} fit />
      </>
      : <button type="button" className="cp-unfold" aria-expanded="false" aria-label="Show where this stands" title="Show where this stands" onClick={() => onToggle(true)}>
        <span aria-hidden="true">‹</span>{p.needs.length > 0 && <i className="cp-dot" role="img" aria-label="Needs you" title="Needs you" />}</button>}
  </aside>;
}

/** The phone's strip: one line, tap to open. */
export function CompanionStrip({ open, onToggle, ...p }: CompanionProps & Fold) {
  return <section className={`cp strip ${open ? "open" : ""}`} aria-label="Where this stands">
    <button type="button" className="cp-line" aria-expanded={open} onClick={() => onToggle(!open)}>
      <span className="cp-line-text" title={p.stands?.text}>{open ? "Where this stands" : p.note ?? (p.ready ? p.stands?.text ?? "Where this stands" : p.load?.error ? "Couldn't load" : "Loading…")}</span>
      {p.needs.length > 0 && <i className="cp-dot" role="img" aria-label="Needs you" title="Needs you" />}
      <span className="cp-chev" aria-hidden="true">{open ? "⌃" : "⌄"}</span>
    </button>
    {open && <Body {...p} fit={false} />}
  </section>;
}
