// T-335 chat feel: the pure parts of a room's turn with Uni (tested in scripts/chatFeel.test.ts). What the status line says while Uni
// works, in plain words, from what the gateway sends (its 👀 and its "⏳ Working — 3 min — iteration 4/90, terminal" pings); the one
// line a finished turn folds into; the commands the room's buttons send (Stop is "/stop", Try again is "/retry", both the gateway's own);
// the plain answers a question offers as chips; and where a room opened on unread should land.
import { isWorkerStatus } from "./chatMarkers.ts";
import type { Reaction } from "./reactions.ts";

type Msg = { ref: string; author: string; ts: number; body: string; reactions: Reaction[] };

/** The gateway's own commands, as the room's buttons send them. */
export const STOP = "/stop", RETRY = "/retry";
/** What Continue sends after a stop. */
export const CONTINUE = "Continue where you left off.";
/** A message that is one of the buttons' commands, not words to show as a bubble. */
export const commandOf = (body: string): "stop" | "retry" | null => {
  const t = body.trim().toLowerCase();
  return t === STOP ? "stop" : t === RETRY ? "retry" : null;
};
/** The gateway's answer to a stop ("⚡ Stopped. You can continue this session."): folded into the room's own Stopped row. */
export const isStopReply = (body: string): boolean => /^\s*⚡\s*Stopped\b/.test(body);

// Tools the gateway names in its pings, said as a person would. Present tense for the live line, past for the folded receipt.
const TOOLS: [RegExp, string, string][] = [
  [/^(terminal|shell|bash|process)$/, "Running a command", "ran a command"],
  [/^(execute_code|code_execution|python)$/, "Running code", "ran code"],
  [/^(read_file|file_read|read)$/, "Reading files", "read files"],
  [/^(write_file|patch|file_write|edit_file|apply_patch)$/, "Writing changes", "made changes"],
  [/^(search_files|grep|find_files|list_files)$/, "Looking through files", "looked through files"],
  [/^(web_search|search_web|search)$/, "Searching the web", "searched the web"],
  [/^(web_extract|web_fetch|fetch|browser_\w+|browse)$/, "Reading a web page", "read a web page"],
  [/^(delegate_task|delegate|spawn_agent)$/, "Handing part of it to a helper", "asked a helper"],
  [/^(vision_analyze|image_analyze)$/, "Looking at an image", "looked at an image"],
  [/^(image_generate|generate_image)$/, "Making an image", "made an image"],
  [/^(text_to_speech|tts)$/, "Recording audio", "recorded audio"],
  [/^(memory|memory_\w+)$/, "Checking its memory", "checked its memory"],
  [/^(session_search|history_search)$/, "Looking through past conversations", "looked through past talks"],
  [/^(skill_view|skills_list|skill_\w+)$/, "Looking up how to do it", "looked up how"],
  [/^(todo|todo_\w+|plan)$/, "Planning the steps", "planned the steps"],
  [/^(send_message|message)$/, "Writing a message", "wrote a message"],
  [/^(cronjob|schedule\w*)$/, "Scheduling", "scheduled it"],
  [/^(clarify|ask_user)$/, "Waiting on you", "asked you"],
  [/^mcp_.*(query|search|find|read|get|list)/, "Reading notes", "read notes"],
  [/^mcp_.*(create|update|write|patch|delete|merge|rename)/, "Changing notes", "changed notes"],
  [/^mcp_/, "Using a connected tool", "used a connected tool"],
];

/** A ping's detail ("iteration 4/90, terminal"): the action it names, if any (never the iteration count). */
export function pingAction(body: string): string | null {
  const m = /^\s*⏳\s*Working\s*[—–-]\s*\d+\s*(?:min|mins|minutes|m|s|sec|secs|h)\b\s*(?:[—–-]\s*(.*))?$/i.exec(body.trim());
  if (!m || !m[1]) return null;
  const parts = m[1].split(",").map((p) => p.trim()).filter((p) => p && !/^iteration\b/i.test(p) && !/^\d+\s*\/\s*\d+$/.test(p));
  return parts[0] ?? null;
}

/** The action as words: [now, past]. A tool the table doesn't know, or a free-text note, is "Working on it": never a raw name. */
export function actionWords(action: string | null): [string, string] | null {
  if (!action) return null;
  const a = action.trim().toLowerCase();
  if (/^[a-z][a-z0-9_.-]*$/.test(a)) {
    for (const [re, now, past] of TOOLS) if (re.test(a)) return [now, past];
    return ["Working on it", "worked on it"];
  }
  if (/model|response|thinking|reason/.test(a)) return ["Thinking it through", "thought it through"];
  return ["Working on it", "worked on it"];
}

