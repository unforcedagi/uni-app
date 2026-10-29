// T-313 Messages: what a message shows besides plain words. Its links open in the system browser; a voice message plays
// inline with its words under it; a picture shows and opens large; a video plays on tap; a file opens in the app the
// system picks; a reply quotes what it answers; reactions sit under the bubble. The bytes come from the Rust core, by
// event (messagesDoor: authenticated media, decrypted there), and stay in memory. Shape and word before colour, and
// nothing animates, so it reads on the Daylight.
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { VideoFull } from "../Attachments";
import { holdMedia, knownWords, mediaUrl, openFile, wordsFor } from "./messagesDoor.ts";
import { asMessagesErr, clock, fileLine, foldedStart, linkify, mediaShape, pictureBox, pictureSize, reactionName, sizeWords, type Media, type MessageRow, type Reaction, type Reply } from "./messagesView.ts";

const openLink = (href: string) => { void invoke("open_link", { url: href }).catch(() => {}); };

/** A message's words with their links, folded with "Read more" when long. */
export function MessageText({ text, after }: { text: string; after?: ReactNode }) {
  const [whole, setWhole] = useState(false);
  const start = whole ? null : foldedStart(text);
  return <>
    {linkify(start ?? text).map((p, i) => p.t === "text" ? <span key={i}>{p.v}</span>
      : <a key={i} className="msgs-link" href={p.href} rel="noreferrer noopener" onClick={(e) => { e.preventDefault(); openLink(p.href); }}>{p.v}</a>)}
    {start !== null && <>… <button type="button" className="msgs-more" onClick={() => setWhole(true)}>Read more</button></>}
    {after}
  </>;
}

/** Whether an element has come on screen (once): attachments load, and voice messages transcribe, as they're seen. */
function useSeen<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === "undefined") { setSeen(true); return; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); } }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

/** Whether an element is on screen now, or just about (`margin`): it changes both ways, unlike useSeen. The margin is
 * small on purpose: what's held is what's on screen (only that may pass the cache's limits), so a wide margin of large
 * pictures would hold too much. */
function useOnScreen<T extends Element>(margin = "100px"): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") { setOn(true); return; }
    // the conversation scrolls inside its own box: the margin is measured from it, not the window
    const root = el.closest(".msgs-log");
    const io = new IntersectionObserver((es) => setOn(es[es.length - 1].isIntersecting), { root, rootMargin: margin });
    io.observe(el);
    return () => io.disconnect();
  }, [margin]);
  return [ref, on];
}

/** An attachment's object URL while `active` (Codex review 9b8p17d9: on screen, or playing). It is held only then: once it
 * isn't, it is let go (the element shows its placeholder) and the cache may drop it within its limits; active again,
 * it is asked for again (from the cache, or fetched). */
function useMediaUrl(roomId: string, eventId: string, mime: string, active: boolean): { url: string | null; problem: string | null; retry: () => void } {
  const [url, setUrl] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (!active) { setUrl(null); return; }
    const release = holdMedia(roomId, eventId);
    let alive = true;
    setProblem(null);
    mediaUrl(roomId, eventId, mime).then((u) => { if (alive) setUrl(u); }, (e) => { if (alive) setProblem(asMessagesErr(e).message); });
    return () => { alive = false; release(); };
  }, [roomId, eventId, mime, active, tries]);
  return { url: active ? url : null, problem, retry: () => setTries((n) => n + 1) };
}

/** One player sounds at a time: starting one pauses the one before. */
let sounding: HTMLMediaElement | null = null;
function playOnly(el: HTMLMediaElement) {
  if (sounding && sounding !== el) sounding.pause();
  sounding = el;
}

/** Play/pause, a scrub bar and the time; the clip is fetched on the first play. Its length comes from the event until the
 * clip says its own (a voice note's container often doesn't). */
