// T-335 the shape: an ask as a message with buttons. `compact`: home's "wants you" block under a room's row (◆, the line, its buttons inline);
// otherwise in the room's chat, a message from Uni with the buttons under it. The buttons come from asksCore.askButtons, by the ask's kind
// (T-335 fixes: do -> Done, Not now; choose -> its options, Not now; look -> Open, Seen; tell -> Seen). Its line opens the ask's sheet
// (AskSheet: its whole context, the same buttons and Archive). It reads by shape and word, never colour alone: a filled ◆ and "wants you".
import { askButtons, seenHint, type AskButton } from "./asksCore.ts";
import type { Ask } from "./types.ts";
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

export function AskMessage({ ask, busy, error, onAct, onOpen, compact = false }: AskMessageProps) {
  const buttons = <AskButtons ask={ask} busy={busy} onAct={onAct} />;
  const err = error ? <p className="sh-ask-error" role="alert">{error}</p> : null;
  if (compact) return <div className="sh-ask sh-ask-wants" data-id={ask.id} data-kind={ask.kind} aria-busy={busy || undefined}>
    <button type="button" className="sh-ask-line sh-ask-open" onClick={(e) => { e.stopPropagation(); onOpen(ask); }} aria-label={`Wants you: ${ask.what}. Open it`}>
      <span className="sh-ask-mark" aria-hidden="true">◆</span><span className="sh-ask-what">{ask.what}</span><span className="sh-ask-chev" aria-hidden="true">›</span>
    </button>
    {buttons}{err}
  </div>;
  return <article className="sh-ask sh-ask-msg" data-id={ask.id} data-kind={ask.kind} aria-busy={busy || undefined} aria-label={`Uni asks: ${ask.what}`}>
    <div className="sh-ask-meta"><b>Uni</b><span className="sh-ask-mark" aria-hidden="true">◆</span> wants you{ask.tid ? <span className="sh-ask-tid"> · {ask.tid}</span> : null}</div>
    <button type="button" className="sh-ask-body sh-ask-open" onClick={() => onOpen(ask)} aria-label={`${ask.what}. Open it`}>
      <p className="sh-ask-what">{ask.what}<span className="sh-ask-chev" aria-hidden="true"> ›</span></p>
      {(ask.next || ask.why) && <p className="sh-ask-why">{ask.next ?? ask.why}</p>}
    </button>
    {buttons}{err}
  </article>;
}
