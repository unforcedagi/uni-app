// T-304: a session, zoomed in. Pure words and parsing for the session view (SessionView.tsx): why it ended, in a sentence; what it left,
// as links where they are links; the exact ask of one that needs you, and the words that answer it in the room; and the steps mts keeps
// on a note beside the run note while it works, read back as a calm list. Anything that looks like a key is hidden here too (mts hides it
// before it leaves the machine; this is the second net).
import { ago, type EndWhy, type Session } from "./model.ts";

/** What stands in for a hidden secret. */
export const HIDDEN = "[hidden]";
const SECRETS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bnsec1[02-9ac-hj-np-z]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
  /\b[0-9a-fA-F]{64}\b/g,
];
const BEARER = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi;
/** A password-like key (password, passphrase, pass, passcode, pwd, secret; with prefixes and suffixes like DB_PASS, SECRET_KEY): a quoted
 *  value is hidden to its closing quote, an unquoted one to the end of the line (a passphrase has spaces; over-hiding a step line is fine,
 *  leaking the tail of a passphrase is not). */
const PASSWORD = /\b((?:[A-Za-z0-9]+[_-])*(?:pass(?:word|wd|phrase|code)?|pwd|secret)s?(?:[_-][A-Za-z0-9]+)*)(["']?[ \t]*[:=][ \t]*)("[^"\n]*"|'[^'\n]*'|\S[^\n]*)/gi;
/** `token=…`, `"password": "two words"`, `API_KEY: …`: the name stays, the value goes, quoted values whole (spaces too). */
const NAMED = /\b([A-Z0-9_]*(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|private[_-]?key|credential)s?)(["']?\s*[:=]\s*)("[^"\n]+"|'[^'\n]+'|[^\s,;"']+)/gi;
/** The one exception: a known token counter with a short number (`max_tokens=4096`, `input_tokens: 980`, `token_count=33`). */
const COUNTER = /^(?:(?:(?:max|min|num|total|input|output|prompt|completion|cache_read_input|cache_creation_input)_?)?tokens|(?:max|min|num|total)_?token|tokens?_(?:count|used|limit|budget))$/i;

/** Anything that looks like a key, token or password, as [hidden]. */
export function redact(text: string): string {
  let t = text;
  for (const r of SECRETS) t = t.replace(r, HIDDEN);
  t = t.replace(PASSWORD, (_, name: string, sep: string) => `${name}${sep}${HIDDEN}`);
  return t.replace(BEARER, (_, kind: string) => `${kind} ${HIDDEN}`).replace(NAMED, (all, name: string, sep: string, raw: string) => {
    // a sentence's closing punctuation is not part of an unquoted value
    const [, value, tail] = /^["']/.test(raw) ? [raw, raw, ""] : /^([\s\S]*?)([.:!?)]*)$/.exec(raw)!;
    if (COUNTER.test(name) && /^\d{1,9}$/.test(value)) return all;
    return `${name}${sep}${value ? HIDDEN : ""}${tail}`;
  });
}

/** One line of the session's stream: a step it took, or something it wrote. `at` is null when the line has no time. */
export type FeedItem = { at: number | null; kind: "step" | "said"; text: string };

/** The steps note's lines, `- <time> · <step|said> · <text>`, oldest first. Anything else in the note is left out. */
export function parseFeed(content: string | null | undefined): FeedItem[] {
  const out: FeedItem[] = [];
  for (const line of (content ?? "").split("\n")) {
    const m = /^- (\S+) · (step|said) · (.+)$/.exec(line.trimEnd());
    if (!m) continue;
    const t = Date.parse(m[1]);
    const text = redact(m[3].trim());
    if (text) out.push({ at: Number.isFinite(t) ? t : null, kind: m[2] as FeedItem["kind"], text });
  }
  return out;
}

const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** Why it ended, as a headline and (when there is more to say) a second sentence. Null for a live session. */
export function endWords(s: Session, now: number): { head: string; more: string | null } | null {
  if (s.state === "running") return null;
  if (s.state === "silent") return { head: "Didn't finish: nothing has been heard from it for a while.", more: `Last heard from ${ago(now - (s.endedAt ?? s.startedAt))}. Its worker may have been lost.` };
  const why: EndWhy | null = s.end?.why ?? null;
  const note = s.end?.note ? redact(s.end.note) : null;
  const room = "Didn't finish: it ran out of room";
  switch (why) {
    case "done": return { head: "Finished.", more: null };
    case "unverified": return { head: "Says it finished, but nothing it left could be checked yet.", more: "Look over its work before it counts as done." };
    case "blocked": return { head: "Stopped to ask you something.", more: null };
    case "stopped": return { head: "Didn't finish: it was stopped on purpose.", more: null };
    case "killed": return { head: "Didn't finish: it was cut off before the end.", more: note };
    case "limit": return { head: `${room}: the Claude account reached its session limit.`, more: s.end?.resumesAt ? `It picks up again by itself at ${clock(s.end.resumesAt)}.` : null };
    case "turns": return { head: `${room}: it used every turn it was given.`, more: null };
    case "context": return { head: `${room}: its conversation grew too long to go on.`, more: null };
    case "failed": return { head: "Didn't finish: it failed.", more: note ? `What went wrong: ${note}` : null };
    case "lost": return { head: "Didn't finish: its worker was lost (the machine restarted, or the worker was gone).", more: null };
    case "never_started": return { head: "It never started.", more: note };
  }
  return { head: { finished: "Finished.", stopped: "Didn't finish: it was stopped.", waiting: "Stopped to ask you something.", failed: "Didn't finish.", running: "", silent: "" }[s.state], more: null };
}

/** The exact ask of a session that needs you: what its report says it needs, else what it says of itself, else a plain line. */
export function askOf(s: Session): string {
  if (s.end?.needs) return redact(s.end.needs);
  if (s.end?.why === "unverified") return "It says it finished, but nothing it left could be checked. Look over its work and say whether it counts as done.";
  if (s.end?.did) return redact(s.end.did);
  return "It ended needing you, but its note doesn't say what.";
}

/** Whether a session ended needing you (and so shows its ask and a way to answer it). */
export const needsYou = (s: Session) => s.state === "waiting";

/** What it left, one item a line: a link where the line holds one (https only), the line's words otherwise. Bullets and backticks go. */
export function leftItems(left: string | null | undefined): { text: string; url: string | null }[] {
  const out: { text: string; url: string | null }[] = [];
  for (const raw of redact(left ?? "").split(/\n|;\s+/)) {
    const line = redact(raw.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").replace(/`/g, "").trim());
    if (!line || /^(none|n\/?a|nothing|-)\.?$/i.test(line)) continue;
    const url = /\bhttps:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?]/.exec(line)?.[0] ?? null;
    // a link that carried a secret is not a link any more
    out.push({ text: line, url: url && !url.includes(HIDDEN) ? url : null });
  }
  return out;
}

/** The words put in the room's composer to answer a session that needs you: which session, and what it asked (never sent for you). */
export function answerDraft(s: Session, project: string): string {
  const ask = askOf(s).replace(/\s+/g, " ").trim();
  const short = ask.length > 160 ? `${ask.slice(0, 159).trimEnd()}…` : ask;
  return `About the session on “${redact(s.ask)}” (${project}), which asks: “${short}” — `;
}
