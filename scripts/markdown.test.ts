// Run: node --experimental-strip-types scripts/markdown.test.ts (Node >= 22.6)
import assert from "node:assert/strict";
import { markdownToText, parseInline, parseMarkdown, safeHref } from "../src/markdown.ts";

const t = (v: string) => ({ t: "text", v });

// Emphasis, code, strike.
assert.deepEqual(parseInline("a **b** _c_ `d` ~~e~~"), [
  t("a "), { t: "strong", c: [t("b")] }, t(" "), { t: "em", c: [t("c")] }, t(" "), { t: "code", v: "d" }, t(" "), { t: "del", c: [t("e")] },
]);
// snake_case and lone stars are literal.
assert.deepEqual(parseInline("run_uni_app now"), [t("run_uni_app now")]);
assert.deepEqual(parseInline("2 * 3 * 4"), [t("2 * 3 * 4")]);
// Code spans keep markdown literal.
assert.deepEqual(parseInline("`**x**`"), [{ t: "code", v: "**x**" }]);

// Links: safe schemes only; unsafe ones degrade to their label text.
assert.deepEqual(parseInline("see [PR](https://github.com/a/b/pull/1)."), [
  t("see "), { t: "link", href: "https://github.com/a/b/pull/1", c: [t("PR")] }, t("."),
]);
assert.deepEqual(parseInline("[x](javascript:alert(1))"), [t("x")]);
assert.equal(safeHref("javascript:alert(1)"), null);
assert.equal(safeHref("data:text/html,hi"), null);
assert.equal(safeHref("mailto:a@b.c"), "mailto:a@b.c");

// Bare URLs, trailing punctuation excluded, balanced parens kept.
assert.deepEqual(parseInline("go to https://x.org/a, then"), [
  t("go to "), { t: "link", href: "https://x.org/a", c: [t("https://x.org/a")] }, t(", then"),
]);
assert.deepEqual(parseInline("(https://en.wikipedia.org/wiki/A_(b))"), [
  t("("), { t: "link", href: "https://en.wikipedia.org/wiki/A_(b)", c: [t("https://en.wikipedia.org/wiki/A_(b)")] }, t(")"),
]);
// Not a URL inside a word.
assert.deepEqual(parseInline("xhttps://a.b"), [t("xhttps://a.b")]);

// Newlines inside a paragraph are line breaks (chat semantics).
assert.deepEqual(parseMarkdown("one\ntwo"), [{ t: "p", c: [t("one"), { t: "br" }, t("two")] }]);

// Blocks: heading, fenced code (content untouched), quote, hr.
const doc = parseMarkdown("## Plan\n\n```rust\nlet x = **y**;\n```\n> quoted *it*\n\n---");
assert.deepEqual(doc, [
  { t: "h", level: 2, c: [t("Plan")] },
  { t: "code", lang: "rust", v: "let x = **y**;" },
  { t: "quote", c: [{ t: "p", c: [t("quoted "), { t: "em", c: [t("it")] }] }] },
  { t: "hr" },
]);
// Unclosed fence runs to the end instead of swallowing nothing.
assert.deepEqual(parseMarkdown("```\ncode"), [{ t: "code", lang: "", v: "code" }]);

// Lists: ordered with start, nested bullets, continuation.
const list = parseMarkdown("3. first\n4. second\n   - nested\n\nafter");
assert.equal(list.length, 2);
assert.equal(list[0].t, "list");
if (list[0].t === "list") {
  assert.equal(list[0].ordered, true);
  assert.equal(list[0].start, 3);
  assert.equal(list[0].items.length, 2);
  assert.deepEqual(list[0].items[1][1], { t: "list", ordered: false, start: 1, items: [[{ t: "p", c: [t("nested")] }]] });
}
assert.deepEqual(list[1], { t: "p", c: [t("after")] });
const bullets = parseMarkdown("- a\n- b");
assert.equal(bullets[0].t === "list" && bullets[0].items.length, 2);

// HTML is never interpreted: it stays text.
assert.deepEqual(parseMarkdown("<img src=x onerror=alert(1)>"), [{ t: "p", c: [t("<img src=x onerror=alert(1)>")] }]);

// Plain-text preview.
assert.equal(markdownToText("**Done** — see [PR](https://x.y)\n- one\n- two"), "Done — see PR one two");

// Robustness: pathological inputs terminate.
for (const s of ["*".repeat(500), "[".repeat(300), "_a".repeat(300), "> ".repeat(100), "1. ".repeat(100), "`".repeat(301)]) parseMarkdown(s);

// Remote-input hardening: deep nesting must not overflow the stack (a throw
// here would crash the whole message list), and unmatched emphasis/bracket
// runs must stay fast.
for (const s of [">".repeat(20000) + " x", "[".repeat(5000) + "a" + "](http://x)".repeat(5000),
  Array.from({ length: 400 }, (_, i) => " ".repeat(i * 2) + "- a").join("\n")]) {
  parseMarkdown(s);
  markdownToText(s);
}
{
  const t0 = Date.now();
  for (const s of ["*a ".repeat(20000), "_a ".repeat(20000), "~~a ".repeat(15000), "[a".repeat(20000)]) parseMarkdown(s);
  assert.ok(Date.now() - t0 < 3000, `pathological emphasis took ${Date.now() - t0} ms`);
}
// Past the nesting cap content survives as text rather than vanishing.
assert.ok(markdownToText(">".repeat(50) + " deep").includes("deep"));
// Emphasis still pairs after an earlier unmatched opener of the same mark.
assert.deepEqual(parseInline("a * b *c*"), [t("a * b "), { t: "em", c: [t("c")] }]);

console.log("markdown tests passed");
