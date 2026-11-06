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
// Pause, resume and delete: every section is its own recorder on one held mic.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Time-limit cases: wait on the outcome, not a guess at how long a busy box takes. */
async function until(done: () => boolean) { for (let i = 0; i < 2000 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5)); }
async function editing(run: (ctx: { session: RecorderSession<string>; clips: { origin: string; text: string; mime: string }[]; discarded: string[]; clock: { now: number }; rec: () => FakeRecorder; stream: FakeStream; streams: () => number; joined: string[][] }) => Promise<void>, join?: (blobs: Blob[]) => Promise<Blob>) {
  const stream = new FakeStream();
  let asked = 0;
  const previousNav = globalThis.navigator, previousRec = globalThis.MediaRecorder;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: async () => { asked++; return asked === 1 ? stream : new FakeStream(); } } } });
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: FakeRecorder });
  FakeRecorder.instances = [];
  const clips: { origin: string; text: string; mime: string }[] = [], discarded: string[] = [], joined: string[][] = [], clock = { now: 0 };
  const session = new RecorderSession<string>((blob, mime, origin) => { void blob.text().then((text) => clips.push({ origin, text, mime })); }, () => {}, {
    onDiscard: (origin) => discarded.push(origin),
    now: () => clock.now,
    join: join ?? (async (blobs) => { joined.push(await Promise.all(blobs.map((b) => b.text()))); return new Blob(["joined"], { type: "audio/webm" }); }),
  });
  try { await run({ session, clips, discarded, clock, rec: () => FakeRecorder.instances[FakeRecorder.instances.length - 1], stream, streams: () => asked, joined }); }
  finally {
    session.dispose();
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNav });
    Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: previousRec });
  }
}
class FakeStream { stopped = 0; ended = false; muted = false; getTracks() { const s = this; return [{ get readyState() { return s.ended ? "ended" : "live"; }, get muted() { return s.muted; }, stop() { s.stopped++; } }]; } }

// No pause: the very same bytes, straight through, on one recorder (nothing a caller relied on moves)
await editing(async ({ session, clips, rec, joined }) => {
  await session.start("A", "for A");
  session.stop();
  rec().finish("as recorded");
  assert.equal(session.phase, "idle", "a recording with no pause finishes at once, as before");
  await tick();
  assert.deepEqual(clips.map((c) => c.text), ["as recorded"]);
  assert.equal(FakeRecorder.instances.length, 1);
  assert.deepEqual(joined, [], "nothing to join");
});

// Pause ends a section and keeps the mic; time paused doesn't count; resume is a new recorder on the same stream
await editing(async ({ session, clock, rec, stream, streams }) => {
  await session.start("A", "for A");
  clock.now = 3000;
  assert.equal(session.elapsed(), 3);
  const paused = session.pause();
  assert.equal(session.phase, "pausing");
  assert.equal(rec().state, "inactive", "the recorder really stopped: nothing is captured while paused");
  rec().finish("one");
  await paused;
  assert.equal(session.phase, "paused");
  assert.deepEqual(session.sections.map((s) => s.seconds), [3]);
  assert.equal(stream.stopped, 0, "the mic is held so resume is instant");
  assert.equal(recordingHolder(), "for A", "a paused recording still holds the mic against other recorders");
  clock.now = 60000;
  assert.equal(session.elapsed(), 3, "paused time isn't recording time");
  await session.resume();
  assert.equal(session.phase, "recording");
  assert.equal(FakeRecorder.instances.length, 2);
  assert.equal(rec().stream, stream);
  assert.equal(streams(), 1, "no second permission ask");
  clock.now = 62000;
  assert.equal(session.elapsed(), 5);
  session.stop();
});

// Keep everything: one join, one delivery, the mic released after
await editing(async ({ session, clips, rec, joined, stream }) => {
  await session.start("A", "for A");
  const p = session.pause(); rec().finish("one"); await p;
  await session.resume();
  session.stop();
  assert.equal(session.phase, "finishing");
  rec().finish("two");
  await tick(); await tick();
  assert.deepEqual(joined, [["one", "two"]]);
  assert.deepEqual(clips.map((c) => [c.origin, c.text]), [["A", "joined"]]);
  assert.equal(session.phase, "idle");
  assert.equal(stream.stopped, 1);
  assert.equal(recordingHolder(), null);
});

