// T-335: images from content, shown without the content making the webview fetch anything (see noteImages.ts). The app's CSP
// refuses remote images anyway; this is the renderer's half: a vault attachment is read by the app and shown from a `blob:` URL,
// and a remote image is a link with a "Load image" tap that fetches that one image through the app (`remote_image`).
import { createContext, useContext, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { imageLabel, imageSource } from "./noteImages";

// ── Loaded images, kept across redraws and remounts ─────────────────────────────────────────────────────────────────
// A note re-rendering, a saved edit, or a chat row scrolling out and back shows the same object URL again instead of reading it
// again. An image tapped once stays loaded wherever it appears (its site already knows; showing it again tells it nothing new).
// A URL is revoked only when nothing shows it and more than KEEP_IDLE others are idle too.

const KEEP_IDLE = 24;
const shown = new Map<string, string>();
const users = new Map<string, number>();
const going = new Map<string, Promise<string>>();
function trim() {
  let idle = [...shown.keys()].filter((k) => !users.get(k));
  while (idle.length > KEEP_IDLE) {
    const k = idle.shift()!;
    URL.revokeObjectURL(shown.get(k)!);
    shown.delete(k);
  }
}
function hold(key: string): () => void {
  users.set(key, (users.get(key) ?? 0) + 1);
  const url = shown.get(key);
  if (url) { shown.delete(key); shown.set(key, url); }
  return () => { const n = (users.get(key) ?? 1) - 1; if (n > 0) users.set(key, n); else users.delete(key); trim(); };
}

let active = 0;
const waiting: (() => void)[] = [];
/** At most 4 reads at once (a note with many attachments doesn't fire them all together); a finished read hands its turn on. */
async function slot<T>(run: () => Promise<T>): Promise<T> {
  if (active >= 4) await new Promise<void>((r) => waiting.push(r));
  else active++;
  try { return await run(); } finally { const next = waiting.shift(); if (next) next(); else active--; }
}
function blobFor(key: string, load: () => Promise<ArrayBuffer>): Promise<string> {
  const have = shown.get(key);
  if (have) return Promise.resolve(have);
  let p = going.get(key);
  if (!p) {
    // untyped: the webview sniffs the raster format (the app never fetches SVG, which would need its type to show)
    p = slot(load).then((buf) => {
      const url = URL.createObjectURL(new Blob([buf]));
      shown.set(key, url);
      trim();
      return url;
    }).finally(() => going.delete(key));
    going.set(key, p);
  }
  return p;
}

/** The object URL for `key` once `load` (null: not asked for yet) has read it; errors are not kept, so Retry reads again. */
function useBlobImage(key: string, load: (() => Promise<ArrayBuffer>) | null) {
  const [state, setState] = useState<{ url: string | null; error: string | null }>(() => ({ url: shown.get(key) ?? null, error: null }));
  const [attempt, setAttempt] = useState(0);
  useEffect(() => hold(key), [key]);
  useEffect(() => {
    const have = shown.get(key);
    if (have || !load) { setState({ url: have ?? null, error: null }); return; }
    let live = true;
    setState({ url: null, error: null });
    blobFor(key, load).then((url) => { if (live) setState({ url, error: null }); }, (e) => { if (live) setState({ url: null, error: String(e) || "couldn't load" }); });
    return () => { live = false; };
    // `load` is rebuilt each render; `key` names what it loads
  }, [key, attempt, !!load]);
  return { ...state, busy: !!load && !state.url && !state.error, retry: () => setAttempt((n) => n + 1) };
}

/** A remote image behind its "Load image" tap: nothing is fetched until `tap`, and a tapped image stays loaded. */
function useTappedImage(url: string) {
  const key = `remote\n${url}`;
  const [asked, setAsked] = useState(() => shown.has(key));
  const img = useBlobImage(key, asked ? () => invoke<ArrayBuffer>("remote_image", { url }) : null);
  return { ...img, tap: () => { if (img.error) img.retry(); else setAsked(true); } };
}

/** The tap itself (or "Loading image…"): one button for notes and chat. */
function LoadButton({ img, label, className }: { img: ReturnType<typeof useTappedImage>; label: string; className: string }) {
  if (img.busy) return <span className="note-image-state" role="status">Loading image…</span>;
  return <button type="button" className={className} aria-label={label} title={img.error ?? "Loads this one image from its site, which then knows it was opened"}
    onClick={img.tap}>{img.error ? "Couldn't load · Retry" : "Load image"}</button>;
}

// ── In a note ──────────────────────────────────────────────────────────────────────────────────────────────────────

type LinkLike = ComponentType<{ href: string; className?: string; children?: ReactNode }>;
/** The note an image is in, for {@link NoteImage}. */
export type NoteImageScope = { vault: string; note: string; hubs: readonly (string | null | undefined)[]; Link: LinkLike };
export const NoteImageContext = createContext<NoteImageScope | null>(null);
/** Inside a link already: an image there shows as its words only (no second link, and no button inside a link). */
export const InLink = createContext(false);

function RemoteImage({ url, alt, Link }: { url: string; alt: string; Link: LinkLike }) {
  const img = useTappedImage(url);
  if (img.url) return <img src={img.url} alt={alt} className="note-image" />;
  const words = alt.trim() || url;
  return <span className="note-image-remote">
    <Link href={url} className="note-image-link">{words}</Link>
    <LoadButton img={img} label={`Load image: ${imageLabel(alt, url)}`} className="note-image-load" />
  </span>;
}

function VaultAttachmentImage({ hub, vault, note, path, alt }: { hub: string; vault: string; note: string; path: string; alt: string }) {
  const img = useBlobImage(`vault\n${hub}\n${vault}\n${note}\n${path}`, () => invoke<ArrayBuffer>("vault_attachment", { vault, note, path }));
  const name = alt.trim() || path.split("/").pop() || "image";
  if (img.url) return <img src={img.url} alt={alt} className="note-image" />;
  if (img.error) return <span className="note-image-missing" role="img" aria-label={`${name}: couldn't show this attachment`} title={img.error}>🖼 {name} · couldn't show this attachment</span>;
  return <span className="note-image-loading" aria-busy="true" aria-label={`Loading ${name}`} />;
}

/**
 * The `img` of a rendered note (react-markdown's component; one type for the app's life, so a redraw never remounts an image). The
 * note it is in comes from {@link NoteImageContext}. Never renders a remote `src`: see {@link imageSource}.
 */
export function NoteImage({ src, alt }: { src?: unknown; alt?: unknown }) {
  const scope = useContext(NoteImageContext);
  const inLink = useContext(InLink);
  const words = typeof alt === "string" ? alt : "";
  const s = scope ? imageSource(src, scope.hubs) : { kind: "none" as const };
  if (s.kind === "vault" && scope) return <VaultAttachmentImage hub={scope.hubs.find(Boolean) ?? ""} vault={scope.vault} note={scope.note} path={s.path} alt={words} />;
  if (s.kind === "remote" && scope && !inLink) return <RemoteImage url={s.url} alt={words} Link={scope.Link} />;
  // inside a link (a badge, a linked picture): the words, or the image's host, so the link still has something to tap
  const shownWords = words.trim() || (s.kind === "remote" ? `${imageLabel("", s.url)} image` : "");
  return shownWords ? <span className="note-image-words">{shownWords}</span> : null;
}

// ── In chat ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A chat message's link to an image (T-335: was a preview the webview fetched on sight). The link is in the message already; this is
 * its "Load image" tap, then the image, which opens full size.
 */
export function ChatLinkImage({ url, onOpen }: { url: string; onOpen: (src: string, alt: string) => void }) {
  const img = useTappedImage(url);
  if (img.url) return <button className="attachment-image" onClick={() => onOpen(img.url!, url)} aria-label={`Open image ${url}`}><img src={img.url} alt="" /></button>;
  const host = imageLabel("", url);
  return <div className="attachment-remote">
    <span className="attachment-remote-host" title={url}>🖼 {host}</span>
    <LoadButton img={img} label={`Load image from ${host}`} className="attachment-save attachment-save-pill" />
  </div>;
}
