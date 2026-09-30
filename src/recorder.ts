import { useEffect, useRef, useState } from "react";
import { RecorderSession } from "./recorderSession";

/** Voice recorder: tap to start, tap to stop. Context belongs to the starting session. */
export function useRecorder<Origin = void>(onDone: (blob: Blob, mime: string, origin: Origin) => void, label = "voice") {
  const [phase, setPhase] = useState<RecorderSession<Origin>["phase"]>("idle");
  const [elapsed, setElapsed] = useState(0);
  const timer = useRef<number | null>(null);
  const done = useRef(onDone);
  done.current = onDone;
  const session = useRef<RecorderSession<Origin> | null>(null);
  if (!session.current) session.current = new RecorderSession<Origin>((blob, mime, origin) => done.current(blob, mime, origin), (next) => {
    if (next === "idle" && timer.current !== null) { clearInterval(timer.current); timer.current = null; }
    setPhase(next);
  });
  useEffect(() => () => {
    if (timer.current !== null) clearInterval(timer.current);
    session.current?.dispose();
  }, []);

  async function start(origin: Origin): Promise<boolean> {
    const started = await session.current!.start(origin, label);
    if (!started) return false;
    const t0 = Date.now();
    setElapsed(0);
    timer.current = window.setInterval(() => setElapsed((Date.now() - t0) / 1000), 250);
    return true;
  }
  function stop() {
    if (timer.current !== null) { clearInterval(timer.current); timer.current = null; }
    session.current?.stop();
  }
  return { recording: phase === "recording", busy: phase !== "idle", phase, elapsed, start, stop };
}

/** File name for a recording, by container type. */
export function voiceFileName(mime: string, d = new Date()): string {
  const ext = mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : mime.includes("wav") ? "wav" : "webm";
  const p = (n: number) => String(n).padStart(2, "0");
  return `voice-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}
