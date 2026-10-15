// Journal helpers (pure, unit-tested). New entries are filed where the server's
// T-60 sweep (~/scripts/t60_journal_sweep.py) would put them: path
// `Journal/YYYY/MM-DD/HH-MM <first words>` in local time, tag `journal`. A voice
// entry still transcribing keeps the time-only `Journal/YYYY/MM-DD/HH-MM`; the
// sweep titles it once the transcript lands.

import { quote } from "./uniActions.ts";
import { noteUrl } from "./vaultlinks.ts";

export type JournalDraft = { entry_id: string; path: string; content: string; source: "text" | "voice"; created_at: string; /** paths to try, in order, when `path` is taken */ alternates: string[] };
export type JournalNote = { id: string; path: string; created_at: string; content: string; source: string | null; entry_id: string | null; tags: string[]; pending: boolean };
export type QueuedEntry = { entry_id: string; path: string; content: string; source: string; created_at: string; has_audio: boolean; note_id: string | null; attempts: number; last_error: string | null };
export type FlushReport = { sent: string[]; remaining: number; error: string | null; /** the entry was already queued ("waiting") or sent in the last 10 minutes ("saved"); nothing new was queued */ duplicate?: { kind: "waiting" | "saved"; id: string } | null };

export const TRANSCRIPT_PENDING = "_Transcript pending._";
const pad = (n: number) => String(n).padStart(2, "0");

// The sweep's `first_words`, ported rule for rule (T-60): the placeholders, front matter, images, link and wikilink targets, bare URLs,
// list/heading/quote markers, ** and __, and the characters a path can't hold go; then up to `n` words while the title stays within `limit`
// characters; then the edge punctuation goes.
const PENDING = ["_Transcript pending._", "*(Transcribing...)*", "_Transcript pending (part"];
const STRIP = /[\\/\[\]#|:*?"<>^{}`~]/g;
export function firstWords(content: string | null | undefined, n = 7, limit = 60): string {
  let text = content ?? "";
  for (const p of PENDING) text = text.split(p).join(" ");
  text = text.replace(/^---\n[\s\S]*?\n---\n/, "");
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2");
  text = text.replace(/https?:\/\/\S+/g, " ");
  text = text.replace(/(^|\n)\s*([#>*\-]+|\d+\.)\s+/g, "$1");
  text = text.split("**").join("").split("__").join("").replace(STRIP, " ");
  let title = "";
  for (const w of text.split(/\s+/).filter(Boolean).slice(0, n)) {
    const next = `${title} ${w}`.trim();
    if ([...next].length > limit) break;
    title = next;
  }
  return title.replace(/^[ .,;\-—–']+|[ .,;\-—–']+$/g, "");
}

const isPending = (content: string) => PENDING.some((p) => content.includes(p));

/**
 * Where an entry made at `d` (local time) goes, and where it goes instead when that path is taken, by the sweep's clash rule: the minute's
 * seconds (`HH-MM-SS`), then more first words (12, 20, 40 within 200 characters). Never `-1`. A voice entry with no words yet is time-only.
 */
export function entryPaths(d: Date, content: string, source: "text" | "voice"): { path: string; alternates: string[] } {
  const folder = `Journal/${d.getFullYear()}/${pad(d.getMonth() + 1)}-${pad(d.getDate())}/`;
  const hm = `${pad(d.getHours())}-${pad(d.getMinutes())}`;
  const hms = `${hm}-${pad(d.getSeconds())}`;
  const title = firstWords(content);
  if (!title && isPending(content)) return { path: folder + hm, alternates: [folder + hms] };
  const name = title || (source === "voice" ? "Voice memo" : "Entry");
  const path = `${folder}${hm} ${name}`;
  const out = [`${folder}${hms} ${name}`];
  // (the sweep means to keep the folder and the stamp here; its regex drops them, see REPORT-NIGHT-0146)
  for (const k of [12, 20, 40]) {
    const more = firstWords(content, k, 200);
    if (more) out.push(`${folder}${hms} ${more}`);
  }
  const seen = new Set([path.toLowerCase()]);
  return { path, alternates: out.filter((p) => !seen.has(p.toLowerCase()) && !!seen.add(p.toLowerCase())) };
}

/** The old shape (<= 0.1.45): `Notes/YYYY/MM-DD/HH-MM-SS`, tag `capture`. Entries still queued on a device with it send as they are; the sweep files them. */
export function legacyEntryPath(d: Date): string {
  return `Notes/${d.getFullYear()}/${pad(d.getMonth() + 1)}-${pad(d.getDate())}/${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

export function newDraft(content: string, source: "text" | "voice", d = new Date(), id = crypto.randomUUID()): JournalDraft {
  const body = source === "voice" ? (content.trim() ? `${content.trim()}\n\n${TRANSCRIPT_PENDING}` : TRANSCRIPT_PENDING) : content;
  return { entry_id: id, ...entryPaths(d, body, source), content, source, created_at: d.toISOString() };
}

/** Content without the transcription placeholder, trimmed. */
export function entryText(content: string): string {
  return content.replace(TRANSCRIPT_PENDING, "").trim();
}

/** Recorder format this WebView supports; Android Chrome records webm/opus. */
export function pickAudioMime(supported: (t: string) => boolean): string {
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]) if (supported(t)) return t;
  return "";
}

const MAX_SHARE = 1500;

/**
 * The message that passes an entry to a room: the entry's canonical Parachute
 * URL, not its text. The vault stays the gate: anyone who can read the vault
 * (Uni, or Aaron in the app) opens it with a tap; anyone else sees only a
 * link. With `uniLabel` the message addresses Uni. Without a hub (not
 * configured) it falls back to the quoted excerpt plus a path reference.
 */
export function shareText(note: Pick<JournalNote, "id" | "path" | "content" | "created_at">, vault: string, uniLabel: string | null, ask = "", hub: string | null = null): string {
  const when = new Date(note.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const head = uniLabel ? `@${uniLabel} ${ask.trim() || "here's a journal entry. Take it in and reflect it back to me."}` : `Journal entry · ${when}`;
  if (hub) return `${head}\n\n${noteUrl(hub, vault, note.id)}`;
  const quoted = quote(entryText(note.content), MAX_SHARE);
  const ref = `journal entry, ${when} · vault ${vault}: ${note.path}`;
  return uniLabel ? `${head}\n\n${quoted}\n\n— ${ref}` : `${quoted}\n\n— ${ref}`;
}

/** A soft opening line for the journal, by time of day. */
export function greeting(d: Date): string {
  const h = d.getHours();
  if (h < 5) return "Late night. What's still with you?";
  if (h < 12) return "Good morning. What's arriving?";
  if (h < 17) return "Good afternoon. What's here right now?";
  if (h < 21) return "Good evening. How was the day?";
  return "Winding down. What wants to be said?";
}

export function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}
