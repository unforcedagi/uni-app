// T-304: a session, zoomed in. Pure words and parsing for the session view (SessionView.tsx): why it ended, in a sentence; what it left,
// as links where they are links; the exact ask of one that needs you, and the words that answer it in the room; and the steps mts keeps
// on a note beside the run note while it works, read back as a calm list. redactRaw() is the app's one redactor, the second net behind
// mts's: workFrom (live.ts) runs every run-note field through it as the note is read, and parseFeed every steps-note line; everything
// here after that works on text already redacted.
import { ago, type EndWhy, type Session } from "./model.ts";

/** What stands in for a hidden secret. */
export const HIDDEN = "[hidden]";
/** One rule of the redactor: a pattern; `mix`: a run counts only with a letter and a digit in it. */
export type RedactRule = { name: string; re: string; flags: string; mix: boolean };
/**
 * T-304 (fail closed): everything from the first secret-like key (password, secret, token, authorization, bearer, api_key, …) or key
 * shape (sk-, ghp_, xox, AKIA, a JWT, a key block, long hex or base64 runs, credentials in a URL) to the END of the text is hidden, the
 * key's own name with it. No parsing of quotes or values: over-hiding is fine, leaking any part of a secret is not. The same rules as
 * mts's (which hides them before they leave the machine; this is the second net); both test suites run the same cases
 * (scripts/fixtures/redaction-vectors.json).
 */
export const REDACT_RULES: readonly RedactRule[] = [
  {"name": "secret-word", "re": "pass(?:word|wd|phrase|code)|secret|token|api[ _-]?key|access[ _-]?key|bearer|credential|private|authori[sz]ation", "flags": "i", "mix": false},
  {"name": "short-key", "re": "(?<![A-Za-z])(?:pass|pwd|pw|cookie|auth)s?(?=\\s*[\"']?\\s*[:=])", "flags": "i", "mix": false},
  {"name": "key-block", "re": "-----BEGIN", "flags": "", "mix": false},
  {"name": "key-prefix", "re": "sk-(?:ant|proj|live|test|svcacct|admin)-|gh[pousr]_[A-Za-z0-9]{6,}|github_pat_|xox[abprse]-|nsec1[02-9ac-hj-np-z]{6,}|eyJ[A-Za-z0-9_-]{10,}|AIza[0-9A-Za-z_-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{12,}", "flags": "", "mix": false},
  {"name": "sk-key", "re": "(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{6,}", "flags": "", "mix": false},
  {"name": "sk-mixed", "re": "sk-[A-Za-z0-9_-]{6,}", "flags": "", "mix": true},
  {"name": "url-credentials", "re": "://[^/\\s:@]+:[^/\\s@]+@", "flags": "", "mix": false},
  {"name": "hex-run", "re": "[0-9a-fA-F]{32,}", "flags": "", "mix": false},
  {"name": "base64-run", "re": "[A-Za-z0-9+/=]{32,}", "flags": "", "mix": true},
];
/** Every dash (Unicode category Pd, and these) reads as "-": a key written with nonbreaking hyphens is still the key. */
export const DASHES = "\u2212\u2043";
const DASH = /^\p{Pd}$/u;
/** Lookalike letters (Cyrillic, Greek, a few Latin variants) read as the Latin ones they look like, for matching only. */
const FOLD_FROM = "\u0430\u0435\u043e\u0440\u0441\u0443\u0445\u0455\u0456\u0458\u0501\u051b\u051d\u04bb\u04cf\u043a\u043c\u0442\u0432\u043d\u0410\u0412\u0415\u041a\u041c\u041d\u041e\u0420\u0421\u0422\u0425\u0423\u0405\u0406\u0408\u03b1\u03bf\u03c1\u03c4\u03c5\u03bd\u03ba\u03b9\u03b5\u0391\u0392\u0395\u0396\u0397\u0399\u039a\u039c\u039d\u039f\u03a1\u03a4\u03a5\u03a7\u0131\u0237\u0251\u0261";
const FOLD_TO = "aeopcyxsijdqwhlkmtbhABEKMHOPCTXYSIJaoptuvkieABEZHIKMNOPTYXijag";
export const FOLD: Readonly<Record<string, string>> = Object.fromEntries([...FOLD_FROM].map((c, i) => [c, FOLD_TO[i]]));
const RULES = REDACT_RULES.map((r) => ({ rx: new RegExp(r.re, `${r.flags}g`), r }));
const KEY_CHAR = /[A-Za-z0-9_-]/;
const DROP = /^[\p{Mn}\p{Cf}]$/u;

