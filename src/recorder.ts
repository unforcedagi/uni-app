import { useEffect, useRef, useState } from "react";
import { pickAudioMime } from "./journalCore";
import { claimRecording, releaseRecording } from "./recLock";

/** Voice recorder: tap to start, tap to stop. Hands back the audio blob. */
export function useRecorder(onDone: (blob: Blob, mime: string) => void, label = "voice") {
  const token = useRef({});
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const timer = useRef<number | null>(null);
  const starting = useRef(false);
  // Latest callback: onstop fires long after start() ran, and must see the
  // text typed during the recording, not the text at the moment it began.
  const done = useRef(onDone);
  done.current = onDone;

  const stopTracks = () => rec.current?.stream.getTracks().forEach((t) => t.stop());
  useEffect(() => () => { stopTracks(); if (timer.current) clearInterval(timer.current); releaseRecording(token.current); }, []);

  async function start() {
    // A second tap while the permission prompt is up would open a second
    // stream and orphan the first (the mic would stay on).
    if (starting.current || rec.current?.state === "recording") return;
    starting.current = true;
    try { claimRecording(token.current, label); await begin(); }
    catch (e) { releaseRecording(token.current); throw e; }
    finally { starting.current = false; }
  }

  async function begin() {
    const mime = pickAudioMime((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t));
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    let r: MediaRecorder;
    try { r = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined); }
    catch (e) { stream.getTracks().forEach((t) => t.stop()); throw e; }
    const chunks: Blob[] = [];
    r.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    r.onstop = () => {
      r.stream.getTracks().forEach((t) => t.stop());
      const type = (r.mimeType || mime || "audio/webm");
      try { done.current(new Blob(chunks, { type }), type); }
      finally { rec.current = null; releaseRecording(token.current); }
    };
    rec.current = r;
    try { r.start(1000); }
    catch (e) { stream.getTracks().forEach((t) => t.stop()); rec.current = null; throw e; }
    const t0 = Date.now();
    setElapsed(0);
    timer.current = window.setInterval(() => setElapsed((Date.now() - t0) / 1000), 250);
    setRecording(true);
  }
  function stop() {
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
    setRecording(false);
    if (rec.current && rec.current.state !== "inactive") rec.current.stop();
  }
  return { recording, elapsed, start, stop };
}

/** File name for a recording, by container type. */
export function voiceFileName(mime: string, d = new Date()): string {
  const ext = mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : mime.includes("wav") ? "wav" : "webm";
  const p = (n: number) => String(n).padStart(2, "0");
  return `voice-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}
