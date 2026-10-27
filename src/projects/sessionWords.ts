// T-304: a session, zoomed in. Pure words and parsing for the session view (SessionView.tsx): why it ended, in a sentence; what it left,
// as links where they are links; the exact ask of one that needs you, and the words that answer it in the room; and the steps mts keeps
// on a note beside the run note while it works, read back as a calm list. redactRaw() is the app's one redactor, the second net behind
// mts's: workFrom (live.ts) runs every run-note field through it as the note is read, and parseFeed every steps-note line; everything
// here after that works on text already redacted.
import { ago, type EndWhy, type Session } from "./model.ts";

/** What stands in for a hidden secret. */
export const HIDDEN = "[hidden]";
/** One rule of the redactor: a pattern; `guard: "not-lower"`: a hit followed by a lowercase letter is a word, not a key (secretary,
 *  tokenizer, passwordless); `mix`: a run counts only with a letter and a digit in it. */
export type RedactRule = { name: string; re: string; flags: string; guard: "not-lower" | null; mix: boolean };
/**
 * T-304 (fail closed): everything from the first secret-like key (password, secret, token, authorization, bearer, api_key, …) or key
 * shape (sk-, ghp_, xox, AKIA, a JWT, a key block, long hex or base64 runs, credentials in a URL) to the END of the text is hidden, the
 * key's own name with it. No parsing of quotes or values: over-hiding is fine, leaking any part of a secret is not. The same rules as
 * mts's (which hides them before they leave the machine; this is the second net); both test suites run the same cases
 * (scripts/fixtures/redaction-vectors.json).
 */
export const REDACT_RULES: readonly RedactRule[] = [
  {"name": "secret-word", "re": "(?:passw(?:or)?d|passphrase|passcode|secret|token|credential|authorization|bearer|api[_-]?key|access[_-]?key|private[ _-]?key)s?", "flags": "i", "guard": "not-lower", "mix": false},
  {"name": "short-key", "re": "(?<![A-Za-z])(?:pass|pwd|pw|cookie|auth)s?(?=\\s*[\"']?\\s*[:=])", "flags": "i", "guard": null, "mix": false},
  {"name": "key-block", "re": "-----BEGIN", "flags": "", "guard": null, "mix": false},
  {"name": "key-prefix", "re": "sk-(?:ant|proj|live|test|svcacct|admin)-|gh[pousr]_[A-Za-z0-9]{6,}|github_pat_|xox[abprse]-|nsec1[02-9ac-hj-np-z]{6,}|eyJ[A-Za-z0-9_-]{10,}|AIza[0-9A-Za-z_-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{12,}", "flags": "", "guard": null, "mix": false},
  {"name": "sk-key", "re": "(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{6,}", "flags": "", "guard": null, "mix": false},
  {"name": "sk-run", "re": "sk-[A-Za-z0-9_-]{20,}", "flags": "", "guard": null, "mix": true},
  {"name": "url-credentials", "re": "://[^/\\s:@]+:[^/\\s@]+@", "flags": "", "guard": null, "mix": false},
  {"name": "hex-run", "re": "[0-9a-fA-F]{32,}", "flags": "", "guard": null, "mix": false},
  {"name": "base64-run", "re": "[A-Za-z0-9+/=]{32,}", "flags": "", "guard": null, "mix": true},
];
/** Lookalike letters (Cyrillic, Greek, a few Latin variants) read as the Latin ones they look like, for matching only. */
const FOLD_FROM = "\u0430\u0435\u043e\u0440\u0441\u0443\u0445\u0455\u0456\u0458\u0501\u051b\u051d\u04bb\u04cf\u043a\u043c\u0442\u0432\u043d\u0410\u0412\u0415\u041a\u041c\u041d\u041e\u0420\u0421\u0422\u0425\u0423\u0405\u0406\u0408\u03b1\u03bf\u03c1\u03c4\u03c5\u03bd\u03ba\u03b9\u03b5\u0391\u0392\u0395\u0396\u0397\u0399\u039a\u039c\u039d\u039f\u03a1\u03a4\u03a5\u03a7\u0131\u0237\u0251\u0261";
const FOLD_TO = "aeopcyxsijdqwhlkmtbhABEKMHOPCTXYSIJaoptuvkieABEZHIKMNOPTYXijag";
export const FOLD: Readonly<Record<string, string>> = Object.fromEntries([...FOLD_FROM].map((c, i) => [c, FOLD_TO[i]]));
const RULES = REDACT_RULES.map((r) => ({ rx: new RegExp(r.re, `${r.flags}g`), r }));
const KEY_CHAR = /[A-Za-z0-9_-]/;
const DROP = /^[\p{Mn}\p{Cf}]$/u;

/** The text as the rules read it: each character NFKD-decomposed (fullwidth to plain), marks and invisible format characters
 *  (zero-width space, soft hyphen) dropped, lookalike letters folded; and, for each character of that, where its original starts. */
function folded(text: string): { norm: string; at: number[] } {
  let norm = "";
  const at: number[] = [];
  let i = 0;
  for (const ch of text) {
    for (const d of ch.normalize("NFKD")) {
      if (DROP.test(d)) continue;
      const f = FOLD[d] ?? d;
      norm += f;
      for (let k = 0; k < f.length; k++) at.push(i);
    }
    i += ch.length;
  }
  return { norm, at };
}

/** THE one redactor (T-304): every piece of a run note or a steps note goes through it, raw, as it is read (workFrom, parseFeed),
 *  before anything else is done to it. The text up to the first secret-like key or key shape (and the rest of the word it starts in),
 *  then [hidden]; everything after is gone, across lines. */
export function redactRaw(text: string): string {
  const { norm, at } = folded(text);
  let first: number | null = null;
  for (const { rx, r } of RULES) {
    rx.lastIndex = 0;
    for (const m of norm.matchAll(rx)) {
      const start = m.index!, end = start + m[0].length;
      if (first !== null && start >= first) break;
      if (r.guard === "not-lower" && end < norm.length && norm[end] >= "a" && norm[end] <= "z") continue;
      if (r.mix && !(/[A-Za-z]/.test(m[0]) && /[0-9]/.test(m[0]))) continue;
      first = start;
      break;
    }
  }
  if (first === null) return text;
  while (first > 0 && KEY_CHAR.test(norm[first - 1])) first--;
  return text.slice(0, at[first]) + HIDDEN;
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
    const text = redactRaw(m[3]).trim();     // raw first: the line's words exactly as the note holds them
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
  const note = s.end?.note ?? null;
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
  if (s.end?.needs) return s.end.needs;
  if (s.end?.why === "unverified") return "It says it finished, but nothing it left could be checked. Look over its work and say whether it counts as done.";
  if (s.end?.did) return s.end.did;
  return "It ended needing you, but its note doesn't say what.";
}

/** Whether a session ended needing you (and so shows its ask and a way to answer it). */
export const needsYou = (s: Session) => s.state === "waiting";

/** What it left, one item a line: a link where the line holds one (https only), the line's words otherwise. Bullets and backticks go. */
export function leftItems(left: string | null | undefined): { text: string; url: string | null }[] {
  const out: { text: string; url: string | null }[] = [];
  for (const raw of (left ?? "").split(/\n|;\s+/)) {
    const line = (raw.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").replace(/`/g, "").trim());
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
  return `About the session on “${s.ask}” (${project}), which asks: “${short}” — `;
}
