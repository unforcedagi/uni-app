// Journal helpers (pure, unit-tested). Entries are tagged `journal` and live at
// `Journal/YYYY/MM-DD/HH-MM <first words>` in local time (T-60).

import { quote } from "./uniActions.ts";
import { noteUrl } from "./vaultlinks.ts";

export type JournalDraft = { entry_id: string; path: string; content: string; source: "text" | "voice"; created_at: string };
export type JournalNote = { id: string; path: string; created_at: string; content: string; source: string | null; entry_id: string | null; tags: string[]; pending: boolean };
export type QueuedEntry = { entry_id: string; path: string; content: string; source: string; created_at: string; has_audio: boolean; note_id: string | null; attempts: number; last_error: string | null };
export type FlushReport = { sent: string[]; remaining: number; error: string | null };

export const TRANSCRIPT_PENDING = "_Transcript pending._";
const pad = (n: number) => String(n).padStart(2, "0");

/** Characters never allowed in an entry title (mirrors uni-core `check_path`). */
const TITLE_FORBIDDEN = /[\\/\[\]#|:*?"<>^{}`~]/g;

/** First words of an entry (T-60, same rule as uni-1's t60_journal_sweep.py):
 * up to 7 words and 60 characters; markdown markers, embeds, links/URLs and
 * forbidden characters removed; trailing punctuation trimmed. */
export function entryTitle(content: string): string {
  const text = entryText(content)
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/!\[\[[^\]]*\]\]/g, " ")                 // ![[embed]]
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")             // ![img](url)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")           // [text](url)
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")    // [[target|alias]]
    .replace(/\b(?:https?|ftp):\/\/\S+/gi, " ")
    .replace(/\bwww\.\S+/gi, " ")
    .replace(/^\s*(?:[#>*\-+]+|\d+[.)])\s+/gm, "")
    .replace(/\*\*|__|[*_]/g, "")
    .replace(TITLE_FORBIDDEN, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ");
  let title = "";
  for (const w of text.split(/\s+/).filter(Boolean).slice(0, 7)) {
    const next = title ? `${title} ${w}` : w;
    if (next.length > 60) { if (!title) title = w.slice(0, 60); break; }
    title = next;
  }
  return title.replace(/^[\s.,;'\-–—]+|[\s.,;!?'"()\-–—…]+$/gu, "");
}

/** Vault path for an entry made at `d`, device local time:
 * `Journal/YYYY/MM-DD/HH-MM <first words>`. A voice entry still transcribing
 * has no words yet → `Journal/YYYY/MM-DD/HH-MM`; uni-1's sweep titles it.
 * Seconds are added only on a clash, by uni-core (`clash_path`). */
export function entryPath(d: Date, content = ""): string {
  const base = `Journal/${d.getFullYear()}/${pad(d.getMonth() + 1)}-${pad(d.getDate())}/${pad(d.getHours())}-${pad(d.getMinutes())}`;
  const title = entryTitle(content);
  return title ? `${base} ${title}` : base;
}

/** Recognises a T-60 journal entry path. */
export const JOURNAL_PATH = /^Journal\/\d{4}\/\d\d-\d\d\/(\d\d-\d\d(-\d\d)? )?.+/;

export function newDraft(content: string, source: "text" | "voice", d = new Date(), id = crypto.randomUUID()): JournalDraft {
  return { entry_id: id, path: entryPath(d, content), content, source, created_at: d.toISOString() };
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
