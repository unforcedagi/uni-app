// A sound: a round play button and a little drawn waveform that fills as it plays. Plays softly when told to (Gallery focus).
import { useEffect, useMemo, useRef, useState } from "react";
import type { Card } from "../../../engine/src/types.ts";
import { hash, rng, useArcade, useMediaUrl } from "../kit/hooks.ts";
import { Pause, Play } from "../kit/icons.tsx";

const BARS = 32;

export function SoundCard({ card, autoPlay = false, volume = 0.6 }: { card: Card; autoPlay?: boolean; volume?: number }) {
  const { url, state } = useMediaUrl(card, "src");
  const { calm } = useArcade();
  const el = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [failed, setFailed] = useState(false);
  const bars = useMemo(() => {
    const r = rng(hash(card.id));
    let prev = 0.5;
    return Array.from({ length: BARS }, (_, i) => {
      prev = Math.max(0.12, Math.min(1, prev + (r() - 0.5) * 0.55));
      const env = Math.sin(Math.PI * (i + 0.5) / BARS) * 0.5 + 0.5;
      return Math.round(prev * env * 100) / 100;
    });
  }, [card.id]);

  useEffect(() => {
    const a = el.current;
    if (!a || !url) return;
    a.volume = volume;
    if (autoPlay) a.play().then(() => setPlaying(true), () => setPlaying(false));
    else { a.pause(); setPlaying(false); }
  }, [autoPlay, url, volume]);

  const toggle = () => {
    const a = el.current;
    if (!a) return;
    if (a.paused) a.play().then(() => { setPlaying(true); setFailed(false); }, () => setFailed(true));
    else { a.pause(); setPlaying(false); }
  };

  return (
    <figure className={`ta-card ta-card-sound${playing ? " is-playing" : ""}${calm ? "" : " is-live"}`} data-kind="sound">
      {url && (
        <audio ref={el} src={url} preload="metadata" loop={autoPlay}
          onTimeUpdate={(e) => { const a = e.currentTarget; setProgress(a.duration ? a.currentTime / a.duration : 0); }}
          onEnded={() => { setPlaying(false); setProgress(0); }}
          onPause={() => setPlaying(false)} onPlay={() => setPlaying(true)}
          onError={() => setFailed(true)} />
      )}
      <div className="ta-sound-body">
        <button type="button" className="ta-sound-play" onClick={toggle} disabled={!url}
          aria-label={`${playing ? "Pause" : "Play"} ${card.title}`} aria-pressed={playing}>
          {playing ? <Pause size={26} /> : <Play size={26} />}
        </button>
        <div className="ta-wave" aria-hidden="true">
          {bars.map((h, i) => (
            <i key={i} className={i / BARS < progress ? "is-past" : ""} style={{ ["--h" as string]: h, ["--d" as string]: `${(i % 7) * 70}ms` }} />
          ))}
        </div>
      </div>
      <figcaption className="ta-card-cap">
        {card.title}
        {(failed || (state === "none")) && <small> This sound won't play here.</small>}
      </figcaption>
    </figure>
  );
}
