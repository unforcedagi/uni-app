import { pickAudioMime } from "./journalCore.ts";
import { claimRecording, releaseRecording } from "./recLock.ts";

/** Keeps the microphone and its starting destination owned until onstop completes. */
export class RecorderSession<Origin> {
  private token = {};
  private recorder: MediaRecorder | null = null;
  private disposed = false;
  phase: "idle" | "starting" | "recording" | "finishing" = "idle";

  private onDone: (blob: Blob, mime: string, origin: Origin) => void;
  private onPhase: (phase: RecorderSession<Origin>["phase"]) => void;
  constructor(onDone: (blob: Blob, mime: string, origin: Origin) => void,
              onPhase: (phase: RecorderSession<Origin>["phase"]) => void = () => {}) {
    this.onDone = onDone;
    this.onPhase = onPhase;
  }

  updateDone(onDone: (blob: Blob, mime: string, origin: Origin) => void) { this.onDone = onDone; }

  private setPhase(phase: RecorderSession<Origin>["phase"]) {
    this.phase = phase;
    if (!this.disposed) this.onPhase(phase);
  }

  async start(origin: Origin, label: string): Promise<boolean> {
    if (this.disposed || this.phase !== "idle") return false;
    this.setPhase("starting");
    try {
      claimRecording(this.token, label);
      const mime = pickAudioMime((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t));
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (this.disposed) { stream.getTracks().forEach((t) => t.stop()); return false; }
      let recorder: MediaRecorder;
      try { recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined); }
      catch (e) { stream.getTracks().forEach((t) => t.stop()); throw e; }
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const type = recorder.mimeType || mime || "audio/webm";
        try { if (!this.disposed) this.onDone(new Blob(chunks, { type }), type, origin); }
        finally {
          if (this.recorder === recorder) this.recorder = null;
          releaseRecording(this.token);
          this.setPhase("idle");
        }
      };
      try { recorder.start(1000); }
      catch (e) { stream.getTracks().forEach((t) => t.stop()); throw e; }
      this.recorder = recorder;
      this.setPhase("recording");
      return true;
    } catch (e) {
      releaseRecording(this.token);
      this.setPhase("idle");
      throw e;
    }
  }

  stop() {
    if (this.phase !== "recording" || !this.recorder) return;
    this.setPhase("finishing");
    if (this.recorder.state !== "inactive") this.recorder.stop();
  }

  dispose() {
    this.disposed = true;
    this.recorder?.stream.getTracks().forEach((t) => t.stop());
    releaseRecording(this.token);
  }
}
