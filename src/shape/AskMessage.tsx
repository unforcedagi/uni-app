// T-335 the shape: an ask as a message with buttons. `compact`: home's "wants you" block under a room's row (◆, the line, its buttons inline);
// otherwise in the room's chat, a message from Uni with the buttons under it. The buttons come from asksCore.askButtons, by the ask's kind
// (T-335 fixes: do -> Done, Not now; choose -> its options, Not now; look -> Open, Seen; tell -> Seen). Its line opens the ask's sheet
// (AskSheet: its whole context, the same buttons and Archive). It reads by shape and word, never colour alone: a filled ◆ and "wants you".
import { useEffect, useId, useRef, type ReactNode } from "react";
import { askButtons, seenHint, type AskButton } from "./asksCore.ts";
import type { Ask } from "./types.ts";
import { clockTime } from "../CompactCard";
import { RepostButton, useCardLinks } from "../cardLinks";
import { repostable, repostBody, staleLine, type CardState } from "../sealedCardCore";
import { useAskCard } from "./useAskCard";
import "./asks.css";

export type AskMessageProps = {
  ask: Ask;
  busy: boolean;
  error: string | null | undefined;
  /** A button was pressed (the host answers, marks it seen, puts it off, hands it back, archives it or opens its link). */
  onAct: (ask: Ask, b: AskButton) => void;
  /** Open the ask's sheet: its whole context. */
  onOpen: (ask: Ask) => void;
  compact?: boolean;
};

/** The ask's buttons, in a row. `archive`: Archive last (the sheet). */
export function AskButtons({ ask, busy, onAct, archive = false }: { ask: Ask; busy: boolean; onAct: (ask: Ask, b: AskButton) => void; archive?: boolean }) {
  return <div className="sh-ask-acts" role="group" aria-label="Answer">
    {askButtons(ask, { archive }).map((b) => <button key={`${b.act}:${b.value}`} type="button" className="sh-ask-btn" data-primary={b.primary || undefined} data-act={b.act}
      // (opening the link never waits on a write)
      disabled={busy && b.act !== "open"} onClick={() => onAct(ask, b)}
      title={b.act === "seen" ? `Seen: ${seenHint(ask.kind)}` : b.act === "notnow" ? "Not now: it stays with its room until it needs you" : b.act === "done" ? "Done: you did it; it goes back to its room" : b.act === "archive" ? "Archive: out of your view; its room is told" : undefined}
      aria-label={b.act === "seen" ? `Seen: ${ask.what} (${seenHint(ask.kind)})` : b.act === "open" ? `Open the link for ${ask.what}` : undefined}>
      {b.label}{b.act === "open" && <span aria-hidden="true"> ↗</span>}</button>)}
  </div>;
}

/**
 * T-335 cards expand: an ask that tells him to tap a card (`sealed_card`) says where that card stands: waiting (and until when), or no longer
 * waiting (expired, answered, ended at the broker, refused, or not on this device), with a way to ask the room for a fresh one. `children`:
 * drawn under a waiting card's line (the sheet puts the card itself there, so it can be answered in place).
 */
export function CardLine({ ask, state, children }: { ask: Ask; state: CardState | null; children?: (s: Extract<CardState, { state: "waiting" }>) => ReactNode }) {
  const links = useCardLinks();
  if (!state || state.state === "checking") return null;
  const other = state.state === "waiting" && state.channel !== ask.room ? links?.roomName(state.channel) ?? null : null;
  const where = state.state === "waiting" && state.channel !== ask.room ? (other ? `#${other}` : "another room") : "its room";
  if (state.state === "waiting") return <div className="sh-ask-card" data-card-state="waiting">
    <p className="sh-ask-card-line"><span aria-hidden="true">🔑</span> Its card waits in {where} · answer by {clockTime(state.expires)}</p>
    {children?.(state)}
  </div>;
  const line = staleLine(state, clockTime) ?? "";
  // (not found here may only mean not synced yet, or posted elsewhere: said plainly, with no repost)
  if (!repostable(state)) return <div className="sh-ask-card" data-card-state={state.state} role="note">
    <p className="sh-ask-card-line"><span aria-hidden="true">🔑</span> {line}.</p>
  </div>;
  const channel = "channel" in state ? state.channel : ask.room;
  return <div className="sh-ask-card sh-ask-card-stale" data-card-state={state.state} role="note">
    <p className="sh-ask-card-line"><span aria-hidden="true">⌛</span> {line}. Nothing to tap.</p>
    {channel && <RepostButton channel={channel} cardRef={"ref" in state ? state.ref : ask.sealedCard ?? ask.id}
      body={repostBody({ tid: ask.tid, what: ask.what, fp: null, why: line.replace(/^Its card /, "it ") })} />}
  </div>;
}

