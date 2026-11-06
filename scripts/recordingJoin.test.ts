// Run: node --experimental-strip-types scripts/recordingJoin.test.ts
// The container logic behind pause/resume: the sections of one recording become one valid file.
// Real recordings go through the same code in scripts/browser/recPause.spec.ts (ffprobe on the result).
import assert from "node:assert/strict";
import { encodeWav, joinSections, joinWebm, NotJoinable, peaksOf } from "../src/recordingJoin.ts";

// --- a small EBML writer, the shape a MediaRecorder writes ---
const UNKNOWN = -1;
function idBytes(id: number): number[] { const out: number[] = []; for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256); return out; }
function sizeBytes(n: number): number[] {
  if (n === UNKNOWN) return [0x01, 255, 255, 255, 255, 255, 255, 255];
  if (n < 127) return [0x80 | n];
  return [0x10 | (n >>> 24), (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}
function el(id: number, body: number[], size?: number): number[] { return [...idBytes(id), ...sizeBytes(size ?? body.length), ...body]; }
const text = (s: string) => [...new TextEncoder().encode(s)];
const uint = (n: number, width = 2) => { const out: number[] = []; for (let i = width - 1; i >= 0; i--) out.push(Math.floor(n / 256 ** i) % 256); return out; };
const EBML = 0x1A45DFA3, SEGMENT = 0x18538067, INFO = 0x1549A966, TRACKS = 0x1654AE6B, CLUSTER = 0x1F43B675, CUES = 0x1C53BB6B, SEEK = 0x114D9B74;
const SCALE = 0x2AD7B1, DURATION = 0x4489, ENTRY = 0xAE, TRACKNO = 0xD7, TRACKUID = 0x73C5, CODEC = 0x86, AUDIO = 0xE1, TIMECODE = 0xE7, BLOCK = 0xA3, PREVSIZE = 0xAB;
const header = () => el(EBML, [...el(0x4282, text("webm"))]);
const info = () => el(INFO, [...el(SCALE, uint(1_000_000, 3)), ...el(0x4D80, text("test"))]);
const tracks = (uid: number, codec = "A_OPUS", channels = 1) => el(TRACKS, el(ENTRY, [...el(TRACKNO, [1]), ...el(TRACKUID, uint(uid, 4)), ...el(CODEC, text(codec)), ...el(AUDIO, el(0x9F, [channels]))]));
const block = (rel: number, payload: number) => el(BLOCK, [0x81, ...uint(rel), 0x80, payload, payload]);
const cluster = (tc: number, blocks: number[][], known = false, prefix: number[] = []) => {
  const body = [...prefix, ...el(TIMECODE, uint(tc)), ...blocks.flat()];
  return el(CLUSTER, body, known ? undefined : UNKNOWN);
};
function file(uid: number, clusters: number[][], opts: { knownSegment?: boolean; codec?: string; channels?: number; extra?: number[]; noHeader?: boolean } = {}): Uint8Array {
  const body = [...(opts.extra ?? []), ...info(), ...tracks(uid, opts.codec, opts.channels), ...clusters.flat()];
  return new Uint8Array([...(opts.noHeader ? [] : header()), ...el(SEGMENT, body, opts.knownSegment ? undefined : UNKNOWN)]);
}

// --- a small reader for what came out ---
type Node = { id: number; start: number; end: number; bodyStart: number; unknown: boolean };
function readNodes(b: Uint8Array, from: number, to: number): Node[] {
  const out: Node[] = [];
  for (let p = from; p < to;) {
    let idLen = 1; while (!(b[p] & (0x80 >> (idLen - 1)))) idLen++;
    let id = 0; for (let i = 0; i < idLen; i++) id = id * 256 + b[p + i];
    let sizeLen = 1; while (!(b[p + idLen] & (0x80 >> (sizeLen - 1)))) sizeLen++;
    let size = b[p + idLen] & (0xFF >> sizeLen), allOnes = size === (0xFF >> sizeLen);
    for (let i = 1; i < sizeLen; i++) { size = size * 256 + b[p + idLen + i]; allOnes &&= b[p + idLen + i] === 255; }
    const bodyStart = p + idLen + sizeLen, end = allOnes ? to : bodyStart + size;
    out.push({ id, start: p, end, bodyStart, unknown: allOnes });
    p = end;
  }
  return out;
}
function parsed(b: Uint8Array) {
  const top = readNodes(b, 0, b.length);
  assert.deepEqual(top.map((n) => n.id), [EBML, SEGMENT], "one header, one segment, nothing after");
  assert.equal(top[1].unknown, false, "the segment says its size");
  const kids = readNodes(b, top[1].bodyStart, top[1].end);
  const blocks: { at: number; payload: number }[] = [];
  const clusterIds: number[] = [];
  for (const c of kids.filter((n) => n.id === CLUSTER)) {
    assert.equal(c.unknown, false, "each cluster says its size");
    clusterIds.push(c.id);
    const parts = readNodes(b, c.bodyStart, c.end);
    assert.equal(parts[0].id, TIMECODE, "a cluster opens with its timecode");
    assert.ok(!parts.some((n) => n.id === PREVSIZE), "a stale PrevSize is dropped");
    let tc = 0; for (let i = parts[0].bodyStart; i < parts[0].end; i++) tc = tc * 256 + b[i];
    for (const s of parts.filter((n) => n.id === BLOCK)) {
      const rel = (b[s.bodyStart + 1] << 8) | b[s.bodyStart + 2];
      blocks.push({ at: tc + (rel > 32767 ? rel - 65536 : rel), payload: b[s.bodyStart + 4] });
    }
  }
  const infoNode = kids.find((n) => n.id === INFO)!;
  const dur = readNodes(b, infoNode.bodyStart, infoNode.end).find((n) => n.id === DURATION);
  assert.ok(dur, "Info carries a Duration");
  const duration = new DataView(b.buffer, b.byteOffset + dur!.bodyStart, dur!.end - dur!.bodyStart).getFloat64(0);
  return { ids: kids.map((n) => n.id), blocks, duration };
}

// 1. Two sections, the way Chromium writes them (unknown sizes, its own track id each)
{
  const a = file(111, [cluster(0, [block(0, 1), block(60, 2)]), cluster(120, [block(0, 3)])]);
  const b = file(222, [cluster(0, [block(0, 4), block(60, 5)])]);
  const { bytes, durationMs } = joinWebm([a, b]);
  const out = parsed(bytes);
  assert.deepEqual(out.ids.filter((id) => id === INFO || id === TRACKS), [INFO, TRACKS], "one Info, one Tracks");
  assert.deepEqual(out.blocks.map((x) => x.payload), [1, 2, 3, 4, 5], "every block, in order");
  assert.deepEqual(out.blocks.map((x) => x.at), [0, 60, 120, 180, 240], "the second section starts one frame after the first ends");
  assert.equal(durationMs, 300);
  assert.equal(out.duration, 300);
}
// 2. A section whose clock doesn't start at zero starts where the last one ended
{
  const a = file(1, [cluster(0, [block(0, 1), block(20, 2)])]);
  const b = file(2, [cluster(5000, [block(0, 3), block(20, 4)])]);
  const out = parsed(joinWebm([a, b]).bytes);
  assert.deepEqual(out.blocks.map((x) => x.at), [0, 20, 40, 60]);
  assert.equal(out.duration, 80);
}
// 3. Known sizes, an index and a seek head (other muxers): the stale index goes, the audio stays
{
  const cues = el(CUES, [1, 2, 3]), seek = el(SEEK, [1, 2, 3]);
  const a = file(1, [cluster(0, [block(0, 1), block(20, 2)], true, el(PREVSIZE, [9])), cues], { knownSegment: true, extra: seek });
  const b = file(2, [cluster(0, [block(0, 3), block(20, 4)], true), cues], { knownSegment: true, extra: seek });
  const out = parsed(joinWebm([a, b]).bytes);
  assert.ok(!out.ids.includes(CUES) && !out.ids.includes(SEEK));
  assert.deepEqual(out.blocks.map((x) => x.payload), [1, 2, 3, 4]);
}
// 4. An unknown-size cluster ends at the next segment-level element, not inside it
{
  const a = file(1, [cluster(0, [block(0, 1), block(20, 2)]), el(CUES, [7, 7])]);
  const out = parsed(joinWebm([a, file(2, [cluster(0, [block(0, 3)])])]).bytes);
  assert.deepEqual(out.blocks.map((x) => x.payload), [1, 2, 3]);
}
// 5. A section with no audio in it adds nothing
{
  const a = file(1, [cluster(0, [block(0, 1), block(20, 2)])]);
  const empty = file(2, []);
  assert.deepEqual(parsed(joinWebm([a, empty]).bytes).blocks.map((x) => x.payload), [1, 2]);
}
// 6. A last block cut short (a recorder killed mid-write) is dropped; what's before it stays
{
  const whole = file(1, [cluster(0, [block(0, 1), block(20, 2)])]);
  const out = parsed(joinWebm([whole.slice(0, whole.length - 2), file(2, [cluster(0, [block(0, 3), block(20, 4)])])]).bytes);
  assert.deepEqual(out.blocks.map((x) => x.payload), [1, 3, 4]);
}
// 7. What can't be joined safely is refused, never written wrong
{
  const ok = file(1, [cluster(0, [block(0, 1)])]);
  assert.throws(() => joinWebm([ok, file(2, [cluster(0, [block(0, 1)])], { codec: "A_VORBIS" })]), NotJoinable, "another codec");
  assert.throws(() => joinWebm([ok, file(2, [cluster(0, [block(0, 1)])], { channels: 2 })]), NotJoinable, "another channel count");
  assert.throws(() => joinWebm([ok, new TextEncoder().encode("ftypmp42 not a webm at all")]), NotJoinable, "not webm");
  assert.throws(() => joinWebm([file(1, []), file(2, [])]), NotJoinable, "no audio at all");
  const noTimecode = file(3, [el(CLUSTER, block(0, 1))]);
  assert.throws(() => joinWebm([ok, noTimecode]), NotJoinable, "a cluster with no timecode");
}
// 8. WAV: a correct header, the right length, loud samples clipped not wrapped
{
  const wav = encodeWav([new Float32Array([0, 0.5]), new Float32Array([-1, 2])], 16000);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (at: number) => new TextDecoder().decode(wav.slice(at, at + 4));
  assert.deepEqual([tag(0), tag(8), tag(12), tag(36)], ["RIFF", "WAVE", "fmt ", "data"]);
  assert.equal(view.getUint32(4, true), wav.length - 8);
  assert.equal(view.getUint16(20, true), 1, "PCM");
  assert.equal(view.getUint16(22, true), 1, "mono");
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint32(28, true), 32000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 8);
  assert.deepEqual([44, 46, 48, 50].map((at) => view.getInt16(at, true)), [0, 16384, -32768, 32767]);
}
// 9. joinSections: WebM stays WebM; anything else goes through decode to WAV; failure throws so the caller keeps the sections
{
  const a = new Blob([file(1, [cluster(0, [block(0, 1), block(20, 2)])])], { type: "audio/webm;codecs=opus" });
  const b = new Blob([file(2, [cluster(0, [block(0, 3), block(20, 4)])])], { type: "audio/webm;codecs=opus" });
  let decodes = 0;
  const decode = async (_: Blob) => { decodes++; return new Float32Array(1600); };
  const webm = await joinSections([a, b], decode);
  assert.equal(webm.type, "audio/webm;codecs=opus");
  assert.equal(decodes, 0, "WebM needs no re-encoding");
  assert.deepEqual(parsed(new Uint8Array(await webm.arrayBuffer())).blocks.map((x) => x.payload), [1, 2, 3, 4]);

  const m4a = () => new Blob([new Uint8Array(64)], { type: "audio/mp4" });
  const wav = await joinSections([m4a(), m4a()], decode);
  assert.equal(wav.type, "audio/wav");
  assert.equal(decodes, 2);
  assert.equal(wav.size, 44 + 2 * 1600 * 2);

  // a WebM that turns out not to be joinable still gets a whole file
  const other = new Blob([file(2, [cluster(0, [block(0, 3)])], { channels: 2 })], { type: "audio/webm" });
  assert.equal((await joinSections([a, other], decode)).type, "audio/wav");

  await assert.rejects(joinSections([m4a(), m4a()], async () => { throw new Error("no decoder"); }), /no decoder/);
  // a WAV past what a voice message can carry is not one: the caller keeps the sections instead
  await assert.rejects(joinSections([m4a(), m4a()], async () => new Float32Array(7_000_000)), /too large/i);
}
// 10. Peaks for the waveform: one 0..1 height per bucket; never a NaN, whatever the length
{
  const samples = new Float32Array(100); samples[10] = 0.5; samples[60] = -1;
  const p = peaksOf(samples, 4);
  assert.equal(p.length, 4);
  assert.deepEqual(p, [0.5, 0, 1, 0]);
  assert.deepEqual(peaksOf(new Float32Array(0), 3), [0, 0, 0]);
  assert.equal(peaksOf(new Float32Array(2), 8).length, 8);
}
console.log("recording join tests passed");
