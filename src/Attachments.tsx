// Message attachments: Buzz relay media (imeta + Blossom-authenticated fetch
// through the `media_bytes` command → `blob:` URL, like Buzz desktop's
// `fetch_media_bytes`) and previews of plain third-party image links.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { pdfThumbnail } from "./pdfPreview";
import { attachmentKind, collectAttachments, displayName, formatSize, imageLinks, parseDim, relayMediaSha, stripAttachmentLines, type MediaRef } from "./media";

export type { MediaRef } from "./media";

// ── Relay origin (fetched once) ──────────────────────────────────────────
let origin: string | null = null;
let originPromise: Promise<string | null> | null = null;
function loadOrigin(): Promise<string | null> {
  originPromise ??= invoke<string>("relay_origin").then((o) => (origin = o)).catch(() => null);
  return originPromise;
}
export function useRelayOrigin(): string | null {
  const [o, setO] = useState(origin);
  useEffect(() => { if (!o) void loadOrigin().then(setO); }, [o]);
  return o;
}

/** Message body minus the attachment lines rendered by <Attachments>. */
export function attachmentBody(body: string, media: MediaRef[] | undefined, relayOrigin: string | null): string {
  const renderable = collectAttachments(body, media ?? [], relayOrigin).filter((m) =>
    !!relayMediaSha(m.url, relayOrigin),
  );
  return stripAttachmentLines(body, renderable);
}

// ── Authenticated blob cache ─────────────────────────────────────────────
// url → blob: URL. Bounded; the Rust side also caches bytes on disk by hash.
const MAX_BLOBS = 60;
const blobs = new Map<string, Promise<string>>();
const MAX_INFLIGHT = 3;
let inflight = 0;
const waiting: (() => void)[] = [];

async function slot<T>(f: () => Promise<T>): Promise<T> {
  if (inflight >= MAX_INFLIGHT) await new Promise<void>((r) => waiting.push(r));
  inflight++;
  try { return await f(); } finally { inflight--; waiting.shift()?.(); }
}

function relayBlob(m: MediaRef): Promise<string> {
  const key = `${m.url}|${m.sha256 ?? ""}`;
  const hit = blobs.get(key);
  if (hit) { blobs.delete(key); blobs.set(key, hit); return hit; }
  const p = slot(() => invoke<ArrayBuffer>("media_bytes", { url: m.url, sha: m.sha256 }))
    .then((buf) => URL.createObjectURL(new Blob([buf], { type: m.mime ?? "" })));
  p.catch(() => blobs.delete(key));
  blobs.set(key, p);
  while (blobs.size > MAX_BLOBS) {
    const [k, old] = blobs.entries().next().value!;
    blobs.delete(k);
    void old.then((u) => URL.revokeObjectURL(u), () => {});
  }
  return p;
}

// ── Hooks ────────────────────────────────────────────────────────────────
function useVisible<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === "undefined") { setSeen(true); return; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); } }, { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

function useRelayBlob(m: MediaRef, enabled: boolean, retry = 0): { src: string | null; error: string | null } {
  const [state, setState] = useState<{ src: string | null; error: string | null }>({ src: null, error: null });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setState({ src: null, error: null });
    relayBlob(m).then((src) => live && setState({ src, error: null }), (e) => live && setState({ src: null, error: String(e) }));
    return () => { live = false; };
  }, [m.url, m.sha256, enabled, retry]);
  return state;
}

// ── Components ───────────────────────────────────────────────────────────
type Open = (src: string, alt: string) => void;

function boxStyle(dim: string | null): React.CSSProperties | undefined {
  const d = parseDim(dim);
  return d ? { aspectRatio: `${d[0]} / ${d[1]}`, width: `min(100%, ${Math.round((240 * d[0]) / d[1])}px, ${d[0]}px)` } : undefined;
}

function RelayImage({ m, onOpen }: { m: MediaRef; onOpen: Open }) {
  const [ref, visible] = useVisible<HTMLButtonElement>();
  const { src, error } = useRelayBlob(m, visible);
  const alt = m.alt ?? displayName(m);
  return <button ref={ref} className={`attachment-image ${src ? "" : "loading"}`} style={boxStyle(m.dim)} disabled={!src}
    onClick={() => src && onOpen(src, alt)} aria-label={src ? `Open image ${alt}` : error ? `Image failed to load: ${alt}` : `Loading image ${alt}`}>
    {src ? <img src={src} alt={alt} /> : <span className="attachment-status">{error ? "⚠ Image unavailable" : "Loading image…"}</span>}
  </button>;
}

function RelayPlayer({ m }: { m: MediaRef }) {
  const [go, setGo] = useState(false);
  const [retry, setRetry] = useState(0);
  const { src, error } = useRelayBlob(m, go, retry);
  const kind = attachmentKind(m);
  if (src) return kind === "video"
    ? <video className="attachment-video" src={src} controls playsInline autoPlay style={boxStyle(m.dim)} />
    : <audio className="attachment-audio" src={src} controls autoPlay />;
  return <button className="attachment-file" onClick={() => { if (go) setRetry((n) => n + 1); else setGo(true); }} disabled={go && !error}>
    <span aria-hidden="true">{kind === "video" ? "▶" : "♪"}</span>
    <span className="attachment-name">{displayName(m)}</span>
    <small>{error ? "⚠ Failed — tap to retry" : go ? "Loading…" : [formatSize(m.size), kind === "video" ? "Play video" : "Play audio"].filter(Boolean).join(" · ")}</small>
  </button>;
}

