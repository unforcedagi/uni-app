// Links in plain text (src/areas/linkText.ts, which Mail and To Post use): a URL reads as its host. Moved from the retired navtree test
// (T-335). Run: node --experimental-strip-types scripts/linkText.test.ts
import assert from "node:assert/strict";
import { linkLabel, splitLinks } from "../src/areas/linkText.ts";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}

check("links: a URL reads as its domain, stays a link, trailing punctuation stays out", () => {
  assert.deepEqual(splitLinks("Try https://docs.example.com/a/b?x=1, then answer"), [{ text: "Try " }, { url: "https://docs.example.com/a/b?x=1", label: "docs.example.com" }, { text: ", then answer" }]);
  assert.deepEqual(splitLinks("see www.example.org."), [{ text: "see " }, { url: "https://www.example.org", label: "example.org" }, { text: "." }]);
  assert.deepEqual(splitLinks("no links here"), [{ text: "no links here" }]);
  assert.deepEqual(splitLinks("(https://a.io/x)"), [{ text: "(" }, { url: "https://a.io/x", label: "a.io" }, { text: ")" }]);
  assert.equal(linkLabel("http://localhost:3000/x"), "link");
  assert.equal(splitLinks("javascript:alert(1)").length, 1);
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("linkText: all passed");
