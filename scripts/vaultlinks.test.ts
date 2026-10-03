// Run: node --experimental-strip-types scripts/vaultlinks.test.ts
import assert from "node:assert/strict";
import { parseInline, parseMarkdown, type Inline } from "../src/markdown.ts";
import { refCandidates, isNoteNotFound, SHORTHAND_VAULTS, matchShorthandAt, noteRoute, noteUrl, parseNoteRoute, parseNoteUrl, parseShorthand, refLabel, sameHub, wikilinkResolver } from "../src/vaultlinks.ts";

const HUB = "https://uni-1.taildf9ce2.ts.net";
const ID = "01M33NQB9BK6543P4SEJ2WKFMS";

// T-24 real chat regressions (written before the parser fix).
const realPaths = ["Projects/Ricki/Phase 1 — work plan", "Projects/Ecociv/Reading experience — concept", "Inbox/Sources/Karpathy — understanding LLM outputs (2026-10-02)"];
const realMessages = [
  "Ricki plan is at uni:Projects/Ricki/Phase 1 — work plan",
  "ready to read in the vault, at uni:Projects/Ecociv/Reading experience — concept.\n\nIt includes:",
  "The first one is saved at uni:Inbox/Sources/Karpathy — understanding LLM outputs (2026-10-02). Design something",
];
for (const [i, message] of realMessages.entries()) {
  const links = parseInline(message).filter((n) => n.t === "vaultlink");
  assert.equal(links[0]?.ref.ref, realPaths[i]);
  assert.equal(parseInline(`\`uni:${realPaths[i]}\``).filter((n) => n.t === "vaultlink")[0]?.ref.ref, realPaths[i]);
}
for (const message of ["(see uni:Projects/Ricki/Phase 1 — work plan)", "uni:Projects/Ricki/Phase 1 — work plan, and the proposal"]) {
  assert.equal(parseInline(message).filter((n) => n.t === "vaultlink")[0]?.ref.ref, realPaths[0]);
}
for (const [source, vault, ref, label] of [
  ["[[Projects/Ricki/Proposal v1]]", "uni", "Projects/Ricki/Proposal v1", "Proposal v1"],
  ["[[Projects/Ricki/Proposal v1|the proposal]]", "uni", "Projects/Ricki/Proposal v1", "the proposal"],
  ["[[unforced:Notes/X#heading]]", "unforced", "Notes/X", "X"],
]) {
  const n = parseInline(source)[0];
  assert.equal(n.t, "vaultlink");
  if (n.t === "vaultlink") { assert.equal(n.ref.vault, vault); assert.equal(n.ref.ref, ref); assert.deepEqual(n.c, [{ t: "text", v: label }]); }
}
for (const source of ["uni:1939", "uni:hello", "a@uni:x/y", "https://x/uni:a/b"]) assert.ok(!parseInline(source).some((n) => n.t === "vaultlink"));
assert.equal(parseInline("uni:01M3ZK2R6A6C62M1ANJCSQNG3M").filter((n) => n.t === "vaultlink")[0]?.ref.ref, "01M3ZK2R6A6C62M1ANJCSQNG3M");
for (const path of ["Projects/Ricki/Phase%201%20%E2%80%94%20work%20plan", "Projects%2FRicki%2FProposal%20v1", "Projects/Ricki/Proposal%20v1"]) {
  assert.equal(parseNoteUrl(`${HUB}/surface/parachute/v/uni/n/${path}`)?.ref, decodeURIComponent(path));
  assert.equal(parseNoteUrl(`${HUB}/surface/parachute/v/uni/n/${path}/edit`)?.ref, decodeURIComponent(path));
}

// ── Canonical URLs ─────────────────────────────────────────────────────────
assert.deepEqual(parseNoteUrl(`${HUB}/surface/parachute/v/uni/n/${ID}`), { hub: HUB, vault: "uni", ref: ID });
assert.deepEqual(parseNoteUrl(`${HUB}/surface/parachute/v/uni/n/${ID}/edit`), { hub: HUB, vault: "uni", ref: ID });
assert.deepEqual(parseNoteUrl(`${HUB}/v/uni/n/${ID}?x=1#h`), { hub: HUB, vault: "uni", ref: ID });
assert.deepEqual(parseNoteUrl(`${HUB}/surface/parachute/v/unforced/n/System%2FNow`), { hub: HUB, vault: "unforced", ref: "System/Now" });
assert.equal(parseNoteUrl(`HTTPS://UNI-1.example/v/uni/n/x`)?.hub, "https://uni-1.example");
assert.equal(parseNoteUrl(`${HUB}/surface/parachute/v/uni`), null);
assert.equal(parseNoteUrl(`${HUB}/surface/parachute/v/uni/n/a/b`)?.ref, "a/b");
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


