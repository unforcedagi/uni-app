// T-335 chat feel: the pieces of a room's turn with Uni that the room view draws. The status line (in Uni's row, where the reply will
// start: plain words and a seconds counter; only it re-renders as the clock ticks), a message's quiet action row, the phone's long-press
// sheet, and the quick replies under a question. The words come from chatFeel.ts; the room (App.tsx) owns what each action does.
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { shortElapsed, statusWords, type TurnPhase } from "./chatFeel";
import { openDialog } from "./areas/focusTrap";

const ENSO = "M29.5 8.8C24.6 5.2 14.8 5 9.3 11.6 4.6 17.3 5.6 27.4 12.6 32.2c7.2 4.9 17.4 2.9 21.2-4.3 3.3-6.3 1.6-13.4-3.1-17.4";

/** The ensō, drawn once (1.6 s) as the line appears; on a calm screen a still ring instead (CSS). */
export const Enso = () => <span className="uni-status-mark" aria-hidden="true">
  <svg className="enso" viewBox="0 0 40 40" width="18" height="18"><path pathLength={100} d={ENSO} /></svg>
  <span className="uni-status-ring" />
</span>;

/** What Uni is doing, in plain words, with a seconds counter. Past 20 s, a quiet line says you can leave. The counter is hidden from
 *  screen readers (the chat is a live region): they hear the words when they change. */
export function StatusLine({ phase, since, ping, place }: { phase: TurnPhase; since: number; ping: string | null; place: string }) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    setNow(Date.now() / 1000);
    const t = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, [since]);
  const words = statusWords(phase, since, now, ping);
  return <div className="uni-status" data-status-line="" data-phase={phase} role="status">
    <p className="uni-status-row"><Enso /><span className="uni-status-words">{words}</span><span className="uni-status-clock" aria-hidden="true"> · <time>{shortElapsed(now - since)}</time></span></p>
    {now - since > 20 && <p className="uni-status-leave">You can leave; I'll put a dot on {place} when it's ready.</p>}
  </div>;
}

export type Action = { id: string; label: string; icon: ReactNode; run: () => void; aria?: string; pressed?: boolean };

const ic = (d: ReactNode) => <svg className="act-icon" viewBox="0 0 24 24" aria-hidden="true">{d}</svg>;
export const ICONS = {
  copy: ic(<><rect x="8.5" y="8.5" width="11" height="11" rx="2.2" /><path d="M15.5 8.5V6.2a1.7 1.7 0 0 0-1.7-1.7H6.2a1.7 1.7 0 0 0-1.7 1.7v7.6a1.7 1.7 0 0 0 1.7 1.7h2.3" /></>),
  retry: ic(<><path d="M4.8 12a7.2 7.2 0 1 0 2.1-5.1" /><path d="M4.6 4.4v3.9h3.9" /></>),
  reply: ic(<><path d="M9.5 7.5 5 12l4.5 4.5" /><path d="M5.5 12H14a5 5 0 0 1 5 5v1.5" /></>),
  save: ic(<path d="M7 3.8h10a1 1 0 0 1 1 1V20l-6-3.7L6 20V4.8a1 1 0 0 1 1-1z" />),
  edit: ic(<path d="M15.5 5.5l3 3L9 18H6v-3z" />),
  select: ic(<path d="M5 6h14M5 12h9M5 18h12" />),
  del: ic(<><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" /></>),
  up: <span className="act-emoji" aria-hidden="true">👍</span>,
};

/** What builds a message's row: the room's handlers, read through a ref so the memoised rows never hold stale ones. */
export type RowMaker<M> = { current: (m: M) => { actions: Action[]; tail?: ReactNode } };
/**
 * A message's row, memoised: a live event or a key in a long room redraws none of them. It is drawn again only when what it shows changes:
 * the message itself (its reactions), whether it is the latest reply (always shown, with Try again), or whether it can be edited now.
 */
export const MessageActions = memo(function MessageActions<M>({ m, make, always }: { m: M; make: RowMaker<M>; always: boolean; retry: boolean; editable: boolean }) {
  const { actions, tail } = make.current(m);
  // what a button does is looked up when it is pressed, from the handlers of that moment (a row that wasn't redrawn holds no old ones)
  const live = actions.map((a) => ({ ...a, run: () => make.current(m).actions.find((x) => x.id === a.id)?.run() }));
  return <ActionRow actions={live} always={always}>{tail}</ActionRow>;
}) as <M>(p: { m: M; make: RowMaker<M>; always: boolean; retry: boolean; editable: boolean }) => ReactNode;

/** A message's quiet row of actions. The latest reply's is always shown; an older message's on hover or focus (CSS). */
export function ActionRow({ actions, always, children }: { actions: Action[]; always: boolean; children?: ReactNode }) {
  return <div className={`msg-actions${always ? " always" : ""}`} role="group" aria-label="Message actions">
    {actions.map((a) => <button key={a.id} type="button" className={`act act-${a.id}`} aria-label={a.aria ?? a.label} title={a.aria ?? a.label} aria-pressed={a.pressed} onClick={a.run}>
      {a.icon}<span className="act-label">{a.label}</span></button>)}
    {children}
  </div>;
}

export const SHEET_REACTIONS = ["👍", "❤️", "✓", "❓"];

/** The phone's long-press sheet: a reaction strip and 44 px rows. A modal dialog (the app's one contract: focus in, Tab kept inside, what is
 *  under it inert, focus back after); Back, Escape or a tap outside closes it. */
export function MessageSheet({ preview, reactions, mine, rows, onReact, onClose }: { preview: string; reactions: boolean; mine: string[]; rows: Action[];
  onReact: (emoji: string) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null), layer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!box.current) return;
    return openDialog(box.current, onClose, { root: layer.current, initial: box.current.querySelector<HTMLButtonElement>("button") });
  }, [onClose]);
  return <div className="msg-sheet-layer" ref={layer}>
    <div className="msg-sheet-scrim" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
    <div className="msg-sheet" role="dialog" aria-modal="true" aria-label="Message actions" ref={box}>
      <div className="msg-sheet-grab" aria-hidden="true" />
      <p className="msg-sheet-preview">{preview}</p>
      {reactions && <div className="msg-sheet-react" role="group" aria-label="React">
        {SHEET_REACTIONS.map((e) => <button key={e} type="button" aria-label={`React ${e}`} aria-pressed={mine.includes(e)} onClick={() => { onClose(); onReact(e); }}>{e}</button>)}
      </div>}
      <div className="msg-sheet-rows">
        {rows.map((r) => <button key={r.id} type="button" className={r.id === "delete" ? "danger" : undefined} aria-label={r.aria ?? r.label} onClick={() => { onClose(); r.run(); }}>{r.icon}<span>{r.label}</span></button>)}
      </div>
    </div>
  </div>;
}

