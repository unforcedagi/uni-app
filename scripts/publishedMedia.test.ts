// Run: node --experimental-strip-types scripts/publishedMedia.test.ts (Node >= 22.6)
// T-260: which links are published media the app plays inline, and where in a note the player goes. Synthetic hosts only.
import assert from "node:assert/strict";
import { classifyPublished, keyOf, publishedFromNote, publishedIn, rehypePublished, PUBLISHED_TAG, type HastNode } from "../src/publishedMedia.ts";

const O = "https://uni.example.ts.net:8444";
const ORIGINS = [O, "https://uni-1.example.ts.net:8444"];
const at = (path: string) => `${O}/${path}`;
const kind = (url: string, origins = ORIGINS) => classifyPublished(url, origins)?.kind ?? null;

// ── the classifier: the publisher's origins and its file types only ─────────────────────────────────────
assert.equal(kind(at("clip-0a1b2c3d.mp4")), "video");
assert.equal(kind(at("clip-0a1b2c3d.webm")), "video");
assert.equal(kind(at("voice-0a1b2c3d.m4a")), "audio");
assert.equal(kind(at("voice-0a1b2c3d.mp3")), "audio");
for (const ext of ["png", "jpg", "jpeg", "gif", "webp"]) assert.equal(kind(at(`flow-0a1b2c3d.${ext}`)), "image", ext);
assert.equal(kind(at("plan-0a1b2c3d.pdf")), "doc");
assert.equal(kind(at("plan-0a1b2c3d.html")), "page");
assert.equal(kind("https://uni-1.example.ts.net:8444/clip-0a1b2c3d.mp4"), "video", "the hub's other name");
assert.equal(kind(at("CLIP-0A1B2C3D.MP4")), "video", "extension case");
assert.equal(kind("https://UNI.Example.ts.net:8444/clip-0a1b2c3d.mp4"), "video", "host case is the same host");
// an encoded path, a query and a fragment are kept as written
const enc = classifyPublished(at("two%20words-0a1b2c3d.mp4?v=2#t=5"), ORIGINS)!;
assert.equal(enc.kind, "video");
assert.equal(enc.url, at("two%20words-0a1b2c3d.mp4?v=2#t=5"));
assert.equal(enc.name, "two words-0a1b2c3d.mp4");
assert.equal(classifyPublished(`  ${at("clip-0a1b2c3d.mp4")} `, ORIGINS)?.url, at("clip-0a1b2c3d.mp4"), "trimmed");

// refused: another scheme, port, host or lookalike, credentials, an unknown type, a malformed path
for (const bad of [
  "http://uni.example.ts.net:8444/clip-0a1b2c3d.mp4",
  "https://uni.example.ts.net/clip-0a1b2c3d.mp4",
  "https://uni.example.ts.net:8445/clip-0a1b2c3d.mp4",
  "https://uni.example.ts.net.evil.example:8444/clip-0a1b2c3d.mp4",
  "https://evil.example/uni.example.ts.net:8444/clip-0a1b2c3d.mp4",
  "https://uni.example-ts.net:8444/clip-0a1b2c3d.mp4",
  "https://xn--ni-ida.example.ts.net:8444/clip-0a1b2c3d.mp4",
  "https://user:pw@uni.example.ts.net:8444/clip-0a1b2c3d.mp4",
  "https://uni.example.ts.net:8444@evil.example/clip-0a1b2c3d.mp4",
  "https://uni.example.ts.net:8444\\@evil.example/clip-0a1b2c3d.mp4",
  "https:/uni.example.ts.net:8444/clip-0a1b2c3d.mp4",
  "//uni.example.ts.net:8444/clip-0a1b2c3d.mp4",
  "javascript:alert(1)//uni.example.ts.net:8444/clip.mp4",
  "data:video/mp4;base64,AAAA",
  "blob:https://uni.example.ts.net:8444/0a1b2c3d",
  `${O}/clip 0a1b2c3d.mp4`,
  `${O}/clip-0a1b2c3d.mp4\n`.replace("\n", "%0a\n"),
  `${O}/drawing-0a1b2c3d.svg`,
  `${O}/movie-0a1b2c3d.mov`,
  `${O}/tool-0a1b2c3d.exe`,
  `${O}/clip-0a1b2c3d`,
  `${O}/`,
  `${O}/folder.mp4/`,
  `${O}/bad%E0%A4%A-0a1b2c3d.mp4`,
  `${O}/clip-0a1b2c3d.mp4?.png`.replace(".mp4", ""),
]) assert.equal(classifyPublished(bad, ORIGINS), null, bad);
assert.equal(classifyPublished(at("clip-0a1b2c3d.mp4"), []), null, "no hub, nothing plays inline");
assert.equal(classifyPublished(at("clip-0a1b2c3d.mp4"), ["https://other.example.ts.net:8444"]), null);

