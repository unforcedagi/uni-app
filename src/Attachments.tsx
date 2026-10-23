// Message attachments: Buzz relay media (imeta + Blossom-authenticated fetch
// in Rust) and previews of plain third-party image links. Images come through
// the `media_bytes` command → `blob:` URL, like Buzz desktop's
// `fetch_media_bytes`; video and audio are streamed to the disk cache by
// `media_stream` and played from the local `unimedia` protocol, or on Linux
// and Android a token-guarded 127.0.0.1 URL (T-172). Every relay attachment
// can be saved where the user finds it (`media_save`: Android's Downloads, the
// Downloads folder on desktop), and files open in the app for their type
// (`media_open`); both say what happened, or why not, on the card (T-174).
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
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
// One state per attachment URL, shared by its card and the image viewer, so a save that finishes after the
// viewer closed still reports on the card.
type SaveState = { state: "idle" | "saving" | "saved" | "error"; text: string };
type Saver = SaveState & { save: () => void };
const IDLE: SaveState = { state: "idle", text: "" };
const saves = new Map<string, SaveState>();
const saveListeners = new Set<() => void>();
const setSave = (url: string, s: SaveState) => { saves.set(url, s); saveListeners.forEach((l) => l()); };
const onSaves = (l: () => void) => { saveListeners.add(l); return () => { saveListeners.delete(l); }; };

/** `media_save` for one attachment; `text` says where it went, or why it didn't. Saving again makes another copy. */
function useSave(m: MediaRef): Saver {
  const s = useSyncExternalStore(onSaves, () => saves.get(m.url) ?? IDLE);
  const save = () => {
    if (saves.get(m.url)?.state === "saving") return;
    setSave(m.url, { state: "saving", text: "" });
    invoke<string>("media_save", { url: m.url, sha: m.sha256, name: m.filename, mime: m.mime })
      .then((where) => setSave(m.url, { state: "saved", text: `Saved to ${where}` }), (e) => setSave(m.url, { state: "error", text: `Not saved: ${mediaErrorText(e)}` }));
  };
  return { ...s, save };
}

function SaveButton({ m, s, className = "attachment-save" }: { m: MediaRef; s: Saver; className?: string }) {
  return <button className={className} onClick={(e) => { e.stopPropagation(); s.save(); }} disabled={s.state === "saving"}
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
  const saver = useSave(m);
  const alt = m.alt ?? displayName(m);
  // The box's width goes on the wrapper (its `100%` is the message's width); the image fills it.
  const box = boxStyle(m.dim);
  return <div className="attachment-media-group" style={box && { width: box.width }}>
    <button ref={ref} className={`attachment-image ${src ? "" : "loading"}`} style={box && { aspectRatio: box.aspectRatio, width: "100%" }} disabled={!src}
      onClick={() => src && onOpen(src, alt, m)} aria-label={src ? `Open image ${alt}` : error ? `Image failed to load: ${alt}` : `Loading image ${alt}`}>
      {src ? <img src={src} alt={alt} /> : <span className="attachment-status">{error ? "⚠ Image unavailable" : "Loading image…"}</span>}
    </button>
    {/* Saved from the full-screen view; without a preview (too large, or it failed) from here. */}
    {error && <div className="attachment-actions"><SaveButton m={m} s={saver} className="attachment-save attachment-save-pill" /></div>}
    <SaveNote s={saver} />
  </div>;
}

