// T-161: Hermes approval prompts in Needs you: the room, the exact command and why it was flagged, the answers it takes and when it ends.
// A row opens the room at the prompt with the composer focused (r30's one answer mechanism: the user answers in the chat, nothing is sent
// for them); it leaves the list when Hermes answers it (approved, denied, timed out) or its own window ends.
import { answersLine, endsLine, type Approval } from "../approvals";
import { elsewhereText, waitingElsewhere } from "../approvalsElsewhere";
import { useApprovalList } from "../approvalsLive";
import { jobFingerprint } from "../sealedCardCore";

const clock = (ts: number) => new Date(ts * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export function ApprovalRows({ approvals, className = "cp-list cp-approvals" }: { approvals: readonly Approval[]; className?: string }) {
  const { open, roomName } = useApprovalList();
  if (!approvals.length) return null;
  return <ul className={className} aria-label="Waiting on your OK">{approvals.map((a) => {
    const room = roomName(a.channel);
    const where = room ? `#${room.replace(/^#/, "")}` : "a room";
    // T-234: Uni's approval card, answered on the card itself (the row opens it)
    if (a.kind === "sealed" && a.sealed) {
      const w = a.sealed;
      const lead = w.kind === "morning" ? "Uni's morning card" : "Uni asks to use a credential";
      const how = `Answer on the card · ${endsLine(a, clock)}`;
      return <li key={a.ref} className="cp-approval cp-sealed" data-ref={a.ref} data-channel={a.channel}>
        <button type="button" className="cp-need cp-approval-open" aria-label={`${lead} in ${where}: ${a.command}${w.kind === "single" ? `, ${w.class}` : ""}. ${how}`} onClick={() => open(a)}>
          <i aria-hidden="true">🔑</i>
          <span className="cp-approval-text">
            <span className="cp-approval-lead">{lead} in <b>{where}</b></span>
            <code className="cp-approval-cmd">{a.command}</code>
            {w.kind === "single" && <small className={`cp-approval-why sealed-class-${w.class}`}>{w.class === "powerful" ? "Powerful: hold to approve" : "Routine"} · job {jobFingerprint(w.fingerprint)}</small>}
            <small className="cp-approval-how">{how}</small>
          </span>
        </button>
      </li>;
    }
    const how = `Reply ${answersLine(a)} · ${endsLine(a, clock)}`;
    return <li key={a.ref} className="cp-approval" data-ref={a.ref} data-channel={a.channel}>
      <button type="button" className="cp-need cp-approval-open" aria-label={`Uni needs your OK in ${where} to run ${a.command}. ${a.why ? `Flagged: ${a.why}. ` : ""}${how}`} onClick={() => open(a)}>
        <i aria-hidden="true">!</i>
        <span className="cp-approval-text">
          <span className="cp-approval-lead">{a.kind === "smart-deny" ? "Override needs your OK" : "Needs your OK"} in <b>{where}</b></span>
          <code className="cp-approval-cmd">{a.command}</code>
          {a.why && <small className="cp-approval-why">{a.why}</small>}
          <small className="cp-approval-how">{how}</small>
        </span>
      </button>
    </li>;
  })}</ul>;
}

export { ApprovalBanner } from "../shape/ApprovalBanner";

/**
 * T-335: at the top of the room you are in, one line for every approval waiting in another room ("Approval waiting in #kiln"). A tap
 * opens that room at the card (the soonest to end); the line goes when nothing waits elsewhere (answered, timed out or expired).
 */
export function ApprovalElsewhere({ approvals, here }: { approvals: readonly Approval[]; here: string | null }) {
  const { open, roomName } = useApprovalList();
  const e = waitingElsewhere(approvals, here);
  if (!e) return null;
  const text = elsewhereText(e, roomName);
  const ends = e.first.deadline === null ? "" : ` · first ${endsLine(e.first, clock)}`;
  return <button type="button" className="approval-elsewhere" data-ref={e.first.ref} data-channel={e.first.channel} aria-label={`${text}${ends}. Show it`} onClick={() => open(e.first)}>
    <i aria-hidden="true">{e.first.kind === "sealed" ? "🔑" : "!"}</i>
    <span className="approval-elsewhere-text"><b>{text}</b>{ends && <small>{ends}</small>}</span>
    <span className="approval-elsewhere-go" aria-hidden="true">Show ›</span>
  </button>;
}