// PDF thumbnails keyed by url; rendered once per session.
const pdfThumbs = new Map<string, Promise<{ src: string; pages: number }>>();

function PdfThumb({ m, onOpen }: { m: MediaRef; onOpen: () => void }) {
  const [ref, visible] = useVisible<HTMLButtonElement>();
  const [thumb, setThumb] = useState<{ src: string; pages: number } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!visible || (m.size ?? 0) > 15 * 1024 * 1024) return;
    let live = true;
    let p = pdfThumbs.get(m.url);
    if (!p) {
      p = slot(() => invoke<ArrayBuffer>("media_bytes", { url: m.url, sha: m.sha256 })).then((buf) => pdfThumbnail(buf));
      p.catch(() => pdfThumbs.delete(m.url));
      pdfThumbs.set(m.url, p);
    }
    p.then((t) => live && setThumb(t), () => live && setFailed(true));
    return () => { live = false; };
  }, [visible, m.url, m.sha256, m.size]);
  if (failed) return null;
  return <button ref={ref} className={`attachment-pdf ${thumb ? "" : "loading"}`} onClick={onOpen} aria-label={`Open PDF ${displayName(m)}`}>
    {thumb ? <><img src={thumb.src} alt="" /><span className="attachment-pdf-pages">{thumb.pages} {thumb.pages === 1 ? "page" : "pages"}</span></> : <span className="attachment-status">Loading preview…</span>}
  </button>;
}

function RelayFile({ m }: { m: MediaRef }) {
  const [state, setState] = useState<"idle" | "opening" | "saving" | "saved" | "error">("idle");
  const [path, setPath] = useState("");
  const run = async (action: "opening" | "saving") => {
    setState(action);
    try {
      if (action === "opening") { await invoke("media_open", { url: m.url, sha: m.sha256 }); setState("idle"); }
      else { setPath(await invoke<string>("media_save", { url: m.url, sha: m.sha256 })); setState("saved"); }
    } catch (e) { setPath(String(e)); setState("error"); }
  };
  const busy = state === "opening" || state === "saving";
  const pdf = m.mime === "application/pdf" || displayName(m).toLowerCase().endsWith(".pdf");
  return <div className="attachment-file-group">
    {pdf && <PdfThumb m={m} onOpen={() => void run("opening")} />}
    <div className="attachment-file-card" title={path || undefined}>
    <button className="attachment-file" onClick={() => void run("opening")} disabled={busy} aria-label={`Open ${displayName(m)}`}>
      <span aria-hidden="true">{pdf ? "📄" : "📎"}</span><span className="attachment-name">{displayName(m)}</span>
      <small>{state === "opening" ? "Opening…" : state === "error" ? "⚠ Failed — tap to retry" : [formatSize(m.size), "Open"].filter(Boolean).join(" · ")}</small>
    </button>
    <button className="attachment-save" onClick={() => void run("saving")} disabled={busy || state === "saved"} aria-label={`Cache ${displayName(m)}`}>{state === "saved" ? "✓ Cached" : state === "saving" ? "Saving…" : "Save"}</button>
    </div>
  </div>;
}

function LinkImage({ url, onOpen }: { url: string; onOpen: Open }) {
  const [ref, visible] = useVisible<HTMLButtonElement>();
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return <button ref={ref} className="attachment-image" onClick={() => onOpen(url, url)} aria-label={`Open image ${url}`}>
    {visible && <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />}
  </button>;
}

function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return <div className="lightbox" role="dialog" aria-modal="true" aria-label={alt} onClick={onClose}>
    <img src={src} alt={alt} referrerPolicy="no-referrer" onClick={(e) => e.stopPropagation()} />
    <button ref={close} className="lightbox-close" onClick={onClose} aria-label="Close image">✕</button>
  </div>;
}

/** Attachments and image-link previews for one message. */
export function Attachments({ body, media }: { body: string; media: MediaRef[] | undefined }) {
  const relayOrigin = useRelayOrigin();
  const [open, setOpen] = useState<{ src: string; alt: string } | null>(null);
  const items = collectAttachments(body, media ?? [], relayOrigin);
  const links = imageLinks(body, relayOrigin, new Set(items.map((m) => m.url)));
  if (!items.length && !links.length) return null;
  const onOpen: Open = (src, alt) => setOpen({ src, alt });
  return <div className="attachments">
    {items.map((m) => {
      const kind = attachmentKind(m);
      const onRelay = !!relayMediaSha(m.url, relayOrigin);
      if (!onRelay) {
        // Off-relay imeta: never send our auth there. Images load directly.
        return kind === "image" && m.url.startsWith("https://") ? <LinkImage key={m.url} url={m.url} onOpen={onOpen} /> : null;
      }
      if (kind === "image") return <RelayImage key={m.url} m={m} onOpen={onOpen} />;
      if (kind === "video" || kind === "audio") return <RelayPlayer key={m.url} m={m} />;
      return <RelayFile key={m.url} m={m} />;
    })}
    {links.map((u) => <LinkImage key={u} url={u} onOpen={onOpen} />)}
    {open && <Lightbox src={open.src} alt={open.alt} onClose={() => setOpen(null)} />}
  </div>;
}
