// The sections of one paused recording become one file.
// WebM (Android and current Macs): a lossless remux. Blocks hold times relative to their cluster, so shifting each
// cluster's timecode moves the audio without touching it. Anything else: decode and write 16 kHz mono WAV.
// A failure throws; the caller still has the sections and keeps them.

export class NotJoinable extends Error {}

const EBML = 0x1A45DFA3, DOC_TYPE = 0x4282, SEGMENT = 0x18538067, INFO = 0x1549A966, TRACKS = 0x1654AE6B, CLUSTER = 0x1F43B675;
const SEEK_HEAD = 0x114D9B74, CUES = 0x1C53BB6B, TAGS = 0x1254C367, CHAPTERS = 0x1043A770, ATTACHMENTS = 0x1941A469;
const SCALE = 0x2AD7B1, DURATION = 0x4489, TRACK_ENTRY = 0xAE, TRACK_UID = 0x73C5;
const CRC32 = 0xBF, TIMECODE = 0xE7, PREV_SIZE = 0xAB, POSITION = 0xA7, SIMPLE_BLOCK = 0xA3, BLOCK_GROUP = 0xA0, BLOCK = 0xA1;
/** What ends an unknown-size cluster. */
const SEGMENT_LEVEL = new Set([INFO, TRACKS, CLUSTER, SEEK_HEAD, CUES, TAGS, CHAPTERS, ATTACHMENTS]);
const DEFAULT_SCALE = 1_000_000; // WebM's default: a tick is a millisecond
const DEFAULT_FRAME_MS = 20;
const SECTION_SLACK = 4096;

type Element = { id: number; start: number; body: number; end: number; unknown: boolean };

/** The element at `at`, or null when `limit` cuts it short. */
function readElement(b: Uint8Array, at: number, limit: number): Element | null {
  if (at >= limit) return null;
  let idLength = 1;
  while (idLength <= 4 && !(b[at] & (0x80 >> (idLength - 1)))) idLength++;
  if (idLength > 4 || at + idLength >= limit) return null;
  let id = 0;
  for (let i = 0; i < idLength; i++) id = id * 256 + b[at + i];
  const sizeAt = at + idLength;
  let sizeLength = 1;
  while (sizeLength <= 8 && !(b[sizeAt] & (0x80 >> (sizeLength - 1)))) sizeLength++;
  if (sizeLength > 8 || sizeAt + sizeLength > limit) return null;
  const mask = 0xFF >> sizeLength;
  let size = b[sizeAt] & mask, allOnes = size === mask;
  for (let i = 1; i < sizeLength; i++) { size = size * 256 + b[sizeAt + i]; allOnes &&= b[sizeAt + i] === 0xFF; }
  const body = sizeAt + sizeLength;
  return { id, start: at, body, end: allOnes ? limit : body + size, unknown: allOnes };
}

function children(b: Uint8Array, parent: Element): Element[] {
  const out: Element[] = [];
  for (let at = parent.body; at < parent.end;) {
    const e = readElement(b, at, parent.end);
    if (!e || e.end > parent.end || e.unknown) throw new NotJoinable("a damaged header");
    out.push(e);
    at = e.end;
  }
  return out;
}

function uintOf(b: Uint8Array, e: Element): number {
  let v = 0;
  for (let i = e.body; i < e.end; i++) v = v * 256 + b[i];
  return v;
}

type Cluster = { timecode: number; parts: Uint8Array[]; length: number };
type Section = { bytes: Uint8Array; header: Element; info: Element; tracks: Element; scale: number; signature: string; clusters: Cluster[]; times: number[] };

/** The time of a Block or SimpleBlock's first frame, relative to its cluster. */
function blockRelative(b: Uint8Array, e: Element): number | null {
  let trackLength = 1;
  while (trackLength <= 8 && !(b[e.body] & (0x80 >> (trackLength - 1)))) trackLength++;
  if (e.body + trackLength + 2 > e.end) return null;
  const v = (b[e.body + trackLength] << 8) | b[e.body + trackLength + 1];
  return v > 32767 ? v - 65536 : v;
}

