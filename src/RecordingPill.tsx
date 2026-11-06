import { useEffect, useRef, useState } from "react";
import { mmss } from "./journalCore";
import type { RecorderControls } from "./recorder";
import type { RecordedSection } from "./recorderSession";
import { decodeMono, peaksOf } from "./recordingJoin";
import "./RecordingPill.css";

const BARS = 28;
const PEAK_RATE = 8000; // plenty for a shape, and little to hold in memory
const LONGEST_DRAWN_SECONDS = 600;
const peakCache = new WeakMap<Blob, number[]>();

const PlayIcon = () => <svg className="rec-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor" /></svg>;
const StopIcon = () => <svg className="rec-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1" fill="currentColor" /></svg>;
const DeleteIcon = () => <svg className="rec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10.5 10.5v5.5M13.5 10.5v5.5" /></svg>;

/** The section's shape, drawn from its own audio once it's there. A flat line until then, or if it can't be read. */
function Wave({ section }: { section: RecordedSection }) {
  const [peaks, setPeaks] = useState<number[] | null>(() => peakCache.get(section.blob) ?? null);
  useEffect(() => {
    if (peaks || section.seconds > LONGEST_DRAWN_SECONDS) return;
    let live = true;
    void decodeMono(section.blob, PEAK_RATE).then((samples) => {
      const shape = peaksOf(samples, BARS);
      peakCache.set(section.blob, shape);
      if (live) setPeaks(shape);
    }).catch(() => {});
    return () => { live = false; };
  }, [section.blob]);
  return <svg className="rec-wave" viewBox={`0 0 ${BARS * 3} 20`} preserveAspectRatio="none" aria-hidden="true">
    {Array.from({ length: BARS }, (_, i) => {
      const height = Math.max(1.5, Math.sqrt(peaks?.[i] ?? 0) * 20);
      return <rect key={i} x={i * 3} y={(20 - height) / 2} width="2" height={height} rx="1" />;
    })}
  </svg>;
}

