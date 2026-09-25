// Run: node --experimental-strip-types scripts/media.test.ts (Node >= 22.6)
import assert from "node:assert/strict";
import { attachmentKind, collectAttachments, displayName, formatSize, imageLinks, parseDim, relayMediaSha, stripAttachmentLines, type MediaRef } from "../src/media.ts";

const O = "https://buzz.example";
const H = "ab".repeat(32);
const ref = (url: string, extra: Partial<MediaRef> = {}): MediaRef => ({ url, mime: null, sha256: null, size: null, dim: null, blurhash: null, alt: null, filename: null, ...extra });

// Kinds: mime first (svg is never an image), then extension.
assert.equal(attachmentKind(ref("x", { mime: "image/png" })), "image");
assert.equal(attachmentKind(ref("x", { mime: "image/svg+xml" })), "file");
assert.equal(attachmentKind(ref("x", { mime: "video/mp4" })), "video");
assert.equal(attachmentKind(ref("x", { mime: "audio/ogg" })), "audio");
assert.equal(attachmentKind(ref("x", { mime: "application/pdf" })), "file");
assert.equal(attachmentKind(ref(`${O}/media/${H}.webp`)), "image");
assert.equal(attachmentKind(ref(`${O}/media/${H}.mov`)), "video");
assert.equal(attachmentKind(ref(`${O}/media/${H}`)), "file");

// Relay media: same origin, /media/<sha>[.ext], no query.
assert.equal(relayMediaSha(`${O}/media/${H}.jpg`, O), H);
assert.equal(relayMediaSha(`${O}/media/${H}`, O), H);
assert.equal(relayMediaSha(`https://evil.example/media/${H}.jpg`, O), null);
assert.equal(relayMediaSha(`${O}/media/${H}.jpg?x=1`, O), null);
assert.equal(relayMediaSha(`${O}/media/${H}.thumb.jpg`, O), null);
assert.equal(relayMediaSha(`${O}/media/${H}.jpg`, null), null);

assert.deepEqual(parseDim("640x480"), [640, 480]);
assert.equal(parseDim("0x5"), null);
assert.equal(parseDim(null), null);
assert.equal(formatSize(512), "512 B");
assert.equal(formatSize(2048), "2.0 KB");
assert.equal(formatSize(5 * 1024 * 1024), "5.0 MB");
assert.equal(formatSize(null), "");
assert.equal(displayName(ref(`${O}/media/${H}.pdf`, { filename: "notes.pdf" })), "notes.pdf");
assert.equal(displayName(ref(`${O}/media/${H}.pdf`)), `${H}.pdf`);

// Buzz body lines: imeta entries are rendered, their lines hidden.
const img = `${O}/media/${H}.png`;
const pdf = `${O}/media/${"cd".repeat(32)}.pdf`;
const body = `look at this\n\n![image](${img})\n[notes.pdf](${pdf})\nand [a link](https://example.com)`;
const media = [ref(img, { mime: "image/png", sha256: H }), ref(pdf, { mime: "application/pdf" })];
assert.deepEqual(collectAttachments(body, media, O).map((m) => m.url), [img, pdf]);
assert.equal(stripAttachmentLines(body, media), "look at this\n\nand [a link](https://example.com)");
// Only relay media without imeta is picked up from the body; spoilers too.
const legacy = `||![image](${img})||\n![image](https://other.example/a.png)`;
assert.deepEqual(collectAttachments(legacy, [], O), [ref(img, { sha256: H })]);
assert.equal(stripAttachmentLines(legacy, collectAttachments(legacy, [], O)), "![image](https://other.example/a.png)");
// No attachments → body untouched.
assert.equal(stripAttachmentLines("  hi  ", []), "  hi  ");

// Plain image links: https + image extension, not relay, not in code, deduped.
assert.deepEqual(
  imageLinks("see https://x.example/cat.JPG, https://x.example/cat.JPG and `https://x.example/code.png` and http://x.example/insecure.png https://x.example/page.html", O, new Set()),
  ["https://x.example/cat.JPG"],
);
assert.deepEqual(imageLinks(`relay ${img}`, O, new Set()), []);
assert.deepEqual(imageLinks("a https://x.example/a.gif", O, new Set(["https://x.example/a.gif"])), []);
assert.equal(imageLinks("https://x.example/1.png https://x.example/2.png https://x.example/3.png https://x.example/4.png https://x.example/5.png", O, new Set()).length, 4);

console.log("media tests passed");