/** The plain answers a question offers, as chips; a tap sends one as your reply. */
export function QuickReplies({ answers, onPick }: { answers: string[]; onPick: (answer: string) => void }) {
  return <div className="quick-replies" role="group" aria-label="Quick replies">
    {answers.map((a) => <button key={a} type="button" onClick={() => onPick(a)}>{a}</button>)}
  </div>;
}

/**
 * A long press on a message (touch only) opens its sheet: 500 ms held, moving less than 10 px. Attached once to the message list, so
 * the memoised rows don't change for it. A mouse's right-click stays the browser's own.
 */
export function useLongPress(list: HTMLElement | null, onPress: (ref: string) => void) {
  const press = useRef(onPress);
  press.current = onPress;
  useEffect(() => {
    if (!list) return;
    let timer = 0, x = 0, y = 0, top = 0, fired = false;
    const cancel = () => { window.clearTimeout(timer); timer = 0; };
    const down = (e: PointerEvent) => {
      if (e.pointerType !== "touch" || !(e.target instanceof Element)) return;
      if (e.target.closest("button, a, summary, input, textarea, .msg-actions")) return;
      const art = e.target.closest<HTMLElement>("article.message[data-ref]");
      if (!art || art.classList.contains("outgoing")) return;
      x = e.clientX; y = e.clientY; top = list.scrollTop; fired = false;
      cancel();
      timer = window.setTimeout(() => { timer = 0; fired = true; press.current(art.dataset.ref!); }, 500);
    };
    const move = (e: PointerEvent) => { if (timer && Math.hypot(e.clientX - x, e.clientY - y) > 10) cancel(); };
    const up = () => cancel();
    // a scroll the finger made ends the press; layout settling under a still finger doesn't
    const scrolled = () => { if (timer && Math.abs(list.scrollTop - top) > 10) cancel(); };
    // the press that opened the sheet doesn't also select text or open the system menu
    const menu = (e: Event) => { if (fired || timer) { e.preventDefault(); } };
    list.addEventListener("pointerdown", down, { passive: true });
    list.addEventListener("pointermove", move, { passive: true });
    for (const t of ["pointerup", "pointercancel"] as const) list.addEventListener(t, up, { passive: true });
    list.addEventListener("scroll", scrolled, { passive: true });
    list.addEventListener("contextmenu", menu);
    return () => {
      cancel();
      list.removeEventListener("pointerdown", down); list.removeEventListener("pointermove", move);
      for (const t of ["pointerup", "pointercancel"] as const) list.removeEventListener(t, up);
      list.removeEventListener("scroll", scrolled);
      list.removeEventListener("contextmenu", menu);
    };
  }, [list]);
}

/** A scroll that eases over `ms` (the one easing, cubic-bezier(.22,.8,.2,1)); a jump when calm. Cancelled by the next call. */
let glide = 0;
let under: { from: number; target: number } | null = null;
export function easeScroll(el: HTMLElement, top: number, ms: number, calm: boolean) {
  const target = Math.max(0, Math.min(top, el.scrollHeight - el.clientHeight));
  stopGlide();
  if (calm || ms <= 0) { el.scrollTop = target; return; }
  const run = under = { from: el.scrollTop, target }, t0 = performance.now();
  const ease = bezier(0.22, 0.8, 0.2, 1);
  const step = (now: number) => {
    const p = Math.min(1, (now - t0) / ms);
    el.scrollTop = run.from + (run.target - run.from) * ease(p);
    if (p < 1) glide = requestAnimationFrame(step); else under = null;
  };
  glide = requestAnimationFrame(step);
}
export function stopGlide() { cancelAnimationFrame(glide); under = null; }
/** Content above the glide's target moved by `d` px: the glide moves with it, so it still lands where it meant to. */
export function shiftGlide(d: number) { if (under) { under.from += d; under.target += d; } }

function bezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t, sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => { let t = x; for (let i = 0; i < 6; i++) { const d = dx(t); if (Math.abs(d) < 1e-6) break; t -= (sx(t) - x) / d; } return sy(Math.min(1, Math.max(0, t))); };
}
