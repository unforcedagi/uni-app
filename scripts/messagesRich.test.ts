// T-313 Messages: what a message shows besides plain words. Links in its text open (http and https only, the words
// unchanged), a long message folds, a voice message's length reads as a clock, and an attachment shows only as what
// the core let through (an SVG picture is a file, never an image). Every scan is linear: a long or hostile message
// can't freeze the conversation.
// Run: node --experimental-strip-types scripts/messagesRich.test.ts
import assert from "node:assert/strict";
import { clock, fileLine, foldedStart, linkHref, linkify, LINK_MAX, mediaShape, pictureBox, reactionName, sizeWords, type Media, type TextPart } from "../src/messages/messagesView.ts";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log(`ok ${name}`); };
const links = (s: string) => linkify(s).filter((p): p is Extract<TextPart, { t: "link" }> => p.t === "link").map((p) => [p.v, p.href]);
const joined = (parts: TextPart[]) => parts.map((p) => p.v).join("");

t("a web address in a message becomes a link to it; the words around it stay words", () => {
  assert.deepEqual(linkify("See https://example.com/menu today"), [
    { t: "text", v: "See " }, { t: "link", v: "https://example.com/menu", href: "https://example.com/menu" }, { t: "text", v: " today" },
  ]);
  assert.deepEqual(links("two: http://a.example.org/x and HTTPS://B.example.org"), [["http://a.example.org/x", "http://a.example.org/x"], ["HTTPS://B.example.org", "https://b.example.org/"]]);
  // www. is taken as https
  assert.deepEqual(links("at www.example.com/hours."), [["www.example.com/hours", "https://www.example.com/hours"]]);
  assert.deepEqual(linkify("no links here"), [{ t: "text", v: "no links here" }]);
  assert.deepEqual(linkify(""), []);
});

t("trailing punctuation belongs to the sentence; a bracket only if the link opened one", () => {
  assert.deepEqual(links("Look: https://example.com/a."), [["https://example.com/a", "https://example.com/a"]]);
  assert.deepEqual(links("(see https://example.com/b)"), [["https://example.com/b", "https://example.com/b"]]);
  assert.deepEqual(links("https://en.example.org/wiki/Bean_(plant)!"), [["https://en.example.org/wiki/Bean_(plant)", "https://en.example.org/wiki/Bean_(plant)"]]);
  assert.deepEqual(links("[https://example.com/c]"), [["https://example.com/c", "https://example.com/c"]]);
  assert.deepEqual(links("“https://example.com/d”"), [["https://example.com/d", "https://example.com/d"]]);
  assert.deepEqual(links('he said "https://example.com/e", then left'), [["https://example.com/e", "https://example.com/e"]]);
});