/** A cluster's audio. A cut at the very end of the file is a killed recorder: what came before stands. A break anywhere else is damage. */
function readCluster(b: Uint8Array, cluster: Element, limit: number, times: number[]): { cluster: Cluster; end: number } {
  const end = cluster.unknown ? limit : Math.min(cluster.end, limit);
  let timecode: number | null = null;
  const parts: Uint8Array[] = [];
  const relative: number[] = [];
  let length = 0, at = cluster.body;
  while (at < end) {
    const e = readElement(b, at, end);
    if (e && cluster.unknown && SEGMENT_LEVEL.has(e.id)) break;
    if (!e || e.unknown || e.end > end) {
      // A killed recorder cuts one block short; more than that unread is damage, and the audio after it would quietly go
      if (end < b.length || end - at > SECTION_SLACK) throw new NotJoinable("a damaged cluster");
      at = end;
      break;
    }
    at = e.end;
    if (e.id === TIMECODE) { timecode = uintOf(b, e); continue; }
    if (e.id === PREV_SIZE || e.id === POSITION || e.id === CRC32) continue; // these describe bytes that move
    if (e.id === SIMPLE_BLOCK) { const r = blockRelative(b, e); if (r !== null) relative.push(r); }
    if (e.id === BLOCK_GROUP) for (const k of children(b, e)) if (k.id === BLOCK) { const r = blockRelative(b, k); if (r !== null) relative.push(r); }
    const part = b.subarray(e.start, e.end);
    parts.push(part);
    length += part.length;
  }
  if (timecode === null) {
    if (relative.length) throw new NotJoinable("a cluster with no timecode");
    return { cluster: { timecode: 0, parts: [], length: 0 }, end: at };
  }
  for (const r of relative) times.push(timecode + r);
  return { cluster: { timecode, parts: relative.length ? parts : [], length: relative.length ? length : 0 }, end: at };
}

function readSection(bytes: Uint8Array): Section {
  const header = readElement(bytes, 0, bytes.length);
  if (!header || header.id !== EBML || header.end > bytes.length) throw new NotJoinable("not a WebM file");
  const doc = children(bytes, header).find((e) => e.id === DOC_TYPE);
  if (!doc || new TextDecoder().decode(bytes.subarray(doc.body, doc.end)) !== "webm") throw new NotJoinable("not a WebM file");
  const segment = readElement(bytes, header.end, bytes.length);
  if (!segment || segment.id !== SEGMENT) throw new NotJoinable("no segment");
  const limit = Math.min(segment.end, bytes.length);
  let info: Element | null = null, tracks: Element | null = null;
  const clusters: Cluster[] = [], times: number[] = [];
  for (let at = segment.body; at < limit;) {
    const e = readElement(bytes, at, limit);
    // A cut at the very end stands; with more than that unread, the clusters after it would quietly go
    if (!e || (e.end > limit && e.id !== CLUSTER)) { // a cluster cut short is readCluster's to judge: its whole blocks stand
      if (limit - at > SECTION_SLACK) throw new NotJoinable("a damaged segment");
      break;
    }
    if (e.id === CLUSTER) {
      const read = readCluster(bytes, e, limit, times);
      if (read.cluster.parts.length) clusters.push(read.cluster);
      at = read.end;
      continue;
    }
    if (e.unknown) throw new NotJoinable("an element of unknown size");
    if (e.id === INFO) info = e;
    if (e.id === TRACKS) tracks = e;
    at = e.end;
  }
  if (!info || !tracks) throw new NotJoinable("no Info or Tracks");
  // A section's row was on screen: if it holds real bytes and no audio can be read, it isn't to vanish quietly.
  if (!clusters.length && bytes.length - tracks.end > SECTION_SLACK) throw new NotJoinable("bytes that hold no audio");
  const scaleElement = children(bytes, info).find((e) => e.id === SCALE);
  const entries = children(bytes, tracks).filter((e) => e.id === TRACK_ENTRY);
  if (entries.length !== 1) throw new NotJoinable("not a single track");
  // Everything about the track but its random id must match, or one stream can't carry both.
  const signature = children(bytes, entries[0]).filter((e) => e.id !== TRACK_UID)
    .map((e) => Array.from(bytes.subarray(e.start, e.end)).join(",")).join("|");
  return { bytes, header, info, tracks, scale: scaleElement ? uintOf(bytes, scaleElement) : DEFAULT_SCALE, signature, clusters, times };
}

