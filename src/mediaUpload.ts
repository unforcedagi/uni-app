// A file on its way to the relay. Rust does the work (crates/uni-core media/normalize.rs) on a copy on disk; the webview
// only moves the bytes, in pieces, because Android's IPC turns bytes into JSON numbers and a whole video would never
// survive that. Every failure comes back as one plain line, ready to show.
import type { MediaRef } from "./media";

/** What can be staged. The relay's limit is 500 MB of what comes out of clean-up; Rust has the last word on that. */
export const MAX_UPLOAD_BYTES = 550 * 1024 * 1024;
/** One piece over IPC. On Android a megabyte is about 3.6 MB of JSON, which a phone handles quickly. */
export const UPLOAD_CHUNK_BYTES = 1024 * 1024;

/** Files being converted or moved over IPC at once. Twenty photos picked together would otherwise each hold a decoded bitmap. */
const STAGING_SLOTS = 2;
let staging = 0;
const stagingWaiters: (() => void)[] = [];
async function withStagingSlot<T>(work: () => Promise<T>): Promise<T> {
  if (staging >= STAGING_SLOTS) await new Promise<void>((resolve) => stagingWaiters.push(resolve));
  else staging++;
  try { return await work(); } finally {
    const next = stagingWaiters.shift();
    if (next) next(); else staging--;
  }
}

type Call = (cmd: string, args?: unknown, options?: { headers: Record<string, string> }) => Promise<unknown>;

/** Photo formats the relay refuses and a webview may still be able to show (a Mac's WebKit reads HEIC; Android reads AVIF). */
const CONVERTIBLE = /^image\/(heic|heif|avif|bmp|tiff)$/i;
const CONVERTIBLE_NAME = /\.(heic|heif|avif|bmp|tiff?)$/i;

export function isConvertiblePhoto(file: { type: string }, name: string): boolean {
  return CONVERTIBLE.test(file.type) || CONVERTIBLE_NAME.test(name);
}

/** A photo as a JPEG the relay takes, by the platform's own decoder, turned the way it was shot. Null: it can't read it. */
export async function photoAsJpeg(file: Blob): Promise<Blob | null> {
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.fillStyle = "#fff"; // JPEG has no transparency
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

function sizeLine(bytes: number): string {
  return `This file is ${Math.ceil(bytes / (1024 * 1024))} MB; Buzz takes up to 500 MB. Trim it, then attach it again.`;
}

/** The line to show for a file too big to even start, or null. */
export function tooLargeLine(size: number): string | null {
  return size > MAX_UPLOAD_BYTES ? sizeLine(size) : null;
}

const STOPPED = "Upload stopped.";

/** Send a file to the relay: one attachment, or, for a long recording Rust converts and cuts, one per part in order.
 *  Throws one plain line. */
export async function uploadMedia(file: Blob, name: string, mime: string, call: Call, signal?: AbortSignal, toJpeg: (f: Blob) => Promise<Blob | null> = photoAsJpeg): Promise<MediaRef[]> {
  const large = tooLargeLine(file.size);
  if (large) throw large; // a plain string, as Rust's refusals are: shown as it is, with no "Error:" in front
  if (signal?.aborted) throw STOPPED;
  const id = await call("media_upload_begin") as string;
  // Removed partway: nothing more moves, and what's staged or on its way goes.
  const abort = () => { void Promise.resolve(call("media_upload_abort", { id })).catch(() => {}); };
  if (signal?.aborted) { abort(); throw STOPPED; } // removed while the staged file was being made
  signal?.addEventListener("abort", abort, { once: true });
  let body = file, sendName = name, sendMime = mime;
  try {
    await withStagingSlot(async () => {
      if (signal?.aborted) throw STOPPED;
      if (isConvertiblePhoto(file, name)) {
        // Can't be read here: leave it, and Rust names what it is and what Buzz takes.
        const jpeg = await toJpeg(file);
        if (jpeg) {
          body = jpeg;
          sendName = `${name.replace(/\.[^.]*$/, "")}.jpg`;
          sendMime = "image/jpeg";
        }
      }
      for (let offset = 0; offset < body.size; offset += UPLOAD_CHUNK_BYTES) {
        if (signal?.aborted) throw STOPPED;
        // A picked file can vanish under us: another app moved it, or Android took back its permission.
        const bytes = await body.slice(offset, offset + UPLOAD_CHUNK_BYTES).arrayBuffer().then((b) => new Uint8Array(b), () => {
          throw "Couldn't read this file on this device. Attach it again.";
        });
        await call("media_upload_chunk", bytes, { headers: { "x-upload-id": id, "x-upload-offset": String(offset) } });
      }
    });
  } catch (e) {
    if (!signal?.aborted) abort();
    throw e;
  }
  if (signal?.aborted) throw STOPPED;
  try {
    return await call("media_upload", { id, filename: sendName, mime: sendMime }) as MediaRef[];
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