function RelayPlayer({ m }: { m: MediaRef }) {
  const [go, setGo] = useState(false);
  const [retry, setRetry] = useState(0);
  const kind = attachmentKind(m);
  const pin = useRef(playerPin(pinCall)).current;
  useEffect(() => () => pin.dispose(), []);
  const { src, error, fail } = useRelayMedia((m) => relayStream(m).then((r) => { pin.loaded(r.sha); return r.src; }), m, go, retry);
  const [full, setFull] = useState<{ at: number; playing: boolean } | null>(null);
  // A playback error (format, or the cache file evicted) gives the pin back; a retry asks media_stream again,
  // and plays in the message (the full-screen layer closes with the failure).
  const failed = (e: React.SyntheticEvent<HTMLMediaElement>) => {
    pin.release();
    setFull(null);
    fail(playbackErrorText(e.currentTarget.error?.code));
  };
  const events = { onError: failed, onPlay: () => pin.play(), onEnded: () => pin.release() };
  const saver = useSave(m);
  const inline = useRef<HTMLVideoElement>(null);
  const openFull = () => {
    const v = inline.current;
    const at = v?.currentTime ?? 0;
    const playing = !!v && !v.paused && !v.ended;
    v?.pause();
    setFull({ at, playing: playing || !v });
  };
  // Back in the message: carry on from where the full-screen view stopped (paused, so it never plays twice at once).
  const closeFull = (at: number) => { setFull(null); requestAnimationFrame(() => { if (inline.current) inline.current.currentTime = at; }); };
  if (src) return <div className="attachment-media-group">
    {kind === "video"
      ? <video ref={inline} className="attachment-video" src={src} controls playsInline autoPlay={!full} style={boxStyle(m.dim)} {...events} />
      : <audio className="attachment-audio" src={src} controls autoPlay {...events} />}
    <div className="attachment-actions">
      {kind === "video" && <button className="attachment-save attachment-save-pill attachment-fullscreen" onClick={openFull} aria-label={`Full screen: ${displayName(m)}`}>⛶ Full screen</button>}
      <SaveButton m={m} s={saver} className="attachment-save attachment-save-pill" /><SaveNote s={saver} />
    </div>
    {full && <VideoFull src={src} name={displayName(m)} at={full.at} playing={full.playing} events={events} onClose={closeFull} />}
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

export function Lightbox({ src, alt, m, onClose }: { src: string; alt: string; m?: MediaRef; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    // Capture, and stop it there: Escape (and Android Back, which sends one) closes only the viewer.
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); onClose(); } };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);
  useEffect(() => { setModalOpen(+1); return () => setModalOpen(-1); }, []);
  return <div className="lightbox" role="dialog" aria-modal="true" aria-label={alt} onClick={onClose}>
    <img src={src} alt={alt} referrerPolicy="no-referrer" onClick={(e) => e.stopPropagation()} />
    <button ref={close} className="lightbox-close" onClick={onClose} aria-label="Close image">✕</button>
    {m && <LightboxSave m={m} />}
  </div>;
}

/**
 * A video filling the whole window (T-258). The platform's own full-screen control can't be relied on: Android's
 * WebView (wry's RustWebChromeClient) cancels every full-screen request, and other webviews vary. So the app shows
 * its own: a fixed layer over everything, rendered at the body so no message ancestor can clip it. Where the
 * Fullscreen API is allowed (desktop), the layer also asks to take the screen; refused or absent, the layer stays.
 * Escape, ✕ and Android Back close it. T-260: a published video in a note opens the same layer.
 */
export function VideoFull({ src, name, at, playing, events, onClose }: {
  src: string; name: string; at: number; playing: boolean;
  events: React.VideoHTMLAttributes<HTMLVideoElement>; onClose: (at: number) => void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const shut = useRef(false);
  const close = () => {
    if (shut.current) return;
    shut.current = true;
    if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
    onClose(video.current?.currentTime ?? at);
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const el = layer.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The app behind is out of reach while the layer is up: no Tab, no screen reader, no stray tap.
    const root = document.getElementById("root");
    const wasInert = root?.inert ?? false;
    if (root) root.inert = true;
    el?.querySelector<HTMLButtonElement>(".lightbox-close")?.focus();
    if (el && document.fullscreenEnabled && el.requestFullscreen) void el.requestFullscreen().catch(() => {});
    // Capture, and stop it there: Escape here closes only this layer, never the panel or note behind it.
    const key = (e: KeyboardEvent) => {
      // Tab is left alone, so it walks the player's own controls; the inert app behind keeps focus in the layer.
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); closeRef.current(); }
    };
    // Leaving the platform's full screen (its own Esc, a swipe) closes the layer too, so one gesture is enough.
    const left = () => { if (!document.fullscreenElement) closeRef.current(); };
    window.addEventListener("keydown", key, true);
    document.addEventListener("fullscreenchange", left);
    setModalOpen(+1);
    return () => {
      window.removeEventListener("keydown", key, true); document.removeEventListener("fullscreenchange", left); setModalOpen(-1);
      if (root) root.inert = wasInert;
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  const start = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    if (at > 0) v.currentTime = at;
    if (playing) void v.play().catch(() => {});
  };
  return createPortal(<div ref={layer} className="lightbox video-full" role="dialog" aria-modal="true" aria-label={`${name}, full screen`}>
    <video ref={video} className="video-full-player" src={src} controls playsInline onLoadedMetadata={start} {...events} />
    <button className="lightbox-close" onClick={close} aria-label="Close full screen">✕</button>
  </div>, document.body);
}

/** How many full-window layers are open; App lets Android Back close the top one. */
let modals = 0;
function setModalOpen(d: number) {
  modals = Math.max(0, modals + d);
  window.dispatchEvent(new CustomEvent("uni-modal", { detail: modals }));
}
export function modalCount(): number { return modals; }

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
