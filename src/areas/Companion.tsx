// T-124: the room's quiet companion. Not a page: one sentence on where the room stands, at most three things that need the user, and what is
// running (only when something is). Desktop: a side panel that folds to a thin rail. Phone: a one-line strip at the top of the room that opens
// downward. Each item opens its task sheet; "Everything here" goes one level deeper, to the full node page. The fold is remembered per device.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cleanText } from "../interface/contract";
import { RefText } from "./noteRefs";
import { LoadHealth } from "./LoadHealth";
import { isActiveRun, type Run } from "./steerCore";
import type { Task } from "./taskCore";
import { splitTitle } from "./whereCore";
import { splitLinks } from "./linkText";
import { actionableTitle, actionLead, askLead, askPreview, decisionQuestion, dueLine, fitsRow, isOverdue, lineBudget, OPEN_TO_SEE, privateLabel, rowAsk, type NeedsFeed, type PrivateNeed } from "./simpleCore";

const KEYS = { side: "uni.companion.side.v1", sideNarrow: "uni.companion.side.narrow.v1", strip: "uni.companion.strip.v1" } as const;
/** Below this width the side panel starts folded: the conversation gets the space. */
export const SIDE_OPEN_MIN = 1100;
const read = (key: string, open: boolean): boolean => { try { const v = localStorage.getItem(key); return v === null ? open : v === "1"; } catch { return open; } };
const roomy = () => typeof window === "undefined" || window.innerWidth >= SIDE_OPEN_MIN;
/** The side panel keeps one choice per width class (r13): at 1100px and over it opens unless folded there; under 1100px it is folded unless
 *  opened there. A window resized across 1100px takes that width's choice, so a panel open on a wide window folds when it narrows. */
const keyFor = (variant: "side" | "strip") => (variant === "strip" ? KEYS.strip : roomy() ? KEYS.side : KEYS.sideNarrow);
const choice = (variant: "side" | "strip") => read(keyFor(variant), variant === "side" && roomy());

/** Whether the companion is open on this device: open by default beside the chat on a wide window (folded under 1100px), folded by default as a phone strip. */
export function useCompanionOpen(variant: "side" | "strip"): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(() => choice(variant));
  useEffect(() => {
    setOpen(choice(variant));
    if (variant !== "side" || typeof window === "undefined") return;
    const mq = window.matchMedia(`(min-width: ${SIDE_OPEN_MIN}px)`);
    const cross = () => setOpen(choice(variant));
    mq.addEventListener("change", cross);
    return () => mq.removeEventListener("change", cross);
  }, [variant]);
  return [open, (v) => { setOpen(v); try { localStorage.setItem(keyFor(variant), v ? "1" : "0"); } catch { /* this session only */ } }];
}


export type CompanionProps = {
  /** Where this stands: the sentence and, quietly, when it was written. Null: nothing to say. */
  stands: { text: string; ago: string } | null; ready: boolean;
  /** Said in place of a node's state (a room no node owns: "Not filed under an area yet."); there is then no Needs you and no way deeper. */
  note?: string | null;
  /** The task list's health: a failed first load (never an endless "Loading…"), a failed refresh (the rows stay), and whether every page was read. */
  load?: TaskLoad;
  /** What needs you here, by the one rule: the rows shown, the private items (named by place only) and the total every surface agrees on. */
  feed: NeedsFeed;
  /** Uni's panel: how many more from the areas wait in "All of Uni's work" ("+N in areas ›"). */
  rest?: number;
  /** Open a private area (its items are shown inside it). */
  onPrivate?: (open: PrivateNeed["open"]) => void;
  runs: readonly Run[];
  /** The node's name, so the way deeper says what it opens ("All of COhere's work"). */
  nodeName: string;
  onTask: (t: Task) => void; onDecide: (t: Task, option: string) => void;
  /** "All of X's work" (null: none, for a room no node owns). */
  onEverything: (() => void) | null;
  /** Opens a linked note (by id) from a title or next step. */
  onNote?: (ref: string) => void;
};
export type TaskLoad = { error: string | null; /** The task tree (the nodes) could not be read: the list may be placed wrongly. */ treeError?: string | null; refreshing: boolean; lastOk: number | null; complete: boolean; retry: () => void };

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

/**
 * A decision's question as every surface shows it (r14): its whole question (the title when not cut, else the ask read from its note at the
 * row's own revision), sentence-cased, with "Your call:" when it does not ask. `answerable`: the whole question is known; `fits`: it fits a
 * row, so a row may show it beside its answers (a longer one shows `preview` and opens to decide). With no whole question, nothing to answer.
 */