// Delete the last section, then any section; undo puts it back in its place; the time follows
await editing(async ({ session, clips, rec, clock, joined }) => {
  await session.start("A", "for A");
  for (const [i, name] of ["one", "two", "three"].entries()) {
    clock.now += 1000 * (i + 1);
    const p = session.pause(); rec().finish(name); await p;
    if (i < 2) await session.resume();
  }
  assert.equal(session.elapsed(), 6);
  const [one, two, three] = session.sections;
  session.removeSection(three.id);
  assert.deepEqual(session.sections, [one, two]);
  assert.equal(session.elapsed(), 3);
  session.removeSection(one.id);
  assert.deepEqual(session.sections, [two]);
  session.undoRemove();
  assert.deepEqual(session.sections, [one, two], "undo: back in its place");
  assert.equal(session.canUndo, true, "the first delete can be undone too");
  session.stop();
  await tick(); await tick();
  assert.deepEqual(joined, [["one", "two"]]);
  assert.deepEqual(clips.map((c) => c.text), ["joined"]);
});

// One section left after a delete: that section's own file, untouched, needs no join
await editing(async ({ session, clips, rec, joined }) => {
  await session.start("A", "for A");
  let p = session.pause(); rec().finish("keep"); await p;
  await session.resume();
  p = session.pause(); rec().finish("drop"); await p;
  session.removeSection(session.sections[1].id);
  session.stop();
  await tick();
  assert.deepEqual(clips.map((c) => c.text), ["keep"]);
  assert.deepEqual(joined, []);
  assert.equal(session.phase, "idle");
});

// Everything deleted, then Stop: nothing goes out, no "empty recording" error, and the caller is told
await editing(async ({ session, clips, discarded, rec, stream }) => {
  await session.start("A", "for A");
  const p = session.pause(); rec().finish("oops"); await p;
  session.removeSection(session.sections[0].id);
  session.stop();
  await tick();
  assert.deepEqual(clips, []);
  assert.deepEqual(discarded, ["A"]);
  assert.equal(session.phase, "idle");
  assert.equal(stream.stopped, 1);
  assert.equal(recordingHolder(), null);
});

// Discard while paused drops the lot
await editing(async ({ session, clips, discarded, rec, stream }) => {
  await session.start("A", "for A");
  const p = session.pause(); rec().finish("oops"); await p;
  session.discard();
  await tick();
  assert.deepEqual(clips, []);
  assert.deepEqual(discarded, ["A"]);
  assert.equal(session.phase, "idle");
  assert.equal(stream.stopped, 1);
  assert.deepEqual(session.sections, []);
  assert.equal(recordingHolder(), null);
});

// A join that fails loses nothing: each section goes out on its own
await editing(async ({ session, clips, rec }) => {
  await session.start("A", "for A");
  const p = session.pause(); rec().finish("one"); await p;
  await session.resume();
  session.stop();
  rec().finish("two");
  await tick(); await tick(); await tick();
  assert.deepEqual(clips.map((c) => c.text), ["one", "two"]);
  assert.equal(session.phase, "idle");
  assert.equal(recordingHolder(), null);
}, async () => { throw new Error("cannot join"); });

// Stop while the pause is still landing: the section lands, then it finishes; Stop twice sends once
await editing(async ({ session, clips, rec }) => {
  await session.start("A", "for A");
  void session.pause();
  session.stop();
  session.stop();
  assert.equal(session.phase, "finishing");
  rec().finish("only");
  await tick();
  assert.deepEqual(clips.map((c) => c.text), ["only"]);
  assert.equal(session.phase, "idle");
});

// The mic died while paused: resume asks again and keeps what's recorded; if it can't, it stays paused with the sections
await editing(async ({ session, rec, stream, streams }) => {
  await session.start("A", "for A");
  const p = session.pause(); rec().finish("one"); await p;
  stream.ended = true;
  await session.resume();
  assert.equal(streams(), 2);
  assert.notEqual(rec().stream, stream);
  assert.equal(session.phase, "recording");
  assert.equal(session.sections.length, 1);
  session.stop();
});
await editing(async ({ session, rec, stream }) => {
  await session.start("A", "for A");
  const p = session.pause(); rec().finish("one"); await p;
  stream.ended = true;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: async () => { throw new Error("denied"); } } } });
  await assert.rejects(session.resume(), /denied/);
  assert.equal(session.phase, "paused");
  assert.equal(session.sections.length, 1);
});

// The recorder stopping by itself (the mic unplugged): never paused, it delivers at once as it always has
await editing(async ({ session, clips, rec }) => {
  await session.start("A", "for A");
  rec().finish("whole");
  assert.equal(session.phase, "idle");
  await tick();
  assert.deepEqual(clips.map((c) => c.text), ["whole"]);
});
// ...but a recording that's been paused or edited lands paused: it isn't sent without the look it was paused for
await editing(async ({ session, clips, rec, joined }) => {
  await session.start("A", "for A");
  const p = session.pause(); rec().finish("one"); await p;
  await session.resume();
  rec().finish("two");
  assert.equal(session.phase, "paused");
  assert.equal(session.micLost, true, "and it says why");
  await tick(); await tick();
  assert.deepEqual(clips, []);
  assert.deepEqual(joined, []);
  assert.deepEqual(session.sections.length, 2);
  await session.resume();
  assert.equal(session.phase, "recording", "and it can go on");
  assert.equal(session.micLost, false);
  session.stop();
});
// ...even when the section that stopped held nothing, so one section is all there is
await editing(async ({ session, clips, rec }) => {
  await session.start("A", "for A");
  const p = session.pause(); rec().finish("one"); await p;
  await session.resume();
  rec().onstop?.(); // no data at all
  assert.equal(session.phase, "paused");
  await tick();
  assert.deepEqual(clips, []);
  assert.equal(session.sections.length, 1);
});