/** The usual gap between frames, for how long the last one lasts. */
function frameTicks(sorted: number[], scale: number): number {
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) if (sorted[i] > sorted[i - 1]) gaps.push(sorted[i] - sorted[i - 1]);
  if (!gaps.length) return Math.max(1, Math.round(DEFAULT_FRAME_MS * 1_000_000 / scale));
  gaps.sort((x, y) => x - y);
  return gaps[gaps.length >> 1];
}

class Writer {
  private chunks: Uint8Array[] = [];
  length = 0;
  push(part: Uint8Array) { this.chunks.push(part); this.length += part.length; }
  /** An element header with an 8-byte size. */
  open(id: number, size: number) {
    const idBytes: number[] = [];
    for (let v = id; v > 0; v = Math.floor(v / 256)) idBytes.unshift(v % 256);
    const out = new Uint8Array(idBytes.length + 8);
    out.set(idBytes);
    out[idBytes.length] = 0x01;
    writeBig(out, idBytes.length + 1, size, 7);
    this.push(out);
  }
  done(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const c of this.chunks) { out.set(c, at); at += c.length; }
    return out;
  }
}

function writeBig(out: Uint8Array, at: number, value: number, width: number) {
  for (let i = width - 1, v = value; i >= 0; i--) { out[at + i] = v % 256; v = Math.floor(v / 256); }
}

/** One WebM from the sections' WebMs, played end to end. Throws NotJoinable when they can't safely share one stream. */
export function joinWebm(parts: Uint8Array[]): { bytes: Uint8Array; durationMs: number } {
  const sections = parts.map(readSection).filter((s) => s.clusters.length);
  if (!sections.length) throw new NotJoinable("no audio");
  const first = sections[0];
  for (const s of sections) {
    if (s.scale !== first.scale) throw new NotJoinable("different clocks");
    if (s.signature !== first.signature) throw new NotJoinable("different tracks");
  }
  // Lay the sections on one timeline
  let cursor = 0;
  const placed: { timecode: number; cluster: Cluster }[] = [];
  for (const s of sections) {
    const sorted = [...s.times].sort((x, y) => x - y);
    const earliest = sorted[0], latest = sorted[sorted.length - 1];
    const lowest = s.clusters.reduce((low, c) => Math.min(low, c.timecode), Infinity);
    const shift = Math.max(cursor - earliest, -lowest); // a cluster's timecode can't go below zero
    for (const cluster of s.clusters) placed.push({ timecode: cluster.timecode + shift, cluster });
    cursor = latest + shift + frameTicks(sorted, first.scale);
  }
  // Info: what the first said, with the length it could not know
  const keep = children(first.bytes, first.info).filter((e) => e.id !== DURATION && e.id !== CRC32);
  const infoBody = keep.reduce((n, e) => n + e.end - e.start, 0) + 2 + 1 + 8;
  const clusterHead = 4 + 8 + 1 + 1 + 8; // id, size, timecode element
  const segmentBody = (4 + 8 + infoBody) + (first.tracks.end - first.tracks.start) + placed.reduce((n, p) => n + clusterHead + p.cluster.length, 0);

  const w = new Writer();
  w.push(first.bytes.subarray(first.header.start, first.header.end));
  w.open(SEGMENT, segmentBody);
  w.open(INFO, infoBody);
  for (const e of keep) w.push(first.bytes.subarray(e.start, e.end));
  const duration = new Uint8Array(11);
  duration.set([0x44, 0x89, 0x88]);
  new DataView(duration.buffer).setFloat64(3, cursor, false);
  w.push(duration);
  w.push(first.bytes.subarray(first.tracks.start, first.tracks.end));
  for (const { timecode, cluster } of placed) {
    w.open(CLUSTER, 1 + 1 + 8 + cluster.length);
    const tc = new Uint8Array(10);
    tc.set([TIMECODE, 0x88]);
    writeBig(tc, 2, timecode, 8);
    w.push(tc);
    for (const part of cluster.parts) w.push(part);
  }
  return { bytes: w.done(), durationMs: cursor * first.scale / 1_000_000 };
}

