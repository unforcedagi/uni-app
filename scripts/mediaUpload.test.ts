// The webview's half of an upload: pieces that add up to the file, in order, and the Rust side's refusal unchanged.
import assert from "node:assert/strict";
import { isConvertiblePhoto, MAX_UPLOAD_BYTES, tooLargeLine, UPLOAD_CHUNK_BYTES, uploadMedia } from "../src/mediaUpload.ts";

const media = { url: "https://relay.example.com/media/x.mp4", mime: "video/mp4" };
function fakeRust(fail?: (cmd: string, n: number) => string | null) {
  const staged: number[] = [];
  const calls: { cmd: string; args: any; headers?: Record<string, string> }[] = [];
  let n = 0;
  const call = async (cmd: string, args?: unknown, options?: { headers: Record<string, string> }) => {
    calls.push({ cmd, args, headers: options?.headers });
    const line = fail?.(cmd, n++);
    if (line) throw line;
    if (cmd === "media_upload_begin") return "id1";
    if (cmd === "media_upload_chunk") {
      assert.equal(Number(options!.headers["x-upload-offset"]), staged.length, "each piece lands where the last ended");
      for (const b of args as Uint8Array) staged.push(b);
      return null;
    }
    if (cmd === "media_upload") return media;
    return null;
  };
  return { call, staged, calls };
}

