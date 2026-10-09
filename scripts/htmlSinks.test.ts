// T-77b P2-1: the host CSP has no script-src (sealed srcdoc frames need that), so an HTML sink in src/ would be
// script execution with the Tauri command surface. This fails on any sink. Run: node --experimental-strip-types scripts/htmlSinks.test.ts
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const SINKS: { name: string; re: RegExp }[] = [
  { name: "dangerouslySetInnerHTML", re: /dangerouslySetInnerHTML/ },
  { name: ".innerHTML =", re: /\.innerHTML\s*[+]?=(?!=)/ },
  { name: "insertAdjacentHTML", re: /insertAdjacentHTML/ },
  { name: "document.write", re: /document\s*\.\s*write(ln)?\s*\(/ },
  { name: "rehype-raw", re: /rehype-raw/ },
  { name: "allowDangerousHtml", re: /allowDangerousHtml/ },
  { name: "highlight= prop", re: /\bhighlight\s*=/ },
];
// file (relative to repo root) -> pattern names allowed there, each with a justification. Empty: no safe use exists.
const ALLOW: Record<string, string[]> = {};

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?|mjs|html)$/.test(f)) out.push(p);
  }
  return out;
}

const root = new URL("..", import.meta.url).pathname;
const hits: string[] = [];
for (const file of walk(join(root, "src"))) {
  const rel = relative(root, file);
  const text = readFileSync(file, "utf8");
  for (const s of SINKS) if (s.re.test(text) && !(ALLOW[rel] ?? []).includes(s.name)) hits.push(`${rel}: ${s.name}`);
}
try {
  assert.deepEqual(hits, [], `HTML sink in src/ (host CSP has no script-src): ${hits.join("; ")}`);
  console.log("ok   no HTML sink anywhere in src/");
} catch (e) { console.log(`FAIL no HTML sink anywhere in src/\n     ${(e as Error).message.split("\n")[0]}`); process.exit(1); }