t("only http and https open: other schemes, addresses inside words, and empty hosts stay words", () => {
  for (const s of ["javascript:alert(1)", "data:text/html,<b>x</b>", "file:///etc/passwd", "intent://scan/#Intent;end", "mailto:sam@example.com",
    "xhttps://example.com", "https://", "http:// spaced.example.com", "www.", "www.example", "https://user:pw@example.com/"]) {
    for (const p of linkify(s)) if (p.t === "link") assert.match(p.href, /^https?:\/\//, s);
    assert.deepEqual(links(s).filter(([, h]) => !/^https?:\/\//.test(h)), [], s);
  }
  assert.deepEqual(links("javascript:alert(1)"), []);
  assert.deepEqual(links("xhttps://example.com"), []);
  assert.deepEqual(links("https://user:pw@example.com/"), []);
  assert.equal(linkHref("https://example.com"), "https://example.com/");
  assert.equal(linkHref("ftp://example.com"), null);
});

t("a link stops at whitespace, quotes and angle brackets, and at LINK_MAX characters", () => {
  assert.deepEqual(links("https://example.com/a<b>"), [["https://example.com/a", "https://example.com/a"]]);
  assert.deepEqual(links("https://example.com/a\nnext line"), [["https://example.com/a", "https://example.com/a"]]);
  const long = "https://example.com/" + "a".repeat(5000);
  const [first] = links(long);
  assert.equal(first[0].length, "https://".length + LINK_MAX);
  assert.equal(joined(linkify(long)), long);
});

// a seeded generator, so a failure names its case and repeats
function rng(seed: number) { return () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; }; }
const BITS = ["https://", "http://", "www.", "example.com", "/", ".", ",", ")", "(", "]", "[", " ", "\n", "javascript:", "\u0000", "é", "\"", "'", "<", ">", "?", "#", "a", "1", "…", "🌱", "\t", "HTTP://"];

t("fuzz: the parts always join back to the text, and every link is http(s) with a host", () => {
  const r = rng(313);
  for (let i = 0; i < 4000; i++) {
    let s = "";
    const len = Math.floor(r() * 30);
    for (let j = 0; j < len; j++) s += BITS[Math.floor(r() * BITS.length)];
    const parts = linkify(s);
    assert.equal(joined(parts), s, JSON.stringify(s));
    for (const p of parts) {
      if (p.t !== "link") continue;
      const u = new URL(p.href);
      assert.ok((u.protocol === "https:" || u.protocol === "http:") && u.hostname, JSON.stringify(s));
      assert.ok(!/[\s<>"'`]/.test(p.v), JSON.stringify(s));
    }
    // no two parts of one kind in a row: text runs are whole
    for (let k = 1; k < parts.length; k++) assert.ok(!(parts[k].t === "text" && parts[k - 1].t === "text"), JSON.stringify(s));
  }
});

/** The time `f` takes, best of three (ms). */
function ms(f: () => void): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) { const t0 = performance.now(); f(); best = Math.min(best, performance.now() - t0); }
  return best;
}

t("a long or hostile message links in linear time", () => {
  // each shape once failed a parser elsewhere in the app (a rescan per candidate, an end-anchored trim)
  const shapes = [
    "https://a" + ")".repeat(200_000),
    "https://example.com/" + "(".repeat(100_000) + ")".repeat(100_000),
    "www.".repeat(50_000),
    "http://".repeat(30_000),
    ("see https://example.com/x, " ).repeat(8_000),
    "h".repeat(200_000),
    "https://" + ".".repeat(200_000),
    // many links, each near LINK_MAX and ending in brackets to trim: a per-step recount is quadratic in each
    ("https://a" + ")".repeat(2000) + " ").repeat(100),
  ];
  for (const s of shapes) {
    const took = ms(() => linkify(s));
    assert.ok(took < 250, `${took.toFixed(0)} ms for ${JSON.stringify(s.slice(0, 24))}… (${s.length} chars)`);
    assert.equal(joined(linkify(s)), s);
  }
});

t("a long message folds at a space, past 1200 characters or 18 lines; a short one doesn't", () => {
  assert.equal(foldedStart("short"), null);
  assert.equal(foldedStart("x".repeat(1200)), null);
  const words = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
  const start = foldedStart(words)!;
  assert.ok(start.length <= 700 && start.length > 600, String(start.length));
  assert.ok(words.startsWith(start) && !start.endsWith(" ") && words[start.length] === " ");
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
  assert.equal(foldedStart(lines), Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"));
  assert.equal(foldedStart(Array.from({ length: 18 }, () => "l").join("\n")), null);
  // a whole message with no spaces still folds
  assert.equal(foldedStart("y".repeat(5000))!.length, 700);
  assert.ok(ms(() => foldedStart("\n".repeat(500_000))) < 100);
});

t("a voice message's length and a file's size read in words", () => {
  assert.deepEqual([clock(0), clock(7.9), clock(65), clock(3723), clock(NaN), clock(Infinity), clock(null)], ["0:00", "0:07", "1:05", "1:02:03", "0:00", "0:00", "0:00"]);
  assert.deepEqual([sizeWords(512), sizeWords(2048), sizeWords(3.4 * 1024 * 1024), sizeWords(null)], ["512 B", "2 KB", "3.4 MB", ""]);
});

const media = (over: Partial<Media>): Media => ({ kind: "file", name: "plan.pdf", mime: "application/octet-stream", size: 2048, duration_ms: null, width: null, height: null, caption: null, ...over });

t("an attachment shows only as what the core let through: an SVG or untyped picture is a file", () => {
  assert.equal(mediaShape(media({ kind: "image", mime: "image/jpeg" })), "image");
  assert.equal(mediaShape(media({ kind: "image", mime: "application/octet-stream" })), "file");
  assert.equal(mediaShape(media({ kind: "voice", mime: "audio/ogg" })), "voice");
  assert.equal(mediaShape(media({ kind: "audio", mime: "audio/mpeg" })), "audio");
  assert.equal(mediaShape(media({ kind: "voice", mime: "text/html" })), "file");
  assert.equal(mediaShape(media({ kind: "video", mime: "video/mp4" })), "video");
  assert.equal(mediaShape(media({ kind: "file", mime: "image/png" })), "file");
  assert.equal(fileLine(media({ name: "planting-plan.pdf", size: 3.4 * 1024 * 1024 })), "PDF · 3.4 MB");
  assert.equal(fileLine(media({ name: "notes", size: null })), "");
});

t("a picture keeps its shape before it loads, inside 320 × 360", () => {
  assert.deepEqual(pictureBox({ width: 640, height: 480 }), { width: 320, height: 240 });
  assert.deepEqual(pictureBox({ width: 480, height: 1920 }), { width: 90, height: 360 });
  assert.deepEqual(pictureBox({ width: 100, height: 50 }), { width: 100, height: 50 });
  assert.deepEqual(pictureBox({ width: null, height: null }), { width: 320, height: 240 });
  assert.deepEqual(pictureBox({ width: 10_000, height: 1 }), { width: 320, height: 48 });
});

t("a reaction reads as who reacted", () => {
  assert.equal(reactionName({ key: "🌱", count: 2, own: true }), "🌱, 2 people, you too");
  assert.equal(reactionName({ key: "👍", count: 1, own: false }), "👍, 1 person");
  assert.equal(reactionName({ key: "👍", count: 1, own: true }), "👍, you");
});

console.log(`${n} passed`);
