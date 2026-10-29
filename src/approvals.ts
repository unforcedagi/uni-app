// T-161: a Hermes approval prompt waiting in a room (pure; unit-tested in scripts/approvals.test.ts).
// The gateway posts the prompt as plain text (gateway/run.py `_format_exec_approval_fallback`) and every outcome as a new message from the
// same author (locales/en.yaml `gateway.approve.*` / `gateway.deny.*`, `APPROVAL_TIMED_OUT_NOTICE`); the prompt itself is never edited. There
// is no structured tag, so a prompt is read from its exact shape: the header line, the fenced command and the `/approve` … `/deny` line.
// It is pending until an outcome from its author answers it, or until the window it states itself ("within 30 minutes") has passed.

/** The slice of a stored message the reading needs (get_messages' and approval_messages' rows both have it). */
export type ApprovalSource = { ref: string; channel: string; author: string; ts: number; body: string; root?: string | null };

export type Approval = {
  /** the prompt's message */
  ref: string; channel: string; author: string; ts: number; root: string | null;
  /** what Hermes wants to run, as the prompt shows it (the gateway cuts it at 200 characters) */
  command: string;
  /** "Why it was flagged" */
  why: string;
  /** the answers the prompt offers, as typed: "/approve", "/approve session", "/approve always", "/deny" */
  answers: string[];
  /** when it stops waiting (unix seconds): the prompt's time plus the window it states; null when it states none */
  deadline: number | null;
  /** "smart-deny": the owner-override prompt (run once or deny only); "sealed": Uni's approval card (T-234), answered on the card */
  kind: "command" | "smart-deny" | "sealed";
  /** T-234: the waiting card, when `kind` is "sealed" */
  sealed?: import("./sealedCardCore").SealedWaiting;
};

const HEADERS: Record<string, Approval["kind"]> = {
  "**Hermes wants to run a command that needs your OK**": "command",
  "**Smart DENY — owner override for one operation:**": "smart-deny",
};
/** "⚠️ **…**" with or without the emoji's variation selector */
const headerOf = (line: string): Approval["kind"] | null => HEADERS[line.trim().replace(/^⚠️?\s*/, "")] ?? null;
/** seconds a prompt is still matched to outcomes after its window (the timeout notice can land a second late) */
const GRACE = 60;
/** a timeout notice is posted when the window is up: at most this many seconds early (whole-second times), never more */
const EARLY = 2;
const UNIT: Record<string, number> = { second: 1, minute: 60, hour: 3600, day: 86400 };

