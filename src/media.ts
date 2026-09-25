// Pure helpers for message attachments (no DOM / Tauri, so node can test them).
//
// Buzz sends an upload as NIP-92 `imeta` tags plus a body line per file:
// `![image](url)` / `![video](url)` for media, `[name](url)` for other files
// (desktop/src/features/messages/lib/imetaMediaMarkdown.ts). We render the
// attachment from its imeta entry and hide that duplicate body line.

export type MediaRef = {
  url: string;
  mime: string | null;
  sha256: string | null;
  size: number | null;
  dim: string | null;
  blurhash: string | null;
  alt: string | null;
  filename: string | null;
};

export type AttachmentKind = "image" | "video" | "audio" | "file";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i;

function urlPath(url: string): string {
  try { return new URL(url).pathname; } catch { return ""; }
}

export function attachmentKind(m: Pick<MediaRef, "url" | "mime">): AttachmentKind {
  const mime = (m.mime ?? "").toLowerCase();
  // SVG can carry script; never render it as an image.
  if (mime === "image/svg+xml") return "file";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime) return "file";
  const path = urlPath(m.url);
  if (IMAGE_EXT.test(path)) return "image";
  if (VIDEO_EXT.test(path)) return "video";
  if (AUDIO_EXT.test(path)) return "audio";
  return "file";
}

const RELAY_MEDIA_PATH = /^\/media\/([0-9a-f]{64})(?:\.[a-z0-9]{1,8})?$/;

/** Hash of a media URL on our relay (`<origin>/media/<sha256>[.ext]`), else null. */
export function relayMediaSha(url: string, relayOrigin: string | null): string | null {
  if (!relayOrigin) return null;
  try {
    const u = new URL(url);
    if (u.origin !== new URL(relayOrigin).origin || u.search || u.hash) return null;
    return RELAY_MEDIA_PATH.exec(u.pathname)?.[1] ?? null;
  } catch { return null; }
}

/** `"640x480"` → `[640, 480]`. */
export function parseDim(dim: string | null | undefined): [number, number] | null {
  const m = /^(\d{1,5})x(\d{1,5})$/.exec((dim ?? "").trim());
  if (!m) return null;
  const w = Number(m[1]), h = Number(m[2]);
  return w > 0 && h > 0 ? [w, h] : null;
}

export function formatSize(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function displayName(m: MediaRef): string {
  if (m.filename) return m.filename;
  const last = urlPath(m.url).split("/").pop() ?? "";
  return last ? decodeURIComponent(last) : "file";
}

const EMPTY: Omit<MediaRef, "url"> = { mime: null, sha256: null, size: null, dim: null, blurhash: null, alt: null, filename: null };

// `![label](url)` / `[label](url)` alone on a line (Buzz's attachment lines,
// optionally spoiler-wrapped in `||`).
const MEDIA_LINE = /^\s*(?:\|\|)?!\[(?:[^\]\\]|\\.)*\]\(([^)\s]+)\)(?:\|\|)?\s*$/;
const FILE_LINE = /^\s*\[(?:[^\]\\]|\\.)*\]\(([^)\s]+)\)\s*$/;

/**
 * Attachments to render for a message: its imeta entries, plus relay media
 * referenced only by a body `![..](url)` line (older / edited messages).
 */
export function collectAttachments(body: string, media: MediaRef[], relayOrigin: string | null): MediaRef[] {
  const out = [...media];
  const seen = new Set(out.map((m) => m.url));
  for (const line of body.split(/\r?\n/)) {
    const url = MEDIA_LINE.exec(line)?.[1];
    if (!url || seen.has(url)) continue;
    const sha = relayMediaSha(url, relayOrigin);
    if (!sha) continue;
    seen.add(url);
    out.push({ ...EMPTY, url, sha256: sha });
  }
  return out;
}

/** Body without the attachment lines we render ourselves. */
export function stripAttachmentLines(body: string, attachments: MediaRef[]): string {
  if (!attachments.length) return body;
  const urls = new Set(attachments.map((m) => m.url));
  const lines = body.split(/\r?\n/).filter((line) => {
    const url = MEDIA_LINE.exec(line)?.[1] ?? FILE_LINE.exec(line)?.[1];
    return !(url && urls.has(url));
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const BARE_URL = /\bhttps:\/\/[^\s<>"'`()\]]+/gi;

/**
 * Plain image links (https, image extension) that are not relay media: shown
 * as previews loaded straight from the web (no auth, no referrer). Links
 * inside code are ignored.
 */
export function imageLinks(body: string, relayOrigin: string | null, exclude: Set<string>, max = 4): string[] {
  const text = body.replace(/```[\s\S]*?(```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
  const out: string[] = [];
  for (const raw of text.match(BARE_URL) ?? []) {
    const url = raw.replace(/[.,;:!?*_~]+$/, "");
    if (out.includes(url) || exclude.has(url)) continue;
    if (!IMAGE_EXT.test(urlPath(url))) continue;
    if (relayOrigin && sameOrigin(url, relayOrigin)) continue;
    out.push(url);
    if (out.length >= max) break;
  }
  return out;
}

function sameOrigin(a: string, b: string): boolean {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}