// A file over one piece arrives whole, in order, in pieces small enough for Android's IPC.
{
  const bytes = new Uint8Array(UPLOAD_CHUNK_BYTES * 2 + 17).map((_, i) => i % 251);
  const rust = fakeRust();
  const got = await uploadMedia(new Blob([bytes]), "v.mov", "video/quicktime", rust.call);
  assert.deepEqual(got, media);
  assert.deepEqual(Uint8Array.from(rust.staged), bytes);
  const pieces = rust.calls.filter((c) => c.cmd === "media_upload_chunk");
  assert.equal(pieces.length, 3);
  assert.ok(pieces.every((c) => (c.args as Uint8Array).length <= UPLOAD_CHUNK_BYTES));
  assert.ok(pieces.every((c) => c.headers!["x-upload-id"] === "id1"));
  assert.deepEqual(rust.calls.at(-1), { cmd: "media_upload", args: { id: "id1", filename: "v.mov", mime: "video/quicktime" }, headers: undefined });
}
// Rust's one-line refusal reaches the caller as it is.
{
  const line = "This video is H.265 (HEVC); Buzz only takes H.264. Convert it to H.264, then attach it again.";
  const rust = fakeRust((cmd) => cmd === "media_upload" ? line : null);
  await assert.rejects(uploadMedia(new Blob([new Uint8Array(4)]), "v.mp4", "video/mp4", rust.call), (e) => e === line);
}
// A piece that fails forgets the staged file and says why.
{
  const rust = fakeRust((cmd) => cmd === "media_upload_chunk" ? "There isn't enough free space on this device to prepare the file." : null);
  await assert.rejects(uploadMedia(new Blob([new Uint8Array(4)]), "v.mp4", "video/mp4", rust.call), /free space/);
  assert.deepEqual(rust.calls.filter((c) => c.cmd === "media_upload_abort").map((c) => c.args), [{ id: "id1" }]);
  assert.ok(!rust.calls.some((c) => c.cmd === "media_upload"));
}
// Too big to start: nothing is sent, and the line gives the real size.
{
  const big = { size: MAX_UPLOAD_BYTES + 1 } as Blob;
  const rust = fakeRust();
  await assert.rejects(uploadMedia(big, "v.mp4", "video/mp4", rust.call), /551 MB.*500 MB/);
  assert.equal(rust.calls.length, 0);
  assert.equal(tooLargeLine(MAX_UPLOAD_BYTES), null);
}
// A phone's HEIC goes as a JPEG when the platform can read it, and as itself (for Rust to name) when it can't.
{
  assert.ok(isConvertiblePhoto({ type: "" }, "IMG_1.HEIC"));
  assert.ok(isConvertiblePhoto({ type: "image/avif" }, "x"));
  assert.ok(!isConvertiblePhoto({ type: "image/jpeg" }, "x.jpg"));
  const rust = fakeRust();
  await uploadMedia(new Blob([new Uint8Array(9)]), "IMG_1.HEIC", "image/heic", rust.call, undefined, async () => new Blob([new Uint8Array(3)], { type: "image/jpeg" }));
  assert.deepEqual(rust.calls.at(-1)!.args, { id: "id1", filename: "IMG_1.jpg", mime: "image/jpeg" });
  assert.equal(rust.staged.length, 3);
  const unread = fakeRust();
  await uploadMedia(new Blob([new Uint8Array(9)]), "IMG_1.HEIC", "image/heic", unread.call, undefined, async () => null);
  assert.deepEqual(unread.calls.at(-1)!.args, { id: "id1", filename: "IMG_1.HEIC", mime: "image/heic" });
  assert.equal(unread.staged.length, 9);
}
// Removed partway: nothing more moves, what's staged is forgotten, and the upload never starts.
{
  const controller = new AbortController();
  const rust = fakeRust((cmd, n) => { if (cmd === "media_upload_chunk" && n === 2) controller.abort(); return null; });
  await assert.rejects(uploadMedia(new Blob([new Uint8Array(UPLOAD_CHUNK_BYTES * 5)]), "v.mp4", "video/mp4", rust.call, controller.signal), (e) => e === "Upload stopped.");
  assert.ok(rust.calls.filter((c) => c.cmd === "media_upload_chunk").length <= 2);
  assert.ok(rust.calls.some((c) => c.cmd === "media_upload_abort"));
  assert.ok(!rust.calls.some((c) => c.cmd === "media_upload"));
}
// Removed while the staged file is being made: it's forgotten too, rather than left for a day's sweep.
{
  const controller = new AbortController();
  const rust = fakeRust((cmd) => { if (cmd === "media_upload_begin") controller.abort(); return null; });
  await assert.rejects(uploadMedia(new Blob([new Uint8Array(4)]), "v.mp4", "video/mp4", rust.call, controller.signal), (e) => e === "Upload stopped.");
  assert.deepEqual(rust.calls.map((c) => c.cmd), ["media_upload_begin", "media_upload_abort"]);
}
// Removed once it's on its way: Rust is told to stop it.
{
  const controller = new AbortController();
  let stop = () => {};
  const held = new Promise<void>((r) => { stop = r; });
  const calls: string[] = [];
  const call = async (cmd: string) => {
    calls.push(cmd);
    if (cmd === "media_upload_begin") return "id1";
    if (cmd === "media_upload_abort") stop();
    if (cmd === "media_upload") { await held; throw "Upload stopped."; }
    return null;
  };
  const running = uploadMedia(new Blob([new Uint8Array(4)]), "v.mp4", "video/mp4", call, controller.signal);
  await new Promise((r) => setTimeout(r, 5));
  controller.abort();
  await assert.rejects(running, (e) => e === "Upload stopped.");
  assert.ok(calls.includes("media_upload_abort"));
}
// Many attachments at once: two files on the IPC at a time, and every one arrives. A failure frees its slot.
{
  let busy = 0, most = 0;
  const ids = new Map<string, number>();
  let n = 0;
  const call = async (cmd: string, args?: any, options?: { headers: Record<string, string> }) => {
    if (cmd === "media_upload_begin") return `id${n++}`;
    if (cmd === "media_upload_chunk") {
      const id = options!.headers["x-upload-id"];
      if (!ids.has(id)) { busy++; most = Math.max(most, busy); }
      ids.set(id, (ids.get(id) ?? 0) + 1);
      await new Promise((r) => setTimeout(r, 2));
      if (id === "id1") { busy--; throw "no room"; }
      if (ids.get(id) === 2) busy--;
      return null;
    }
    return media;
  };
  const results = await Promise.allSettled([0, 1, 2, 3, 4].map(() => uploadMedia(new Blob([new Uint8Array(UPLOAD_CHUNK_BYTES + 1)]), "a.bin", "", call)));
  assert.ok(most <= 2, `${most} at once`);
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "rejected", "fulfilled", "fulfilled", "fulfilled"]);
}
// Twenty photos picked at once: two being decoded at a time.
{
  let busy = 0, most = 0;
  const toJpeg = async () => {
    busy++; most = Math.max(most, busy);
    await new Promise((r) => setTimeout(r, 2));
    busy--;
    return new Blob([new Uint8Array(3)], { type: "image/jpeg" });
  };
  const call = async (cmd: string) => cmd === "media_upload_begin" ? "id" : cmd === "media_upload" ? media : null;
  await Promise.all(Array.from({ length: 20 }, (_, i) => uploadMedia(new Blob([new Uint8Array(9)]), `p${i}.heic`, "image/heic", call, undefined, toJpeg)));
  assert.ok(most <= 2, `${most} at once`);
}
console.log("media upload tests passed");
