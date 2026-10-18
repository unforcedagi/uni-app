// Message attachments: Buzz relay media (imeta + Blossom-authenticated fetch
// in Rust) and previews of plain third-party image links. Images come through
// the `media_bytes` command → `blob:` URL, like Buzz desktop's
// `fetch_media_bytes`; video and audio are streamed to the disk cache by
// `media_stream` and played from the local `unimedia` protocol, or on Linux
// and Android a token-guarded 127.0.0.1 URL (T-172). Every relay attachment
// can be saved where the user finds it (`media_save`: Android's Downloads, the
// Downloads folder on desktop), and files open in the app for their type
// (`media_open`); both say what happened, or why not, on the card (T-174).
import { useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { pdfThumbnail } from "./pdfPreview";
import { attachmentKind, collectAttachments, displayName, formatSize, imageLinks, mediaErrorText, parseDim, playbackErrorText, playerPin, relayMediaSha, stripAttachmentLines, type MediaRef } from "./media";

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

// Video/audio → local `unimedia` URL over the verified cache file. Not behind
// `slot`: a 40 MB download must not hold up the images.
// Each player asks for itself: `media_stream` pins the file for that player (see playerPin), and a file already
// verified this session answers at once.
function relayStream(m: MediaRef): Promise<{ sha: string; src: string }> {
  return invoke<{ sha: string; url: string | null }>("media_stream", { url: m.url, sha: m.sha256, mime: m.mime })
    // url: the 127.0.0.1 loopback on Linux and Android (see media_loopback.rs)
    .then((r) => ({ sha: r.sha, src: r.url ?? convertFileSrc(r.sha, "unimedia") }));
}

const pinCall = (cmd: "media_pin" | "media_release", sha: string) => { void invoke(cmd, { sha }).catch(() => {}); };

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

type MediaState = { src: string | null; error: string | null };

/** `load(m)` once enabled (again on each `retry`); `fail` shows a later error, e.g. from playback. */
function useRelayMedia(load: (m: MediaRef) => Promise<string>, m: MediaRef, enabled: boolean, retry = 0): MediaState & { fail: (error: string) => void } {
  const [state, setState] = useState<MediaState>({ src: null, error: null });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setState({ src: null, error: null });
    load(m).then((src) => live && setState({ src, error: null }), (e) => live && setState({ src: null, error: mediaErrorText(e) }));
    return () => { live = false; };
  }, [m.url, m.sha256, enabled, retry]);
  return { ...state, fail: (error) => setState({ src: null, error }) };
}

// ── Components ───────────────────────────────────────────────────────────
type Open = (src: string, alt: string, m?: MediaRef) => void;

function boxStyle(dim: string | null): React.CSSProperties | undefined {
  const d = parseDim(dim);
  return d ? { aspectRatio: `${d[0]} / ${d[1]}`, width: `min(100%, ${Math.round((240 * d[0]) / d[1])}px, ${d[0]}px)` } : undefined;
}

// ── Save to Downloads (T-174) ───────────────────────────────────────────
type Saver = { state: "idle" | "saving" | "saved" | "error"; text: string; save: () => void };

/** `media_save` for one attachment; `text` says where it went, or why it didn't. */
function useSave(m: MediaRef): Saver {
  const [s, setS] = useState<Omit<Saver, "save">>({ state: "idle", text: "" });
  const save = () => {
    setS({ state: "saving", text: "" });
    invoke<string>("media_save", { url: m.url, sha: m.sha256, name: m.filename, mime: m.mime })
      .then((where) => setS({ state: "saved", text: `Saved to ${where}` }), (e) => setS({ state: "error", text: `Not saved: ${mediaErrorText(e)}` }));
  };
  return { ...s, save };
}

function SaveButton({ m, s, className = "attachment-save" }: { m: MediaRef; s: Saver; className?: string }) {
  return <button className={className} onClick={(e) => { e.stopPropagation(); s.save(); }} disabled={s.state === "saving" || s.state === "saved"}
    aria-label={`Save ${displayName(m)} to Downloads`}>{s.state === "saved" ? "✓ Saved" : s.state === "saving" ? "Saving…" : "Save"}</button>;
}

/** Where a save went, or why it failed; nothing while idle. */
function SaveNote({ s }: { s: Saver }) {
  if (s.state === "saved") return <small className="attachment-note" role="status">✓ {s.text}</small>;
  if (s.state === "error") return <small className="attachment-note attachment-error" role="alert">⚠ {s.text}</small>;
  return null;
}

function RelayImage({ m, onOpen }: { m: MediaRef; onOpen: Open }) {
  const [ref, visible] = useVisible<HTMLButtonElement>();
  const { src, error } = useRelayMedia(relayBlob, m, visible);
  const alt = m.alt ?? displayName(m);
  return <button ref={ref} className={`attachment-image ${src ? "" : "loading"}`} style={boxStyle(m.dim)} disabled={!src}
    onClick={() => src && onOpen(src, alt, m)} aria-label={src ? `Open image ${alt}` : error ? `Image failed to load: ${alt}` : `Loading image ${alt}`}>
    {src ? <img src={src} alt={alt} /> : <span className="attachment-status">{error ? "⚠ Image unavailable" : "Loading image…"}</span>}
  </button>;
}