// ── a Published note: its metadata url is what plays; the URL's own type is its kind ──────────────────────
const note = (metadata: Record<string, unknown>, tags = [PUBLISHED_TAG]) => ({ tags, metadata });
const pub = publishedFromNote(note({ url: at("clip-0a1b2c3d.mp4"), mime: "video/mp4", kind: "video" }), ORIGINS)!;
assert.deepEqual([pub.kind, pub.url, pub.name], ["video", at("clip-0a1b2c3d.mp4"), "clip-0a1b2c3d.mp4"]);
assert.equal(publishedFromNote(note({ url: at("voice-0a1b2c3d.m4a"), mime: "audio/mp4", kind: "audio" }), ORIGINS)?.kind, "audio");
assert.equal(publishedFromNote(note({ url: at("plan-0a1b2c3d.pdf"), mime: "application/pdf", kind: "doc" }), ORIGINS)?.kind, "doc");
// a metadata kind or mime is never trusted over the URL's type
assert.equal(publishedFromNote(note({ url: at("clip-0a1b2c3d.mp4"), mime: "image/png", kind: "video" }), ORIGINS)?.kind, "video");
assert.equal(publishedFromNote(note({ url: at("clip-0a1b2c3d.mp4"), mime: "video/mp4", kind: "image" }), ORIGINS)?.kind, "video");
// an image by mime but SVG, or a URL off the publisher, never plays
assert.equal(publishedFromNote(note({ url: at("d-0a1b2c3d.svg"), mime: "image/svg+xml", kind: "image" }), ORIGINS), null);
assert.equal(publishedFromNote(note({ url: "https://evil.example:8444/clip-0a1b2c3d.mp4", mime: "video/mp4", kind: "video" }), ORIGINS), null);
// only a note tagged published, with a url
assert.equal(publishedFromNote(note({ url: at("clip-0a1b2c3d.mp4"), mime: "video/mp4", kind: "video" }, ["decision"]), ORIGINS), null);
assert.equal(publishedFromNote(note({ mime: "video/mp4", kind: "video" }), ORIGINS), null);
assert.equal(publishedFromNote({ tags: [PUBLISHED_TAG] }, ORIGINS), null);
assert.equal(publishedFromNote(null, ORIGINS), null);

// ── the published files a note's text links, in order, each once; code is not a link ──────────────────
const text = [
  "# Which cut?",
  "",
  `Watch ${at("clip-0a1b2c3d.mp4")}, then the [plan](${at("plan-0a1b2c3d.html")}).`,
  `<${at("voice-0a1b2c3d.mp3")}>`,
  `Again: ${at("clip-0a1b2c3d.mp4")}`,
  "`" + at("code-0a1b2c3d.mp4") + "`",
  "```",
  at("fenced-0a1b2c3d.png"),
  "```",
  `Elsewhere: https://www.example.org/clip.mp4 and ${at("flow-0a1b2c3d.png")}`,
].join("\n");
assert.deepEqual(publishedIn(text, ORIGINS).map((p) => p.url), [at("clip-0a1b2c3d.mp4"), at("plan-0a1b2c3d.html"), at("voice-0a1b2c3d.mp3"), at("flow-0a1b2c3d.png")]);
// counted where a note shows a player: a heading or a table cell is not (the note view leaves them links)
assert.deepEqual(publishedIn(`## See ${at("clip-0a1b2c3d.mp4")}\n\n| a | b |\n|---|---|\n| ${at("clip-0a1b2c3d.webm")} | x |\n\n> ${at("flow-0a1b2c3d.png")}\n\n- ${at("voice-0a1b2c3d.mp3")}`, ORIGINS).map((p) => p.kind), ["image", "audio"]);
// one file in two spellings (host case) is one file
assert.equal(publishedIn(`${at("clip-0a1b2c3d.mp4")} and https://UNI.example.ts.net:8444/clip-0a1b2c3d.mp4`, ORIGINS).length, 1);
assert.equal(keyOf("https://UNI.example.ts.net:8444/a%C3%A9-0a1b2c3d.mp4"), keyOf("https://uni.example.ts.net:8444/aé-0a1b2c3d.mp4"));
assert.deepEqual(publishedIn(text, []), []);
assert.deepEqual(publishedIn("", ORIGINS), []);

// ── where the player goes in a rendered note (the markdown tree) ───────────────────────────────────────
const t = (value: string): HastNode => ({ type: "text", value });
const el = (tagName: string, properties: Record<string, unknown>, children: HastNode[] = []): HastNode => ({ type: "element", tagName, properties, children });
const a = (href: string, label = href) => el("a", { href }, [t(label)]);
const p = (...children: HastNode[]) => el("p", {}, children);
const root = (...children: HastNode[]): HastNode => ({ type: "root", children });
const run = (tree: HastNode, opts: { origins?: string[]; shown?: string[] } = {}) => { rehypePublished({ origins: opts.origins ?? ORIGINS, shown: opts.shown ?? [] })(tree); return tree; };
/** The tree as tag names, a player as `media:<kind>`, text as its words. */
const shape = (n: HastNode): unknown => n.type === "text" ? n.value : n.type === "element" && n.tagName === "published-media" ? `media:${n.properties?.["dataKind"]}` : n.type === "element" ? { [n.tagName]: (n.children ?? []).map(shape) } : (n.children ?? []).map(shape);

