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
};

const MIC = { audio: { echoCancellation: true, noiseSuppression: true } };

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
  phase: RecorderPhase = "idle";
  sections: RecordedSection[] = [];

  private onDone: (blob: Blob, mime: string, origin: Origin) => void;
  private onPhase: (phase: RecorderPhase) => void;
  private options: RecorderOptions<Origin>;
  constructor(onDone: (blob: Blob, mime: string, origin: Origin) => void,
              onPhase: (phase: RecorderPhase) => void = () => {},
              options: RecorderOptions<Origin> = {}) {
    this.onDone = onDone;
    this.onPhase = onPhase;
    this.options = options;
  }

  updateDone(onDone: (blob: Blob, mime: string, origin: Origin) => void) { this.onDone = onDone; }

  private setPhase(phase: RecorderPhase) {
    this.phase = phase;
    if (!this.disposed) this.onPhase(phase);
  }
  private changed() { if (!this.disposed) this.options.onChange?.(); }
  private now() { return this.options.now ? this.options.now() : performance.now(); }
  private stopStream(stream = this.stream) { stream?.getTracks().forEach((t) => t.stop()); }

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
    if (this.afterSection === "pause") {
      this.afterSection = null;
      this.setPhase("paused");
    } else {
      this.afterSection = null;
      void this.finish();
    }
    landed?.();
  }

  private reset() {
    this.stream = null;
    this.origin = null;
    this.sections = [];
    this.removed = [];
    this.changed();
    releaseRecording(this.token);
    this.setPhase("idle");
  }

  /** Hand over what was kept. A join that fails hands over each section: nothing recorded is lost. */
  private async finish() {
    this.stopStream();
    const origin = this.origin as Origin, sections = this.sections, type = this.lastType;
    try {
      if (this.disposed) return;
      if (!sections.length) {
        if (this.removed.length) this.options.onDiscard?.(origin);
        else this.onDone(new Blob([], { type }), type, origin);
      } else if (sections.length === 1) {
        this.onDone(sections[0].blob, sections[0].blob.type, origin);
      } else {
        let joined: Blob | null = null;
        try { joined = await (this.options.join ?? joinSections)(sections.map((s) => s.blob)); }
        catch (e) { console.warn("Recording sections could not be joined; sending each", e); }
        if (this.disposed) return;
        if (joined) this.onDone(joined, joined.type, origin);
        else for (const s of sections) this.onDone(s.blob, s.blob.type, origin);
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
    if (this.phase !== "recording" || !this.recorder || this.activeSince === null) return;
    this.activeSeconds = (this.now() - this.activeSince) / 1000;
    this.activeSince = null;
    this.afterSection = "pause";
    this.setPhase("pausing");
    const recorder = this.recorder;
    await new Promise<void>((resolve) => {
      this.pauseLanded = resolve;
      recorder.stop();
    });
  }

  /** Start the next section. If the mic was lost while paused it's asked for again; failing that, still paused, sections kept. */
  async resume(): Promise<void> {
    if (this.phase !== "paused") return;
    this.setPhase("resuming");
    try {
      let stream = this.stream;
      if (!stream || !stream.getTracks().some((t) => t.readyState !== "ended")) {
        stream = await navigator.mediaDevices.getUserMedia(MIC);
        if (this.disposed || this.phase !== "resuming") { this.stopStream(stream); return; }
        this.stream = stream;
      }
      this.beginSection(stream);
      this.setPhase("recording");
    } catch (e) {
      if (this.phase === "resuming") this.setPhase("paused");
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
    if (this.phase !== "paused") return;
    const origin = this.origin as Origin;
    this.stopStream();
    try { if (!this.disposed) this.options.onDiscard?.(origin); }
    finally { this.reset(); }
  }

  stop() {
    if (this.phase === "recording" && this.recorder) {
      if (this.activeSince !== null) {
        this.activeSeconds = (this.now() - this.activeSince) / 1000;
        this.activeSince = null;
      }
      this.afterSection = "finish";
      this.setPhase("finishing");
      if (this.recorder.state !== "inactive") this.recorder.stop();
    } else if (this.phase === "pausing") {
      this.afterSection = "finish";
      this.setPhase("finishing");
    } else if (this.phase === "paused" || this.phase === "resuming") {
      this.setPhase("finishing");
      void this.finish();
    }
  }

  dispose() {
    this.disposed = true;
    this.stopStream();
    releaseRecording(this.token);
  }
}
