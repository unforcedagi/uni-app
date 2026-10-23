// T-260 (not PublishedMedia.tsx: on a Mac that is publishedMedia.ts): a published file in a note or a decision, in place: a video or audio player with its controls, an image, or (a page or
// PDF) a link that opens in the browser. One component for the note view and the decision card; which links qualify is
// publishedMedia.ts. The webview loads the file from the hub's publish port itself: no autoplay, nothing fetched natively, no frame.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Lightbox, VideoFull } from "./Attachments";
import { playbackErrorText } from "./media";
import { classifyPublished, type Published, type PublishedKind } from "./publishedMedia";

// ── The publish origins (the hub setting, read once) ───────────────────────────────────────────────────────
let origins: string[] | null = null;
let loading: Promise<string[]> | null = null;
function loadOrigins(): Promise<string[]> {
  loading ??= invoke<{ publish_origins?: unknown }>("journal_config").then((c) => {
    const list = Array.isArray(c?.publish_origins) ? c.publish_origins.filter((o): o is string => typeof o === "string") : [];
    return (origins = list);
  }, () => { loading = null; return []; });
  return loading;
}
/** Where published files may play from: none until the hub setting is read (or when it can't be). */
export function usePublishOrigins(): string[] {
  const [o, setO] = useState<string[]>(origins ?? []);
  useEffect(() => {
    let live = true;
    if (!origins) void loadOrigins().then((l) => { if (live) setO(l); });
    return () => { live = false; };
  }, []);
  return o;
}

const openExternal = (url: string) => { void invoke("open_link", { url }).catch(() => {}); };
const KIND_WORD: Record<PublishedKind, string> = { video: "video", audio: "audio", image: "image", doc: "PDF", page: "page" };
/** Why a published file may not show: it is on the hub, over the tailnet. */
const REACH = "It plays from the hub, so this device needs to be on the tailnet.";

/** Opens the file in the system browser: the way to it when it can't play here. */
function OpenOut({ m, label }: { m: Published; label?: string }) {
  return <a className="pub-open" href={m.url} rel="noreferrer noopener" onClick={(e) => { e.preventDefault(); openExternal(m.url); }}>{label ?? "Open in browser"} ↗</a>;
}

function Player({ m }: { m: Published }) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [full, setFull] = useState<{ at: number; playing: boolean } | null>(null);
  const video = m.kind === "video";
  const failed = (e: React.SyntheticEvent<HTMLMediaElement>) => { setFull(null); setError(playbackErrorText(e.currentTarget.error?.code)); };
  const retry = () => { setError(null); ref.current?.load(); };
  // full screen: the same layer as an attached video (T-258); it carries on from here, and back here from where it stopped
  const openFull = () => {
    const v = ref.current;
    const playing = !!v && !v.paused && !v.ended;
    v?.pause();
    setFull({ at: v?.currentTime ?? 0, playing });
  };
  const closeFull = useCallback((at: number) => { setFull(null); requestAnimationFrame(() => { if (ref.current) ref.current.currentTime = at; }); }, []);
  return <figure className={`pub-media pub-${m.kind}`} data-kind={m.kind} data-url={m.url}>
    {video
      ? <video ref={ref} className="pub-player" src={m.url} controls playsInline preload="metadata" aria-label={m.name} onError={failed} />
      : <audio ref={ref} className="pub-audio" src={m.url} controls preload="metadata" aria-label={m.name} onError={failed} />}
    {error && <p className="pub-error" role="alert">⚠ {error}. {REACH} <button type="button" className="pub-act" onClick={retry}>Try again</button></p>}
    <figcaption className="pub-cap">
      <span className="pub-name" title={m.name}>{m.name}</span>
      {video && !error && <button type="button" className="pub-act" onClick={openFull} aria-label={`Full screen: ${m.name}`}>⛶ Full screen</button>}
      <OpenOut m={m} />
    </figcaption>
    {full && <VideoFull src={m.url} name={m.name} at={full.at} playing={full.playing} events={{ onError: failed }} onClose={closeFull} />}
  </figure>;
}

function Picture({ m }: { m: Published }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return <figure className="pub-media pub-image" data-kind="image" data-url={m.url}>
    {failed
      ? <p className="pub-error" role="alert">⚠ This image didn't load. {REACH} <button type="button" className="pub-act" onClick={() => { setFailed(false); setAttempt((n) => n + 1); }}>Try again</button></p>
      : <button type="button" className="pub-image-open" onClick={() => setOpen(true)} aria-label={`Open image ${m.name}`}>
          <img key={attempt} src={m.url} alt={m.name} referrerPolicy="no-referrer" onError={() => setFailed(true)} />
        </button>}
    <figcaption className="pub-cap"><span className="pub-name" title={m.name}>{m.name}</span><OpenOut m={m} /></figcaption>
    {open && <Lightbox src={m.url} alt={m.name} onClose={close} />}
  </figure>;
}

/** One published file, in place: a player, an image, or a link to open a page or PDF in the browser. */
export function PublishedMedia({ m }: { m: Published }) {
  if (m.kind === "video" || m.kind === "audio") return <Player m={m} />;
  if (m.kind === "image") return <Picture m={m} />;
  return <p className="pub-media pub-link" data-kind={m.kind} data-url={m.url}><OpenOut m={m} label={`Open ${KIND_WORD[m.kind]}: ${m.name}`} /></p>;
}

/** The player the markdown step left in a note (`published-media`, see rehypePublished): its URL is checked again here. */
export function PublishedInNote(props: Record<string, unknown>) {
  const o = usePublishOrigins();
  const m = classifyPublished(props["data-url"], o);
  if (!m) return null;
  const mime = typeof props["data-mime"] === "string" ? props["data-mime"] : null;
  return <PublishedMedia m={{ ...m, mime }} />;
}