/**
 * An ask's words in a room (T-335 copy): text, not a button's label, so a long press selects them. A tap opens the sheet; a mouse's click
 * waits out a double-click (which selects a word) and the click that ends a drag-selection opens nothing. The chevron is the button a
 * keyboard and a screen reader use.
 */
function AskBody({ ask, onOpen }: { ask: Ask; onOpen: (ask: Ask) => void }) {
  const id = useId(), mouse = useRef(false), wait = useRef(0);
  useEffect(() => () => window.clearTimeout(wait.current), []);
  const body = useRef<HTMLDivElement>(null);
  // words selected in this ask (a selection elsewhere doesn't stop a tap here)
  const picked = () => { const sel = window.getSelection(); return !!sel && !sel.isCollapsed && !!body.current && sel.containsNode(body.current, true); };
  return <div className="sh-ask-body" ref={body} onPointerDown={(e) => { mouse.current = e.pointerType === "mouse"; }} onClick={(e) => {
    window.clearTimeout(wait.current);
    if (e.detail > 1 || picked()) return;
    if (!mouse.current) { onOpen(ask); return; }
    wait.current = window.setTimeout(() => { if (!picked()) onOpen(ask); }, 260);
  }}>
    <span className="sh-ask-what"><span id={id}>{ask.what}</span><button type="button" className="sh-ask-open sh-ask-chev" aria-label="Open this ask" aria-describedby={id}
      onClick={(e) => { e.stopPropagation(); onOpen(ask); }}> ›</button></span>
    {(ask.next || ask.why) && <span className="sh-ask-why">{ask.next ?? ask.why}</span>}
  </div>;
}

export function AskMessage({ ask, busy, error, onAct, onOpen, compact = false }: AskMessageProps) {
  const buttons = <AskButtons ask={ask} busy={busy} onAct={onAct} />;
  const err = error ? <p className="sh-ask-error" role="alert">{error}</p> : null;
  const card = useAskCard(ask);
  const cardLine = ask.sealedCard ? <CardLine ask={ask} state={card} /> : null;
  if (compact) return <div className="sh-ask sh-ask-wants" data-id={ask.id} data-kind={ask.kind} aria-busy={busy || undefined}>
    <button type="button" className="sh-ask-line sh-ask-open" onClick={(e) => { e.stopPropagation(); onOpen(ask); }} aria-label={`Wants you: ${ask.what}. Open it`}>
      <span className="sh-ask-mark" aria-hidden="true">◆</span><span className="sh-ask-what">{ask.what}</span><span className="sh-ask-chev" aria-hidden="true">›</span>
    </button>
    {cardLine}{buttons}{err}
  </div>;
  return <article className="sh-ask sh-ask-msg" data-id={ask.id} data-kind={ask.kind} aria-busy={busy || undefined} aria-label={`Uni asks: ${ask.what}`}>
    <div className="sh-ask-meta"><b>Uni</b><span className="sh-ask-mark" aria-hidden="true">◆</span> wants you{ask.tid ? <span className="sh-ask-tid"> · {ask.tid}</span> : null}</div>
    <AskBody ask={ask} onOpen={onOpen} />
    {cardLine}{buttons}{err}
  </article>;
}
