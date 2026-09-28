// Hermes posts a plain-text approval prompt on Buzz (the connector has no
// button cards). We recognise that prompt and offer one-tap answers that send
// the same `/approve …` / `/deny` reply the text asks for.

export type ApprovalChoice = { label: string; reply: string; tone: "go" | "stop" };
export type ApprovalPrompt = { command: string; reason: string; choices: ApprovalChoice[] };

const HEADERS = ["Hermes wants to run a command that needs your OK", "Smart DENY — owner override"];

export function parseApproval(body: string): ApprovalPrompt | null {
  if (!HEADERS.some((h) => body.includes(h))) return null;
  // Command prefix is "/" on Buzz; tolerate any single-char prefix.
  const once = body.match(/`(.)approve`/);
  if (!once || !/`.deny`/.test(body)) return null;
  const p = once[1];
  const command = body.match(/```\n?([\s\S]*?)\n?```/)?.[1]?.trim() ?? "";
  const reason = body.match(/\n(?:Why it was flagged|Reason)\s*:\s*(.+)/)?.[1]?.trim() ?? "";
  const choices: ApprovalChoice[] = [{ label: "Approve once", reply: `${p}approve`, tone: "go" }];
  if (body.includes(`\`${p}approve session\``)) choices.push({ label: "This session", reply: `${p}approve session`, tone: "go" });
  if (body.includes(`\`${p}approve always\``)) choices.push({ label: "Always", reply: `${p}approve always`, tone: "go" });
  choices.push({ label: "Deny", reply: `${p}deny`, tone: "stop" });
  return { command, reason, choices };
}

/** An approval is answered once any later message (from anyone) follows it in
 *  the same conversation lane, or its window has passed. */
export function approvalOpen(ts: number, later: { ts: number }[], nowSec: number, windowSec = 1800): boolean {
  return nowSec - ts < windowSec && !later.some((m) => m.ts > ts);
}
