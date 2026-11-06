import { useEffect, useRef, useState } from "react";
import { RecorderSession, type RecordedSection, type RecorderPhase } from "./recorderSession";

/** What a recording's controls need, whoever owns the recorder. */
export type RecorderControls = {
  phase: RecorderPhase;
  elapsed: number;
  sections: RecordedSection[];
  canUndo: boolean;
  stop: () => void;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  removeSection: (id: number) => void;
  undoRemove: () => void;
  discard: () => void;
};

/**
 * Voice recorder: tap to start, tap to stop; pause, resume and delete a section in between. Context belongs to the starting session.
 * `recording` stays true while paused, so whatever holds other actions back during a recording still does. `onDiscard`: it ended with nothing kept.
 */
export function useRecorder<Origin = void>(onDone: (blob: Blob, mime: string, origin: Origin) => void, label = "voice", onDiscard?: (origin: Origin) => void) {
  const [phase, setPhase] = useState<RecorderPhase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [sections, setSections] = useState<RecordedSection[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const timer = useRef<number | null>(null);
  const done = useRef(onDone);
  done.current = onDone;
  const discarded = useRef(onDiscard);
  discarded.current = onDiscard;
  const session = useRef<RecorderSession<Origin> | null>(null);
  if (!session.current) session.current = new RecorderSession<Origin>((blob, mime, origin) => done.current(blob, mime, origin), (next) => {
    if (next === "idle" && timer.current !== null) { clearInterval(timer.current); timer.current = null; }
    setPhase(next);
  }, {
    onDiscard: (origin) => discarded.current?.(origin),
    onChange: () => {
      setSections(session.current!.sections);
      setCanUndo(session.current!.canUndo);
      setElapsed(session.current!.elapsed());
    },
  });
  useEffect(() => () => {
    if (timer.current !== null) clearInterval(timer.current);
    session.current?.dispose();
  }, []);

  async function start(origin: Origin, forLabel?: string): Promise<boolean> {
    const started = await session.current!.start(origin, forLabel ?? label);
    if (!started) return false;
    setElapsed(0);
    timer.current = window.setInterval(() => setElapsed(session.current!.elapsed()), 250);
    return true;
  }
  function stop() {
    if (timer.current !== null) { clearInterval(timer.current); timer.current = null; }
    session.current?.stop();
  }
  return {
    recording: phase === "recording" || phase === "pausing" || phase === "paused" || phase === "resuming",
    paused: phase === "paused",
    busy: phase !== "idle", phase, elapsed, sections, canUndo, start, stop,
    pause: () => session.current!.pause(),
    resume: () => session.current!.resume(),
    removeSection: (id: number) => session.current!.removeSection(id),
    undoRemove: () => session.current!.undoRemove(),
    discard: () => session.current!.discard(),
    isBusy: () => session.current!.phase !== "idle",
  };
}

/** File name for a recording, by container type. */
export function voiceFileName(mime: string, d = new Date()): string {
  const ext = mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : mime.includes("wav") ? "wav" : "webm";
  const p = (n: number) => String(n).padStart(2, "0");
  return `voice-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}
