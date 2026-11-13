// Run: node --experimental-strip-types scripts/noteImages.test.ts
// T-335: an image in a note is a vault attachment (read by the app), inline data, a remote image (a "Load image" tap) or words.
// Never anything the webview would fetch by itself.
import assert from "node:assert/strict";
import { imageBlob, imageLabel, imageSource } from "../src/noteImages.ts";

const HUB = ["https://hub.example.ts.net", null, undefined];
const vault = (path: string) => ({ kind: "vault", path });
const remote = (url: string) => ({ kind: "remote", url });
const none = { kind: "none" };

// the vault's storage: relative, on this hub (the vault's own route or the bare one), percent-encoded; query and fragment dropped
assert.deepEqual(imageSource("/api/storage/2026-11-13/a.png", HUB), vault("2026-11-13/a.png"));
assert.deepEqual(imageSource("api/storage/2026-11-13/a.png", HUB), vault("2026-11-13/a.png"));
assert.deepEqual(imageSource(" /api/storage/2026-11-13/my%20file.png?x=1#y ", HUB), vault("2026-11-13/my file.png"));
assert.deepEqual(imageSource("https://hub.example.ts.net/vault/uni/api/storage/2026-11-13/a.png", HUB), vault("2026-11-13/a.png"));
assert.deepEqual(imageSource("https://hub.example.ts.net/api/storage/2026-11-13/a.png", HUB), vault("2026-11-13/a.png"));
// a path that climbs, is absolute or badly encoded is nothing at all (never tried anywhere)
for (const bad of ["/api/storage/../secret.png", "/api/storage/2026/../../x.png", "/api/storage//etc/x.png", "/api/storage/%2e%2e/x.png", "/api/storage/%E0%A4%A.png", "/api/storage/a%5Cb.png"]) {
  assert.deepEqual(imageSource(bad, HUB), none, bad);
}
// storage on another host is just a remote image: the app reads attachments only from its own hub
assert.deepEqual(imageSource("https://other.example.com/vault/uni/api/storage/2026/a.png", HUB), remote("https://other.example.com/vault/uni/api/storage/2026/a.png"));
assert.deepEqual(imageSource("https://hub.example.ts.net.evil.example/api/storage/2026/a.png", HUB), remote("https://hub.example.ts.net.evil.example/api/storage/2026/a.png"));
// a page on the hub that isn't storage is remote too (a tap away, never automatic)
assert.deepEqual(imageSource("https://hub.example.ts.net/vault/uni/notes/x.png", HUB), remote("https://hub.example.ts.net/vault/uni/notes/x.png"));

// remote images: any http(s) image elsewhere
assert.deepEqual(imageSource("https://tracker.example/pixel.png?n=1", HUB), remote("https://tracker.example/pixel.png?n=1"));
assert.deepEqual(imageSource("http://example.org/a.gif", []), remote("http://example.org/a.gif"));

// inline data is already in the note
assert.deepEqual(imageSource("data:image/png;base64,iVBOR", HUB), { kind: "inline", src: "data:image/png;base64,iVBOR" });
assert.deepEqual(imageSource("data:image/svg+xml,%3Csvg%3E", HUB), { kind: "inline", src: "data:image/svg+xml,%3Csvg%3E" });

// everything else is words: other schemes, relative paths, credentials, whitespace tricks, non-strings
for (const bad of ["data:text/html,<b>x</b>", "javascript:alert(1)", "blob:https://x/1", "file:///etc/passwd", "//tracker.example/a.png", "img/a.png",
  "https://user:pw@tracker.example/a.png", "https://tracker.example/a b.png", "https:\\\\tracker.example\\a.png", "", "   ", undefined, null, 42]) {
  assert.deepEqual(imageSource(bad, HUB), none, String(bad));
}

// a remote image's button names it by its words, else its host
assert.equal(imageLabel(" weekly chart ", "https://tracker.example/a.png"), "weekly chart");
assert.equal(imageLabel("", "https://tracker.example/a.png"), "tracker.example");
assert.equal(imageLabel(undefined, "not a url"), "image");

// SVG bytes get their type (an <img> won't sniff SVG); other formats are left to the webview
const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
assert.equal(imageBlob(enc('<svg xmlns="http://www.w3.org/2000/svg"/>')).type, "image/svg+xml");
assert.equal(imageBlob(enc('<?xml version="1.0"?>\n<svg/>')).type, "image/svg+xml");
assert.equal(imageBlob(enc("x"), "/2026/a.svg").type, "image/svg+xml");
assert.equal(imageBlob(enc("\u0089PNG")).type, "");
console.log("note image tests passed");
