// T-124: the room's quiet companion. Not a page: one sentence on where the room stands, at most three things that need the user, and what is
// running (only when something is). Desktop: a side panel that folds to a thin rail. Phone: a one-line strip at the top of the room that opens
// downward. Each item opens its task sheet; "Everything here" goes one level deeper, to the full node page. The fold is remembered per device.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cleanText } from "../interface/contract";
import { RefName, RefText } from "./noteRefs";
import { splitRefs, type NoteRef } from "./noteRefsCore";
import { useVaultProfile } from "./ProfileContext";
import { LoadHealth } from "./LoadHealth";
import { openDialog } from "./focusTrap";
import { isActiveRun, type Run } from "./steerCore";
import { ownerLabel, type Task } from "./taskCore";
import { taskTitle } from "./whereCore";
import { splitLinks } from "./linkText";
import { ROOM_NOT_FOUND, actionableTitle, runText, answerChoices, answerLabel, askLead, askPreview, checkLine, CHECK_FAILED, DANGLING, decideLine, decisionQuestion, dueLine, fitsRow, isOverdue, missingLine, OPEN_TASK, OPEN_TO_ANSWER, privateActionLabel, privateRestLabel, askedLine, askedShown, requestDate, currentStep, actionOf, rowAction, rowSubParts, standsHeading, titleSays, titleWords, TIDY_LINE, toTidy, unknownDecision, waitsLine, waitsOnMe, withHosts, rowAsk, withoutRawIds, runStateLabel, waitingOnYou, waitingRunParts, notWrittenDown, referencedItems, ROW_ITEMS, ITEM_LINES, itemForms, lastWritten, summaryLine, SUMMARY_LONG, recheckLine, reasonShort, noneLine, approvalAsk, type RecheckScope, type Choice, type NeedsFeed, type PrivateNeed, type RowAction, type Support } from "./simpleCore";
import { requestRecheck } from "./useTasks";
import { ApprovalRows } from "./ApprovalRows";
import type { RecheckWhy } from "./simpleCore";

const KEYS = { side: "uni.companion.side.v1", sideNarrow: "uni.companion.side.narrow.v1", strip: "uni.companion.strip.v1" } as const;
/** Below this width the side panel starts folded: the conversation gets the space. */
export const SIDE_OPEN_MIN = 1100;
const read = (key: string, open: boolean): boolean => { try { const v = localStorage.getItem(key); return v === null ? open : v === "1"; } catch { return open; } };
const roomy = () => typeof window === "undefined" || window.innerWidth >= SIDE_OPEN_MIN;
/** The side panel keeps one choice per width class (r13): at 1100px and over it opens unless folded there; under 1100px it is folded unless
 *  opened there. A window resized across 1100px takes that width's choice, so a panel open on a wide window folds when it narrows. */
const keyFor = (variant: "side" | "strip") => (variant === "strip" ? KEYS.strip : roomy() ? KEYS.side : KEYS.sideNarrow);
const choice = (variant: "side" | "strip") => read(keyFor(variant), variant === "side" && roomy());

/** A short viewport (r16): under 700px tall or 900px wide. The strip starts folded there, whatever was chosen before: the conversation first. */
export const SHORT_QUERY = "(max-height: 699.98px), (max-width: 899.98px)";
const isShort = () => typeof window !== "undefined" && !!window.matchMedia?.(SHORT_QUERY).matches;

/** Whether the companion is open on this device: open by default beside the chat on a wide window (folded under 1100px), folded by default as a
 *  phone strip. r16: the strip folds whenever the app opens on, or enters, a short viewport (the saved choice is kept, not applied there). */
export function useCompanionOpen(variant: "side" | "strip"): [boolean, (v: boolean) => void] {
  const first = () => (variant === "strip" && isShort() ? false : choice(variant));
  const [open, setOpen] = useState(first);
  useEffect(() => {
    setOpen(first());
    if (typeof window === "undefined" || !window.matchMedia) return;
    if (variant === "strip") {
      const mq = window.matchMedia(SHORT_QUERY);
      const enter = () => { if (mq.matches) setOpen(false); };
      mq.addEventListener("change", enter);
      return () => mq.removeEventListener("change", enter);
    }
    const mq = window.matchMedia(`(min-width: ${SIDE_OPEN_MIN}px)`);
    const cross = () => setOpen(choice(variant));
    mq.addEventListener("change", cross);
    return () => mq.removeEventListener("change", cross);
  }, [variant]); // eslint-disable-line react-hooks/exhaustive-deps
  return [open, (v) => { setOpen(v); try { localStorage.setItem(keyFor(variant), v ? "1" : "0"); } catch { /* this session only */ } }];
}


