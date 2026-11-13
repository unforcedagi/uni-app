// T-335: where an image in a note comes from, and so how it may be shown. Pure (node tests it: scripts/noteImages.test.ts).
//
// Nothing a note says is fetched by the webview. An image is one of:
// - `vault`: the vault's storage (`/api/storage/<date>/<file>`, relative or on this hub), read by the app as one of the note's own
//   attachments (`vault_attachment`) and shown from a `blob:` URL;
// - `inline`: a `data:image/…` URL, already in the note (no request);
// - `remote`: an http(s) image anywhere else, shown as a link with a "Load image" tap (`remote_image`), never automatically;
// - `none`: anything else (a relative path, another scheme), shown as its words.

export type ImageSource =
  | { kind: "vault"; path: string }
  | { kind: "inline"; src: string }
  | { kind: "remote"; url: string }
  | { kind: "none" };

const STORAGE = /^\/?api\/storage\/([^?#]+)/;
const VAULT_STORAGE = /^(?:\/vault\/[^/]+)?\/api\/storage\/(.+)$/;
const DATA_IMAGE = /^data:image\/[a-z0-9.+-]+[;,]/i;

/** A storage path as the vault stores it (`<date>/<file>`): decoded, relative, no `.`/`..` segment; else null. */
function storagePath(raw: string): string | null {
  let p: string;
  try { p = decodeURIComponent(raw); } catch { return null; }
  if (!p || p.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(p)) return null;
  if (p.split("/").some((s) => s === "" || s === "." || s === "..")) return null;
  return p;
}

const originOf = (u: string): string | null => { try { return new URL(u).origin; } catch { return null; } };

/**
 * Classify an image `src` from a note. `hubs` are the origins of the hub the note was read from (a storage URL on any other host is
 * just a remote image: the app only reads attachments from its own hub).
 */
export function imageSource(src: unknown, hubs: readonly (string | null | undefined)[]): ImageSource {
  if (typeof src !== "string") return { kind: "none" };
  const s = src.trim();
  if (!s || s.length > 8192) return { kind: "none" };
  if (DATA_IMAGE.test(s)) return { kind: "inline", src: s };
  const rel = STORAGE.exec(s);
  if (rel) {
    const path = storagePath(rel[1]);
    return path ? { kind: "vault", path } : { kind: "none" };
  }
  if (!/^https?:\/\/[^/\\]/i.test(s) || /[\s\\\u0000-\u001f\u007f]/.test(s)) return { kind: "none" };
  let u: URL;
  try { u = new URL(s); } catch { return { kind: "none" }; }
  if (u.username || u.password) return { kind: "none" };
  const own = hubs.map((h) => (h ? originOf(h) : null)).filter((o): o is string => !!o);
  if (own.includes(u.origin)) {
    const m = VAULT_STORAGE.exec(u.pathname);
    const path = m ? storagePath(m[1]) : null;
    if (path) return { kind: "vault", path };
  }
  return { kind: "remote", url: s };
}

/** What a remote image is called on its button when the note gives it no words: its host. */
export function imageLabel(alt: unknown, url: string): string {
  const a = typeof alt === "string" ? alt.trim() : "";
  if (a) return a;
  try { return new URL(url).hostname || "image"; } catch { return "image"; }
}

/** A Blob for image bytes: SVG needs its type to show in an <img>; every other format is sniffed by the webview. */
export function imageBlob(bytes: ArrayBuffer, nameHint = ""): Blob {
  const head = new TextDecoder().decode(new Uint8Array(bytes.slice(0, 256))).trimStart().toLowerCase();
  const svg = /\.svg(?:[?#]|$)/i.test(nameHint) || head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"));
  return new Blob([bytes], svg ? { type: "image/svg+xml" } : {});
}
