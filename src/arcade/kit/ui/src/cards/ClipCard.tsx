// A short video: muted, looping, playing only while in view (focused); a toggle lets the sound in.
import { useEffect, useRef, useState } from "react";
import type { Card } from "../../../engine/src/types.ts";
import { useArcade, useMediaUrl } from "../kit/hooks.ts";
import { Pause, Play, SoundOff, SoundOn } from "../kit/icons.tsx";

export function ClipCard({ card, focused = true }: { card: Card; focused?: boolean }) {
  const { url } = useMediaUrl(card, "src");
  const poster = useMediaUrl(card, "poster");
  const { calm } = useArcade();
  const el = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const v = el.current;
    if (!v || !url) return;
    // the ink screen and reduced motion: a still frame unless they press play themselves
    if (focused && !calm) v.play().catch(() => undefined);
    else v.pause();
  }, [focused, url, calm]);
  return (
    <figure className="ta-card ta-card-clip" data-kind="clip">
      <div className="ta-media-frame">
        {url
          ? <video ref={el} src={url} poster={poster.url ?? undefined} muted={muted} loop playsInline preload="auto" aria-label={card.title}
              onLoadedMetadata={(e) => { if (calm && !poster.url) e.currentTarget.currentTime = Math.min(0.5, e.currentTarget.duration / 2 || 0); }}
              onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} />
          : <div className="ta-media-missing">{card.title}</div>}
        {url && calm && (
          <button type="button" className="ta-clip-play" onClick={() => { const v = el.current; if (v) { if (v.paused) void v.play().catch(() => undefined); else v.pause(); } }}
            aria-pressed={playing} aria-label={`${playing ? "Pause" : "Play"} ${card.title}`}>
            {playing ? <Pause size={20} /> : <Play size={20} />}
          </button>
        )}
        {url && !calm && (
          <button type="button" className="ta-clip-sound" onClick={() => setMuted((m) => !m)} aria-pressed={!muted}
            aria-label={muted ? `Let the sound in: ${card.title}` : `Mute ${card.title}`}>
            {muted ? <SoundOff size={20} /> : <SoundOn size={20} />}
          </button>
        )}
      </div>
      <figcaption className="ta-card-cap">{card.title}</figcaption>
    </figure>
  );
}
