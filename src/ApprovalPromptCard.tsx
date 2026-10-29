import { answersLine, commandLine, endsLine, type Approval, type ApprovalOutcome } from "./approvals";
import { clockTime, DoneCard, PendingCard, QuietCard } from "./CompactCard";

// T-335: a Hermes approval prompt in its room, drawn short. Waiting: one row with the command and how to answer; it is still answered by
// typing /approve or /deny in the composer (r30: one answer mechanism, no approval buttons in chat). Ended: one line saying how. A state
// the store hasn't told yet (checking, unchecked) or one too old for its read (past) says only that, never "waiting" or an outcome.

const ENDED: Record<ApprovalOutcome["outcome"], [string, string]> = {
  approved: ["✓", "Approved"], denied: ["✕", "Denied"], "timed-out": ["⌛", "Timed out"], expired: ["⌛", "Expired"], gone: ["–", "No longer waiting"],
};

export type PromptState = "waiting" | "checking" | "unchecked" | "past" | ApprovalOutcome;

export function ApprovalPromptCard({ a, state }: { a: Approval; state: PromptState }) {
  const cmd = commandLine(a);
  const lead = a.kind === "smart-deny" ? "Override needs your OK" : "Hermes needs your OK";
  const label = `${lead}: ${cmd}`;
  const details = <>
    <pre className="cc-pre">{a.command}</pre>
    {a.why && <p className="approvals-note">Why it was flagged: {a.why}</p>}
    <p className="approvals-note">Reply {answersLine(a)} in this room · {endsLine(a, clockTime)}</p>
  </>;
  if (state === "checking" || state === "unchecked") return <QuietCard className="approval-card" label={label} icon="⚠️" title={cmd}
    status={state === "checking" ? "Checking whether it still waits…" : "Couldn't check whether it still waits"} warn={state === "unchecked"} />;
  if (state === "past") return <DoneCard className="approval-card" label={label} mark="–" status="No longer waiting" what={<code className="cc-cmd">{cmd}</code>}
    details={<>{details}<p className="approvals-note">The app can't read how it ended.</p></>} />;
  if (state !== "waiting") {
    const [mark, status] = ENDED[state.outcome];
    return <DoneCard className="approval-card" label={label} mark={mark} status={status} what={<code className="cc-cmd">{cmd}</code>}
      when={clockTime(state.at)} details={details} />;
  }
  return <PendingCard className="approval-card" label={label} icon="⚠️" what={<code className="cc-cmd">{cmd}</code>}
    meta={<>{lead} · reply {answersLine(a)} · {endsLine(a, clockTime)} · </>} details={details} />;
}
