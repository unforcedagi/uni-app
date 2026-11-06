import { pickAudioMime } from "./journalCore.ts";
import { claimRecording, releaseRecording } from "./recLock.ts";
import { joinSections } from "./recordingJoin.ts";

export type RecorderPhase = "idle" | "starting" | "recording" | "pausing" | "paused" | "resuming" | "finishing";
/** A stretch between two pauses: its own whole file, until the recording finishes. */
export type RecordedSection = { id: number; blob: Blob; seconds: number };
export type RecorderOptions<Origin> = {
  /** The recording ended with nothing kept: every section deleted, or discarded while paused. */
  onDiscard?: (origin: Origin) => void;
  /** The sections, or what can be undone, changed. */
  onChange?: () => void;
  now?: () => number;
  join?: (blobs: Blob[]) => Promise<Blob>;
  joinTimeoutMs?: number;
  deliveryTimeoutMs?: number;
  micHoldMs?: number;
};

const MIC = { audio: { echoCancellation: true, noiseSuppression: true } };
/** Longer than any decode that's working: a join that never answers must not hold the mic and the recording. */
const JOIN_TIMEOUT_MS = 120_000;
/** Sections going out one by one wait for each save, so its typed words land once; a save that hangs doesn't hold the rest. */
const DELIVERY_TIMEOUT_MS = 30_000;
/** A short pause keeps the mic so resume is instant. After this it's let go, so a recording left paused doesn't hold it; resume asks again. */
const MIC_HOLD_MS = 60_000;

/**
 * Keeps the microphone and its starting destination owned until the recording finishes.
 * Each section is its own recorder on one held stream: pausing ends a section (nothing is captured while paused),
 * resuming starts the next. A recording never paused is one recorder's file, delivered as it came.
 */
export class RecorderSession<Origin> {
  private token = {};
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private origin: Origin | null = null;
  private mime = "";
  private lastType = "audio/webm";
  private disposed = false;
  private nextId = 1;
  private removed: RecordedSection[] = [];
  private activeSince: number | null = null;
  private activeSeconds = 0;
  private afterSection: "pause" | "finish" | null = null;
  private pauseLanded: (() => void) | null = null;
  private everPaused = false;
  private micHold: ReturnType<typeof setTimeout> | null = null;
  phase: RecorderPhase = "idle";
  /** Paused because the mic went, not by choice. */
  micLost = false;
  sections: RecordedSection[] = [];

  private onDone: (blob: Blob, mime: string, origin: Origin) => void | Promise<void>;
  private onPhase: (phase: RecorderPhase) => void;
  private options: RecorderOptions<Origin>;
  constructor(onDone: (blob: Blob, mime: string, origin: Origin) => void | Promise<void>,
              onPhase: (phase: RecorderPhase) => void = () => {},
              options: RecorderOptions<Origin> = {}) {
    this.onDone = onDone;
    this.onPhase = onPhase;
    this.options = options;
  }

  updateDone(onDone: (blob: Blob, mime: string, origin: Origin) => void | Promise<void>) { this.onDone = onDone; }

  private setPhase(phase: RecorderPhase) {
    this.phase = phase;
    if (!this.disposed) this.onPhase(phase);
  }
  private changed() { if (!this.disposed) this.options.onChange?.(); }
  private now() { return this.options.now ? this.options.now() : performance.now(); }
  /** The phase now: it can move while a call waits on the mic. */
  private phaseNow(): RecorderPhase { return this.phase; }
  private stopStream(stream = this.stream) { stream?.getTracks().forEach((t) => t.stop()); }

  private holdMic() {
    this.keepMic();
    this.micHold = setTimeout(() => {
      this.micHold = null;
      if (this.phase !== "paused") return;
      this.stopStream();
      this.stream = null;
    }, this.options.micHoldMs ?? MIC_HOLD_MS);
  }
  private keepMic() {
    if (this.micHold !== null) clearTimeout(this.micHold);
    this.micHold = null;
  }
  private captureActive() {
    if (this.activeSince === null) return;
    this.activeSeconds = (this.now() - this.activeSince) / 1000;
    this.activeSince = null;
  }

