// Journal helpers (pure, unit-tested). Entries use the Parachute app's capture
// shape: path Notes/YYYY/MM-DD/HH-MM-SS in local time, tag `capture`.

import { quote } from "./uniActions.ts";
import { noteUrl } from "./vaultlinks.ts";

export type JournalDraft = { entry_id: string; path: string; content: string; source: "text" | "voice"; created_at: string };
export type JournalNote = { id: string; path: string; created_at: string; content: string; source: string | null; entry_id: string | null; tags: string[]; pending: boolean };
export type QueuedEntry = { entry_id: string; path: string; content: string; source: string; created_at: string; has_audio: boolean; note_id: string | null; attempts: number; last_error: string | null };
export type FlushReport = { sent: string[]; remaining: number; error: string | null };

export const TRANSCRIPT_PENDING = "_Transcript pending._";
const pad = (n: number) => String(n).padStart(2, "0");

/** Vault path for an entry made at `d` (local time, like the Parachute app). */
export function entryPath(d: Date): string {
  return `Notes/${d.getFullYear()}/${pad(d.getMonth() + 1)}-${pad(d.getDate())}/${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

export function newDraft(content: string, source: "text" | "voice", d = new Date(), id = crypto.randomUUID()): JournalDraft {
  return { entry_id: id, path: entryPath(d), content, source, created_at: d.toISOString() };
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