function Player({ roomId, eventId, media, label }: { roomId: string; eventId: string; media: Media; label: string }) {
  const [want, setWant] = useState(false);
  const [box, onScreen] = useOnScreen<HTMLDivElement>();
  const [playing, setPlaying] = useState(false);
  // the clip is held while it plays, or while it's on screen once asked for; paused off screen, it's let go
  const { url, problem, retry } = useMediaUrl(roomId, eventId, media.mime, want && (onScreen || playing));
  const audio = useRef<HTMLAudioElement | null>(null);
  const [at, setAt] = useState(0);
  const [length, setLength] = useState<number | null>(media.duration_ms != null ? media.duration_ms / 1000 : null);
  const [broken, setBroken] = useState<string | null>(null);
  /** What to do once the clip is here: play, or go to a spot. */
  const pending = useRef<{ play: boolean; seek: number | null }>({ play: false, seek: null });
  useEffect(() => () => { const el = audio.current; if (el && sounding === el) { el.pause(); sounding = null; } }, []);
  const ready = () => {
    const el = audio.current;
    if (!el) return;
    if (Number.isFinite(el.duration) && el.duration > 0) setLength(el.duration);
    const p = pending.current;
    pending.current = { play: false, seek: null };
    // back after it was let go: where the bar says it was
    const to = p.seek ?? (at > 0 ? at : null);
    if (to != null) el.currentTime = to;
    if (p.play) { playOnly(el); void el.play().catch(() => {}); }
  };
  const toggle = () => {
    const el = audio.current;
    // not here (yet, or let go): fetched, then played from where it was left
    if (!url || !el) { pending.current = { play: true, seek: pending.current.seek }; setWant(true); if (problem) retry(); return; }
    if (el.paused) { playOnly(el); void el.play().catch(() => {}); } else el.pause();
  };
  const seek = (v: number) => {
    setAt(v);
    const el = audio.current;
    if (url && el && el.readyState >= 1) el.currentTime = v;
    else { pending.current.seek = v; setWant(true); }
  };
  const max = length ?? 0;
  const loading = want && pending.current.play && !url && !problem;
  const name = playing ? `Pause ${label}` : `Play ${label}${length != null ? `, ${clock(length)}` : ""}`;
  return <div ref={box} className={`msgs-player ${playing ? "playing" : ""}`}>
    <button type="button" className="msgs-play" aria-label={name} disabled={loading} onClick={toggle}>
      <span aria-hidden="true">{loading ? "…" : playing ? "❚❚" : "▶"}</span>
    </button>
    <input type="range" className="msgs-scrub" min={0} max={max || 1} step={0.1} value={Math.min(at, max || 1)} disabled={!max}
      aria-label={`Position in ${label}`} aria-valuetext={`${clock(at)} of ${clock(length)}`} onChange={(e) => seek(Number(e.target.value))} />
    <span className="msgs-time" aria-hidden="true">{at > 0 || playing ? `${clock(at)} / ${clock(length)}` : clock(length)}</span>
    {url && <audio ref={audio} src={url} preload="auto" onLoadedMetadata={ready} onDurationChange={() => { const el = audio.current; if (el && Number.isFinite(el.duration) && el.duration > 0) setLength(el.duration); }}
      onTimeUpdate={() => setAt(audio.current?.currentTime ?? 0)} onPlay={() => { setPlaying(true); setBroken(null); }}
      onPause={() => setPlaying(false)}
      onEnded={() => { setPlaying(false); setAt(0); if (audio.current) audio.current.currentTime = 0; }}
      onError={() => { setPlaying(false); setBroken("This device can't play this recording."); }} />}
    {(problem || broken) && <p className="msgs-media-problem" role="status">{broken ?? `Couldn't load it: ${problem}`}</p>}
  </div>;
}

/** A voice message's words under its player: asked for as it comes on screen (automatically for a voice message, on a tap
 * for other audio), transcribed once on the owner's box. */
function Words({ roomId, eventId, auto }: { roomId: string; eventId: string; auto: boolean }) {
  const [ref, seen] = useSeen<HTMLDivElement>();
  const [asked, setAsked] = useState(auto);
  const [text, setText] = useState<string | null>(() => knownWords(roomId, eventId)?.text ?? null);
  const [problem, setProblem] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (!asked || !seen || text !== null) return;
    let alive = true;
    setProblem(null);
    wordsFor(roomId, eventId).then((t) => { if (alive) setText(t.text); }, (e) => { if (alive) setProblem(asMessagesErr(e).message); });
    return () => { alive = false; };
  }, [asked, seen, text, roomId, eventId, tries]);
  return <div ref={ref} className="msgs-words" aria-live="polite">
    {!asked ? <button type="button" className="note-quiet msgs-words-ask" onClick={() => setAsked(true)}>Transcribe</button>
      : text !== null ? (text ? <p className="msgs-words-text"><span className="msgs-sr">Transcript: </span>{text}</p> : <p className="msgs-words-none">No words heard.</p>)
      : problem ? <p className="msgs-words-none">No transcript: {problem} <button type="button" className="note-quiet" onClick={() => setTries((n) => n + 1)}>Try again</button></p>
      : <p className="msgs-words-none" role="status">Transcribing…</p>}
  </div>;
}