// Calls out of turn do nothing
await editing(async ({ session, rec }) => {
  await session.resume();
  await session.pause();
  session.discard();
  assert.equal(session.phase, "idle");
  await session.start("A", "for A");
  await session.resume();
  assert.equal(session.phase, "recording");
  assert.equal(FakeRecorder.instances.length, 1);
  session.removeSection(1);
  session.undoRemove();
  session.discard();
  assert.equal(session.phase, "recording", "discard is for a paused recording");
  session.stop();
  rec().finish("x");
});
// Review: a Stop that's joining when the owner goes away (the Journal tab closed) still delivers
await editing(async ({ session, clips, rec }) => {
  await session.start("A", "for A");
  const p = session.pause(); rec().finish("one"); await p;
  await session.resume();
  session.stop();
  rec().finish("two");
  session.dispose();
  await tick(); await tick(); await tick();
  assert.deepEqual(clips.map((c) => c.text), ["joined"], "nothing recorded and stopped is dropped");
});

// Review: while Stop's join runs, pause, resume and delete do nothing
await editing(async ({ session, clips, rec, joined }) => {
  await session.start("A", "for A");
  const p = session.pause(); rec().finish("one"); await p;
  await session.resume();
  session.stop();
  rec().finish("two");
  assert.equal(session.phase, "finishing");
  await session.pause(); await session.resume();
  session.removeSection(session.sections[0].id); session.undoRemove(); session.discard();
  assert.equal(session.phase, "finishing");
  assert.equal(session.sections.length, 2);
  assert.equal(FakeRecorder.instances.length, 2, "no new recorder");
  await tick(); await tick();
  assert.deepEqual(joined, [["one", "two"]], "both sections, once");
  assert.deepEqual(clips.map((c) => c.text), ["joined"]);
});

// Review: a muted mic is no mic; resume asks again and lets the old one go
await editing(async ({ session, rec, stream, streams }) => {
  await session.start("A", "for A");
  const p = session.pause(); rec().finish("one"); await p;
  stream.muted = true;
  await session.resume();
  assert.equal(streams(), 2);
  assert.notEqual(rec().stream, stream);
  assert.equal(stream.stopped, 1, "the old stream is released");
  session.stop();
});

// Review: a join that never answers (a decoder that hangs) ends in each section going out, and frees the mic
{
  const stream = new FakeStream();
  const previousNav = globalThis.navigator, previousRec = globalThis.MediaRecorder;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: async () => stream } } });
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: FakeRecorder });
  FakeRecorder.instances = [];
  const texts: string[] = [];
  const session = new RecorderSession<string>((blob) => { void blob.text().then((t) => texts.push(t)); }, () => {}, { join: () => new Promise<Blob>(() => {}), joinTimeoutMs: 5 });
  await session.start("A", "for A");
  const p = session.pause(); FakeRecorder.instances[0].finish("one"); await p;
  await session.resume();
  session.stop();
  FakeRecorder.instances[1].finish("two");
  await until(() => session.phase === "idle" && texts.length === 2);
  assert.deepEqual(texts, ["one", "two"]);
  assert.equal(session.phase, "idle");
  assert.equal(recordingHolder(), null);
  session.dispose();
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNav });
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: previousRec });
}

