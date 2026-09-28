// Run: node --experimental-strip-types scripts/vaultlinks.test.ts
import assert from "node:assert/strict";
import { parseInline, parseMarkdown, type Inline } from "../src/markdown.ts";
import { matchShorthandAt, noteRoute, noteUrl, parseNoteRoute, parseNoteUrl, parseShorthand, refLabel, sameHub, wikilinkResolver } from "../src/vaultlinks.ts";

const HUB = "https://uni-1.taildf9ce2.ts.net";
const ID = "01M33NQB9BK6543P4SEJ2WKFMS";

// ── Canonical URLs ─────────────────────────────────────────────────────────
assert.deepEqual(parseNoteUrl(`${HUB}/surface/parachute/v/uni/n/${ID}`), { hub: HUB, vault: "uni", ref: ID });
assert.deepEqual(parseNoteUrl(`${HUB}/surface/parachute/v/uni/n/${ID}/edit`), { hub: HUB, vault: "uni", ref: ID });
assert.deepEqual(parseNoteUrl(`${HUB}/v/uni/n/${ID}?x=1#h`), { hub: HUB, vault: "uni", ref: ID });
assert.deepEqual(parseNoteUrl(`${HUB}/surface/parachute/v/unforced/n/System%2FNow`), { hub: HUB, vault: "unforced", ref: "System/Now" });
assert.equal(parseNoteUrl(`HTTPS://UNI-1.example/v/uni/n/x`)?.hub, "https://uni-1.example");
assert.equal(parseNoteUrl(`${HUB}/surface/parachute/v/uni`), null);
assert.equal(parseNoteUrl(`${HUB}/surface/parachute/v/uni/n/a/b`), null); // nested path segment isn't the grammar
assert.equal(parseNoteUrl(`${HUB}/surface/parachute/v/..%2Fx/n/a`), null); // vault name rule
assert.equal(parseNoteUrl(`${HUB}/surface/parachute/v/uni/n/%E0%A4%A`), null); // bad escape
assert.equal(parseNoteUrl(`javascript:alert(1)//v/uni/n/x`), null);
assert.equal(parseNoteUrl(`https://github.com/org/repo`), null);

// Round trip: what we share is what we parse.
const u = noteUrl(`${HUB}/`, "unforced", "Notes/2026/09-05/07-03-09");
assert.equal(u, `${HUB}/surface/parachute/v/unforced/n/Notes%2F2026%2F09-05%2F07-03-09`);
assert.deepEqual(parseNoteUrl(u), { hub: HUB, vault: "unforced", ref: "Notes/2026/09-05/07-03-09" });

// ── Shorthand ──────────────────────────────────────────────────────────────
assert.deepEqual(parseShorthand("uni:System/Now"), { hub: null, vault: "uni", ref: "System/Now" });
assert.deepEqual(parseShorthand("uni:System/Uni app — surface architecture"), { hub: null, vault: "uni", ref: "System/Uni app — surface architecture" });
assert.deepEqual(parseShorthand(`unforced:${ID}`), { hub: null, vault: "unforced", ref: ID });
assert.equal(parseShorthand("uni:1939"), null);       // port-ish, not a note
assert.equal(parseShorthand("uni:hello"), null);      // no path, not an id
assert.equal(parseShorthand("uni://x/y"), null);
assert.equal(parseShorthand("other:System/Now"), null);
assert.equal(parseShorthand("mailto:a/b"), null);
assert.equal(matchShorthandAt("see uni:System/Now.", 4)?.end, 18);
assert.equal(matchShorthandAt("xuni:System/Now", 1), null);  // mid-word
assert.equal(matchShorthandAt("a@uni:System/Now", 2), null);

// ── Markdown integration ───────────────────────────────────────────────────
const only = (src: string): Inline => { const c = parseInline(src); assert.equal(c.length, 1, JSON.stringify(c)); return c[0]; };
const vl = (n: Inline) => { assert.equal(n.t, "vaultlink", JSON.stringify(n)); return n as Extract<Inline, { t: "vaultlink" }>; };

