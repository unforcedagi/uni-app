import { answersLine, commandLine, endsLine, type Approval, type ApprovalOutcome } from "./approvals";
import { clockTime, DoneCard, PendingCard } from "./CompactCard";

// T-335: a Hermes approval prompt in its room, drawn short. Waiting: one row with the command and how to answer; it is still answered by
// typing /approve or /deny in the composer (r30: one answer mechanism, no approval buttons in chat). Ended: one line saying how.

const ENDED: Record<ApprovalOutcome["outcome"], [string, string]> = {
  approved: ["✓", "Approved"], denied: ["✕", "Denied"], "timed-out": ["⌛", "Timed out"], expired: ["⌛", "Expired"], gone: ["–", "No longer waiting"],
};

export function ApprovalPromptCard({ a, ended }: { a: Approval; ended: ApprovalOutcome | undefined }) {
  const cmd = commandLine(a);
  const lead = a.kind === "smart-deny" ? "Override needs your OK" : "Hermes needs your OK";
  const details = <>
    <pre className="cc-pre">{a.command}</pre>
    {a.why && <p className="approvals-note">Why it was flagged: {a.why}</p>}
    <p className="approvals-note">Reply {answersLine(a)} in this room · {endsLine(a, clockTime)}</p>
  </>;
  if (ended) {
    const [mark, status] = ENDED[ended.outcome];
    return <DoneCard className="approval-card" label={`${lead}: ${cmd}`} mark={mark} status={status} what={<code className="cc-cmd">{cmd}</code>}
      when={clockTime(ended.at)} details={details} />;
  }
  return <PendingCard className="approval-card" label={`${lead}: ${cmd}`} icon="⚠️" what={<code className="cc-cmd">{cmd}</code>}
    meta={<>{lead} · reply {answersLine(a)} · {endsLine(a, clockTime)} · </>} details={details} />;
}
