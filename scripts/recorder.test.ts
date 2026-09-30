// Run: node --experimental-strip-types scripts/recorder.test.ts
import assert from "node:assert/strict";
import { RecorderSession } from "../src/recorderSession.ts";
import { recordingHolder } from "../src/recLock.ts";

const tracks = { stopped: 0, getTracks() { return [{ stop: () => { this.stopped++; } }]; } };
let resolvePermission!: (stream: typeof tracks) => void;
let permission = new Promise<typeof tracks>((resolve) => { resolvePermission = resolve; });
const previousNavigator = globalThis.navigator;
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: () => permission } } });
class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static isTypeSupported(_mime: string) { return true; }
  state = "inactive";
  mimeType = "audio/webm";
  onstop: (() => void) | null = null;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  stream: typeof tracks;
  constructor(stream: typeof tracks) { this.stream = stream; FakeRecorder.instances.push(this); }
  start() { this.state = "recording"; }
  stop() { this.state = "inactive"; }
  finish(text: string) { this.ondataavailable?.({ data: new Blob([text]) }); this.onstop?.(); }
}
const previousRecorder = globalThis.MediaRecorder;
Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: FakeRecorder });
try {
  const clips: { origin: string; text: string }[] = [];
  const session = new RecorderSession<string>((blob, _mime, origin) => { void blob.text().then((text) => clips.push({ origin, text })); });
  const pending = session.start("A", "for A");
  assert.equal(session.phase, "starting");
  assert.equal(await session.start("B", "for B"), false);
  assert.equal(FakeRecorder.instances.length, 0);
  resolvePermission(tracks);
  assert.equal(await pending, true);
  const first = FakeRecorder.instances[0];
  session.stop();
  assert.equal(session.phase, "finishing");
  assert.equal(await session.start("B", "for B"), false);
  assert.equal(FakeRecorder.instances.length, 1);
  assert.equal(recordingHolder(), "for A");
  first.finish("clip A");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(clips, [{ origin: "A", text: "clip A" }]);
  assert.equal(session.phase, "idle");
  assert.equal(recordingHolder(), null);
  permission = Promise.resolve(tracks);
  assert.equal(await session.start("B", "for B"), true);
  session.stop();
  FakeRecorder.instances[1].finish("clip B");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(clips, [{ origin: "A", text: "clip A" }, { origin: "B", text: "clip B" }]);
  assert.equal(tracks.stopped, 2);
  session.dispose();
} finally {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: previousRecorder });
}
console.log("recorder tests passed");
