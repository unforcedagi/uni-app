import { useId, useState, type ReactNode } from "react";

// T-335: every card in a room is short. Waiting for you: one row (what, where/how long, the answer buttons) with its facts behind a
// small "Show all" toggle, closed. Once answered, expired or gone: one quiet line ("✓ Approved · … · 12:04") that opens to the facts.
// The answered line is a disclosure only: nothing in it answers anything, so a tap on a collapsed card can never approve.
// T-335 cards expand (11-11): "I can't see the full text, theres no option to expand". A waiting card opens on a tap on its line or on
// "Show all" to its whole text (never cut off) and its facts, and closes again on "Show less"; an answered line opens the same way.

/**
 * The waiting row. `actions` are the card's own buttons, untouched; `below` is what must stay in sight (a warning, a form, a decision's
 * options), or a function of whether the details are open, for what shows only then or when it holds something.
 */
export function PendingCard({ className, label, icon, what, meta, actions, below, details }: {
  className: string; label: string; icon: string; what: ReactNode; meta: ReactNode; actions?: ReactNode; below?: ReactNode | ((open: boolean) => ReactNode); details: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <section className={`cc cc-pending ${className}${open ? " cc-open" : ""}`} aria-label={label}>
    <div className="cc-row">
      <span className="cc-icon" aria-hidden="true">{icon}</span>
      <span className="cc-text">
        {/* (a tap on the line opens it too; the button is the one control a keyboard and a screen reader use) */}
        <span className="cc-what" onClick={() => setOpen((o) => !o)}>{what}</span>
        <span className="cc-meta">{meta}<button type="button" className="cc-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>{open ? "Show less" : "Show all"}</button></span>
      </span>
      {actions && <div className="cc-actions">{actions}</div>}
    </div>
    {typeof below === "function" ? below(open) : below}
    <div id={id} className="cc-details" hidden={!open}>{open && details}</div>
  </section>;
}

/** The answered (or expired, or gone) line: closed by default, it opens to the card's facts. `after` stays in sight under it. */
export function DoneCard({ className, label, mark, status, what, when, details, after }: {
  className: string; label: string; mark: string; status: string; what: ReactNode; when?: string | null; details: ReactNode; after?: ReactNode;
}) {
  return <section className={`cc cc-done ${className}`} aria-label={label}>
    <details>
      <summary><span className="cc-mark" aria-hidden="true">{mark}</span><span className="cc-status" role="status">{status}</span>
        <span className="cc-sep" aria-hidden="true"> · </span><span className="cc-what">{what}</span>{when && <><span className="cc-sep" aria-hidden="true"> · </span><time className="cc-when">{when}</time></>}</summary>
      <div className="cc-details">{details}</div>
    </details>
    {after}
  </section>;
}

/** A card with nothing to answer and nothing more to show (checking, refused, can't be verified): one line. */
export function QuietCard({ className, label, icon, title, status, warn, after }: { className: string; label: string; icon: string; title: string; status: string; warn: boolean; after?: ReactNode }) {
  return <section className={`cc cc-quiet ${className}`} aria-label={label}>
    <p className="cc-row"><span className="cc-icon" aria-hidden="true">{icon}</span><strong className="cc-title">{title}</strong>
      <span className={`cc-status secret-status ${warn ? "warn" : ""}`} role="status">{status}</span></p>
    {after}
  </section>;
}

/** "12:04", as the cards say a time. One formatter, made once (T-335: one per call was slow in a long room). */
const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
export const clockTime = (ts: number): string => clockFormat.format(new Date(ts * 1000));