/** The text as the rules read it: each character NFKD-decomposed (fullwidth to plain), marks and invisible format characters
 *  (zero-width space, soft hyphen) dropped, lookalike letters folded, dashes read as -; and, for each character of that, where its original starts. */
function folded(text: string): { norm: string; at: number[] } {
  let norm = "";
  const at: number[] = [];
  let i = 0;
  for (const ch of text) {
    for (const d of ch.normalize("NFKD")) {
      if (DROP.test(d)) continue;
      const f = DASH.test(d) || DASHES.includes(d) ? "-" : FOLD[d] ?? d;
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
      const start = m.index!;
      if (first !== null && start >= first) break;
      if (r.mix && !(/[A-Za-z]/.test(m[0]) && /[0-9]/.test(m[0]))) continue;
      first = start;
      break;
    }
  }
  if (first === null) return text;
  while (first > 0 && KEY_CHAR.test(norm[first - 1])) first--;
  return text.slice(0, at[first]) + HIDDEN;
}

/** T-304 (allowlist): a step line is a fixed phrase for the tool's kind, with a label only when the label is known plain. The same
 *  phrases and limits as mts's (which writes the lines; this is the second net). */
export type Phrase = { tools: string[]; bare: string; with: string | null };
export const PHRASES: readonly Phrase[] = [
  {"tools": ["Bash"], "bare": "Running a command", "with": "Running {}"},
  {"tools": ["Edit", "MultiEdit", "NotebookEdit"], "bare": "Editing a file", "with": "Editing {}"},
  {"tools": ["Write"], "bare": "Writing a file", "with": "Writing {}"},
  {"tools": ["Read"], "bare": "Reading a file", "with": "Reading {}"},
  {"tools": ["Grep", "Glob"], "bare": "Searching the code", "with": null},
  {"tools": ["WebSearch"], "bare": "Searching the web", "with": null},
  {"tools": ["WebFetch"], "bare": "Reading a web page", "with": null},
  {"tools": ["Task", "Agent"], "bare": "Handing off a part of the work", "with": null},
  {"tools": ["TodoWrite"], "bare": "Updating its to-do list", "with": null},
  {"tools": ["Skill"], "bare": "Using a skill", "with": "Using the {} skill"},
];
export const LABEL = {"chars": "[A-Za-z0-9/._-]", "max_len": 64, "split": "[/._-]", "max_token": 32, "max_mixed": 12, "entropy_from": 12, "entropy_max": 3.5, "max_case_turns": 3};
const LABEL_RE = new RegExp(`^${LABEL.chars}{1,${LABEL.max_len}}$`);
const LABEL_SPLIT = new RegExp(LABEL.split);

/** Whether a label (a file's name, a program's, a skill's) is known plain: LABEL's (ASCII) characters only; each token (split on
 *  / . _ -) short, short again when it mixes letters and digits, low in entropy when long, not churning case; and nothing the redactor
 *  would hide. */
export function labelOk(label: string): boolean {
  if (!LABEL_RE.test(label)) return false;
  for (const t of label.split(LABEL_SPLIT).filter(Boolean)) {
    if (t.length > LABEL.max_token) return false;
    if (/[A-Za-z]/.test(t) && /[0-9]/.test(t) && t.length > LABEL.max_mixed) return false;
    if (t.length >= LABEL.entropy_from) {
      const counts = new Map<string, number>();
      for (const c of t) counts.set(c, (counts.get(c) ?? 0) + 1);
      let h = 0;
      for (const n of counts.values()) h -= (n / t.length) * Math.log2(n / t.length);
      if (h >= LABEL.entropy_max) return false;
    }
    if ((t.match(/[a-z][A-Z]/g) ?? []).length > LABEL.max_case_turns) return false;
  }
  return redactRaw(label) === label;
}

/** A step line as it may be shown: a phrase as written (its label passing labelOk), the phrase alone when the label doesn't, or
 *  "A step" for anything that isn't a phrase. */
export function safeStep(text: string): string {
  if (PHRASES.some((p) => p.bare === text)) return text;
  for (const p of PHRASES) {
    if (!p.with) continue;
    const [pre, post] = p.with.split("{}");
    if (text.startsWith(pre) && text.endsWith(post) && text.length > pre.length + post.length)
      return labelOk(text.slice(pre.length, text.length - post.length)) ? text : p.bare;
  }
  return "A step";
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
    // raw first: the line's words exactly as the note holds them; a step is then shown only as a phrase with a plain label
    const said = redactRaw(m[3]).trim();
    const text = m[2] === "step" ? safeStep(said) : said;
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