/** The prompt a message is, or null. Only the gateway's exact shape counts: a message that only mentions `/approve` is not one. */
export function parseApproval(m: ApprovalSource): Approval | null {
  const lines = m.body.replace(/\r\n/g, "\n").split("\n");
  const kind = headerOf(lines[0] ?? "");
  if (!kind || lines[1] !== "```") return null;
  const close = lines.indexOf("```", 2);
  if (close < 0) return null;
  const command = lines.slice(2, close).join("\n");
  let i = close + 1;
  const whyLines: string[] = [];
  if (lines[i]?.startsWith("Why it was flagged: ")) {
    whyLines.push(lines[i].slice("Why it was flagged: ".length));
    for (i++; i < lines.length && lines[i] !== ""; i++) whyLines.push(lines[i].trim());
  }
  while (lines[i] === "") i++;
  const reply = lines[i] ?? "";
  // "Reply `/approve` to run it once, `/approve session` to …, or `/deny` to cancel."
  if (!/^Reply `[^`\s]*approve` to run it once, (.*, )?or `[^`\s]*deny` to cancel\.$/.test(reply)) return null;
  const answers = [...reply.matchAll(/`([^`]+)`/g)].map((x) => x[1]);
  const rest = lines.slice(i + 1).filter((l) => l.trim() !== "");
  // the last line states the window: "If you don't answer within 30 minutes it will NOT run."
  let deadline: number | null = null;
  if (rest.length > 1) return null;
  if (rest.length === 1) {
    const w = /^If you don(?:'|’)t answer within (\d+) (second|minute|hour|day)s? it will NOT run\.$/.exec(rest[0]);
    if (!w) return null;
    deadline = m.ts + Number(w[1]) * UNIT[w[2]];
  }
  return { ref: m.ref, channel: m.channel, author: m.author, ts: m.ts, root: m.root ?? null, command, why: whyLines.join(" ").trim(), answers, deadline, kind };
}

/** What an outcome message from the prompt's author settles: the oldest `n` prompts waiting, or all of them; null when it settles nothing. */
export function parseOutcome(body: string): { n: number } | "all" | null {
  const b = body.trim();
  const many = /\((\d+) commands\)/.exec(b);
  const n = many ? Number(many[1]) : 1;
  if (/^✅ Commands? approved\b.*The agent is resuming/.test(b)) return { n };
  if (b.startsWith("❌ Command denied (approval was stale).")) return "all";
  if (/^❌ Commands? denied\b/.test(b)) return { n };
  if (b.startsWith("⌛ Approval timed out after ")) return { n: 1 };
  // nothing was waiting after all: whatever this room showed as waiting is not
  if (/^⚠️? Approval expired \(agent is no longer waiting\)/.test(b) || b.startsWith("⌛ Approval expired") || b.startsWith("⌛ That prompt is no longer waiting")
    || b === "No pending command to approve." || b === "No pending command to deny.") return "all";
  return null;
}

/**
 * The prompts still waiting at `now`, oldest first, read from stored messages (any rooms, any order). Per room and author, in time order: a
 * prompt waits; an outcome from that author settles the oldest one waiting in its own thread. One at the top of the room settles one in a
 * thread when none waits at the top (Hermes keys one session per room here, and answers where it was answered); one inside a thread never
 * settles a prompt outside it. A timeout notice settles only a prompt whose window is up. A prompt whose stated window has passed is gone.
 * `me`: the user's own messages are never prompts or outcomes. Within one second a prompt comes before an outcome (an outcome follows a prompt).
 */
export function pendingApprovals(messages: readonly ApprovalSource[], now: number, me: string | null = null): Approval[] {
  return readApprovals(messages, now, me).pending;
}

/** T-335: how a prompt ended, for its one line in the room. "gone": the gateway said nothing was waiting after all. */
export type ApprovalOutcome = { outcome: "approved" | "denied" | "timed-out" | "expired" | "gone"; at: number };

const outcomeOf = (body: string): ApprovalOutcome["outcome"] => {
  const b = body.trim();
  return b.startsWith("✅") ? "approved" : b.startsWith("❌") ? "denied" : b.startsWith("⌛ Approval timed out after ") ? "timed-out" : "gone";
};

/**
 * T-335: the prompts in `messages` that are no longer waiting at `now`, and how each ended, by the same reading as `pendingApprovals`
 * (an outcome settles the oldest one waiting; a prompt whose own window has passed with no answer has expired). A prompt still waiting,
 * or one whose answer isn't among `messages`, is not in the map.
 */
export function approvalOutcomes(messages: readonly ApprovalSource[], now: number, me: string | null = null): Map<string, ApprovalOutcome> {
  return readApprovals(messages, now, me).ended;
}

/** Both at once, from one reading: the prompts waiting at `now` (`pendingApprovals`) and how the others ended (`approvalOutcomes`). */
export function readApprovals(messages: readonly ApprovalSource[], now: number, me: string | null = null): { pending: Approval[]; ended: Map<string, ApprovalOutcome> } {
  const { waiting, settled } = walk(messages, me);
  const pending: Approval[] = [];
  for (const a of [...waiting.values()].flat()) {
    if (a.deadline === null || a.deadline > now) pending.push(a);
    else settled.set(a.ref, { outcome: "expired", at: a.deadline });
  }
  return { pending: pending.sort((a, b) => a.ts - b.ts), ended: settled };
}

function walk(messages: readonly ApprovalSource[], me: string | null): { waiting: Map<string, Approval[]>; settled: Map<string, ApprovalOutcome> } {
  const settledAt = new Map<string, ApprovalOutcome>();
  const isPrompt = new Map(messages.map((m) => [m.ref, parseApproval(m) ? 0 : 1]));
  const sorted = [...messages].sort((a, b) => a.ts - b.ts || isPrompt.get(a.ref)! - isPrompt.get(b.ref)! || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  const waiting = new Map<string, Approval[]>();
  const seen = new Set<string>();
  for (const m of sorted) {
    if (seen.has(m.ref) || (me && m.author === me)) continue;
    seen.add(m.ref);
    const key = `${m.channel}\n${m.author}`;
    // a prompt is kept a little past its window: the gateway's own timeout notice comes at the deadline, and settles that prompt, not the next
    const list = (waiting.get(key) ?? []).filter((a) => {
      const keep = a.deadline === null || a.deadline + GRACE > m.ts;
      if (!keep) settledAt.set(a.ref, { outcome: "expired", at: a.deadline! });
      return keep;
    });
    const prompt = parseApproval(m);
    if (prompt) list.push(prompt);
    else {
      const out = parseOutcome(m.body);
      if (out) {
        const root = m.root ?? null;
        const inThread = root !== null || list.some((a) => a.root === null) ? list.filter((a) => a.root === root) : list;
        // a timeout settles one whose window is up (or that stated none), never one still open; an answer, one still open
        const due = (a: Approval) => a.deadline === null || a.deadline <= m.ts + EARLY;
        const timedOut = m.body.trim().startsWith("⌛ Approval timed out after ");
        const fits = inThread.filter((a) => (timedOut ? due(a) : a.deadline === null || a.deadline > m.ts));
        const here = fits.length || timedOut ? fits : inThread;
        const settled = new Set(out === "all" ? here : here.slice(0, out.n));
        for (let i = list.length - 1; i >= 0; i--) if (settled.has(list[i])) { settledAt.set(list[i].ref, { outcome: outcomeOf(m.body), at: m.ts }); list.splice(i, 1); }
      }
    }
    waiting.set(key, list);
  }
  return { waiting, settled: settledAt };
}

/** "/approve or /deny", "/approve, /approve session or /deny": the answers a prompt takes, for the row. */
export function answersLine(a: Pick<Approval, "answers">): string {
  const xs = a.answers.length ? a.answers : ["/approve", "/deny"];
  return xs.length === 1 ? xs[0] : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`;
}

/** "ends 2:45 PM" (the time the prompt stops waiting, local); "no end time stated" when it gave none. */
export function endsLine(a: Pick<Approval, "deadline">, clock: (ts: number) => string): string {
  return a.deadline === null ? "no end time stated" : `ends ${clock(a.deadline)}`;
}

/** The command on one line, for a row's title and a notification (the whole command is in the room). */
export const commandLine = (a: Pick<Approval, "command">): string => a.command.replace(/\s+/g, " ").trim();