/** 16-bit mono WAV. Loud samples clip rather than wrap. */
export function encodeWav(samples: Float32Array[], rate: number): Uint8Array {
  const count = samples.reduce((n, s) => n + s.length, 0);
  const out = new Uint8Array(44 + count * 2);
  const view = new DataView(out.buffer);
  const tag = (at: number, text: string) => { for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i); };
  tag(0, "RIFF"); view.setUint32(4, out.length - 8, true); tag(8, "WAVE");
  tag(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  tag(36, "data"); view.setUint32(40, count * 2, true);
  let at = 44;
  for (const s of samples) for (let i = 0; i < s.length; i++, at += 2) {
    const v = Math.max(-1, Math.min(1, s[i]));
    view.setInt16(at, Math.round(v < 0 ? v * 32768 : v * 32767), true);
  }
  return out;
}

/** One 0..1 height per bucket: the loudest sample in it. */
export function peaksOf(samples: Float32Array, buckets: number): number[] {
  const out: number[] = [];
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * samples.length / buckets), to = Math.floor((b + 1) * samples.length / buckets);
    let peak = 0;
    for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(samples[i]));
    out.push(Math.min(1, peak));
  }
  return out;
}

export type Decode = (blob: Blob) => Promise<Float32Array>;

const WAV_RATE = 16000; // what the transcriber listens at
/** A voice message's limit. Past it a joined file can't be sent, so it isn't made: the sections go on their own. */
const JOIN_LIMIT = 25 * 1024 * 1024;
/** The transcriber's limit: a longer WAV could be kept but its words would never come. */
const WAV_LIMIT = 25 * 1024 * 1024;

/** A recording's audio as mono samples at `rate`, by the platform's own decoder. */
export async function decodeMono(blob: Blob, rate = WAV_RATE): Promise<Float32Array> {
  const context = new OfflineAudioContext(1, 1, rate);
  const buffer = await context.decodeAudioData(await blob.arrayBuffer());
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const channel = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += channel[i] / buffer.numberOfChannels;
  }
  return out;
}

export type JoinOptions = {
  /** Whoever keeps the file can take WAV. Rooms can't: the relay takes only WebM and Ogg Opus, so there the sections go on their own. */
  wav?: boolean;
  limit?: number;
  decode?: Decode;
};

/** One file from a recording's sections. Throws when it can't make one the caller can keep; the sections are still whole. */
export async function joinSections(blobs: Blob[], { wav = false, limit = JOIN_LIMIT, decode = decodeMono }: JoinOptions = {}): Promise<Blob> {
  const tooLarge = () => new Error("Recording too large to join");
  let refusal: unknown = new NotJoinable("not WebM");
  if (blobs.every((b) => b.type.includes("webm"))) {
    let joined: Uint8Array | null = null;
    try { joined = joinWebm(await Promise.all(blobs.map(async (b) => new Uint8Array(await b.arrayBuffer())))).bytes; }
    catch (e) { if (!(e instanceof NotJoinable)) throw e; refusal = e; }
    if (joined) {
      if (joined.length > limit) throw tooLarge();
      return new Blob([joined as BlobPart], { type: blobs[0].type });
    }
  }
  if (!wav) throw refusal;
  const samples: Float32Array[] = [];
  let total = 44;
  for (const b of blobs) {
    const s = await decode(b);
    total += s.length * 2;
    if (total > Math.min(limit, WAV_LIMIT)) throw tooLarge();
    samples.push(s);
  }
  return new Blob([encodeWav(samples, WAV_RATE) as BlobPart], { type: "audio/wav" });
}