export type CompanionProps = {
  /** Where this stands: the sentence and, quietly, when it was written. Null: nothing to say. */
  stands: { text: string; ago: string; /** r31: days since a written summary was written */ age?: number | null; /** r27: the date a written summary is dated by ("Oct 14") */ asOf?: string | null; /** the room that wrote it */ by?: string | null; /** a summary somebody wrote, not the app's own line */ written?: boolean } | null; ready: boolean;
  /** Said in place of a node's state (a room no node owns: "Not filed under an area yet."); there is then no Needs you and no way deeper. */
  note?: string | null;
  /** The task list's health: a failed first load (never an endless "Loading…"), a failed refresh (the rows stay), and whether every page was read. */
  load?: TaskLoad;
  /** What needs you here, by the one rule: the rows shown, the private items (named by place only) and the total every surface agrees on. */
  feed: NeedsFeed;
  /** Uni's panel (r17): everything past its rows, private items folded in, as one "N more ›" to the work view; `moreTitle` says what it holds. */
  rest?: number; moreTitle?: string | null;
  /** Open a private area (its items are shown inside it). */
  onPrivate?: (open: PrivateNeed["open"]) => void;
  runs: readonly Run[];
  /** The node's name, so the way deeper says what it opens ("All of COhere's work"). */
  nodeName: string;
  /** A node shown in a room it borrows (r15): the state is labelled as this node's ("Where Expression stands"), not the room's. */
  scope?: string | null;
  onTask: (t: Task) => void; onDecide: (t: Task, option: string) => void;
  /** r30: a run waiting on the user's answer is a row: it opens its room at the run's message, the composer focused */
  onRun?: (r: Run) => void;
  /** r31: a waiting run whose room (by its `channel` id) is not among the rooms: its row says "Room not found" */
  runMissing?: (r: Run) => boolean;
  /** r30: this is Uni's own room: what it counts is across all rooms (any other room's counts are its own) */
  scopeAll?: boolean;
  /** "All of X's work" (null: none, for a room no node owns). */
  onEverything: (() => void) | null;
  /** Opens a linked note (in its own vault) from a title or next step. */
  onNote?: (ref: NoteRef) => void;
  /** r20: the area a row belongs to when it is shown outside it (its subtitle names it); null inside it. */
  placeOf?: (t: Task) => string | null;
};
export type TaskLoad = { error: string | null; /** The task tree (the nodes) could not be read: the list may be placed wrongly. */ treeError?: string | null; refreshing: boolean; lastOk: number | null; complete: boolean; retry: () => void;
  /** The rows are the device's copy from this moment, being read again (r16). */ savedAt?: number | null;
  /** The read has run past 8 seconds (r16): "Still loading · Retry". */ slow?: boolean };

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
export function NextText({ text, vault, onNote, lines, open: openProp, onOpen, onClamp }: { text: string; /** where the text lives: an id written without a vault is this vault's note */ vault: string; onNote?: (ref: NoteRef) => void; lines?: number; open?: boolean; onOpen?: (v: boolean) => void; onClamp?: (v: boolean) => void }) {
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
    <p ref={ref} className={`cp-next ${open ? "open" : ""}`} style={!open && lines !== undefined ? { "--lines": lines, maxHeight: `${(lines * 13.5 * 1.45).toFixed(2)}px` } as React.CSSProperties : undefined}>{splitLinks(cleanText(text)).map((p, i) => "url" in p
      ? <a key={i} className="cp-link" href={p.url} title={p.url} rel="noreferrer noopener" onClick={(e) => openLink(e, p.url)}>{p.label}</a>
      : <RefText key={i} text={p.text} vault={vault} onNote={onNote} />)}</p>
    {!onOpen && (clamped || open) && <button type="button" className="cp-more-next" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Less" : "More"}</button>}
  </div>;
}

/** A step as words (r15): each word, link and linked note is one token, so a clamp can end on a whole one. `space`: whitespace before it. */
/** A row's link label (r20): a host too long for a row's line ("cohere-signup-staging.unforced.workers.dev" broke mid-word onto a third line at
 *  236px) reads as its first part ("cohere-signup-staging"); the link and its title keep the whole address. */
export const ROW_LINK_MAX = 24;
export const rowLinkLabel = (label: string): string => (label.length > ROW_LINK_MAX && /^[\w-]+(\.[\w-]+)+$/.test(label) ? label.split(".")[0] : label);
function stepTokens(text: string, vault: string, onNote?: (ref: NoteRef) => void, row = false): { node: React.ReactNode; space: boolean }[] {
  const out: { node: React.ReactNode; space: boolean }[] = [];
  let space = false; let first = true;
  for (const p of splitLinks(cleanText(text))) {
    // r21 (Codex 10): in a row a link is words (the row is one button that opens the sheet, where the link opens)
    if ("url" in p) { out.push({ node: row ? <span className="cp-link" title={p.url}>{rowLinkLabel(p.label)}</span> : <a className="cp-link" href={p.url} title={p.url} rel="noreferrer noopener" onClick={(e) => openLink(e, p.url)}>{p.label}</a>, space }); space = false; first = false; continue; }
    for (const q of splitRefs(p.text, vault)) {
      if ("id" in q) { out.push({ node: <RefName r={q} onNote={row ? undefined : onNote} />, space }); space = false; first = false; continue; }
      for (const w of q.text.split(/(\s+)/)) {
        if (!w) continue;
        if (/^\s+$/.test(w)) { space = true; continue; }
        out.push({ node: first ? w.replace(/^\S/, (c) => c.toLocaleUpperCase()) : w, space }); space = false; first = false;
      }
    }
  }
  return out;
}

/** A word a cut must not end on (r17): the one list every cut uses (r18, `simpleCore`). */
const DANGLING_WORD = DANGLING;
/** Plain words as clamp tokens (a decision's preview has no links). */
const wordTokens = (text: string) => text.split(/\s+/).filter(Boolean).map((w, i) => ({ node: w, space: i > 0 }));

/**
 * Text clamped at `lines` lines that ends on a whole word (r15): every line full up to the last word that fits, never inside a word, a link
 * or a note's title. r23 (both critics): no "…" after it. Drawn whole once to measure (before paint), then cut; a new width or text measures again.
 */
function WordClamp({ tokens, lines, open, textKey, onCut, elRef, className, onClick, tag = "p", title, keep = 0, data }: { tokens: { node: React.ReactNode; space: boolean }[]; lines: number; open: boolean; textKey: string; title?: string;
  /** data-* attributes for the element */
  data?: Record<string, string>;
  /** r20: the first `keep` tokens (a row's verb phrase) are never cut: a cut falls inside the object, after them */
  keep?: number;
  onCut: (cut: boolean) => void; elRef: React.RefObject<HTMLParagraphElement | null>; className: string; onClick: (e: React.MouseEvent) => void; /** "span" inside a button */ tag?: "p" | "span" }) {
  const [cut, setCut] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const tries = useRef(0);
  useLayoutEffect(() => { tries.current = 0; setCut(null); }, [textKey, lines, open, width]);
  useLayoutEffect(() => {
    const el = elRef.current;
    if (!el || open || cut !== null) { if (open) onCut(false); return; }
    const words = [...el.querySelectorAll<HTMLElement>(".wc-w")];
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || 20;
    const box = el.getBoundingClientRect();
    const top = box.top + (parseFloat(cs.paddingTop) || 0);
    const right = box.right - (parseFloat(cs.paddingRight) || 0);
    const lineOf = (y: number) => Math.floor((y - top + 1) / lh);
    const last = (w: HTMLElement) => { const r = w.getClientRects(); return r[r.length - 1] ?? w.getBoundingClientRect(); };
    let k = 0;
    while (k < words.length && lineOf(last(words[k]).top) < lines) k++;
    if (k >= words.length) { onCut(false); return; }
    while (k > 1 && lineOf(last(words[k - 1]).top) === lines - 1 && last(words[k - 1]).right > right + 1) k--;
    // r17: never end on a hanging word ("…to the …") or a word that only leads into the rest ("Dominic: …")
    const plain = (i: number) => (typeof tokens[i]?.node === "string" ? (tokens[i].node as string) : null);
    // r27: nor inside an unclosed bracket ("(recommended: keep 15, fold" → before the "("), for text that is only words
    if (tokens.every((t) => typeof t.node === "string")) while (k > 1) { const j = tokens.slice(0, k).map((t) => t.node as string).join(" "); const o = j.lastIndexOf("("); if (o > 0 && j.indexOf(")", o) < 0) k--; else break; }
    while (k > 1 && plain(k - 1) !== null && (DANGLING_WORD.test(plain(k - 1)!.replace(/[,;:(\[–—-]+$/, "")) || /^[,;:–—&+·•|/-]+$/.test(plain(k - 1)!))) k--;
    // r20: never inside the verb phrase ("Edit and send the ATLAS follow-up"): the cut keeps it whole, and the verb
    k = Math.max(k, Math.min(keep, words.length));
    if (k >= words.length) { onCut(false); return; }
    setCut(Math.max(1, k)); onCut(true);
  });
  useLayoutEffect(() => {
    const el = elRef.current; if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const w = Math.round(el.clientWidth);
      setWidth((cur) => (cur === w ? cur : w));
      // a word kept changed length (a note's title arrived) and the text runs past its lines: measure again, a few times at most
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
      if (cut !== null && !open && el.scrollHeight > lines * lh + (parseFloat(getComputedStyle(el).paddingTop) || 0) + (parseFloat(getComputedStyle(el).paddingBottom) || 0) + 2 && tries.current < 4) { tries.current++; setCut(null); }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [cut, open, lines]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = open || cut === null ? tokens : tokens.slice(0, cut).map((t, i, a) => (i === a.length - 1 && typeof t.node === "string" ? { ...t, node: t.node.replace(/[\s,;:(\[–—-]+$/, "") || t.node } : t));
  const Tag = tag;
  return <Tag ref={elRef} className={className} title={title} {...data} data-cut={cut !== null && !open ? "true" : undefined} onClick={onClick}>
    {shown.map((t, i) => <span key={i}>{i > 0 && t.space ? " " : ""}<span className="wc-w">{t.node}</span></span>)}
  </Tag>;
}

/**
 * A row's action (r22, both critics): the whole action, every step ("A, then B") and every verb phrase, wrapping to as many lines as it needs:
 * no clamp, no "then …", no ellipsis, and (r28) no length past which it is shortened.
 */
function ActionLine({ forms, vault, elRef }: { forms: { text: string; keep: string }[]; vault: string; elRef: React.RefObject<HTMLParagraphElement | null> }) {
  const tokens = stepTokens(forms[0].text, vault, undefined, true);
  return <span ref={elRef} className="cp-title cp-lead" data-form="0">{tokens.map((t, i) => <Fragment key={i}>{t.space ? " " : ""}{t.node}</Fragment>)}</span>;
}

/**
 * Where this stands (r29, Codex P1-3): a dated account, never the app's own claim. "Last written Oct 14 by #cohere:" and the text as written
 * (without raw ids), muted, below Needs you. Whole when short; a long one is behind "What it said". `written`: a summary somebody wrote (the
 * app's own line from the tasks has no author or date to give).
 */
export function Stands({ stands, className = "cp-lede", folded = false }: { stands: { text: string; asOf?: string | null; by?: string | null; written?: boolean; /** days since it was written */ age?: number | null }; className?: string;
  /** r30: the room for it is short: its date line, and "Read" to open the whole (never a text cut by the panel's edge) */ folded?: boolean }) {
  const text = useMemo(() => withoutRawIds(stands.text), [stands.text]);
  const long = text.length > SUMMARY_LONG;
  return <div className={`${className} cp-stands-note`} data-written={stands.written ? "true" : undefined} data-folded={folded ? "true" : undefined}>
    {folded || long ? <details className="cp-said"><summary>{summaryLine(stands.written ? stands.asOf : null, stands.by, stands.age)}</summary><p className="cp-stands">{text}</p></details>
      : <>{stands.written && <p className="cp-asof">{lastWritten(stands.asOf, stands.by)}</p>}<p className="cp-stands">{text}</p></>}
  </div>;
}

/** One line of small print under a row (r18): whole words, then "…"; never a second line. */
export function SmallLine({ text, className }: { text: string; className: string }) {
  const ref = useRef<HTMLParagraphElement | null>(null);
  return <WordClamp title={text} elRef={ref} className={className} tokens={wordTokens(text)} textKey={text} lines={1} open={false} onCut={() => {}} onClick={() => {}} tag="span" />;
}

/**
 * Where a row belongs, beside its due cue (r20): whole on one line, or not at all. A subtitle cut short is vague ("SOW…"), so one that doesn't
 * fit beside the cue is dropped (the sheet has it); it is measured again when the row's width changes.
 */
function FitLine({ text, fallback = null, className, onHide }: { text: string; /** a shorter form to try when the whole doesn't fit ("From #atlas/teach") */ fallback?: string | null; className: string; onHide: (hidden: boolean) => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  /** which form shows: the whole, the shorter one, or none */
  const [shown, setShown] = useState<"full" | "short" | "none">("full");
  useLayoutEffect(() => {
    const el = ref.current; const box = el?.parentElement; if (!el || !box) return;
    const [full, short] = [el.querySelector<HTMLElement>(".fit-full"), el.querySelector<HTMLElement>(".fit-short")];
    const fits = (form: HTMLElement | null) => { if (!form) return false; el.hidden = false; if (full) full.hidden = form !== full; if (short) short.hidden = form !== short; return el.scrollWidth <= el.clientWidth + 1; };
    const check = () => {
      const pick = fits(full) ? "full" : fits(short) ? "short" : "none";
      // the DOM is left as React will draw it
      el.hidden = pick === "none"; if (full) full.hidden = pick !== "full"; if (short) short.hidden = pick !== "short";
      setShown(pick); onHide(pick === "none");
    };
    check();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => check());
    ro?.observe(box);
    return () => ro?.disconnect();
  }, [text, fallback]); // eslint-disable-line react-hooks/exhaustive-deps
  return <span ref={ref} className={className} hidden={shown === "none"} title={text}>
    <span className="fit-full" hidden={shown !== "full"}>{text}</span>
    {fallback && <span className="fit-short" hidden={shown !== "short"}>{fallback}</span>}
  </span>;
}

/**
 * A decision's question as every surface shows it (r14): its whole question (the title when not cut, else the ask read from its note at the
 * row's own revision), sentence-cased, with "Your call:" when it does not ask. `answerable`: the whole question is known; `fits`: it fits a
 * row, so a row may show it beside its answers (a longer one shows `preview` and opens to decide). With no whole question, nothing to answer.
 */
export function decisionAsk(t: Task): { text: string; yourCall: boolean; answerable: boolean; fits: boolean; preview: string; decide: string; /** the question as the note has it (links and all), for the sheet */ full: string;
  /** r18: its stored options, as stored (Yes/No only when those are the options); `box`: none stored, so it is answered in words */
  choices: Choice[]; box: boolean } {
  const tt = taskTitle(cleanText(t.title));
  const q = decisionQuestion(tt.rest, t.ask, t.askAt, t.updatedAt, tt.cut || tt.previewed);
  // r16: no whole question known: the row reads "Decide: <first words>" (verb first, whole words, never "…"), and opens to decide
  if (!q) { const line = decideLine(askOf(tt.rest)); return { text: line, yourCall: false, answerable: false, fits: false, preview: line, decide: line, full: line, choices: [], box: !t.options.length }; }
  // r16: the question read from a note is cleaned like a title (no leading date, no "(preview: …)" tail); the sheet keeps the note's words
  const l = askLead(taskTitle(q).rest || q);
  const a = answerChoices(t.options);
  // r18: a decision answered in words is always "Your call:", question or statement
  return { text: l.text, yourCall: l.yourCall || a.box, answerable: true, fits: fitsRow(l.text), preview: askPreview(l.text), decide: decideLine(l.text), full: q, choices: a.choices, box: a.box };
}

/**
 * The one way a decision is closed by a tap (r12): its stored options, each written back as stored (r18: nothing built from its wording; Yes and
 * No only when those are its options). A tap records the answer (`decided`) through the vault's compare-and-set; nothing closes a decision
 * without one. With no options there are no buttons: the sheet's answer box (`AnswerBox`). The companion, the task sheet and the work page use this.
 */
export function DecisionAnswer({ t, label, onDecide, max = Infinity, onMore, className = "" }: { t: Task; label: string; onDecide: (t: Task, option: string) => void; max?: number; onMore?: () => void; className?: string }) {
  const a = answerChoices(t.options);
  if (!a.choices.length) return null;
  const opts = a.choices.map((o) => ({ label: cleanText(o.label), value: o.value }));
  const yesNo = a.binary;
  return <div className={`cp-opts ${yesNo ? "cp-yesno" : ""} ${className}`} role="group" aria-label={`Decide: ${label}`}>
    {opts.slice(0, max).map((o) => <button key={o.value} type="button" className="cp-opt" onClick={() => onDecide(t, o.value)}>{o.label}</button>)}
    {opts.length > max && onMore && <button type="button" className="cp-opt more" onClick={onMore}>More…</button>}
  </div>;
}

/** A task's question source (r18), as its current check found it (r19: `check`, set by the list; null when it stands on no note or isn't read). */
export const supportOf = (t: Pick<Task, "check">): Support | null => (t.check && (t.check.kind === "list" || t.check.kind === "closed" || t.check.kind === "unclear") ? t.check : null);

export type RowMode = "answers" | "preview" | "call" | "decide" | "lead" | "title" | "check" | "checking" | "unavailable" | "waits" | "tidy" | "missing";
export type RowLead = { text: string; under: string | null; go: string | null; answers: boolean; yourCall: boolean; lead: boolean; mode: RowMode;
  /** r20: a row that leads with an action: the action (its first clause), the verb phrase a cut never enters, and its subtitle's two parts:
   *  where it belongs (cut to one line if it must) and the due cue (never cut) */
  action?: RowAction | null; sub?: { where: string | null; when: string | null; /** a shorter "where" ("From #atlas/teach") */ short?: string | null } };
/** What a Needs-you row leads with (r14), the same in the companion, the work view and the sheet: a task's action when its next step names one
 *  (the title, its event or project, is a quiet line under it); a decision's whole question; else the title. r16: a decision whose question is
 *  too long for a row is its first two lines of words and "Open to decide" (`preview`); one with no whole question known is "Decide: <first
 *  words>" (`decide`). r18: a decision with no stored options is "Your call: <question>" (`call`), answered in words in its sheet; a task
 *  whose source note is closed is "Check: … is closed — still needed?" (`check`), never its extracted action. r19: a task whose supporting notes
 *  aren't read yet is "Checking what's needed…" (`checking`), one whose read failed shows its title and "Couldn't check · Retry"
 *  (`unavailable`), one whose `depends_on` note is open "Waits on “…” first" (`waits`); none asserts the action. A record Uni has to tidy
 *  (`tidy`) is its title with why, never an action. r20: a decision whose question isn't read yet is "Checking what's needed…" too, never
 *  "Decide: …"; a note it stands on that can't be found is "Couldn't find … · Open the task" (`missing`); a decision has the same contract for
 *  what it stands on as a task. An action row leads with the action's first clause (`rowAction`), its subtitle the title or area and the due
 *  cue (`rowSub`). `area`: the row's area when it is shown outside it. */
/** r21: "Checking…", the quiet line under a row being checked (never its title). */
export const CHECKING_SHORT = "Checking…";
/** A decision's question as words while its record is being read (r21): its whole question when the title holds it, else the title as words. */
const decisionLeadWords = (t: Task, words: string): string => { const dq = decisionAsk(t); return dq.answerable ? dq.text : words; };
export function rowLead(t: Task, area: string | null = null): RowLead {
  const tt = taskTitle(cleanText(t.title));
  const full = tt.rest;
  const next = t.next.trim();
  const ck = t.check ?? null;
  // r20: a quiet line under a row that asserts nothing is the title as words (never "…feature 4, the")
  const words = titleWords(askOf(full)) || full;
  const quiet = (text: string, under: string | null, mode: RowMode): RowLead => ({ text, under, go: mode === "check" || mode === "waits" || mode === "missing" ? "" : null, answers: false, yourCall: false, lead: false, mode });
  // r20: nothing is owed until it is known: a decision whose record isn't read yet (or couldn't be) asserts nothing
  if (t.kind === "decision" && (t.askFailed || ck?.kind === "unavailable")) return quiet(words, null, "unavailable");
  // r21 (both critics): a row being checked leads with its question (a decision) or its title (a task), "Checking…" a quiet line under it: it
  // asserts no action and isn't counted until it is classified
  if (t.kind === "decision" && unknownDecision(t)) return quiet(decisionLeadWords(t, words), CHECKING_SHORT, "checking");
  const ask = rowAsk(askOf(full), t.ask, false, !!next, tt.cut);
  if (ck?.kind === "checking") return quiet(t.kind === "decision" ? decisionLeadWords(t, words) : ask.text || words, CHECKING_SHORT, "checking");
  if (ck?.kind === "unavailable") return quiet(ask.text || "This task", null, "unavailable");
  // r20: a missing note it stands on is unresolved: no action, no "I did this"; the way on is the task itself
  if (ck?.kind === "missing") return quiet(`${missingLine(ck)} · ${OPEN_TASK}`, t.kind === "decision" ? words : ask.text || null, "missing");
  if (ck?.kind === "closed") return quiet(checkLine(ck), t.kind === "decision" ? words : ask.text || null, "check");
  if (ck?.kind === "waits") return quiet(waitsLine(ck), t.kind === "decision" ? words : ask.text || null, "waits");
  const why = toTidy(t);
  if (why) return { text: t.kind === "decision" ? decisionAsk(t).text : askOf(full), under: TIDY_LINE[why], go: "", answers: false, yourCall: false, lead: false, mode: "tidy" };
  if (t.kind === "decision") {
    const dq = decisionAsk(t);
    if (!dq.answerable) return { text: dq.decide, under: null, go: "", answers: false, yourCall: false, lead: false, mode: "decide" };
    if (dq.box) return { text: dq.text, under: null, go: "", answers: false, yourCall: true, lead: false, mode: "call" };
    if (!dq.fits) return { text: dq.text, under: null, go: "Open to decide", answers: false, yourCall: dq.yourCall, lead: false, mode: "preview" };
    return { text: dq.text, under: null, go: null, answers: true, yourCall: dq.yourCall, lead: false, mode: "answers" };
  }
  // r17: someone else's task that waits on the user leads with what it asks of them; the task itself is the quiet line under it
  const theirs = waitsOnMe(t);
  // r20: the action, never the stored sentence: its first clause, the date label and the notes after it left to the subtitle and the sheet
  // r23: a step that points at words nobody stored ("…the message below") asks the room for them: "Ask #techne for the message"
  // r25: the row and the sheet's heading say the same current step (`currentStep`)
  const action = rowAction(currentStep(t, t.stewardRoom ?? t.room)) ?? (theirs && next ? actionOf(next) : null);
  if (action) {
    // r17: someone else's task says whose it is (and the task, when its title says something the action doesn't)
    const from = `From ${ownerLabel(t.owner)}`;
    const sub = theirs ? { where: [from, titleSays(t.title, action.text)].filter(Boolean).join(" · "), short: from, when: dueLine(t.due) ?? action.prefix } : rowSubParts(t, action, area);
    // r19: a link in the action reads as its host ("Look at cohere-signup-staging.unforced.workers.dev on phone"), never a gap where it was
    return { text: plainDetail(withHosts(action.text)) || action.text, under: [sub.where, sub.when].filter(Boolean).join(" · ") || null, go: null, answers: false, yourCall: false, lead: true, mode: "lead", action, sub };
  }
  return { text: ask.text || "Open to see what's needed", under: null, go: null, answers: false, yourCall: false, lead: false, mode: "title" };
}

/**
 * r27 (both critics): the items a row carries, each its whole clause. An item takes at most two lines and is cut only at a sentence end: the
 * first of its forms (`itemForms`) that fits is drawn; an item with no form that fits is left out whole (the sheet lists it), and the row says
 * the total ("10 labels in all") for it and for any past `cap`: the same number whatever the width or height (r31; a count of what is left out changed with the panel). `cap`: how many the room above the panel's footer allows (the panel lowers it when three whole
 * items don't fit).
 */
export function RowItems({ items, cap, noun = "items" }: { items: readonly string[]; cap: number; noun?: string }) {
  const forms = useMemo(() => items.map(itemForms), [items]);
  const key = items.join("\n");
  const [pick, setPick] = useState<number[]>(() => items.map(() => 0));
  const [width, setWidth] = useState(0);
  const ref = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => { setPick(items.map(() => 0)); }, [key, width]); // eslint-disable-line react-hooks/exhaustive-deps
  /** the items drawn: in order, each with a form that has not been ruled out, at most `cap` */
  const drawn = (() => { const out: number[] = []; for (let i = 0; i < items.length && out.length < cap; i++) if ((pick[i] ?? 0) < forms[i].length) out.push(i); return out; })();
  useLayoutEffect(() => {
    const box = ref.current; if (!box) return;
    const lines = [...box.querySelectorAll<HTMLElement>(".cp-item-line")];
    for (let j = 0; j < lines.length; j++) {
      const lh = parseFloat(getComputedStyle(lines[j]).lineHeight) || 17;
      if (lines[j].getBoundingClientRect().height > lh * ITEM_LINES + 2) { const i = drawn[j]; setPick((p) => { const q = [...p]; q[i] = (q[i] ?? 0) + 1; return q; }); return; }
    }
  });
  useLayoutEffect(() => {
    const el = ref.current; if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { const w = Math.round(el.clientWidth); setWidth((cur) => (cur === w ? cur : w)); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const more = items.length - drawn.length;
  return <span ref={ref} className="cp-items" data-count={items.length} data-shown={drawn.length}>
    {drawn.map((i) => <span key={i} className="cp-item-line">{forms[i][Math.min(pick[i] ?? 0, forms[i].length - 1)]}</span>)}
    {drawn.length > 0 && more > 0 && <span className="cp-item-more" data-total={items.length}>{`${items.length} ${noun} in all`}</span>}
  </span>;
}

/**
 * A Needs-you row (r14): action first. A task whose next step names an action leads with it (r21: the whole action, up to three lines), its
 * title or area under it as one quiet line (r18: small print is never more than a line); otherwise the title, then the next step. A decision is
 * its question; its answers are in the sheet. r21 (Codex 10): the row is one button that opens its sheet, with nothing clickable inside it.
 * `compact` (the companion, r18): at most one line of step under a title.
 */
export function NeedRow({ t, onTask, meta, area = null, itemCap = ROW_ITEMS }: { t: Task; onTask: (t: Task) => void; /** r20 (Codex 7): answers are in the sheet only; kept for callers */ onDecide?: (t: Task, option: string) => void;
  /** r21 (Codex 10): a row's notes and links open in its sheet; kept for callers */ onNote?: (ref: NoteRef) => void;
  /** A quiet line on where it stands, for a row that is not the user's ("With Casey · in progress"; the work view's In motion and Later). */
  meta?: string | null; compact?: boolean;
  /** r20: the row's area when it is shown outside it: an action row's subtitle names it when its title can't say where it belongs. */
  area?: string | null;
  /** r27: how many of the list a row carries may show (the panel lowers it when whole items don't fit above its footer) */ itemCap?: number }) {
  const { id } = taskTitle(cleanText(t.title));
  const isDecision = t.kind === "decision";
  const next = t.next.trim();
  const due = dueLine(t.due);
  /** The task's own vault: its linked notes are read and opened there (r15). */
  const profileVault = useVaultProfile().vault;
  const vault = t.vault ?? profileVault;
  const r = rowLead(t, area);
  const text = r.text;
  const sup = isDecision ? null : supportOf(t);
  const titleRef = useRef<HTMLElement>(null);
  /** r20: the subtitle's "where" didn't fit whole beside the due cue, so it is dropped (never cut short) */
  const [whereHidden, setWhereHidden] = useState(false);
  /** r22: the date part wrapped under where the row belongs: that line starts with its words, not " · " */
  const subRef = useRef<HTMLSpanElement>(null);
  const [subWrapped, setSubWrapped] = useState(false);
  useLayoutEffect(() => {
    const el = subRef.current; if (!el) return;
    const check = () => {
      const w = el.querySelector<HTMLElement>(".cp-sub-where"); const d = el.querySelector<HTMLElement>(".cp-sub-when");
      if (!w || !d || w.hidden) { setSubWrapped(false); return; }
      const wb = w.getBoundingClientRect(); const db = d.getBoundingClientRect();
      // once wrapped (no " · "), it comes back up only when the date and a separator fit beside where it belongs: no flip-flop
      const sep = (parseFloat(getComputedStyle(el).fontSize) || 13) * 1.6;
      setSubWrapped(el.dataset.wrapped ? el.getBoundingClientRect().right - wb.right < db.width + sep : db.top > wb.top + 2);
    };
    check();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(check);
    ro?.observe(el);
    return () => ro?.disconnect();
  });
  // r28 (Sonnet): a row is whole or it is not shown: no clamp of any kind on its words (the list shows fewer rows instead)
  // the next step shows under a title; a row that leads with it does not repeat it, and a row whose step isn't checked (or is doubted, or is
  // Uni's to tidy) never shows it (r19)
  const showNext = !!next && !r.lead && r.mode === "title";
  // r20: an action row's subtitle carries its due cue ("COhere opens Oct 15 · due today"); other rows keep the due line of their own
  // r22 (Codex P1): every Needs-you row says when it was asked ("asked Oct 11"), from the record's last change; never on a row that isn't the user's
  // r23 (Codex P1): when it was asked ("asked Oct 6") or, with no request time, added ("added Oct 11"); never the record's last change
  const asked = meta ? null : askedShown(t.due, askedLine(requestDate(t)));
  const when_ = r.sub ? [r.sub.when, asked].filter(Boolean).join(" · ") : null;
  const meta_ = <>{r.sub ? (<span ref={subRef} className="cp-under cp-sub" data-wrapped={subWrapped || undefined} title={[r.sub.where, when_].filter(Boolean).join(" · ")}>{r.sub.where && <FitLine className="cp-sub-where" text={r.sub.where} fallback={r.sub.short ?? null} onHide={setWhereHidden} />}
      {when_ && <span className={`cp-sub-when${isOverdue(t.due) ? " overdue" : ""}`}>{r.sub.where && !whereHidden && !subWrapped ? " · " : ""}{when_}</span>}</span>)
    : r.under && <span className="cp-under" title={r.under}>{r.under}</span>}
    {!r.lead && (due || asked) && <small className={`cp-detail cp-asked-line${isOverdue(t.due) ? " overdue" : ""}`}>{[due, asked].filter(Boolean).join(" · ")}</small>}
    {meta && <small className="cp-detail cp-meta" title={meta}>{meta}</small>}</>;
  // r21 (Codex 10): one target per visible request: the whole row is one button that opens its sheet (its links and notes open there).
  // r21 (P1-1): a row whose check failed retries as it opens, so its "Retry" is what the tap does
  const open_ = () => { if (r.mode === "unavailable") requestRecheck(); onTask(t); };
  // r26: a step that points at a list ("the asks listed in this task's detail", "the unknowns") carries it: the first three items under the row
  const refd = r.lead && !isDecision ? referencedItems(next, t.detail) : null;
  const itemRoom = (t.stewardRoom ?? t.room ?? "").replace(/^#/, "");
  const label = r.lead ? [r.action?.text ? plainDetail(withHosts(r.action.text)) : text, refd?.kind === "list" ? refd.items.map((x) => itemForms(x)[0] ?? x).join("; ") : refd ? notWrittenDown(refd.noun) : null, r.sub ? [r.sub.where, when_].filter(Boolean).join(" · ") : r.under, meta].filter(Boolean).join(". ") : r.yourCall ? `Your call: ${text}` : undefined;
  return <li className="cp-item" data-lead={r.lead ? "action" : undefined} data-mode={r.mode}>
    <button type="button" className={`cp-need${isDecision ? " decision" : ""}${r.lead ? " cp-need-lead" : ""}`} data-id={id ?? undefined} data-mode={r.mode} aria-busy={r.mode === "checking" || undefined} aria-label={label} onClick={open_}>
      {r.yourCall && <small className="cp-call-lead">Your call:</small>}
      {r.lead
        // r21: the whole action, a third line before its object is cut; "2 steps: A, then …" when two steps don't fit
        ? <ActionLine elRef={titleRef as React.RefObject<HTMLParagraphElement | null>} forms={r.action?.forms.length ? r.action.forms : [{ text: next, keep: "" }]} vault={vault} />
        // r20: no "›" on any row: the whole row opens its sheet, in the companion and the work view alike
        : <span ref={titleRef} className="cp-title"><RefText text={text} vault={vault} /></span>}
      {refd?.kind === "list" && <RowItems items={refd.items} cap={itemCap} noun={refd.noun.toLowerCase()} />}
      {refd?.kind === "none" && <span className="cp-items cp-items-none">{notWrittenDown(refd.noun)}{itemRoom ? ` · Open #${itemRoom}` : ""}</span>}
      {r.go && <span className="cp-open-decide">{r.go}</span>}
      {!next && !isDecision && r.mode === "title" && !actionableTitle(text) && text !== "Open to see what's needed" && <span className="cp-open-to-see">Open to see what's needed</span>}
      {/* the step under a title, as words (its links open in the sheet) */}
      {showNext && <span className="cp-next cp-next-in">{splitLinks(cleanText(next)).map((p, i) => "url" in p
        ? <span key={i} className="cp-link" title={p.url}>{rowLinkLabel(p.label)}</span> : <RefText key={i} text={p.text} vault={vault} />)}</span>}
      {/* r18: "Answer N questions" only from an explicit list; an unclear source says to open the note (the sheet has both ways in) */}
      {sup?.kind === "list" ? <span className="cp-questions">{answerLabel(sup.items.length)}</span> : sup?.kind === "unclear" ? <span className="cp-questions">{OPEN_TO_ANSWER}</span> : null}
      {meta_}
      {/* r19: the read failed: not "nothing there", and not the action either; r21: the tap retries */}
      {r.mode === "unavailable" && <span className="cp-checkfail" role="status">{CHECK_FAILED} · Retry</span>}
    </button>
  </li>;
}

/**
 * A private area's items, from outside it (r22, both critics): each item whose step is a short work imperative is its own row, "In Sanctum: Book
 * the dentist" (its verb and object only); the rest, whose words may be personal, are one plain row, "In Sanctum: 1 thing for you · open
 * Sanctum". Every row opens that area, where its items are ordinary rows with their sheets. Never a title, never "›".
 */
export function PrivateRow({ p, onPrivate }: { p: PrivateNeed; onPrivate?: (open: PrivateNeed["open"]) => void }) {
  return <>
    {(p.actions ?? []).map((a, i) => <li key={`a${i}`} className="cp-item cp-private-item" data-private="action"><button type="button" className="cp-need cp-private" onClick={() => onPrivate?.(p.open)}>
      <span className="cp-title">{privateActionLabel(p.place, a)}</span></button></li>)}
    {(p.others ?? p.count) > 0 && <li className="cp-item cp-private-item" data-private="count"><button type="button" className="cp-need cp-private" onClick={() => onPrivate?.(p.open)}>
      <span className="cp-title">{privateRestLabel({ place: p.place, others: p.others ?? p.count, actions: p.actions ?? [] })}</span></button></li>}
  </>;
}

/** r21: "Show 15 more": a link row says what it does, with no "›". */
export const moreLabel = (n: number): string => `Show ${n} more`;

/**
 * Only whole rows are shown: in the side panel (`fit`) the rows that don't fit above the footer wait behind "+N more ›" rather than being
 * cut or faded at the panel's bottom. Every row is drawn once to be measured (before paint), then the ones that fit stay.
 */
export function NeedsList({ needs: owed, pending = [], fit, onTask, onDecide, onNote, placeOf, onMore, extra = 0, moreTitle = null, keepOne = false, wholeFirst = false }: Pick<CompanionProps, "onTask" | "onDecide" | "onNote" | "placeOf"> & { needs: readonly Task[]; fit: boolean; /** "+N more" opens elsewhere (the strip's sheet) instead of in place */ onMore?: () => void;
  /** r20: decisions still being read: shown after the rows that are owed, never counted in "+N more" */
  pending?: readonly Task[];
  /** The phone's inline strip always shows its first row (its body was sized to the room left beside the conversation). */
  keepOne?: boolean;
  /** r28 (Codex P2-5): the compact panel starts with one whole request: the first row's inline items are lowered until the row fits in what scrolls (none, when none fit) */
  wholeFirst?: boolean;
  /** r17, Uni's panel: items past these rows (private ones included): they and any row that doesn't fit are one "N more ›" (`onMore`, the work view). */
  extra?: number; moreTitle?: string | null }) {
  const needs = pending.length ? [...owed, ...pending] : owed;
  const [limit, setLimit] = useState(Infinity);
  const [measuring, setMeasuring] = useState(fit);
  const [all, setAll] = useState(false);
  const [size, setSize] = useState("");
  /** r27: how many items of a row's list show: three whole items that don't fit above the footer become fewer, with "and N more" */
  const [itemCap, setItemCap] = useState(ROW_ITEMS);
  const listRef = useRef<HTMLUListElement>(null);
  const settled = useRef(""); // the list the last measurement was made for
  const remeasured = useRef(0);
  const grown = useRef(0);
  const grownFor = useRef("");
  const key = needs.map((t) => `${t.id}\n${t.ask ?? ""}\n${t.next}`).join("\u0000");
  if (grownFor.current !== key) { grownFor.current = key; grown.current = 0; }
  useLayoutEffect(() => {
    const scroller = listRef.current?.closest(".cp-fit") as HTMLElement | null;
    if (!fit || !scroller) return;
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => setSize(`${scroller.clientWidth}x${scroller.clientHeight}`));
    ro?.observe(scroller);
    setSize(`${scroller.clientWidth}x${scroller.clientHeight}`);
    return () => ro?.disconnect();
  }, [fit]);
  // a new list folds back to what fits; a resize only measures again, so "+N more" once opened stays open (r13: opening it can add a
  // scrollbar, which narrows the panel, and that must not fold it back)
  useLayoutEffect(() => { if (fit) { setAll(false); setItemCap(ROW_ITEMS); setLimit(Infinity); setMeasuring(true); } }, [fit, key]);
  useLayoutEffect(() => { if (fit && !all) { setItemCap(ROW_ITEMS); setLimit(Infinity); setMeasuring(true); } }, [size]); // eslint-disable-line react-hooks/exhaustive-deps
  /** r18: rows cut their own lines (WordClamp) in the commit that draws them; the list is measured one commit later, once they have. */
  const [pass, setPass] = useState(0);
  useLayoutEffect(() => {
    if (!fit || !measuring) return;
    if (pass === 0) { setPass(1); return; }
    const list = listRef.current; const scroller = list?.closest(".cp-fit") as HTMLElement | null; const body = list?.closest(".cp-body") as HTMLElement | null;
    if (!list || !scroller || !body) { setMeasuring(false); setPass(0); return; }
    const rows = [...list.children] as HTMLElement[];
    // room for the list = the panel minus everything that is not the list (heading, sentence, runs, footer) minus the "+N more" line
    // with every row drawn: no overflow means they all fit. Otherwise the body has its natural height, and the panel's own bar sits outside it
    const top = scroller.querySelector<HTMLElement>(".cp-top")?.offsetHeight ?? 0;
    const fits = scroller.scrollHeight <= scroller.clientHeight + 1;
    const budget = scroller.clientHeight - top - (body.scrollHeight - list.offsetHeight) - 40;
    let used = 0; let n = 0;
    // r17: not even the first row is kept when it doesn't fit whole (a 360px-tall window): it waits behind "+N more" too, never a sliver
    // r22 (both critics): rows are whole actions now, so fewer may fit. r30: the panel shows the rows that fit whole above its footer, the first
    // always (the panel scrolls only for that one): a second row that would push the rest of the panel under the footer waits behind "Show N more"
    const keepMin = 1;
    // r27: the first row's list is too tall for the room above the footer: one item fewer, measured again (never a cut item)
    if (!fits && itemCap > 1 && rows[0]?.querySelector(".cp-items") && rows[0].offsetHeight > budget) { setItemCap(itemCap - 1); setPass(0); return; }
    for (const r of fits ? [] : rows) { if (n >= keepMin && used + r.offsetHeight > budget) break; used += r.offsetHeight; n++; }
    setLimit(fits || n >= rows.length ? Infinity : n);
    if (settled.current !== key) remeasured.current = 0;
    settled.current = key;
    setMeasuring(false); setPass(0);
  }, [measuring, fit, pass]); // eslint-disable-line react-hooks/exhaustive-deps
  // a row can change height after it was measured (a full question arrives, a next step wraps): if the panel then overflows, measure
  // again (a few times in a row at most, so this settles)
  useLayoutEffect(() => {
    const list = listRef.current; const scroller = list?.closest(".cp-fit") as HTMLElement | null;
    if (!fit || !list || !scroller || measuring || all || typeof ResizeObserver === "undefined") return;
    const check = () => {
      if (settled.current !== key || list.querySelector("[data-open]")) return;
      if (scroller.scrollHeight <= scroller.clientHeight + 1) {
        remeasured.current = 0;
        // r18: room came free after the rows were measured (the sentence above was cut to its three lines, a title arrived shorter): measure
        // again so the rows that now fit show, a few times per list at most
        const room = scroller.clientHeight - scroller.scrollHeight;
        const nextRow = Number.isFinite(limit) && limit < needs.length;
        if (nextRow && room > 48 && grown.current < 3) { grown.current++; setLimit(Infinity); setMeasuring(true); }
        return;
      }
      if (remeasured.current < 6) { remeasured.current++; setLimit(Infinity); setMeasuring(true); }
      // still over after measuring again (a row's height settles only once it is the last one shown): one row fewer, until it fits (r14)
      else if (Number.isFinite(limit) && limit > (keepOne ? 1 : 2)) setLimit(limit - 1);
    };
    const ro = new ResizeObserver(check);
    ro.observe(list);
    const body = list.closest(".cp-body"); if (body) ro.observe(body); // the sentence or the footer can change height too
    check();
    return () => ro.disconnect();
  }, [fit, measuring, all, limit, needs.length, key]);
  // r28: the compact panel's first request is whole in view at scroll 0: its inline items go one at a time (to none) until it fits
  useLayoutEffect(() => {
    if (!wholeFirst) return;
    const list = listRef.current; const sc = list?.closest(".cp-scroll") as HTMLElement | null; const row = list?.firstElementChild as HTMLElement | null;
    if (!list || !sc || !row || sc.scrollTop > 0 || !row.querySelector(".cp-items") || itemCap <= 0) return;
    if (row.getBoundingClientRect().bottom > sc.getBoundingClientRect().bottom + 0.5) setItemCap(itemCap - 1);
  });
  useLayoutEffect(() => { if (wholeFirst) setItemCap(ROW_ITEMS); }, [wholeFirst, key]);
  const shown = fit && !measuring && !all ? needs.slice(0, limit) : needs;
  // r20: only what is owed counts in "+N more"; a decision still being read is never a count
  const hidden = Math.max(0, owed.length - Math.min(shown.length, owed.length));
  return <>
    <ul ref={listRef} className="cp-list">{shown.map((t) => <NeedRow key={t.id} t={t} onTask={onTask} onDecide={onDecide} onNote={onNote} area={placeOf?.(t) ?? null} compact itemCap={itemCap} />)}</ul>
    {extra > 0
      ? <button type="button" className="cp-more cp-more-rows cp-more-all" title={moreTitle ?? undefined} onClick={() => onMore?.()}>{moreLabel(hidden + extra)}</button>
      : hidden > 0 && <button type="button" className="cp-more cp-more-rows" onClick={() => (onMore ? onMore() : setAll(true))}>{moreLabel(hidden)}</button>}
  </>;
}

/**
 * r28 (Sonnet): a run that waits on the user's answer is a Needs-you row, counted with the asks: the question it waits on is the step, whole
 * and wrapped ("Waiting on your answer in #Uni: Ship 0.1.46?" is "Ship 0.1.46?", "in #Uni" its place), never the lead-in with a colon.
 */
export function WaitingRuns({ runs, className = "cp-list cp-waiting", onRun, missing }: { runs: readonly Run[]; className?: string; missing?: (r: Run) => boolean; /** r30: the whole row opens its room at the run's message (the room, with none), the composer focused */ onRun?: (r: Run) => void }) {
  return runs.length > 0 ? <ul className={className} aria-label="Waiting on your answer">{runs.map((r) => {
    const w = waitingRunParts(cleanText(r.what));
    const gone = !!missing?.(r);
    return <li key={r.id} className="cp-run cp-run-waiting" data-state={r.state} data-task={r.task ?? undefined}>
      <button type="button" className="cp-need cp-run-open" aria-label={[w.step, w.place, gone ? ROOM_NOT_FOUND : runStateLabel(r.state)].filter(Boolean).join(". ")} data-missing={gone || undefined} onClick={() => onRun?.(r)}>
        <i aria-hidden="true" /><span className="cp-run-text" title={cleanText(r.what)}><span className="cp-run-step">{w.step}</span>{w.place && <small className="cp-run-place">{w.place}</small>}</span><small>{gone ? ROOM_NOT_FOUND : runStateLabel(r.state)}</small>
      </button></li>;
  })}</ul> : null;
}
/** An ask's whole step, wrapped, never ending at a colon (the recheck list shows nothing less). */
export function wholeStep(t: Task): string {
  const r = rowLead(t);
  const text = t.kind === "decision" ? (() => { const d = decisionAsk(t); return d.answerable ? d.text : r.text; })() : r.text;
  return text.replace(/[\s:;,—–-]+$/, "");
}
/**
 * r28 (Codex P1-2), r30: requests that aren't confirmed (no `asked_at` or `confirmed_at` within 3 days) are not in Needs you and not counted. One quiet
 * line says how many need confirming and where it counts ("in this room", "across all rooms"); it opens to a plain list: each request's whole step,
 * its reason in a few words ("asked Oct 11"), and one tap to its sheet. "Answer anyway"
 * is not here: it is in the sheet, after the reason.
 */
export function Rechecks({ tasks, why, scope = "room", onTask, placeOf }: { tasks: readonly Task[]; why?: Record<string, RecheckWhy | null>; scope?: RecheckScope; onTask: (t: Task) => void; /** the area an ask belongs to when it is listed outside it */ placeOf?: (t: Task) => string | null }) {
  const [open, setOpen] = useState(false);
  const vault = useVaultProfile().vault;
  if (!tasks.length) return null;
  return <div className="cp-recheck" data-count={tasks.length} data-scope={scope}>
    <button type="button" className="cp-recheck-line" aria-expanded={open} onClick={() => setOpen(!open)}>{recheckLine(tasks.length, scope)}<i aria-hidden="true">{open ? "–" : "+"}</i></button>
    {open && <ul className="cp-recheck-list" aria-label="Requests that need confirming">{tasks.map((t) => {
      const place = placeOf?.(t) ?? null;
      const w = why?.[t.id] ?? null;
      const reason = [reasonShort(t, undefined, w), place ? `in ${place}` : null].filter(Boolean).join(" · ");
      // a request whose row leads with its title (no action in its step) shows the step under it, whole: no word of it is left out of the list
      const under = t.kind !== "decision" && rowLead(t).mode === "title" ? t.next.trim() : "";
      return <li key={t.id} className="cp-recheck-item" data-id={taskTitle(t.title).id ?? undefined} data-why={w ?? undefined}>
        <button type="button" className="cp-rc-open" aria-label={`${wholeStep(t)}${under ? `. ${under}` : ""}. ${reason}`} onClick={() => onTask(t)}>
          <span className="cp-recheck-step"><RefText text={wholeStep(t)} vault={t.vault ?? vault} /></span>
          {under && <span className="cp-recheck-next"><RefText text={under} vault={t.vault ?? vault} /></span>}
          <small className="cp-recheck-asked">{reason}</small>
        </button>
      </li>;
    })}</ul>}
  </div>;
}

function Body({ stands, ready, note, load, feed, rest = 0, moreTitle = null, onPrivate, runs, nodeName, onTask, onDecide, onRun, runMissing, scopeAll, onEverything, onNote, placeOf, fit, hideHealth = false, onMore, keepOne = false, compact = false }: CompanionProps & { fit: boolean; hideHealth?: boolean; onMore?: () => void; keepOne?: boolean;
  /** r28 (Codex P2-5): the one compact panel: the summary is its date line, the footer is outside what scrolls */
  compact?: boolean }) {
  const live = runs.filter(isActiveRun);
  const waiting = feed.waiting ?? [];
  const active = live.filter((r) => !waitingOnYou(r));
  /** r24 (Sonnet): in the side panel a Running row is whole above the footer or it waits behind "+N more running": one fewer until the last fits */
  const [runCap, setRunCap] = useState(RUNS_SHOWN);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => { setRunCap(RUNS_SHOWN); }, [active.length, fit]);
  useLayoutEffect(() => {
    const b = bodyRef.current; const sc = b?.closest(".cp-fit") as HTMLElement | null;
    if (!fit || !b || !sc || typeof ResizeObserver === "undefined") return;
    let height = sc.clientHeight;
    const check = () => {
      // a taller panel gives the rows back
      if (sc.clientHeight > height + 1) { height = sc.clientHeight; setRunCap(RUNS_SHOWN); return; }
      height = sc.clientHeight;
      const runs = b.querySelectorAll<HTMLElement>(".cp-run"); const foot = b.querySelector<HTMLElement>(".cp-foot");
      const last = runs[runs.length - 1]; if (!last || !foot || sc.scrollTop > 0) return;
      const [l, f] = [last.getBoundingClientRect(), foot.getBoundingClientRect()];
      // a row the sticky footer cuts in two, or that is wholly under it (r30: its "Running" heading would stand alone above the footer): one fewer,
      // down to none ("+N more running" is in the footer)
      const cut = sc.scrollHeight > sc.clientHeight + 1 && l.bottom > f.top + 0.5;
      if (cut) setRunCap((c) => Math.max(0, Math.min(c, runs.length) - 1));
    };
    const ro = new ResizeObserver(check); ro.observe(b); ro.observe(sc); check();
    return () => ro.disconnect();
  }, [fit, runCap, active.length, feed.rows.length]);
  /**
   * r30 (Codex, Sonnet: "Where this stands" was cut mid-line at the panel's bottom): the summary is shown whole, or as its date line with "Read", or
   * (when even that line would be cut) below "All of X's work"; never cut by the panel's edge. It goes down one step at a time, never back up until
   * the text or the panel's size changes.
   */
  const [standsAt, setStandsAt] = useState<"whole" | "folded" | "foot">("whole");
  const [panelSize, setPanelSize] = useState("");
  const standsKey = `${stands?.text ?? ""}|${feed.rows.length}|${feed.recheck?.length ?? 0}|${waiting.length}|${active.length}|${fit}|${compact}|${panelSize}`;
  const standsSeen = useRef("");
  /** how many times a summary folded while the panel settled has been tried whole again */
  const retries = useRef(0);
  useLayoutEffect(() => {
    const b = bodyRef.current; const sc = (fit ? b?.closest(".cp-fit") : compact ? b : null) as HTMLElement | null;
    if (!sc || typeof ResizeObserver === "undefined") return;
    // (the panel's width and the window's height: the panel's own height follows what it holds, and a scrollbar that comes or goes with it is not a new size)
    const size = () => setPanelSize(`${sc.offsetWidth}x${window.innerHeight}`);
    const ro = new ResizeObserver(size);
    ro.observe(sc); size();
    return () => ro.disconnect();
  }, [fit, compact]);
  useLayoutEffect(() => {
    if (standsSeen.current !== standsKey) { standsSeen.current = standsKey; retries.current = 0; if (standsAt !== "whole") { setStandsAt("whole"); return; } }
    const b = bodyRef.current; const sc = (fit ? b?.closest(".cp-fit") : compact ? b : null) as HTMLElement | null;
    if (!b || !sc || standsAt === "foot") return;
    // measured once the panel has been quiet for a moment (the rows above are still being fitted while they change), and again whenever it changes
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      const note = b.querySelector<HTMLElement>(".cp-stands-note");
      if (!note || sc.scrollTop > 1 || note.querySelector("details[open]")) return;
      const s = sc.getBoundingClientRect(); const n = note.getBoundingClientRect();
      const foot = (fit ? b : sc.parentElement)?.querySelector<HTMLElement>(".cp-foot");
      // what is in view above the footer: a sticky footer covers the scrolling panel's bottom; the compact panel's footer is outside what scrolls
      const limit = Math.min(s.bottom, foot && foot.getBoundingClientRect().top > s.top ? foot.getBoundingClientRect().top : Infinity);
      if (n.top < limit - 0.5 && n.bottom > limit + 0.5) { setStandsAt(standsAt === "whole" ? "folded" : foot ? "foot" : "folded"); return; }
      // folded while the panel was still settling, and now there is room to spare: the whole summary is tried again (twice at most; it folds again if it is cut)
      if (standsAt === "folded" && retries.current < 2) {
        const lastBottom = Math.max(...Array.from(b.children).filter((c) => !c.classList.contains("cp-foot")).map((c) => c.getBoundingClientRect().bottom));
        if (limit - lastBottom >= 76) { retries.current++; setStandsAt("whole"); }
      }
    };
    const later = () => { clearTimeout(timer); timer = setTimeout(measure, 120); };
    later();
    // (a scroller that is the body itself doesn't change size when its content does: its children are watched too)
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(later);
    ro?.observe(b); ro?.observe(sc); for (const c of Array.from(b.children)) ro?.observe(c);
    const mo = typeof MutationObserver === "undefined" ? null : new MutationObserver(later);
    mo?.observe(b, { childList: true, subtree: true });
    return () => { clearTimeout(timer); ro?.disconnect(); mo?.disconnect(); };
  }, [standsAt, standsKey, fit, compact]);
  const runsShown = fit ? Math.min(RUNS_SHOWN, runCap) : RUNS_SHOWN;
  const hiddenRuns = Math.max(0, active.length - runsShown);
  if (note) return <div className="cp-body"><p className="cp-lede cp-note">{note}</p></div>;
  // below 900px the room shows the list's health itself, outside the strip (r14)
  const health = !hideHealth && <LoadHealth load={load} ready={ready} count={feed.total} />;
  const footStands = ready && !!stands && standsAt === "foot";
  const foot = onEverything && <div className="cp-foot"><button type="button" className="cp-all" onClick={onEverything}><span className="cp-all-t">{`All of ${nodeName}'s work`}</span>{hiddenRuns > 0 && <span className="cp-all-more">+{hiddenRuns} more running</span>}<span className="cp-all-arrow" aria-hidden="true">→</span></button>
    {/* r30: with no room above the footer for even its date line, the summary is below "All of X's work", folded */}
    {footStands && <Stands stands={stands!} folded />}</div>;
  const content = <>
    {/* an approval waiting in a room (T-161, T-234) needs no task list: it shows while the list loads or fails */}
    {!ready && <ApprovalRows approvals={feed.approvals ?? []} />}
    {!ready && (load?.error || load?.slow ? <LoadHealth load={load} ready={false} /> : <p className="cp-lede">Loading…</p>)}
    {ready && <section aria-label="Needs you" className="cp-sec" aria-busy={load?.refreshing || undefined}>
      <h3 className="cp-h">Needs you</h3>
      <ApprovalRows approvals={feed.approvals ?? []} />
      {/* r17: Uni's panel is at most three rows and one "Show N more" (private items folded in) to the work view, which keeps the full list */}
      {(feed.rows.length > 0 || !!feed.pending?.length) && <NeedsList needs={feed.rows} pending={feed.pending} fit={fit} onTask={onTask} onDecide={onDecide} onNote={onNote} placeOf={placeOf} onMore={rest > 0 && onEverything ? onEverything : onMore} extra={onEverything ? rest : 0} moreTitle={moreTitle} keepOne={keepOne} wholeFirst={compact} />}
      {feed.rows.length === 0 && rest > 0 && onEverything && <button type="button" className="cp-more cp-more-rows cp-more-all" title={moreTitle ?? undefined} onClick={onEverything}>{moreLabel(rest)}</button>}
      {feed.privates.length > 0 && <ul className="cp-list cp-privates">{feed.privates.map((p) => <PrivateRow key={p.key} p={p} onPrivate={onPrivate} />)}</ul>}
      <WaitingRuns runs={waiting} onRun={onRun} missing={runMissing} />
      {feed.total === 0 && !feed.pending?.length && !waiting.length && <p className="cp-none">{noneLine(feed)}</p>}
      <Rechecks tasks={feed.recheck ?? []} why={feed.recheckWhy} scope={scopeAll ? "all" : "room"} onTask={onTask} placeOf={placeOf} />
      {health}
    </section>}
    {/* r29 (Codex P1-3): the summary is a dated account, below what needs you, never leading */}
    {ready && stands && !footStands && <Stands stands={stands} folded={standsAt === "folded"} />}
    {active.length > 0 && runsShown > 0 && <section aria-label="Running" className="cp-sec">
      <h3 className="cp-h">Running</h3>
      <ul className="cp-list">{active.slice(0, runsShown).map((r) => <li key={r.id} className="cp-run" data-state={r.state}><i aria-hidden="true" /><RunText what={cleanText(r.what)} /><small>{runStateLabel(r.state)}</small></li>)}</ul>
    </section>}
  </>;
  // r28 (Codex P2-5): in the compact panel the footer is outside what scrolls, so nothing is ever under it
  return compact ? <><div className="cp-body cp-scroll" ref={bodyRef}>{content}</div>{foot}</> : <div className="cp-body" ref={bodyRef}>{content}{foot}</div>;
}

/** A Running row's words (r28): the whole text, wrapped; no short form and no cut. The same function for the panel and the work view. */
export function RunText({ what }: { what: string }) {
  const full = runText(what);
  return <span className="cp-run-text" title={full}>{full}</span>;
}

/**
 * "Needs you · 2: Say go on prod deploy of #38 + #58": the folded strip's line when anything needs the user (r19). The first row whose request
 * is known; the count is the feed's own total, asks and waiting runs alike. `short` is "Needs you · 2": the line when the action doesn't fit
 * whole beside it (r28: a line is whole or short, never cut). Null when nothing needs them.
 */
export function waitingLine(feed: NeedsFeed): { full: string; short: string } | null {
  if (!feed.total) return null;
  const short = `Needs you · ${feed.total}`;
  const first = feed.rows.map((t) => rowLead(t)).find((r) => r.mode !== "checking" && r.mode !== "unavailable");
  // T-161: a prompt waiting on the user's OK goes first: a run is blocked on it, and it ends on its own
  if (feed.approvals?.length) return { short, full: `${short}: ${approvalAsk(feed.approvals[0])}` };
  const run = !first && feed.waiting?.length ? waitingRunParts(feed.waiting[0].what).step : null;
  // r28: the line is the first request whole, or just the count: never step 1 of it, never a part (the r21 "step 1 of 2" form is gone)
  const text = run ?? first?.text;
  return { short, full: `${short}${text ? `: ${first?.yourCall ? `Your call: ${text}` : text}` : ""}` };
}

/** One line of text that is whole or is its shorter form: never cut and never "…" (r28). */
function FitText({ full, short, className }: { full: string; short: string; className: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [mode, setMode] = useState<"full" | "short">("full");
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => { setMode("full"); }, [full, short, width]);
  useLayoutEffect(() => {
    const el = ref.current; if (!el || mode !== "full") return;
    if (el.scrollWidth > el.clientWidth + 1) setMode("short");
  });
  useLayoutEffect(() => {
    const el = ref.current; if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { const w = Math.round(el.clientWidth); setWidth((cur) => (cur === w ? cur : w)); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return <span ref={ref} className={className} data-form={mode} title={full}>{mode === "full" ? full : short}</span>;
}

/** The side panel (wide screens). `open` and `onToggle` come from `useCompanionOpen("side")`. */
export function CompanionSide({ open, onToggle, ...p }: CompanionProps & Fold) {
  return <aside className={`cp side cp-fit ${open ? "open" : "folded"}`} aria-label="Where this stands">
    {open
      ? <>
        <button type="button" className="cp-top" aria-expanded="true" aria-label="Hide where this stands" title="Hide where this stands" onClick={() => onToggle(false)}><span>{standsHeading(p.scope, p.ready ? p.stands?.ago : null, p.stands?.asOf)}</span><span className="cp-fold" aria-hidden="true">›</span></button>
        <Body {...p} fit />
      </>
      : <button type="button" className="cp-unfold" aria-expanded="false" aria-label="Show where this stands" title="Show where this stands" onClick={() => onToggle(true)}>
        <span aria-hidden="true">‹</span>{p.feed.total > 0 && <i className="cp-dot" role="img" aria-label="Needs you" title="Needs you" />}</button>}
  </aside>;
}

/**
 * The strip (the phone's, and a short window's): one line, tap to open. r28 (Codex P2-5): it opens one panel, always the same one: over the
 * room, under its header. The panel's summary is folded to its date line, its footer is outside what scrolls, and it always starts with a whole
 * request. Opening a task from it leaves the panel where it was; closing the task comes back to the panel at the same scroll position.
 */
export function CompanionStrip({ open, onToggle, onSheet, behind = false, ...p }: CompanionProps & Fold & { /** r20 (Codex 5): the sheet's close, while it is open, so the shell's Back closes it first */ onSheet?: (close: (() => void) | null) => void;
  /** r28: a task's sheet is open over this panel: the panel stays where it is, out of the way of assistive technology until that sheet is closed */ behind?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const close = () => onToggle(false);
  const closeRef = useRef(close); closeRef.current = close;
  /** Where the panel starts: under the room's header, so the room it belongs to stays in sight; in a window too short for that, from the top. */
  const [top, setTop] = useState(0);
  useLayoutEffect(() => {
    if (!open) return;
    const el = ref.current; const room = el?.closest(".sr") as HTMLElement | null;
    const under = el && room ? Math.max(0, Math.round(el.getBoundingClientRect().top - room.getBoundingClientRect().top)) : 0;
    setTop(room && room.clientHeight < SHEET_FULL_BELOW ? 0 : under);
    // r17: focus goes back to the strip's own line when the panel closes. r19: the one dialog contract (focus in, Tab kept inside, the room
    // under it inert, Escape on the window when it is the top dialog)
    const line = el?.querySelector<HTMLElement>(".cp-line") ?? null;
    const box = sheetRef.current; const layer = box?.closest(".cp-sheet-wrap") as HTMLElement | null;
    onSheet?.(() => closeRef.current());
    const off = box ? openDialog(box, () => closeRef.current(), { root: layer, initial: box, opener: line }) : undefined;
    return () => { off?.(); onSheet?.(null); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const heading = standsHeading(p.scope, p.ready ? p.stands?.ago : null, p.stands?.asOf);
  // r18: folded, the line is the sentence cut on a whole word (never "underway ac…"); open, it is the dated heading. r19: when anything needs
  // the user, the folded line says what is waiting first ("Needs you · 2: Say go on the deploy…"), never only a dot behind a chevron
  const waiting = p.ready && !p.note ? waitingLine(p.feed) : null;
  const folded = p.note ?? (p.ready ? (p.stands ? (p.stands.written ? `${lastWritten(p.stands.asOf, p.stands.by)} ${withoutRawIds(p.stands.text)}` : withoutRawIds(p.stands.text)) : null) ?? "Where this stands" : p.load?.error ? "Couldn't load" : p.load?.slow ? "Still loading" : "Loading…");
  const lineRef = useRef<HTMLParagraphElement | null>(null);
  const lineTokens = [...(p.scope ? [{ node: <b className="cp-scope">{`${p.scope}:`}</b>, space: false }] : []), ...wordTokens(folded).map((w, i) => (i === 0 && p.scope ? { ...w, space: true } : w))];
  const label = <span className="cp-line-text" title={p.stands?.text}>{open ? heading
    : waiting ? <FitText className="cp-line-fit" full={waiting.full} short={waiting.short} />
    : <WordClamp elRef={lineRef} className="cp-line-words" tokens={lineTokens} textKey={`${p.scope ?? ""}\n${folded}`} lines={1} open={false} onCut={() => {}} onClick={() => {}} tag="span" />}</span>;
  // the strip sits in a room below 900px, which shows the list's health above it (r14)
  return <>
    <section ref={ref} className={`cp strip ${open ? "open" : ""}`} aria-label="Where this stands" data-place={open ? "sheet" : "folded"}>
      <button type="button" className="cp-line" aria-expanded={open} onClick={() => (open ? close() : onToggle(true))}>
        {label}
        {p.feed.total > 0 && <i className="cp-dot" role="img" aria-label="Needs you" title="Needs you" />}
        <span className="cp-chev" aria-hidden="true">{open ? "⌃" : "⌄"}</span>
      </button>
    </section>
    {open && <div className="cp-sheet-wrap" aria-hidden={behind || undefined}>
      <button type="button" className="cp-sheet-scrim" aria-label="Close" tabIndex={-1} onClick={close} />
      <div ref={sheetRef} className="cp cp-sheet" role="dialog" aria-modal="true" aria-label={p.scope ? `Where ${p.scope} stands` : "Where this stands"} tabIndex={-1}
        style={{ maxHeight: `calc(100% - ${top}px)` }}>
        <div className="cp-sheet-head"><span className="cp-sheet-lead">{p.scope ?? p.nodeName}</span><button type="button" className="cp-sheet-close" onClick={close}>Close</button></div>
        {/* one panel: a task opened from it is a sheet over it (the panel stays, and is where Close comes back to); "All of X's work" and a private area leave it */}
        <Body {...p} fit={false} hideHealth compact onPrivate={p.onPrivate && ((o) => { close(); p.onPrivate!(o); })} onEverything={p.onEverything && (() => { close(); p.onEverything!(); })} />
      </div>
    </div>}
  </>;
}
/** A room shorter than this (px) gives the compact panel its whole height, header included. */
export const SHEET_FULL_BELOW = 520;