assert.deepEqual(refCandidates("Projects/Ricki/Phase 1 — work plan extra prose"), ["Projects/Ricki/Phase 1 — work plan extra", "Projects/Ricki/Phase 1 — work plan", "Projects/Ricki/Phase 1 — work", "Projects/Ricki/Phase 1 —", "Projects/Ricki/Phase 1", "Projects/Ricki/Phase"]);
assert.deepEqual(refCandidates("Folder with spaces/First"), []);
assert.deepEqual(refCandidates("Folder with spaces/First second third"), ["Folder with spaces/First second", "Folder with spaces/First"]);
assert.deepEqual(refCandidates(ID), []);
assert.deepEqual(refCandidates("First second third"), ["First second", "First"]);
assert.deepEqual(refCandidates("A/B   C\tD "), ["A/B   C", "A/B"]);
assert.ok(isNoteNotFound("vault: note not found: A/B"));
assert.ok(!isNoteNotFound("unauthorized"));
assert.ok(!isNoteNotFound("network unavailable"));
for (const vault of SHORTHAND_VAULTS) assert.equal(parseShorthand(`${vault}:Notes/X`)?.vault, vault);
for (const stop of ["; ", ": ", "! ", "? ", "`", "<", ">", '"', "]", "\n"]) assert.equal(matchShorthandAt(`uni:A/B title${stop}following`, 0)?.ref.ref, "A/B title");
assert.equal(matchShorthandAt("**uni:A/B title**", 2)?.ref.ref, "A/B title");
assert.equal(parseInline(`[[${"x".repeat(513)}]]`)[0].t, "text");
assert.ok(!parseInline("[[A/B\nC]]").some((n) => n.t === "vaultlink"));
assert.deepEqual(resolve("Runbooks/Tending#Weekly|alias"), { href: noteRoute("uni", "T1"), exists: true });
assert.deepEqual(resolve("unforced:Notes/Title with spaces#Heading|alias"), { href: noteRoute("unforced", "Notes/Title with spaces"), exists: false });
assert.ok(!sameHub({ hub: "https://uni-2.taildf9ce2.ts.net", vault: "uni", ref: ID }, HUB));

const spaced = wikilinkResolver({ id: "S", links: [{ sourceId: "S", targetNote: { id: "T", path: "Notes/Title with spaces" } }] }, "uni");
assert.deepEqual(spaced("Notes/Title with spaces#Heading|alias"), { href: noteRoute("uni", "T"), exists: true });
assert.deepEqual(spaced("uni:Notes/Title with spaces"), { href: noteRoute("uni", "T"), exists: true });
assert.equal(parseInline("[[Title with spaces#Heading|alias]]").filter((n) => n.t === "vaultlink")[0]?.ref.ref, "Title with spaces");
assert.equal(matchShorthandAt("uni:A/B dotted.title,part!word", 0)?.ref.ref, "A/B dotted.title,part!word");
console.log("vaultlinks ok");

// ── Adversarial: a long line of repeated refs must stay linear-ish ─────────
{
  const big = "uni:A/B ".repeat(5000);
  const t0 = performance.now();
  parseInline(big);
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `40k-char shorthand line took ${ms.toFixed(0)}ms`);
}

// ── Adversarial: many unmatched `[[` must not rescan the whole message ─────
{
  const big = "[[a ".repeat(16000); // 64 KiB, the relay's message cap
  const t0 = performance.now();
  parseInline(big);
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `64k unmatched-wikilink line took ${ms.toFixed(0)}ms`);
}
// A real wikilink still parses after the bound.
assert.equal((parseInline("see [[Projects/Ricki/Phase 1 — work plan|the plan]] now").find((x) => x.t === "vaultlink") as any)?.ref.ref, "Projects/Ricki/Phase 1 — work plan");