let n = vl(only(`${HUB}/surface/parachute/v/uni/n/${ID}`));
assert.deepEqual([n.ref.vault, n.ref.ref, n.href], ["uni", ID, `${HUB}/surface/parachute/v/uni/n/${ID}`]);
assert.deepEqual(n.c, [{ t: "text", v: "uni · 01M33NQB…" }]);

n = vl(only(`[the plan](${HUB}/surface/parachute/v/uni/n/${ID})`));
assert.deepEqual(n.c, [{ t: "text", v: "the plan" }]);

n = vl(only(`<${HUB}/v/uni/n/${ID}>`));
assert.equal(n.ref.ref, ID);

n = vl(only("`uni:System/Uni app — surface architecture`"));
assert.equal(n.ref.ref, "System/Uni app — surface architecture");
assert.equal(n.href, null);

const mixed = parseInline("Read uni:System/Now, then https://example.com/x.");
assert.deepEqual(mixed.map((x) => x.t), ["text", "vaultlink", "text", "link", "text"]);
assert.equal(vl(mixed[1]).ref.ref, "System/Now");
assert.deepEqual((mixed[2] as { v: string }).v, ", then ");

// Ordinary things stay ordinary.
assert.equal(only("`uni:hello`").t, "code");
assert.equal(only("``uni:System/Now``").t, "code");      // only single-backtick spans
assert.equal(only("https://example.com/v/x").t, "link");
assert.deepEqual(parseInline("ratio uni:1939 here").map((x) => x.t), ["text"]);
assert.equal(parseMarkdown("```\nuni:System/Now\n```")[0].t, "code");   // fenced code is literal
// Unsafe schemes never become links, even with note-shaped paths.
assert.ok(!JSON.stringify(parseInline("[x](javascript:alert(1)/v/uni/n/a)")).includes("vaultlink"));

// ── Hubs, labels, routes ───────────────────────────────────────────────────
assert.ok(sameHub({ hub: null, vault: "uni", ref: "a/b" }, HUB));
assert.ok(sameHub({ hub: HUB, vault: "uni", ref: "a" }, `${HUB}/`));
assert.ok(!sameHub({ hub: "https://evil.example", vault: "uni", ref: "a" }, HUB));
assert.ok(!sameHub({ hub: HUB, vault: "uni", ref: "a" }, null));
assert.equal(refLabel({ hub: null, vault: "uni", ref: "System/Now" }), "uni · System/Now");

assert.deepEqual(parseNoteRoute(noteRoute("uni", "System/Uni app")), { hub: null, vault: "uni", ref: "System/Uni app" });
assert.equal(parseNoteRoute("#note/uni"), null);
assert.equal(parseNoteRoute("#note/../x/y"), null);
assert.equal(parseNoteRoute("https://x/#note/uni/a"), null);

// Wikilinks resolve through the note's outbound link records.
const note = { id: "S", links: [
  { sourceId: "S", targetId: "T1", targetNote: { id: "T1", path: "Runbooks/Tending" } },
  { sourceId: "X", targetId: "S", targetNote: { id: "S", path: "Self/Me" } }, // inbound: ignored
] };
const resolve = wikilinkResolver(note, "uni");
assert.deepEqual(resolve("Runbooks/Tending"), { href: noteRoute("uni", "T1"), exists: true });
assert.deepEqual(resolve("tending"), { href: noteRoute("uni", "T1"), exists: true });
assert.deepEqual(resolve("Runbooks/Tending#Weekly"), { href: noteRoute("uni", "T1"), exists: true });
assert.deepEqual(resolve("Nowhere/Yet"), { href: noteRoute("uni", "Nowhere/Yet"), exists: false });
assert.equal(resolve("Self/Me").exists, false);
// A hostile target can only ever become an in-app route.
assert.ok(resolve("javascript:alert(1)").href.startsWith("#note/uni/"));

console.log("vaultlinks ok");