/** "4s", "59s", "3m 05s", "1h 02m". */
export function shortElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(r).padStart(2, "0")}s`;
}

export type TurnPhase = "sending" | "waiting" | "working";
/** What the status line says: the phase's words, and since when (unix seconds) its counter runs. */
export function statusWords(phase: TurnPhase, since: number, nowS: number, ping: string | null): string {
  const verb = actionWords(ping ? pingAction(ping) : null)?.[0];
  if (phase === "working") return verb ?? (nowS - since < 10 ? "Reading your message" : "Thinking it through");
  return nowS - since < 10 ? "Passing it to Uni" : "Waiting for Uni to pick it up";
}

/** The room's newest message when it is a ping (the one the status line reads while the turn is open). */
export function livePing(messages: Msg[]): Msg | null {
  const m = messages[messages.length - 1];
  return m && isWorkerStatus(m.body) ? m : null;
}

/** Your newest message, when nothing from anyone else (a ping aside) has come after it, and it isn't a stop. */
export function openAsk<M extends Msg>(messages: M[], me: string | null): M | null {
  if (!me) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (isWorkerStatus(m.body)) continue;
    if (m.author !== me) return null;
    return commandOf(m.body) === "stop" ? null : m;
  }
  return null;
}

const ON_IT = /^👀️?$/u;
/** When someone other than you first put 👀 on this message (unix seconds), if anyone did. */
export function eyesAt(m: Msg, me: string | null): number | null {
  const ts = m.reactions.filter((r) => ON_IT.test(r.emoji)).flatMap((r) => r.by ?? []).filter((b) => b.pubkey !== me).map((b) => b.ts);
  return ts.length ? Math.min(...ts) : null;
}

export type Receipt = { seconds: number; steps: string[] };
/**
 * The one line a finished turn folds into, for the reply at `i`: how long Uni worked on the ask before it (from its 👀 to the reply) and
 * what it did, from the pings between, in past-tense words, each once. Null when the reply doesn't answer an ask Uni took (no 👀).
 */
export function workReceipt(messages: Msg[], i: number, me: string | null): Receipt | null {
  const reply = messages[i];
  if (!reply || reply.author === me || isWorkerStatus(reply.body)) return null;
  const said: string[] = [];
  let at: number | null = null;
  for (let j = i - 1; j >= 0; j--) {
    const m = messages[j];
    if (isWorkerStatus(m.body)) { const w = actionWords(pingAction(m.body))?.[1]; if (w) said.unshift(w); continue; }
    if (m.author !== me) break;
    const e = eyesAt(m, me);
    if (e !== null) at = at === null ? e : Math.min(at, e);
  }
  if (at === null) return null;
  return { seconds: Math.max(0, reply.ts - at), steps: said.filter((w, k) => said.indexOf(w) === k) };
}

/** "Worked 41s", "Worked 3m 05s · ran a command, read files". */
export const receiptLine = (r: Receipt): string => `Worked ${shortElapsed(r.seconds)}${r.steps.length ? ` · ${r.steps.join(", ")}` : ""}`;

/**
 * The plain answers a question offers, as chips under it: a yes-or-no question ("Shall I ask the neighbours for jars?") gives
 * Yes · No · Not now. Only for the room's newest message, when it is someone else's and ends on such a question; null otherwise.
 */
export function quickReplies(body: string): string[] | null {
  const text = body.trim();
  if (!text.endsWith("?") || text.length > 600 || /```/.test(text)) return null;
  const last = (text.split(/(?<=[.!?])\s+|\n+/).filter(Boolean).pop() ?? "").trim();
  if (!/^(shall|should|can|could|may|do|does|did|will|would|want|is|are|was|were|have|has|ok|okay)\b/i.test(last)) return null;
  // a question that already lists its own choices ("... Monday or Tuesday?") is not a yes or a no
  if (/\bor\b/i.test(last)) return null;
  return ["Yes", "No", "Not now"];
}

/**
 * Where a room opened on `unread` unread messages should land: the index of the first of them (counting only messages from others, the
 * way the store counts them, pings aside), or -1 when there are none or all of them are unread past the loaded window's start.
 */
export function firstUnread(messages: Msg[], unread: number, me: string | null): number {
  if (unread <= 0) return -1;
  let n = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.author === me || isWorkerStatus(m.body)) continue;
    if (++n === unread) return i;
  }
  return -1;
}