/** What a paused recording offers: hear a section, delete one, undo that, go on, or finish. */
function PausedCard({ title, controls, finish, overSidebar, onJump }: { title: string; controls: RecorderControls; finish: "send" | "save"; overSidebar: boolean; onJump: () => void }) {
  const [playing, setPlaying] = useState<number | null>(null);
  const [problem, setProblem] = useState("");
  const [said, setSaid] = useState("");
  const player = useRef<{ audio: HTMLAudioElement; url: string } | null>(null);
  const resumeButton = useRef<HTMLButtonElement>(null);
  const ready = controls.phase === "paused";
  const none = !controls.sections.length;

  function stopPlaying() {
    if (player.current) {
      player.current.audio.pause();
      URL.revokeObjectURL(player.current.url);
      player.current = null;
    }
    setPlaying(null);
  }
  function play(section: RecordedSection) {
    const same = playing === section.id;
    stopPlaying();
    if (same) return;
    const url = URL.createObjectURL(section.blob);
    const audio = new Audio(url);
    player.current = { audio, url };
    audio.onended = stopPlaying;
    setPlaying(section.id);
    setProblem("");
    void audio.play().catch(() => {
      if (player.current?.audio !== audio) return;
      stopPlaying();
      setProblem("That section couldn't play here. It's still kept.");
    });
  }
  useEffect(() => () => {
    if (player.current) { player.current.audio.pause(); URL.revokeObjectURL(player.current.url); player.current = null; }
  }, []);
  // The button that opened this is gone: once the section has landed, keyboard focus goes to the way back, and a screen reader hears it.
  useEffect(() => {
    if (!ready) return;
    resumeButton.current?.focus({ preventScroll: true });
    setSaid(`Paused. ${controls.sections.length} ${controls.sections.length === 1 ? "section" : "sections"} kept.`);
  }, [ready]);

  function remove(section: RecordedSection) {
    if (playing === section.id) stopPlaying();
    controls.removeSection(section.id);
    const left = controls.sections.length - 1;
    setSaid(`Section deleted. ${left} kept.`);
    resumeButton.current?.focus({ preventScroll: true }); // its own button is gone
  }
  function undo() {
    controls.undoRemove();
    setSaid(`Section back. ${controls.sections.length + 1} kept.`);
    resumeButton.current?.focus({ preventScroll: true });
  }
  function resume() {
    stopPlaying();
    setProblem("");
    controls.resume().catch(() => setProblem("The microphone isn't available. What you recorded is still here."));
  }

  return <div className={`recording-pill paused ${overSidebar ? "over-sidebar" : ""}`} role="group" aria-label="Paused recording">
    <div className="rec-head">
      <span className="rec-state">Paused</span>
      <span className="rec-time">{mmss(controls.elapsed)}</span>
      <button className="recording-destination" onClick={onJump} aria-label={`Jump to recording in ${title}`}>{title}</button>
      <span className="rec-said" role="status">{said}</span>
    </div>
    {none ? <p className="rec-empty">Nothing kept yet.</p> : <ol className="rec-sections">
      {controls.sections.map((section, i) => <li key={section.id} className={playing === section.id ? "playing" : undefined}>
        <button className="rec-row-button" onClick={() => play(section)} disabled={!ready} aria-label={`${playing === section.id ? "Stop playing" : "Play"} section ${i + 1}`}>
          {playing === section.id ? <StopIcon /> : <PlayIcon />}
        </button>
        <Wave section={section} />
        <span className="rec-seconds">{mmss(section.seconds)}</span>
        <button className="rec-row-button rec-delete" onClick={() => remove(section)} disabled={!ready} aria-label={`Delete section ${i + 1}`}><DeleteIcon /></button>
      </li>)}
    </ol>}
    {controls.canUndo && <button className="rec-undo" onClick={undo} disabled={!ready} aria-label="Undo delete">Undo delete</button>}
    {problem && <p className="rec-problem" role="alert">{problem}</p>}
    {/* Resume sits under the finger that tapped Pause: a second, quick tap can never send */}
    <div className="rec-actions">
      {none
        ? <button className="rec-finish" onClick={() => controls.discard()} disabled={!ready} aria-label="Discard recording">Discard</button>
        : <button className="rec-finish recording-stop" onClick={controls.stop} disabled={!ready} aria-label={`Stop and ${finish} recording for ${title}`}>Stop and {finish}</button>}
      <button ref={resumeButton} className="rec-resume" onClick={resume} disabled={!ready} aria-label="Resume recording">Resume</button>
    </div>
  </div>;
}

/** The recording, wherever you've gone in the app: its time and where it's going; paused, its sections. */
export default function RecordingPill({ title, controls, finish, overSidebar, onJump }: { title: string; controls: RecorderControls; finish: "send" | "save"; overSidebar: boolean; onJump: () => void }) {
  const { phase } = controls;
  const pauseButton = useRef<HTMLButtonElement>(null);
  const wasPaused = useRef(false);
  const onCard = phase === "pausing" || phase === "paused" || phase === "resuming";
  useEffect(() => {
    if (wasPaused.current && phase === "recording") pauseButton.current?.focus({ preventScroll: true });
    wasPaused.current = onCard;
  }, [phase]);
  if (onCard) return <PausedCard title={title} controls={controls} finish={finish} overSidebar={overSidebar} onJump={onJump} />;
  return <div className={`recording-pill ${overSidebar ? "over-sidebar" : ""}`} role="status" aria-live="polite">
    <span className="recording-dot" aria-hidden="true">●</span><span>{phase === "recording" ? mmss(controls.elapsed) : phase === "starting" ? "Starting…" : "Finishing…"}</span>
    <span className="recording-separator" aria-hidden="true">·</span>
    <button className="recording-destination" onClick={onJump} aria-label={`Jump to recording in ${title}`}>{title}</button>
    <span className="recording-separator" aria-hidden="true">·</span>
    <button ref={pauseButton} className="rec-pause" onClick={() => void controls.pause()} disabled={phase !== "recording"} aria-label="Pause recording">Pause</button>
    <span className="recording-separator" aria-hidden="true">·</span>
    <button className="recording-stop" onClick={controls.stop} disabled={phase !== "recording"} aria-label={`Stop recording for ${title}`}>Stop</button>
  </div>;
}