/** A picture: its shape held while it loads, then shown; a tap opens it large. */
function Picture({ roomId, eventId, media, onOpen }: { roomId: string; eventId: string; media: Media; onOpen: (url: string) => void }) {
  const [ref, onScreen] = useOnScreen<HTMLButtonElement>();
  const { url, problem, retry } = useMediaUrl(roomId, eventId, media.mime, onScreen);
  /** The picture's own size once it has loaded (the event's can be missing or wrong): let go and shown again, it keeps it. */
  const [own, setOwn] = useState<{ width: number; height: number } | null>(null);
  const box = pictureBox(pictureSize(media, own));
  const alt = media.caption ?? media.name ?? "Photo";
  return <button ref={ref} type="button" className="msgs-picture" style={{ width: box.width, height: url ? undefined : box.height }} aria-label={`Photo: ${alt}. Open large`}
    onClick={() => (url ? onOpen(url) : problem ? retry() : undefined)}>
    {url ? <img src={url} alt="" width={box.width} height={box.height} onLoad={(e) => { const i = e.currentTarget; if (i.naturalWidth && i.naturalHeight) setOwn({ width: i.naturalWidth, height: i.naturalHeight }); }} />
      : <span className="msgs-picture-wait">{problem ? `Couldn't load the photo. Tap to try again.` : "Photo"}</span>}
  </button>;
}

/** A video plays inline once tapped (fetched then). T-335: Full screen opens it in the same layer as an attached video. */
function Video({ roomId, eventId, media }: { roomId: string; eventId: string; media: Media }) {
  const [want, setWant] = useState(false);
  const [ref, onScreen] = useOnScreen<HTMLDivElement>();
  const [playing, setPlaying] = useState(false);
  const [full, setFull] = useState<{ at: number; playing: boolean } | null>(null);
  // held while it plays, is on screen or is full screen; paused off screen it's let go, and comes back paused where it was
  const { url, problem, retry } = useMediaUrl(roomId, eventId, media.mime, want && (onScreen || playing || !!full));
  /** Play once it's here: only right after a tap, never because it scrolled back into view. */
  const start = useRef(false);
  const left = useRef(0);
  const inline = useRef<HTMLVideoElement>(null);
  const box = pictureBox(media);
  const name = media.name || "video";
  useEffect(() => { if (!url) setPlaying(false); }, [url]);
  // full screen carries on from here (playing if it was), and back here paused where it stopped, so only one plays
  const openFull = () => {
    const v = inline.current;
    const was = !!v && !v.paused && !v.ended;
    v?.pause();
    setFull({ at: v?.currentTime ?? left.current, playing: was });
  };
  const closeFull = (at: number) => { setFull(null); left.current = at; requestAnimationFrame(() => { if (inline.current) inline.current.currentTime = at; }); };
  return <div ref={ref} className="msgs-video-box">{url ? <>
    <video ref={inline} className="msgs-video" src={url} controls playsInline width={box.width}
      onLoadedMetadata={(e) => { const v = e.currentTarget; if (left.current > 0) v.currentTime = left.current; if (start.current) { start.current = false; playOnly(v); void v.play().catch(() => {}); } }}
      onTimeUpdate={(e) => { left.current = e.currentTarget.currentTime; }}
      onPlay={(e) => { playOnly(e.currentTarget); setPlaying(true); }} onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); left.current = 0; }} />
    <button type="button" className="note-action msgs-video-full" aria-label={`Full screen: ${name}`} onClick={openFull}>⛶ Full screen</button>
    {full && <VideoFull src={url} name={name} at={full.at} playing={full.playing} onClose={closeFull}
      events={{ onPlay: (e) => playOnly(e.currentTarget), onError: () => setFull(null) }} />}
  </>
  : <button type="button" className="msgs-video-wait" style={{ width: box.width, height: url ? undefined : box.height }} disabled={want && onScreen && !problem} onClick={() => { start.current = true; setWant(true); if (problem) retry(); }}>
    <span aria-hidden="true">▶</span> {problem ? "Couldn't load the video. Try again" : want && onScreen ? "Loading the video…" : `Play video${media.duration_ms ? `, ${clock(media.duration_ms / 1000)}` : ""}${media.size ? ` (${sizeWords(media.size)})` : ""}`}
  </button>}</div>;
}

