// T-161: Hermes approval prompts in Needs you: the room, the exact command and why it was flagged, the answers it takes and when it ends.
// A row opens the room at the prompt with the composer focused (r30's one answer mechanism: the user answers in the chat, nothing is sent
// for them); it leaves the list when Hermes answers it (approved, denied, timed out) or its own window ends.
import { answersLine, commandLine, endsLine, type Approval } from "../approvals";
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
      <button type="button" className="cp-need cp-approval-open" aria-label={`Hermes needs your OK in ${where} to run ${a.command}. ${a.why ? `Flagged: ${a.why}. ` : ""}${how}`} onClick={() => open(a)}>
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

/** Over a room's composer while a prompt there waits: what it asks, and a way back to the prompt in the chat. */
export function ApprovalBanner({ approvals, onShow }: { approvals: readonly Approval[]; onShow: (a: Approval) => void }) {
  if (!approvals.length) return null;
  const a = approvals[0];
  const more = approvals.length > 1 ? ` · ${approvals.length - 1} more waiting` : "";
  if (a.kind === "sealed") return <div className="approval-banner" role="status" data-ref={a.ref}>
    <span className="approval-banner-text"><b>Uni asks for your tap</b>: <code>{commandLine(a)}</code>. Answer on its card · {endsLine(a, clock)}{more}</span>
    <button type="button" className="approval-banner-show" onClick={() => onShow(a)}>Show</button>
  </div>;
  return <div className="approval-banner" role="status" data-ref={a.ref}>
    <span className="approval-banner-text"><b>Hermes needs your OK</b> to run <code>{commandLine(a)}</code>. Reply {answersLine(a)} below · {endsLine(a, clock)}{approvals.length > 1 ? ` · ${approvals.length - 1} more waiting` : ""}</span>
    <button type="button" className="approval-banner-show" onClick={() => onShow(a)}>Show</button>
  </div>;
}
