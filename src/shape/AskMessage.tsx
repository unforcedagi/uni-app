// T-335 the shape: an ask as a message with buttons. `compact`: home's "wants you" block under a room's row (◆, the line, its buttons inline);
// otherwise in the room's chat, a message from Uni with the buttons under it. The buttons come from asksCore.askButtons (the default filled,
// the rest outlined; Seen on every ask). It reads by shape and word, never colour alone: a filled ◆ and the words "wants you".
import { askButtons, seenHint, type AskButton } from "./asksCore.ts";
import type { Ask } from "./types.ts";
import "./asks.css";

export type AskMessageProps = {
  ask: Ask;
  busy: boolean;
  error: string | null | undefined;
  onAnswer: (ask: Ask, text: string) => void | Promise<void>;
  onSeen: (ask: Ask) => void | Promise<void>;
  /** Open the ask's link (the host decides: an Arcade look opens in the app, a web link outside). */
  onOpenLink: (url: string) => void;
  compact?: boolean;
};

export function AskMessage({ ask, busy, error, onAnswer, onSeen, onOpenLink, compact = false }: AskMessageProps) {
  const press = (b: AskButton) => {
    if (b.act === "open") onOpenLink(b.value);
    else if (b.act === "seen") void onSeen(ask);
    else void onAnswer(ask, b.value);
  };
  const buttons = <div className="sh-ask-acts" role="group" aria-label="Answer">
    {askButtons(ask).map((b) => <button key={`${b.act}:${b.value}`} type="button" className="sh-ask-btn" data-primary={b.primary || undefined} data-act={b.act}
      // (opening the link never waits on a write)
      disabled={busy && b.act !== "open"} onClick={() => press(b)}
      title={b.act === "seen" ? `Seen: ${seenHint(ask.kind)}` : undefined}
      aria-label={b.act === "seen" ? `Seen: ${ask.what} (${seenHint(ask.kind)})` : b.act === "open" ? `Open the link for ${ask.what}` : undefined}>
      {b.label}{b.act === "open" && <span aria-hidden="true"> ↗</span>}</button>)}
  </div>;
  const err = error ? <p className="sh-ask-error" role="alert">{error}</p> : null;
  if (compact) return <div className="sh-ask sh-ask-wants" data-id={ask.id} data-kind={ask.kind} aria-busy={busy || undefined}>
    <p className="sh-ask-line"><span className="sh-ask-mark" aria-hidden="true">◆</span><span className="sh-ask-sr">Wants you: </span><span className="sh-ask-what">{ask.what}</span></p>
    {buttons}{err}
  </div>;
  return <article className="sh-ask sh-ask-msg" data-id={ask.id} data-kind={ask.kind} aria-busy={busy || undefined} aria-label={`Uni asks: ${ask.what}`}>
    <div className="sh-ask-meta"><b>Uni</b><span className="sh-ask-mark" aria-hidden="true">◆</span> wants you{ask.tid ? <span className="sh-ask-tid"> · {ask.tid}</span> : null}</div>
    <div className="sh-ask-body">
      <p className="sh-ask-what">{ask.what}</p>
      {ask.why && <p className="sh-ask-why">{ask.why}</p>}
    </div>
    {buttons}{err}
  </article>;
}
