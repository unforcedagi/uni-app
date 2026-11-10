// T-335 OTA: the shell's contract with the screens, as text. A screens bundle runs only on a shell with the same
// SHELL_API (src-tauri/src/ota.rs, src/ota.ts), so the number must change whenever this contract does:
//   - every command the screens can invoke (tauri::generate_handler! in src-tauri/src/lib.rs), with its arguments and
//     result as written (names and types; a change inside a returned struct still needs a bump by hand);
//   - the plugins and URI schemes the shell registers;
//   - the capability files (what the screens are allowed to call), by hash.
// src-tauri/shell-api.txt records this text for each API number. scripts/shellApi.test.ts fails when today's text
// differs from the block for SHELL_API, or when a block an earlier release shipped was edited instead of a new number.
//   node --experimental-strip-types scripts/shellApi.ts   prints today's block, for a new number's entry
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const collapse = (s: string) => s.replace(/\s+/g, " ").replace(/,\s*([)>])/g, "$1").replace(/\(\s+/g, "(").trim();

/** `name(args) -> Ret` for one `#[tauri::command]` fn, whitespace and trailing commas normalised. */
export function commandSignature(src: string, name: string): string | null {
  const head = new RegExp(`#\\[tauri::command[^\\]]*\\]\\s*(?:#\\[[^\\]]*\\]\\s*)*(?:pub(?:\\([^)]*\\))?\\s+)?(async\\s+)?fn\\s+${name}\\b`);
  const m = head.exec(src);
  if (!m) return null;
  const i = m.index + m[0].length;
  // Generic parameters, then the argument list (balanced), then the return type up to the body or a where clause.
  const open = src.indexOf("(", i);
  const generics = src.slice(i, open);
  const args = balanced(src, open);
  const rest = src.slice(open + args.length);
  const end = rest.search(/\{|\bwhere\b/);
  const ret = rest.slice(0, end);
  return collapse(`${m[1] ? "async " : ""}${name}${generics}${args}${ret}`);
}

/** The text from the "(" at ``open`` to its matching ")". */
function balanced(src: string, open: number): string {
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "(") depth++;
    else if (src[j] === ")" && --depth === 0) return src.slice(open, j + 1);
  }
  throw new Error("unbalanced parentheses");
}

/** The command paths in the invoke handler, cfg attributes dropped. */
export function handlerCommands(lib: string): string[] {
  const m = /generate_handler!\s*\[([\s\S]*?)\]\s*\)/.exec(lib);
  if (!m) throw new Error("no tauri::generate_handler! in lib.rs");
  return m[1].replace(/#\[[^\]]*\]/g, "").replace(/\/\/[^\n]*/g, "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** Today's contract text, one line per item, sorted. */
export function shellContract(root: string): string[] {
  const srcDir = join(root, "src-tauri/src");
  const lib = readFileSync(join(srcDir, "lib.rs"), "utf8");
  const lines: string[] = [];
  for (const path of handlerCommands(lib)) {
    const parts = path.split("::");
    const name = parts.pop()!;
    const file = parts.length ? join(srcDir, `${parts.join("/")}.rs`) : join(srcDir, "lib.rs");
    const sig = commandSignature(readFileSync(file, "utf8"), name);
    if (!sig) throw new Error(`command ${path}: no #[tauri::command] fn ${name} in ${file}`);
    const mod = parts.length ? parts.join("::") + "::" : "";
    lines.push(sig.startsWith("async ") ? `command async ${mod}${sig.slice(6)}` : `command ${mod}${sig}`);
  }
  for (const m of lib.matchAll(/\.plugin\(/g)) lines.push(`plugin ${collapse(balanced(lib, m.index + m[0].length - 1).slice(1, -1))}`);
  for (const m of lib.matchAll(/register_[a-z_]*uri_scheme_protocol\(\s*"([^"]+)"/g)) lines.push(`protocol ${m[1]}`);
  const caps = join(root, "src-tauri/capabilities");
  for (const f of readdirSync(caps).filter((f) => f.endsWith(".json")).sort()) {
    const canon = JSON.stringify(JSON.parse(readFileSync(join(caps, f), "utf8")));
    lines.push(`capability ${f} ${createHash("sha256").update(canon).digest("hex").slice(0, 16)}`);
  }
  return [...new Set(lines)].sort();
}

/** shell-api.txt: `api N` lines, each followed by its contract lines; `#` comments and blank lines ignored. */
export function parseRecord(text: string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  let cur: string[] | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (!line || line.startsWith("#")) continue;
    const m = /^api (\d+)$/.exec(line);
    if (m) {
      if (out.has(Number(m[1]))) throw new Error(`shell-api.txt: api ${m[1]} appears twice`);
      cur = [];
      out.set(Number(m[1]), cur);
    } else if (cur) cur.push(line.trim());
    else throw new Error("shell-api.txt: a line before the first `api N`");
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = new URL("..", import.meta.url).pathname;
  console.log(shellContract(root).join("\n"));
}
