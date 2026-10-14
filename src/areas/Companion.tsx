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
import { actionableTitle, answerChoices, answerLabel, askLead, askPreview, checkLine, CHECK_FAILED, DANGLING, decideLine, stripRoom, decisionQuestion, dueLine, fitsRow, isOverdue, lineBudget, missingLine, OPEN_TASK, OPEN_TO_ANSWER, privateActionLabel, privateRestLabel, askedLine, requestDate, pointsNowhere, firstOfSteps, actionOf, rowAction, withoutBrackets, rowSubParts, standsHeading, titleSays, titleWords, TIDY_LINE, toTidy, unknownDecision, waitsLine, waitsOnMe, withHosts, withoutCut, rowAsk, withoutRawIds, clauseForms, type Choice, type NeedsFeed, type PrivateNeed, type RowAction, type Support } from "./simpleCore";
import { requestRecheck } from "./useTasks";

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
  stands: { text: string; ago: string } | null; ready: boolean;
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

/** Lines an action may take (r22: no limit; the whole action, as many lines as it needs). */
const ACTION_LINES = 99;
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
    <p ref={ref} className={`cp-next ${open ? "open" : ""}`} style={!open && lines !== undefined ? { WebkitLineClamp: lines, lineClamp: lines, maxHeight: `${(lines * 13.5 * 1.45).toFixed(2)}px` } as React.CSSProperties : undefined}>{splitLinks(cleanText(text)).map((p, i) => "url" in p
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
 * no clamp, no "then …", no ellipsis. An action past `ROW_ACTION_MAX` characters was already shortened with words (`rowForm`).
 */
function ActionLine({ forms, vault, elRef }: { forms: { text: string; keep: string }[]; vault: string; elRef: React.RefObject<HTMLParagraphElement | null> }) {
  const tokens = stepTokens(forms[0].text, vault, undefined, true);
  return <span ref={elRef} className="cp-title cp-lead" data-form="0">{tokens.map((t, i) => <Fragment key={i}>{t.space ? " " : ""}{t.node}</Fragment>)}</span>;
}

/**
 * Where this stands (r23, both critics): the node's sentence without raw ids (run numbers, hashes, long links), whole when it fits three
 * lines, else the longest form that ends on a clause ("…; prod waits…" → "Staging has the D2 one-app…."), never cut inside one and never
 * with "…". "More" (a real button) shows the whole. Its date is in the heading ("Where this stands · 2 days ago"), not under it.
 */
function Stands({ text }: { text: string }) {
  const clean = useMemo(() => withoutRawIds(text), [text]);
  const forms = useMemo(() => clauseForms(clean), [clean]);
  const [full, setFull] = useState(false);
  const [form, setForm] = useState(0);
  const [width, setWidth] = useState(0);
  const ref = useRef<HTMLParagraphElement | null>(null);
  useLayoutEffect(() => { setForm(0); }, [clean, width]);
  useLayoutEffect(() => {
    const el = ref.current; if (!el || full) return;
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 22;
    if (el.scrollHeight > lh * 3 + 2 && form < forms.length - 1) setForm(form + 1);
  });
  useLayoutEffect(() => {
    const el = ref.current; if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { const w = Math.round(el.clientWidth); setWidth((cur) => (cur === w ? cur : w)); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const cut = !full && form > 0;
  return <div className={`cp-lede ${full ? "full" : ""}`}>
    <p ref={ref} className="cp-stands" data-cut={cut ? "true" : undefined}>{full ? clean : forms[form]}</p>
    {(cut || full) && <button type="button" className="cp-more-next cp-stands-more" aria-expanded={full} onClick={() => setFull(!full)}>{full ? "Less" : "More"}</button>}</div>;
}

/** One line of small print under a row (r18): whole words, then "…"; never a second line. */
function SmallLine({ text, className }: { text: string; className: string }) {
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
    if (!dq.fits) return { text: dq.preview, under: null, go: "Open to decide", answers: false, yourCall: dq.yourCall, lead: false, mode: "preview" };
    return { text: dq.text, under: null, go: null, answers: true, yourCall: dq.yourCall, lead: false, mode: "answers" };
  }
  // r17: someone else's task that waits on the user leads with what it asks of them; the task itself is the quiet line under it
  const theirs = waitsOnMe(t);
  // r20: the action, never the stored sentence: its first clause, the date label and the notes after it left to the subtitle and the sheet
  // r23: a step that points at words nobody stored ("…the message below") asks the room for them: "Ask #techne for the message"
  const nowhere = pointsNowhere(t, t.stewardRoom ?? t.room);
  const action = rowAction(nowhere ?? next) ?? (theirs && next ? actionOf(next) : null);
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
 * A Needs-you row (r14): action first. A task whose next step names an action leads with it (r21: the whole action, up to three lines), its
 * title or area under it as one quiet line (r18: small print is never more than a line); otherwise the title, then the next step. A decision is
 * its question; its answers are in the sheet. r21 (Codex 10): the row is one button that opens its sheet, with nothing clickable inside it.
 * `compact` (the companion, r18): at most one line of step under a title.
 */
export function NeedRow({ t, onTask, meta, compact = false, area = null }: { t: Task; onTask: (t: Task) => void; /** r20 (Codex 7): answers are in the sheet only; kept for callers */ onDecide?: (t: Task, option: string) => void;
  /** r21 (Codex 10): a row's notes and links open in its sheet; kept for callers */ onNote?: (ref: NoteRef) => void;
  /** A quiet line on where it stands, for a row that is not the user's ("With Casey · in progress"; the work view's In motion and Later). */
  meta?: string | null; compact?: boolean;
  /** r20: the row's area when it is shown outside it: an action row's subtitle names it when its title can't say where it belongs. */
  area?: string | null }) {
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
  const [titleLines, setTitleLines] = useState(1);
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
  // r16: an action reads whole up to four lines (the panel shows fewer rows rather than cutting an instruction); a title reads to its object
  // (up to 3 lines beside other lines, 4 alone); a decision's question is never clamped, its preview is two lines of whole words.
  // r18: in the companion an action is three lines at most, and a long "Your call" or "Check" two
  const quietMode = r.mode === "check" || r.mode === "waits" || r.mode === "tidy" || r.mode === "missing";
  // r20 (Codex 7): one decision presentation: a row is the question and opens the sheet, where the answers are; beside the chat, two lines
  const clampMode = r.mode === "preview" || ((r.mode === "call" || r.mode === "answers" || quietMode) && compact);
  // r20: an action is two lines everywhere, the companion and the work view alike; what it cuts is the object, never the verb phrase
  const titleMax = r.lead ? ACTION_LINES : isDecision ? (r.mode === "preview" || ((r.mode === "call" || r.mode === "answers" || r.mode === "tidy" || quietMode) && compact) ? 2 : 99) : quietMode ? (compact ? 2 : 99) : next || due ? 3 : 4;
  useLayoutEffect(() => {
    const el = titleRef.current; if (!el) return;
    const measure = () => {
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
      setTitleLines(Math.max(1, Math.round(el.clientHeight / lh)));
    };
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [text, titleMax]);
  // the next step shows under a title; a row that leads with it does not repeat it, and a row whose step isn't checked (or is doubted, or is
  // Uni's to tidy) never shows it (r19)
  const showNext = !!next && !r.lead && r.mode === "title";
  const nextLines = compact ? Math.min(1, lineBudget(Math.min(titleLines, titleMax), !!due, 4).next) : lineBudget(Math.min(titleLines, titleMax), !!due, 4).next;
  const clampStyle = isDecision ? undefined : ({ WebkitLineClamp: titleMax, lineClamp: titleMax } as React.CSSProperties);
  // r20: an action row's subtitle carries its due cue ("COhere opens Oct 15 · due today"); other rows keep the due line of their own
  // r22 (Codex P1): every Needs-you row says when it was asked ("asked Oct 11"), from the record's last change; never on a row that isn't the user's
  // r23 (Codex P1): when it was asked ("asked Oct 6") or, with no request time, added ("added Oct 11"); never the record's last change
  const asked = meta ? null : askedLine(requestDate(t));
  const when_ = r.sub ? [r.sub.when, asked].filter(Boolean).join(" · ") : null;
  const meta_ = <>{r.sub ? (<span ref={subRef} className="cp-under cp-sub" data-wrapped={subWrapped || undefined} title={[r.sub.where, when_].filter(Boolean).join(" · ")}>{r.sub.where && <FitLine className="cp-sub-where" text={r.sub.where} fallback={r.sub.short ?? null} onHide={setWhereHidden} />}
      {when_ && <span className={`cp-sub-when${isOverdue(t.due) ? " overdue" : ""}`}>{r.sub.where && !whereHidden && !subWrapped ? " · " : ""}{when_}</span>}</span>)
    : r.under && <SmallLine className="cp-under" text={r.under} />}
    {!r.lead && (due || asked) && <small className={`cp-detail cp-asked-line${isOverdue(t.due) ? " overdue" : ""}`}>{[due, asked].filter(Boolean).join(" · ")}</small>}
    {meta && <SmallLine className="cp-detail cp-meta" text={meta} />}</>;
  // r21 (Codex 10): one target per visible request: the whole row is one button that opens its sheet (its links and notes open there).
  // r21 (P1-1): a row whose check failed retries as it opens, so its "Retry" is what the tap does
  const open_ = () => { if (r.mode === "unavailable") requestRecheck(); onTask(t); };
  const label = r.lead ? [r.action?.text ? plainDetail(withHosts(r.action.text)) : text, r.sub ? [r.sub.where, when_].filter(Boolean).join(" · ") : r.under, meta].filter(Boolean).join(". ") : r.yourCall ? `Your call: ${text}` : undefined;
  return <li className="cp-item" data-lead={r.lead ? "action" : undefined} data-mode={r.mode}>
    <button type="button" className={`cp-need${isDecision ? " decision" : ""}${r.lead ? " cp-need-lead" : ""}`} data-id={id ?? undefined} data-mode={r.mode} aria-busy={r.mode === "checking" || undefined} aria-label={label} onClick={open_}>
      {r.yourCall && <small className="cp-call-lead">Your call:</small>}
      {r.lead
        // r21: the whole action, a third line before its object is cut; "2 steps: A, then …" when two steps don't fit
        ? <ActionLine elRef={titleRef as React.RefObject<HTMLParagraphElement | null>} forms={r.action?.forms.length ? r.action.forms : [{ text: next, keep: "" }]} vault={vault} />
        : clampMode
          // r16: a question too long for a row: whole words, then "Open to decide" (r18: the companion's "Your call"/"Check" lines too)
          ? <span className="cp-title-wrap"><WordClamp elRef={titleRef as React.RefObject<HTMLParagraphElement | null>} className="cp-title cp-preview" tokens={wordTokens(withoutCut(text))} textKey={text} lines={titleMax} open={false} onCut={() => {}} onClick={() => {}} tag="span" /></span>
          // r20: no "›" on any row: the whole row opens its sheet, in the companion and the work view alike
          : <span ref={titleRef} className="cp-title" style={clampStyle}><RefText text={text} vault={vault} /></span>}
      {r.go && <span className="cp-open-decide">{r.go}</span>}
      {!next && !isDecision && r.mode === "title" && !actionableTitle(text) && text !== "Open to see what's needed" && <span className="cp-open-to-see">Open to see what's needed</span>}
      {/* the step under a title, as words (its links open in the sheet) */}
      {showNext && nextLines > 0 && <span className="cp-next cp-next-in" style={{ WebkitLineClamp: nextLines, lineClamp: nextLines } as React.CSSProperties}>{splitLinks(cleanText(next)).map((p, i) => "url" in p
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
export function NeedsList({ needs: owed, pending = [], fit, onTask, onDecide, onNote, placeOf, onMore, extra = 0, moreTitle = null, keepOne = false }: Pick<CompanionProps, "onTask" | "onDecide" | "onNote" | "placeOf"> & { needs: readonly Task[]; fit: boolean; /** "+N more" opens elsewhere (the strip's sheet) instead of in place */ onMore?: () => void;
  /** r20: decisions still being read: shown after the rows that are owed, never counted in "+N more" */
  pending?: readonly Task[];
  /** The phone's inline strip always shows its first row (its body was sized to the room left beside the conversation). */
  keepOne?: boolean;
  /** r17, Uni's panel: items past these rows (private ones included): they and any row that doesn't fit are one "N more ›" (`onMore`, the work view). */
  extra?: number; moreTitle?: string | null }) {
  const needs = pending.length ? [...owed, ...pending] : owed;
  const [limit, setLimit] = useState(Infinity);
  const [measuring, setMeasuring] = useState(fit);
  const [all, setAll] = useState(false);
  const [size, setSize] = useState("");
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
  useLayoutEffect(() => { if (fit) { setAll(false); setLimit(Infinity); setMeasuring(true); } }, [fit, key]);
  useLayoutEffect(() => { if (fit && !all) { setLimit(Infinity); setMeasuring(true); } }, [size]); // eslint-disable-line react-hooks/exhaustive-deps
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
    // r22 (both critics): rows are whole actions now, so fewer may fit: at least two are kept (the panel scrolls), one in the phone's strip
    const keepMin = keepOne ? 1 : 2;
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
  const shown = fit && !measuring && !all ? needs.slice(0, limit) : needs;
  // r20: only what is owed counts in "+N more"; a decision still being read is never a count
  const hidden = Math.max(0, owed.length - Math.min(shown.length, owed.length));
  return <>
    <ul ref={listRef} className="cp-list">{shown.map((t) => <NeedRow key={t.id} t={t} onTask={onTask} onDecide={onDecide} onNote={onNote} area={placeOf?.(t) ?? null} compact />)}</ul>
    {extra > 0
      ? <button type="button" className="cp-more cp-more-rows cp-more-all" title={moreTitle ?? undefined} onClick={() => onMore?.()}>{moreLabel(hidden + extra)}</button>
      : hidden > 0 && <button type="button" className="cp-more cp-more-rows" onClick={() => (onMore ? onMore() : setAll(true))}>{moreLabel(hidden)}</button>}
  </>;
}

function Body({ stands, ready, note, load, feed, rest = 0, moreTitle = null, onPrivate, runs, nodeName, onTask, onDecide, onEverything, onNote, placeOf, fit, hideHealth = false, onMore, keepOne = false }: CompanionProps & { fit: boolean; hideHealth?: boolean; onMore?: () => void; keepOne?: boolean }) {
  const active = runs.filter(isActiveRun);
  const hiddenRuns = Math.max(0, active.length - RUNS_SHOWN);
  if (note) return <div className="cp-body"><p className="cp-lede cp-note">{note}</p></div>;
  // below 900px the room shows the list's health itself, outside the strip (r14)
  const health = !hideHealth && <LoadHealth load={load} ready={ready} count={feed.total} />;
  return <div className="cp-body">
    {!ready ? (load?.error || load?.slow ? <LoadHealth load={load} ready={false} /> : <p className="cp-lede">Loading…</p>) : stands && <Stands text={stands.text} />}
    {ready && <section aria-label="Needs you" className="cp-sec" aria-busy={load?.refreshing || undefined}>
      <h3 className="cp-h">Needs you</h3>
      {/* r17: Uni's panel is at most three rows and one "Show N more" (private items folded in) to the work view, which keeps the full list */}
      {(feed.rows.length > 0 || !!feed.pending?.length) && <NeedsList needs={feed.rows} pending={feed.pending} fit={fit} onTask={onTask} onDecide={onDecide} onNote={onNote} placeOf={placeOf} onMore={rest > 0 && onEverything ? onEverything : onMore} extra={onEverything ? rest : 0} moreTitle={moreTitle} keepOne={keepOne} />}
      {feed.rows.length === 0 && rest > 0 && onEverything && <button type="button" className="cp-more cp-more-rows cp-more-all" title={moreTitle ?? undefined} onClick={onEverything}>{moreLabel(rest)}</button>}
      {feed.privates.length > 0 && <ul className="cp-list cp-privates">{feed.privates.map((p) => <PrivateRow key={p.key} p={p} onPrivate={onPrivate} />)}</ul>}
      {feed.total === 0 && !feed.pending?.length && <p className="cp-none">Nothing needs you here.</p>}
      {health}
    </section>}
    {active.length > 0 && <section aria-label="Running" className="cp-sec">
      <h3 className="cp-h">Running</h3>
      <ul className="cp-list">{active.slice(0, RUNS_SHOWN).map((r) => <li key={r.id} className="cp-run" data-state={r.state}><i aria-hidden="true" /><span>{cleanText(r.what)}</span><small>{r.state}</small></li>)}</ul>
    </section>}
    {onEverything && <div className="cp-foot"><button type="button" className="cp-all" onClick={onEverything}><span className="cp-all-t">{`All of ${nodeName}'s work`}</span>{hiddenRuns > 0 && <span className="cp-all-more">+{hiddenRuns} more running</span>}<span className="cp-all-arrow" aria-hidden="true">→</span></button></div>}
  </div>;
}

/** "Needs you · 2: Say go on prod deploy of #38 + #58": the folded strip's line when anything needs the user (r19). The first row whose request
 *  is known (never one still being checked); the count is the feed's own total. Null when nothing needs them. */
export function waitingLine(feed: NeedsFeed): string | null {
  if (!feed.total) return null;
  const first = feed.rows.map((t) => rowLead(t)).find((r) => r.mode !== "checking" && r.mode !== "unavailable");
  // r21: one line can't hold every action whole: an action of two steps says so ("2 steps: Look at …, then …"), never step 1 as the whole
  // job; brackets are left to the row; a long host reads as its first part, as in a row
  const a = first?.action;
  const text = a ? withHosts(a.steps.length > 1 ? firstOfSteps(a.steps) : withoutBrackets(a.text)).replace(/\b([\w-]+)(?:\.[\w-]+){2,}\b/g, (h) => rowLinkLabel(h)) : first?.text;
  return `Needs you · ${feed.total}${first ? `: ${first.yourCall ? `Your call: ${text}` : text}` : ""}`;
}

/** The side panel (wide screens). `open` and `onToggle` come from `useCompanionOpen("side")`. */
export function CompanionSide({ open, onToggle, ...p }: CompanionProps & Fold) {
  return <aside className={`cp side cp-fit ${open ? "open" : "folded"}`} aria-label="Where this stands">
    {open
      ? <>
        <button type="button" className="cp-top" aria-expanded="true" aria-label="Hide where this stands" title="Hide where this stands" onClick={() => onToggle(false)}><span>{standsHeading(p.scope, p.ready ? p.stands?.ago : null)}</span><span className="cp-fold" aria-hidden="true">›</span></button>
        <Body {...p} fit />
      </>
      : <button type="button" className="cp-unfold" aria-expanded="false" aria-label="Show where this stands" title="Show where this stands" onClick={() => onToggle(true)}>
        <span aria-hidden="true">‹</span>{p.feed.total > 0 && <i className="cp-dot" role="img" aria-label="Needs you" title="Needs you" />}</button>}
  </aside>;
}

/**
 * The phone's strip (and a short window's): one line, tap to open. r16: it opens inline only when the room keeps its whole composer and 40% of
 * its height for the conversation (the rows that fit are whole, the rest behind "+N more"); otherwise, and for "+N more", it opens as a sheet
 * over the room. Never a sliver: what doesn't fit whole waits behind a way in.
 */
export function CompanionStrip({ open, onToggle, onSheet, ...p }: CompanionProps & Fold & { /** r20 (Codex 5): the sheet's close, while it is open, so the shell's Back closes it first */ onSheet?: (close: (() => void) | null) => void }) {
  const ref = useRef<HTMLElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<ReturnType<typeof stripRoom> | null>(null);
  const [sheet, setSheet] = useState(false);
  useLayoutEffect(() => {
    if (!open) { setPlace(null); setSheet(false); return; }
    const measure = () => {
      const el = ref.current; const room = el?.closest(".sr") as HTMLElement | null;
      if (!el || !room) { setPlace({ mode: "sheet" }); return; }
      const line = el.querySelector<HTMLElement>(".cp-line")?.offsetHeight ?? 46;
      const composer = room.querySelector<HTMLElement>(".sr-chat .composer")?.offsetHeight ?? 64;
      const above = el.getBoundingClientRect().top - room.getBoundingClientRect().top;
      setPlace(stripRoom({ room: room.clientHeight, above, line, composer }));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);
  const asSheet = open && (sheet || place?.mode === "sheet");
  const close = () => { setSheet(false); onToggle(false); };
  const closeRef = useRef(close); closeRef.current = close;
  /** Where the sheet starts: under the room's header, so the room it belongs to stays in sight (r16). */
  const [top, setTop] = useState(0);
  useEffect(() => {
    if (!asSheet) return;
    const el = ref.current; const room = el?.closest(".sr") as HTMLElement | null;
    setTop(el && room ? Math.max(0, Math.round(el.getBoundingClientRect().top - room.getBoundingClientRect().top)) : 0);
    // r17: focus goes back to the strip's own line when the sheet closes (the element focused before may be gone or be the body). r19: the one
    // dialog contract (focus in, Tab kept inside, the room under it inert, Escape on the window when it is the top dialog)
    const line = el?.querySelector<HTMLElement>(".cp-line") ?? null;
    const box = sheetRef.current; const layer = box?.closest(".cp-sheet-wrap") as HTMLElement | null;
    onSheet?.(() => closeRef.current());
    const off = box ? openDialog(box, () => closeRef.current(), { root: layer, initial: box, opener: line }) : undefined;
    return () => { off?.(); onSheet?.(null); };
  }, [asSheet]); // eslint-disable-line react-hooks/exhaustive-deps
  const heading = standsHeading(p.scope, p.ready ? p.stands?.ago : null);
  // r18: folded, the line is the sentence cut on a whole word (never "underway ac…"); open, it is the dated heading. r19: when anything needs
  // the user, the folded line says what is waiting first ("Needs you · 2: Say go on the deploy…"), never only a dot behind a chevron
  const folded = p.note ?? (p.ready ? waitingLine(p.feed) ?? (p.stands ? withoutRawIds(p.stands.text) : null) ?? "Where this stands" : p.load?.error ? "Couldn't load" : p.load?.slow ? "Still loading" : "Loading…");
  const lineRef = useRef<HTMLParagraphElement | null>(null);
  const lineTokens = [...(p.scope ? [{ node: <b className="cp-scope">{`${p.scope}:`}</b>, space: false }] : []), ...wordTokens(folded).map((w, i) => (i === 0 && p.scope ? { ...w, space: true } : w))];
  const label = <span className="cp-line-text" title={p.stands?.text}>{open ? heading
    : <WordClamp elRef={lineRef} className="cp-line-words" tokens={lineTokens} textKey={`${p.scope ?? ""}\n${folded}`} lines={1} open={false} onCut={() => {}} onClick={() => {}} tag="span" />}</span>;
  // the strip sits in a room below 900px, which shows the list's health above it (r14)
  return <>
    <section ref={ref} className={`cp strip ${open ? "open" : ""} ${asSheet ? "as-sheet" : ""}`} aria-label="Where this stands" data-place={!open ? "folded" : asSheet ? "sheet" : place ? "inline" : undefined}>
      <button type="button" className="cp-line" aria-expanded={open} onClick={() => (open ? close() : onToggle(true))}>
        {label}
        {p.feed.total > 0 && <i className="cp-dot" role="img" aria-label="Needs you" title="Needs you" />}
        <span className="cp-chev" aria-hidden="true">{open ? "⌃" : "⌄"}</span>
      </button>
      {open && !asSheet && place?.mode === "inline" && <div className="cp-strip-body cp-fit" style={{ maxHeight: `${place.body}px` }}>
        <Body {...p} fit hideHealth keepOne onMore={() => setSheet(true)} />
      </div>}
    </section>
    {asSheet && <div className="cp-sheet-wrap">
      <button type="button" className="cp-sheet-scrim" aria-label="Close" tabIndex={-1} onClick={close} />
      <div ref={sheetRef} className="cp cp-sheet" role="dialog" aria-modal="true" aria-label={p.scope ? `Where ${p.scope} stands` : "Where this stands"} tabIndex={-1}
        style={{ maxHeight: `calc(100% - ${top}px)` }}>
        <div className="cp-sheet-head"><span>{heading}</span><button type="button" className="cp-sheet-close" onClick={close}>Close</button></div>
        {/* one sheet at a time: an item opened from here (or a way deeper) replaces this sheet */}
        <Body {...p} fit={false} hideHealth onTask={(t) => { close(); p.onTask(t); }} onPrivate={p.onPrivate && ((o) => { close(); p.onPrivate!(o); })} onEverything={p.onEverything && (() => { close(); p.onEverything!(); })} />
      </div>
    </div>}
  </>;
}