  /** Seconds kept so far: paused time and deleted sections don't count. */
  elapsed(): number {
    const kept = this.sections.reduce((n, s) => n + s.seconds, 0);
    return kept + (this.activeSince !== null ? (this.now() - this.activeSince) / 1000 : this.activeSeconds);
  }
  get canUndo() { return this.removed.length > 0; }

  private beginSection(stream: MediaStream) {
    const recorder = new MediaRecorder(stream, this.mime ? { mimeType: this.mime, audioBitsPerSecond: 32000 } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => this.sectionEnded(recorder, chunks);
    recorder.start(1000);
    this.recorder = recorder;
    this.activeSince = this.now();
    this.activeSeconds = 0;
  }

  private sectionEnded(recorder: MediaRecorder, chunks: Blob[]) {
    if (this.recorder === recorder) this.recorder = null;
    const seconds = this.activeSince !== null ? (this.now() - this.activeSince) / 1000 : this.activeSeconds;
    this.activeSince = null;
    this.activeSeconds = 0;
    this.lastType = recorder.mimeType || this.mime || "audio/webm";
    if (chunks.length) {
      this.sections = [...this.sections, { id: this.nextId++, blob: new Blob(chunks, { type: this.lastType }), seconds }];
      this.changed();
    }
    const landed = this.pauseLanded;
    this.pauseLanded = null;
    // The recorder stopped by itself (the mic went): a recording that's been paused or edited isn't sent without its look.
    if (this.afterSection === "pause" || (this.afterSection === null && this.everPaused)) {
      this.micLost = this.afterSection === null;
      this.afterSection = null;
      if (this.micLost) this.changed();
      this.holdMic();
      this.setPhase("paused");
    } else {
      this.afterSection = null;
      void this.finish();
    }
    landed?.();
  }

  private reset() {
    this.keepMic();
    this.stream = null;
    this.origin = null;
    this.sections = [];
    this.removed = [];
    this.everPaused = false;
    this.micLost = false;
    this.changed();
    releaseRecording(this.token);
    this.setPhase("idle");
  }

  /** Join with a time limit; null when that can't be done. */
  private async joined(sections: RecordedSection[]): Promise<Blob | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), this.options.joinTimeoutMs ?? JOIN_TIMEOUT_MS); });
    try { return await Promise.race([(this.options.join ?? joinSections)(sections.map((s) => s.blob)), timeout]); }
    catch (e) { console.warn("Recording sections could not be joined; sending each", e); return null; }
    finally { clearTimeout(timer); }
  }

  private async deliverInTurn(blob: Blob, origin: Origin) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const enough = new Promise<void>((resolve) => { timer = setTimeout(resolve, this.options.deliveryTimeoutMs ?? DELIVERY_TIMEOUT_MS); });
    try { await Promise.race([this.onDone(blob, blob.type, origin), enough]); }
    catch (e) { console.warn("A section's delivery failed", e); }
    finally { clearTimeout(timer); }
  }

  /**
   * Hand over what was kept. A join that fails hands over each section, in turn: nothing recorded is lost.
   * Once a join is under way it's delivered even if the owner goes away meanwhile (the Journal tab closed).
   */
  private async finish() {
    this.stopStream();
    if (this.phase !== "finishing") this.setPhase("finishing");
    const origin = this.origin as Origin, sections = this.sections, type = this.lastType;
    try {
      if (this.disposed) return;
      if (!sections.length) {
        if (this.removed.length) this.options.onDiscard?.(origin);
        else void this.onDone(new Blob([], { type }), type, origin);
      } else if (sections.length === 1) {
        void this.onDone(sections[0].blob, sections[0].blob.type, origin); // nothing to wait for: finishes at once, as it always has
      } else {
        const joined = await this.joined(sections);
        if (joined) void this.onDone(joined, joined.type, origin);
        else for (const s of sections) await this.deliverInTurn(s.blob, origin);
      }
    } finally { this.reset(); }
  }

  async start(origin: Origin, label: string): Promise<boolean> {
    if (this.disposed || this.phase !== "idle") return false;
    this.setPhase("starting");
    try {
      claimRecording(this.token, label);
      this.mime = pickAudioMime((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t));
      const stream = await navigator.mediaDevices.getUserMedia(MIC);
      if (this.disposed) { this.stopStream(stream); return false; }
      try { this.beginSection(stream); }
      catch (e) { this.stopStream(stream); throw e; }
      this.stream = stream;
      this.origin = origin;
      this.setPhase("recording");
      return true;
    } catch (e) {
      releaseRecording(this.token);
      this.setPhase("idle");
      throw e;
    }
  }

  /** End the current section and hold the mic. Resolves once the section is in `sections`. */
  async pause(): Promise<void> {
    if (this.phase !== "recording" || !this.recorder) return;
    this.captureActive();
    this.afterSection = "pause";
    this.everPaused = true;
    this.setPhase("pausing");
    const recorder = this.recorder;
    await new Promise<void>((resolve) => {
      this.pauseLanded = resolve;
      if (recorder.state !== "inactive") recorder.stop();
    });
  }

  /** Start the next section. If the mic was lost while paused it's asked for again; failing that, still paused, sections kept. */
  async resume(): Promise<void> {
    if (this.phase !== "paused") return;
    this.keepMic();
    this.setPhase("resuming");
    try {
      let stream = this.stream;
      if (!stream || !stream.getTracks().some((t) => t.readyState !== "ended" && !t.muted)) {
        const lost = stream;
        stream = await navigator.mediaDevices.getUserMedia(MIC);
        if (this.disposed || this.phaseNow() !== "resuming") { this.stopStream(stream); return; }
        this.stopStream(lost);
        this.stream = stream;
      }
      this.beginSection(stream);
      this.micLost = false;
      this.changed();
      this.setPhase("recording");
    } catch (e) {
      if (this.phaseNow() === "resuming") { this.holdMic(); this.setPhase("paused"); }
      throw e;
    }
  }

  /** Delete a section while paused. It can be undone until the recording finishes. */
  removeSection(id: number) {
    if (this.phase !== "paused") return;
    const section = this.sections.find((s) => s.id === id);
    if (!section) return;
    this.sections = this.sections.filter((s) => s !== section);
    this.removed = [...this.removed, section];
    this.changed();
  }

  /** The last delete, undone: sections stay in the order they were recorded. */
  undoRemove() {
    if (this.phase !== "paused") return;
    const section = this.removed[this.removed.length - 1];
    if (!section) return;
    this.removed = this.removed.slice(0, -1);
    this.sections = [...this.sections, section].sort((a, b) => a.id - b.id);
    this.changed();
  }

  /** Drop the whole paused recording: nothing goes out. */
  discard() {
    if (this.phase !== "paused" && this.phase !== "resuming") return;
    const origin = this.origin as Origin;
    this.stopStream();
    try { if (!this.disposed) this.options.onDiscard?.(origin); }
    finally { this.reset(); }
  }

  stop() {
    if (this.phase === "recording" && this.recorder) {
      this.captureActive();
      this.afterSection = "finish";
      this.setPhase("finishing");
      if (this.recorder.state !== "inactive") this.recorder.stop();
    } else if (this.phase === "pausing") {
      this.afterSection = "finish";
      this.setPhase("finishing");
    } else if (this.phase === "paused" || this.phase === "resuming") {
      void this.finish();
    }
  }

  dispose() {
    this.disposed = true;
    this.keepMic();
    this.stopStream();
    releaseRecording(this.token);
  }
}