/** A file: its name, type and size, and Open (the app the system picks). */
function FileCard({ roomId, eventId, media }: { roomId: string; eventId: string; media: Media }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const open = async () => {
    setBusy(true); setProblem(null);
    try { await openFile(roomId, eventId); } catch (e) { setProblem(asMessagesErr(e).message); } finally { setBusy(false); }
  };
  return <div className="msgs-file">
    <span className="msgs-file-mark" aria-hidden="true">{(/\.([a-z0-9]{1,4})$/i.exec(media.name)?.[1] ?? "FILE").toUpperCase()}</span>
    <span className="msgs-file-text"><strong>{media.name || "File"}</strong>{fileLine(media) && <small>{fileLine(media)}</small>}</span>
    <button type="button" className="note-action msgs-file-open" disabled={busy} aria-label={`Open ${media.name || "the file"}`} onClick={() => void open()}>{busy ? "Opening…" : "Open"}</button>
    {problem && <p className="msgs-media-problem" role="status">Couldn't open it: {problem}</p>}
  </div>;
}

/** The attachment of a media message, as its shape says. */
export function Attachment({ roomId, row, onPicture }: { roomId: string; row: MessageRow; onPicture: (url: string, alt: string, eventId: string) => void }) {
  const media = row.media;
  if (!media || !row.event_id) return null;
  const id = row.event_id;
  switch (mediaShape(media)) {
    case "image": return <Picture roomId={roomId} eventId={id} media={media} onOpen={(url) => onPicture(url, media.caption ?? media.name, id)} />;
    case "voice": return <div className="msgs-voice"><Player roomId={roomId} eventId={id} media={media} label="voice message" /><Words roomId={roomId} eventId={id} auto /></div>;
    case "audio": return <div className="msgs-voice"><p className="msgs-audio-name">{media.name}</p><Player roomId={roomId} eventId={id} media={media} label={media.name || "audio"} /><Words roomId={roomId} eventId={id} auto={false} /></div>;
    case "video": return <Video roomId={roomId} eventId={id} media={media} />;
    case "file": return <FileCard roomId={roomId} eventId={id} media={media} />;
  }
}

/** What a reply answers, above its words; a tap goes to it when it's loaded here. */
export function Quote({ reply, onGo }: { reply: Reply; onGo: (eventId: string) => void }) {
  return <button type="button" className="msgs-quote" onClick={() => onGo(reply.event_id)}>
    <span className="msgs-sr">In reply to </span>
    <strong>{reply.sender_name ?? "a message"}</strong>
    <span className="msgs-quote-text">{reply.text ?? (reply.unavailable ? "The message it answers isn't available." : "Loading the message it answers…")}</span>
  </button>;
}

/** The reactions under a bubble: each emoji once, with how many; yours are filled. */
export function Reactions({ reactions }: { reactions: Reaction[] }) {
  if (!reactions.length) return null;
  return <ul className="msgs-reactions" aria-label="Reactions">
    {reactions.map((r, i) => <li key={`${i}:${r.key}`} className={r.own ? "own" : ""} aria-label={reactionName(r)}><span aria-hidden="true">{r.key}{r.count > 1 ? ` ${r.count}` : ""}</span></li>)}
  </ul>;
}

/** A picture, large, over the conversation: Escape, the button or a tap outside it closes. */
export function Lightbox({ url, alt, roomId, eventId, onClose }: { url: string; alt: string; roomId: string; eventId: string; onClose: () => void }) {
  const close = useRef<HTMLButtonElement | null>(null);
  // open large, the picture is held, wherever its message has scrolled to
  useEffect(() => holdMedia(roomId, eventId), [roomId, eventId]);
  useEffect(() => {
    close.current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return <div className="msgs-lightbox" role="dialog" aria-modal="true" aria-label={`Photo: ${alt}`} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <img src={url} alt={alt} />
    <button ref={close} type="button" className="note-action msgs-lightbox-close" onClick={onClose}>Close</button>
  </div>;
}