function RelayPlayer({ m }: { m: MediaRef }) {
  const [go, setGo] = useState(false);
  const [retry, setRetry] = useState(0);
  const kind = attachmentKind(m);
  const pin = useRef(playerPin(pinCall)).current;
  useEffect(() => () => pin.dispose(), []);
  const { src, error, fail } = useRelayMedia((m) => relayStream(m).then((r) => { pin.loaded(r.sha); return r.src; }), m, go, retry);
  // A playback error (format, or the cache file evicted) gives the pin back; a retry asks media_stream again.
  const failed = (e: React.SyntheticEvent<HTMLMediaElement>) => {
    pin.release();
    fail(playbackErrorText(e.currentTarget.error?.code));
  };
  const events = { onError: failed, onPlay: () => pin.play(), onEnded: () => pin.release() };
  const saver = useSave(m);
  if (src) return <div className="attachment-media-group">
    {kind === "video"
      ? <video className="attachment-video" src={src} controls playsInline autoPlay style={boxStyle(m.dim)} {...events} />
      : <audio className="attachment-audio" src={src} controls autoPlay {...events} />}
    <div className="attachment-actions"><SaveButton m={m} s={saver} className="attachment-save attachment-save-pill" /><SaveNote s={saver} /></div>
  </div>;
  const size = formatSize(m.size);
  return <div className="attachment-file-group">
    <div className="attachment-file-card">
    <button className="attachment-file" onClick={() => { if (go) setRetry((n) => n + 1); else setGo(true); }} disabled={go && !error}
      title={error ?? undefined}>
      <span aria-hidden="true">{kind === "video" ? "▶" : "♪"}</span>
      <span className="attachment-name">{displayName(m)}</span>
      <small className={error ? "attachment-error" : undefined}>{error ? `⚠ ${error} · tap to retry` : go ? (size ? `Downloading ${size}…` : "Downloading…") : [size, kind === "video" ? "Play video" : "Play audio"].filter(Boolean).join(" · ")}</small>
    </button>
    <SaveButton m={m} s={saver} />
    </div>
    <SaveNote s={saver} />
  </div>;
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
  const [opening, setOpening] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const saver = useSave(m);
  const open = () => {
    setOpening({ busy: true, error: null });
    invoke("media_open", { url: m.url, sha: m.sha256, mime: m.mime })
      .then(() => setOpening({ busy: false, error: null }), (e) => setOpening({ busy: false, error: mediaErrorText(e) }));
  };
  const pdf = m.mime === "application/pdf" || displayName(m).toLowerCase().endsWith(".pdf");
  return <div className="attachment-file-group">
    {pdf && <PdfThumb m={m} onOpen={open} />}
    <div className="attachment-file-card">
    <button className="attachment-file" onClick={open} disabled={opening.busy} aria-label={`Open ${displayName(m)}`} title={opening.error ?? undefined}>
      <span aria-hidden="true">{pdf ? "📄" : "📎"}</span><span className="attachment-name">{displayName(m)}</span>
      <small className={opening.error ? "attachment-error" : undefined} role={opening.error ? "alert" : undefined}>{opening.busy ? "Opening…" : opening.error ? `⚠ ${opening.error} · tap to retry` : [formatSize(m.size), "Open"].filter(Boolean).join(" · ")}</small>
    </button>
    <SaveButton m={m} s={saver} />
    </div>
    <SaveNote s={saver} />
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

function Lightbox({ src, alt, m, onClose }: { src: string; alt: string; m?: MediaRef; onClose: () => void }) {
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
    {m && <LightboxSave m={m} />}
  </div>;
}

/** Save for a relay image, at the foot of the lightbox. */
function LightboxSave({ m }: { m: MediaRef }) {
  const saver = useSave(m);
  return <div className="lightbox-actions" onClick={(e) => e.stopPropagation()}>
    <SaveButton m={m} s={saver} className="lightbox-save" /><SaveNote s={saver} />
  </div>;
}

/** Attachments and image-link previews for one message. */
export function Attachments({ body, media }: { body: string; media: MediaRef[] | undefined }) {
  const relayOrigin = useRelayOrigin();
  const [open, setOpen] = useState<{ src: string; alt: string; m?: MediaRef } | null>(null);
  const items = collectAttachments(body, media ?? [], relayOrigin);
  const links = imageLinks(body, relayOrigin, new Set(items.map((m) => m.url)));
  if (!items.length && !links.length) return null;
  const onOpen: Open = (src, alt, m) => setOpen({ src, alt, m });
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
    {open && <Lightbox src={open.src} alt={open.alt} m={open.m} onClose={() => setOpen(null)} />}
  </div>;
}