// Review: sections going out one by one go in turn, so the Journal's typed words land on the first entry only
{
  const stream = new FakeStream();
  const previousNav = globalThis.navigator, previousRec = globalThis.MediaRecorder;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: async () => stream } } });
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: FakeRecorder });
  FakeRecorder.instances = [];
  let note = "typed words";
  const saved: string[] = [];
  const session = new RecorderSession<string>(async () => { saved.push(note); await tick(); note = ""; }, () => {}, { join: async () => { throw new Error("cannot join"); } });
  await session.start("A", "for A");
  const p = session.pause(); FakeRecorder.instances[0].finish("one"); await p;
  await session.resume();
  session.stop();
  FakeRecorder.instances[1].finish("two");
  await until(() => session.phase === "idle");
  assert.deepEqual(saved, ["typed words", ""]);
  assert.equal(session.phase, "idle");
  session.dispose();
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNav });
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: previousRec });
}
// Review 2: Stop or a new owner while resume waits on the mic: the mic that turns up is let go, no recorder runs with no owner
{
  const stream = new FakeStream(), late = new FakeStream();
  let answer!: (s: FakeStream) => void;
  let asked = 0;
  const previousNav = globalThis.navigator, previousRec = globalThis.MediaRecorder;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: () => asked++ === 0 ? Promise.resolve(stream) : new Promise((r) => { answer = r; }) } } });
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: FakeRecorder });
  FakeRecorder.instances = [];
  const texts: string[] = [];
  const session = new RecorderSession<string>((blob) => { void blob.text().then((t) => texts.push(t)); });
  await session.start("A", "for A");
  const p = session.pause(); FakeRecorder.instances[0].finish("one"); await p;
  stream.ended = true;
  const resuming = session.resume();
  assert.equal(session.phase, "resuming");
  session.stop();
  await tick();
  assert.deepEqual(texts, ["one"]);
  assert.equal(session.phase, "idle");
  answer(late);
  await resuming;
  assert.equal(late.stopped, 1, "the late mic is released");
  assert.equal(FakeRecorder.instances.length, 1, "no recorder started");
  assert.equal(session.phase, "idle");
  session.dispose();
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNav });
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: previousRec });
}

// Review 2: a joined recording is handed over and the mic and lock are free at once, however long the caller's save takes
await (async () => {
  const stream = new FakeStream();
  const previousNav = globalThis.navigator, previousRec = globalThis.MediaRecorder;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: async () => stream } } });
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: FakeRecorder });
  FakeRecorder.instances = [];
  let handed = 0;
  const session = new RecorderSession<string>(() => { handed++; return new Promise<void>(() => {}); }, () => {}, { join: async () => new Blob(["joined"], { type: "audio/webm" }) });
  await session.start("A", "for A");
  const p = session.pause(); FakeRecorder.instances[0].finish("one"); await p;
  await session.resume();
  session.stop();
  FakeRecorder.instances[1].finish("two");
  await tick(); await tick();
  assert.equal(handed, 1);
  assert.equal(session.phase, "idle", "a slow save doesn't hold the recorder");
  assert.equal(recordingHolder(), null);
  session.dispose();
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNav });
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: previousRec });
})();

// Review 2: sections going out in turn wait for each save, but not forever
{
  const stream = new FakeStream();
  const previousNav = globalThis.navigator, previousRec = globalThis.MediaRecorder;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: async () => stream } } });
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: FakeRecorder });
  FakeRecorder.instances = [];
  let handed = 0;
  const session = new RecorderSession<string>(() => { handed++; return new Promise<void>(() => {}); }, () => {}, { join: async () => { throw new Error("no"); }, deliveryTimeoutMs: 5 });
  await session.start("A", "for A");
  const p = session.pause(); FakeRecorder.instances[0].finish("one"); await p;
  await session.resume();
  session.stop();
  FakeRecorder.instances[1].finish("two");
  await until(() => session.phase === "idle");
  assert.equal(handed, 2);
  assert.equal(session.phase, "idle");
  session.dispose();
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNav });
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: previousRec });
}
// Review 3: discard works while resume waits on a mic that may never answer: the card is never a dead end
{
  const stream = new FakeStream(), late = new FakeStream();
  let answer!: (s: FakeStream) => void;
  let asked = 0;
  const previousNav = globalThis.navigator, previousRec = globalThis.MediaRecorder;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: () => asked++ === 0 ? Promise.resolve(stream) : new Promise((r) => { answer = r; }) } } });
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: FakeRecorder });
  FakeRecorder.instances = [];
  const discarded: string[] = [];
  const session = new RecorderSession<string>(() => { throw new Error("nothing is delivered"); }, () => {}, { onDiscard: (o) => discarded.push(o) });
  await session.start("A", "for A");
  const p = session.pause(); FakeRecorder.instances[0].finish("one"); await p;
  stream.ended = true;
  const resuming = session.resume();
  session.discard();
  assert.equal(session.phase, "idle");
  assert.deepEqual(discarded, ["A"]);
  assert.equal(recordingHolder(), null);
  answer(late);
  await resuming;
  assert.equal(late.stopped, 1);
  assert.equal(session.phase, "idle");
  session.dispose();
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNav });
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: previousRec });
}

// Review 3: the owner going away during the one-by-one fallback still delivers every section
await editing(async ({ session, clips, rec }) => {
  await session.start("A", "for A");
  const p = session.pause(); rec().finish("one"); await p;
  await session.resume();
  session.stop();
  rec().finish("two");
  session.dispose();
  await tick(); await tick(); await tick(); await tick();
  assert.deepEqual(clips.map((c) => c.text), ["one", "two"]);
}, async () => { throw new Error("cannot join"); });

console.log("recorder tests passed");