const V = at("clip-0a1b2c3d.mp4");
// a link alone in its paragraph becomes the player, in its place
assert.deepEqual(shape(run(root(p(t("Before")), p(a(V)), p(t("After"))))), [{ p: ["Before"] }, "media:video", { p: ["After"] }]);
// a labelled link alone is a player too; surrounding whitespace and a line break don't make it a sentence
assert.deepEqual(shape(run(root(p(t(" "), a(V, "the clip"), el("br", {}), t("\n"))))), ["media:video"]);
// a link inside a sentence stays a link; the player follows the paragraph
assert.deepEqual(shape(run(root(p(t("Watch "), a(V), t(" first."))))), [{ p: ["Watch ", { a: [V] }, " first."] }, "media:video"]);
// the same file twice: one player (the first place), the second a link
assert.deepEqual(shape(run(root(p(a(V)), p(t("Again "), a(V))))), ["media:video", { p: ["Again ", { a: [V] }] }]);
// pages and docs stay links; other hosts stay links
const H = at("plan-0a1b2c3d.html"), D = at("plan-0a1b2c3d.pdf");
assert.deepEqual(shape(run(root(p(a(H)), p(a(D)), p(a("https://www.example.org/clip.mp4"))))), [{ p: [{ a: [H] }] }, { p: [{ a: [D] }] }, { p: [{ a: ["https://www.example.org/clip.mp4"] }] }]);
// an image written as markdown (![](url)) is the published image; a video written as one plays as video
assert.deepEqual(shape(run(root(p(el("img", { src: at("flow-0a1b2c3d.png"), alt: "flow" }))))), ["media:image"]);
assert.deepEqual(shape(run(root(p(el("img", { src: V, alt: "" }))))), ["media:video"]);
// a list item: alone it is the player, in a sentence the player follows within the item
const li = (...c: HastNode[]) => el("li", {}, c);
assert.deepEqual(shape(run(root(el("ul", {}, [li(a(V)), li(t("hear "), a(at("voice-0a1b2c3d.mp3")))])))), [{ ul: [{ li: ["media:video"] }, { li: ["hear ", { a: [at("voice-0a1b2c3d.mp3")] }, "media:audio"] }] }]);
// a file in an item's words and again in a list nested under it: the player follows the item's words, before the nested list
assert.deepEqual(shape(run(root(el("ul", {}, [li(t("watch "), a(V), el("ul", {}, [li(t("again "), a(V))]))])))), [{ ul: [{ li: ["watch ", { a: [V] }, "media:video", { ul: [{ li: ["again ", { a: [V] }] }] }] }] }]);
assert.deepEqual(shape(run(root(el("ul", {}, [li(a(V), el("ul", {}, [li(t("more"))]))])))), [{ ul: [{ li: ["media:video", { ul: [{ li: ["more"] }] }] }] }]);
// a loose list item (its words in a paragraph) and a quote are walked the same way
assert.deepEqual(shape(run(root(el("blockquote", {}, [p(a(V))])))), [{ blockquote: ["media:video"] }]);
// table cells, headings and code are never replaced
const cell = root(el("table", {}, [el("tr", {}, [el("td", {}, [a(V)])])]), el("h2", {}, [a(V)]), el("pre", {}, [el("code", {}, [t(V)])]));
assert.deepEqual(shape(run(cell)), [{ table: [{ tr: [{ td: [{ a: [V] }] }] }] }, { h2: [{ a: [V] }] }, { pre: [{ code: [V] }] }]);
// already shown above the body (a Published note's own file): its line goes, other mentions stay links, no second player
assert.deepEqual(shape(run(root(p(a(V)), p(t("Made for "), a(V))), { shown: [V] })), [{ p: ["Made for ", { a: [V] }] }]);
// ... also when the renderer wrote the body's URL another way (percent-encoded, another host case) than the metadata
const raw = at("café-0a1b2c3d.mp4"), rendered = at("caf%C3%A9-0a1b2c3d.mp4");
assert.deepEqual(shape(run(root(p(a(rendered))), { shown: [raw] })), []);
assert.deepEqual(shape(run(root(p(a("https://UNI.example.ts.net:8444/clip-0a1b2c3d.mp4"))), { shown: [V] })), []);
// no origins: nothing changes
assert.deepEqual(shape(run(root(p(a(V))), { origins: [] })), [{ p: [{ a: [V] }] }]);
// the player carries what it plays
const m = run(root(p(a(at("two%20words-0a1b2c3d.mp4#t=5"), "the clip")))).children![0];
assert.deepEqual([m.properties?.["dataUrl"], m.properties?.["dataKind"], m.properties?.["dataName"]], [at("two%20words-0a1b2c3d.mp4#t=5"), "video", "two words-0a1b2c3d.mp4"]);

console.log("publishedMedia: ok");
