// T-335 Taste Arcade: the small pure pieces of the app's host (unit-tested in scripts/arcade.test.ts).
import type { Card, Reaction } from "./kit/engine/src/types.ts";

type Flush = { sent: string[]; error: string | null; duplicate?: unknown };

/** Where a Ripple answer landed. Its note id once it reached the vault (the journal sweep renames a voice entry when the
 *  transcript lands, so the path known now goes stale), else the path it was filed under (still queued on the device). */
export function journalRef(r: Flush, path: string): string {
  const id = !r.error && !r.duplicate && r.sent.length ? r.sent[r.sent.length - 1] : "";
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id) ? id : path;
}

const BY_EXT: Record<string, string> = { webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", svg: "image/svg+xml", mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", wav: "audio/wav", mp4: "video/mp4", webm: "video/webm" };

/** The type to give a card's media blob (raw IPC carries bytes only). Never a type that runs script. */
export function mediaType(card: Card, which: "src" | "poster"): string {
  const name = (which === "src" ? card.media?.src : card.media?.poster) ?? "";
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const t = (which === "src" ? card.media?.mime : undefined) || BY_EXT[ext] || "application/octet-stream";
  return /^(image\/(webp|jpeg|png|gif)|audio\/[a-z0-9.+-]+|video\/(mp4|webm))$/.test(t) ? t : "application/octet-stream";
}

/** A door error (Rust's ArcadeError, tagged by kind) in words for the games' own error lines. */
export function arcadeError(e: unknown): string {
  const o = e && typeof e === "object" ? (e as { kind?: string; message?: string }) : null;
  switch (o?.kind) {
    case "unreachable": return "The arcade lives on your own machine, and it isn't answering. Are you on the tailnet?";
    case "not_allowed": return "The arcade doesn't know this device yet.";
    case "refused": return o.message ? `The arcade said no: ${o.message}` : "The arcade said no.";
    case "server": return "The arcade had a problem on its side. Try again in a bit.";
    default: return o?.message ?? (typeof e === "string" ? e : "Something went wrong.");
  }
}

/** A typed Ripple answer, as the door hears it: like a voice answer, only where its journal entry landed (the door reads
 *  that one entry when it distils). Without a known entry it stays as it was. Every other reaction passes unchanged. */
export function typedAnswer(r: Reaction, refs: Map<string, string>): Reaction {
  if (r.game !== "ripple" || r.kind !== "words" || !r.words) return r;
  const ref = refs.get(`${r.card}\n${r.words.trim()}`);
  if (!ref) return r;
  const { words: _drop, ...rest } = r;
  void _drop;
  return { ...rest, kind: "voice", voice: { ref } };
}