export function decisionAsk(t: Task): { text: string; yourCall: boolean; answerable: boolean; fits: boolean; preview: string } {
  const { rest } = splitTitle(cleanText(t.title));
  const q = decisionQuestion(rest, t.ask, t.askAt, t.updatedAt);
  if (!q) return { text: OPEN_TO_SEE, yourCall: false, answerable: false, fits: false, preview: OPEN_TO_SEE };
  const l = askLead(q);
  return { text: l.text, yourCall: l.yourCall, answerable: true, fits: fitsRow(l.text), preview: askPreview(l.text) };
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

/** What a Needs-you row leads with (r14), the same in the companion, the work view and the sheet: a task's action when its next step names one
 *  (the title, its event or project, is a quiet line under it); a decision's whole question; else the title. */
export function rowLead(t: Task): { text: string; under: string | null; go: string | null; answers: boolean; yourCall: boolean; lead: boolean } {
  const { rest: full } = splitTitle(cleanText(t.title));
  const next = t.next.trim();
  if (t.kind === "decision") {
    const dq = decisionAsk(t);
    if (!dq.answerable) return { text: dq.text, under: null, go: "", answers: false, yourCall: false, lead: false };
    if (!dq.fits) return { text: dq.preview, under: null, go: "Open to decide", answers: false, yourCall: dq.yourCall, lead: false };
    return { text: dq.text, under: null, go: null, answers: true, yourCall: dq.yourCall, lead: false };
  }
  const ask = rowAsk(askOf(full), t.ask, false, !!next);
  const action = actionLead(next);
  if (action) return { text: plainDetail(action) || action, under: ask.text || null, go: null, answers: false, yourCall: false, lead: true };
  return { text: ask.text || "Open to see what's needed", under: null, go: null, answers: false, yourCall: false, lead: false };
}

/**
 * A Needs-you row (r14): action first. A task whose next step names an action leads with it (two full lines, then More), its title under it as
 * a quiet line; otherwise the title, then the next step. A decision is its whole question beside its answers when it fits; a longer one shows a
 * preview and "Open to decide ›"; with no whole question, "Open to see the question ›". Never answers beside a preview.
 */
export function NeedRow({ t, onTask, onDecide, onNote, meta }: { t: Task; onTask: (t: Task) => void; onDecide: (t: Task, option: string) => void; onNote?: (ref: string) => void;
  /** A quiet line on where it stands, for a row that is not the user's ("With Kevin · in progress"; the work view's In motion and Later). */
  meta?: string | null }) {
  const { id } = splitTitle(cleanText(t.title));
  const isDecision = t.kind === "decision";
  const next = t.next.trim();
  const due = dueLine(t.due);
  const r = rowLead(t);
  const text = r.text;
  const titleRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [titleLines, setTitleLines] = useState(1);
  const [titleCut, setTitleCut] = useState(false);
  const [nextCut, setNextCut] = useState(false);
  // an action leads with two full lines; a title reads to its object (up to 3 lines beside other lines, 4 alone); a decision is never clamped
  const titleMax = isDecision ? 99 : r.lead ? 2 : next || due ? 3 : 4;
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
  // the next step shows under a title; a row that leads with it does not repeat it
  const showNext = !!next && !r.lead && !isDecision;
  const nextLines = lineBudget(Math.min(titleLines, titleMax), !!due, 4).next;
  const more = open || (titleCut && !isDecision) || (showNext && (nextCut || nextLines <= 0));
  const clampStyle = open || isDecision ? undefined : ({ WebkitLineClamp: titleMax, lineClamp: titleMax } as React.CSSProperties);
  return <li className="cp-item" data-open={open ? "true" : undefined} data-lead={r.lead ? "action" : undefined}>
    <button type="button" className={`cp-need${isDecision ? " decision" : ""}`} data-id={id ?? undefined} onClick={() => onTask(t)}>
      {r.yourCall && <small className="cp-call-lead">Your call:</small>}
      <span ref={titleRef} className="cp-title" style={clampStyle}><RefText text={text} />{r.go === "" && <span className="cp-go" aria-hidden="true"> ›</span>}</span>
      {r.go && <span className="cp-open-decide">{r.go}<span aria-hidden="true"> ›</span></span>}
      {r.under && <small className="cp-detail cp-under">{r.under}</small>}
      {due && <small className={`cp-detail${isOverdue(t.due) ? " overdue" : ""}`}>{due}</small>}
      {meta && <small className="cp-detail cp-meta">{meta}</small>}</button>
    {!next && !isDecision && !actionableTitle(text) && text !== "Open to see what's needed" && <p className="cp-open-to-see">Open to see what's needed</p>}
    {showNext && <NextText text={next} onNote={onNote} lines={open ? undefined : nextLines} open={open} onOpen={setOpen} onClamp={setNextCut} />}
    {more && <button type="button" className="cp-more-next cp-row-more" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Less" : "More"}</button>}
    {r.answers && <DecisionAnswer t={t} label={text} onDecide={onDecide} max={OPTS_SHOWN} onMore={() => onTask(t)} />}
  </li>;
}

/** A private area's items, from outside it (r14): "Sadhana: 2 for you ›", opening that area. Never a title. */
export function PrivateRow({ p, onPrivate }: { p: PrivateNeed; onPrivate?: (open: PrivateNeed["open"]) => void }) {
  return <li className="cp-item cp-private-item"><button type="button" className="cp-need cp-private" onClick={() => onPrivate?.(p.open)}>
    <span className="cp-title">{privateLabel(p)}<span className="cp-go" aria-hidden="true"> ›</span></span></button></li>;
}

/**
 * Only whole rows are shown: in the side panel (`fit`) the rows that don't fit above the footer wait behind "+N more ›" rather than being
 * cut or faded at the panel's bottom. Every row is drawn once to be measured (before paint), then the ones that fit stay.
 */
export function NeedsList({ needs, fit, onTask, onDecide, onNote }: Pick<CompanionProps, "onTask" | "onDecide" | "onNote"> & { needs: readonly Task[]; fit: boolean }) {
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
  // a new list folds back to what fits; a resize only measures again, so "+N more" once opened stays open (r13: opening it can add a
  // scrollbar, which narrows the panel, and that must not fold it back)
  useLayoutEffect(() => { if (fit) { setAll(false); setLimit(Infinity); setMeasuring(true); } }, [fit, key]);
  useLayoutEffect(() => { if (fit && !all) { setLimit(Infinity); setMeasuring(true); } }, [size]); // eslint-disable-line react-hooks/exhaustive-deps
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

function Body({ stands, ready, note, load, feed, rest = 0, onPrivate, runs, nodeName, onTask, onDecide, onEverything, onNote, fit, hideHealth = false }: CompanionProps & { fit: boolean; hideHealth?: boolean }) {
  const active = runs.filter(isActiveRun);
  const hiddenRuns = Math.max(0, active.length - RUNS_SHOWN);
  if (note) return <div className="cp-body"><p className="cp-lede cp-note">{note}</p></div>;
  // below 900px the room shows the list's health itself, outside the strip (r14)
  const health = !hideHealth && <LoadHealth load={load} ready={ready} />;
  return <div className="cp-body">
    {!ready ? (load?.error ? health : <p className="cp-lede">Loading…</p>) : stands && <Stands text={stands.text} ago={stands.ago} />}
    {ready && <section aria-label="Needs you" className="cp-sec" aria-busy={load?.refreshing || undefined}>
      <h3 className="cp-h">Needs you</h3>
      {feed.rows.length > 0 && <NeedsList needs={feed.rows} fit={fit} onTask={onTask} onDecide={onDecide} onNote={onNote} />}
      {feed.privates.length > 0 && <ul className="cp-list cp-privates">{feed.privates.map((p) => <PrivateRow key={p.key} p={p} onPrivate={onPrivate} />)}</ul>}
      {rest > 0 && onEverything && <button type="button" className="cp-more cp-more-areas" onClick={onEverything}>+{rest} in areas ›</button>}
      {feed.total === 0 && <p className="cp-none">Nothing needs you here.</p>}
      {health}
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
        <span aria-hidden="true">‹</span>{p.feed.total > 0 && <i className="cp-dot" role="img" aria-label="Needs you" title="Needs you" />}</button>}
  </aside>;
}

/** The phone's strip: one line, tap to open. */
export function CompanionStrip({ open, onToggle, ...p }: CompanionProps & Fold) {
  // the strip sits in a room below 900px, which shows the list's health above it (r14)
  return <section className={`cp strip ${open ? "open" : ""}`} aria-label="Where this stands">
    <button type="button" className="cp-line" aria-expanded={open} onClick={() => onToggle(!open)}>
      <span className="cp-line-text" title={p.stands?.text}>{open ? "Where this stands" : p.note ?? (p.ready ? p.stands?.text ?? "Where this stands" : p.load?.error ? "Couldn't load" : "Loading…")}</span>
      {p.feed.total > 0 && <i className="cp-dot" role="img" aria-label="Needs you" title="Needs you" />}
      <span className="cp-chev" aria-hidden="true">{open ? "⌃" : "⌄"}</span>
    </button>
    {open && <Body {...p} fit={false} hideHealth />}
  </section>;
}
