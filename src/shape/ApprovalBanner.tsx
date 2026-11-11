// T-161: over a room's composer while an approval waits there (a Hermes prompt answered in the composer, or Uni's card answered on the card):
// what it asks, and Show, which brings the prompt into view. Moved from src/areas/ApprovalRows.tsx (the old home's Needs you rows).
import { answersLine, commandLine, endsLine, type Approval } from "../approvals";

const clock = (ts: number) => new Date(ts * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

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
    <span className="approval-banner-text"><b>Uni needs your OK</b> to run <code>{commandLine(a)}</code>. Reply {answersLine(a)} below · {endsLine(a, clock)}{approvals.length > 1 ? ` · ${approvals.length - 1} more waiting` : ""}</span>
    <button type="button" className="approval-banner-show" onClick={() => onShow(a)}>Show</button>
  </div>;
}
