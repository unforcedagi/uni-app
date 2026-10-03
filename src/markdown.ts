// Minimal, safe markdown for chat messages (Uni's replies are markdown).
//
// Output is a plain data tree, never HTML: the renderer builds React
// elements from it, so no message text can inject markup. Links are only
// kept for http(s) and mailto; anything else (javascript:, data:, intent:)
// degrades to plain text. Covers what agent replies actually use: headings,
// paragraphs, bold/italic/strike, inline code, fenced code, block quotes,
// ordered/unordered (nested by indent) lists, rules, [text](url) links and
// bare URLs. Parachute note URLs and `uni:`/`unforced:` note references
// become `vaultlink` nodes, which open the in-app note view.

import { matchShorthandAt, parseNoteUrl, parseShorthand, refLabel, SHORTHAND_VAULTS, type VaultRef } from "./vaultlinks.ts";

export type Inline =
  | { t: "text"; v: string }
  | { t: "strong" | "em" | "del"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "link"; href: string; c: Inline[] }
  /** A vault note. `href` is the original https URL (null for a shorthand ref). */
  | { t: "vaultlink"; ref: VaultRef; href: string | null; c: Inline[] }
  | { t: "br" };

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: number; c: Inline[] }
  | { t: "code"; lang: string; v: string }
  | { t: "quote"; c: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: Block[][] }
  | { t: "hr" };

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

export function safeHref(url: string): string | null {
  const u = url.trim();
  return SAFE_URL.test(u) && !/\s/.test(u) ? u : null;
}

const FENCE = /^ {0,3}(```|~~~)\s*([\w+#.-]*)\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
// Message text is remote input: nesting beyond this renders flat, so a crafted
// message (`>>>>…`, `[[[[…`, deeply indented lists) cannot overflow the stack
// and take the whole UI down with it.
const MAX_DEPTH = 12;
// A `[label](url)` label longer than this is not treated as a link; keeps the
// bracket scan linear on inputs like `[[[[…`.
const MAX_LABEL = 1000;

export function parseMarkdown(src: string): Block[] {
  return parseBlocks(src.replace(/\r\n?/g, "\n").split("\n"));
}

function parseBlocks(lines: string[], depth = 0): Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ t: "p", c: parseInline(para.join("\n"), depth) });
    para = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++; // closing fence (or EOF: an unclosed fence runs to the end)
      out.push({ t: "code", lang: fence[2] ?? "", v: body.join("\n") });
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    const h = HEADING.exec(line);
    if (h) { flush(); out.push({ t: "h", level: h[1].length, c: parseInline(h[2], depth) }); i++; continue; }
    if (HR.test(line)) { flush(); out.push({ t: "hr" }); i++; continue; }
    const nest = depth < MAX_DEPTH;
    if (nest && QUOTE.test(line)) {
      flush();
      const body: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) body.push(QUOTE.exec(lines[i])![1]);
      out.push({ t: "quote", c: parseBlocks(body, depth + 1) });
      continue;
    }
    if (nest && ITEM.test(line)) {
      flush();
      const [list, next] = parseList(lines, i, depth);
      out.push(list);
      i = next;
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
  return out;
}

function parseList(lines: string[], start: number, depth: number): [Block, number] {
  const first = ITEM.exec(lines[start])!;
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items: string[][] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    const m = ITEM.exec(line);
    if (m && m[1].length === indent && /\d/.test(m[2]) === ordered) {
      items.push([m[3]]);
      i++;
      continue;
    }
    if (!line.trim()) {
      // A blank line ends the list unless the next line continues it.
      const nxt = lines[i + 1];
      if (nxt !== undefined && (/^\s+\S/.test(nxt) || (ITEM.exec(nxt)?.[1].length === indent))) { items[items.length - 1].push(""); i++; continue; }
      break;
    }
    const lead = /^(\s*)/.exec(line)![1].length;
    if (lead > indent) { items[items.length - 1].push(line.slice(Math.min(lead, indent + 4))); i++; continue; }
    if (m) break; // sibling list of another type / shallower level
    // Lazy continuation of the item's paragraph.
    items[items.length - 1].push(line.trim());
    i++;
  }
  return [{ t: "list", ordered, start: ordered ? parseInt(first[2], 10) : 1, items: items.map((it) => parseBlocks(it, depth + 1)) }, i];
}

// ── Inline ────────────────────────────────────────────────────────────────

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/iy;
const AUTOLINK_RE = /<((?:https?:\/\/|mailto:)[^\s<>]+)>/iy;

export function parseInline(src: string, depth = 0): Inline[] {
  if (depth > MAX_DEPTH) return src ? [{ t: "text", v: src }] : [];
  const out: Inline[] = [];
  // Emphasis marks with no possible closer from a given offset on (see matchEmphasis).
  const dead = new Map<string, number>();
  let text = "";
  const push = (node: Inline) => { if (text) { out.push({ t: "text", v: text }); text = ""; } out.push(node); };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\" && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!~>|]/.test(src[i + 1])) { text += src[i + 1]; i += 2; continue; }
    if (ch === "\n") {
      // Chat semantics: every newline is a visible line break.
      push({ t: "br" }); i++; continue;
    }
    if (ch === "`") {
      let n = 1;
      while (src[i + n] === "`") n++;
      const run = "`".repeat(n);
      const end = src.indexOf(run, i + run.length);
      if (end > 0) {
        const v = src.slice(i + run.length, end).replace(/^ (.*) $/, "$1");
        // `uni:System/Now` in code is how agents cite notes: make it tappable.
        const ref = n === 1 ? parseShorthand(v) : null;
        push(ref ? { t: "vaultlink", ref, href: null, c: [{ t: "text", v }] } : { t: "code", v });
        i = end + run.length; continue;
      }
      text += run; i += run.length; continue;
    }
    if (src.startsWith("[[", i)) {
      // Bound the search to the 512-char body limit: an unbounded indexOf
      // rescans the rest of the message at every `[[` (quadratic).
      const rel = src.slice(i + 2, i + 2 + 512 + 2).indexOf("]]");
      const end = rel < 0 ? -1 : i + 2 + rel;
      const body = end < 0 ? "" : src.slice(i + 2, end);
      if (body && body.length <= 512 && !/[\r\n]/.test(body)) {
        const [path, alias] = body.split("|");
        const target = path.split("#")[0].trim();
        const explicit = /^([a-z][a-z0-9_-]*):(.*)$/.exec(target);
        const vault = explicit?.[1] ?? "uni";
        const ref = explicit?.[2].trim() ?? target;
        if (ref && SHORTHAND_VAULTS.includes(vault as typeof SHORTHAND_VAULTS[number])) {
          push({ t: "vaultlink", ref: { hub: null, vault, ref, recover: true }, href: null, c: [{ t: "text", v: alias?.trim() || ref.split("/").pop() || ref }] });
          i = end + 2; continue;
        }
      }
    }
    if (ch === "[") {
      const link = matchLink(src, i);
      if (link) {
        const href = safeHref(link.href);
        const note = href ? parseNoteUrl(href) : null;
        if (note) push({ t: "vaultlink", ref: note, href, c: parseInline(link.label, depth + 1) });
        else if (href) push({ t: "link", href, c: parseInline(link.label, depth + 1) });
        else out.push(...flushText(), ...parseInline(link.label, depth + 1));
        i = link.end; continue;
      }
    }
    if (ch === "<") {
      AUTOLINK_RE.lastIndex = i;
      const m = AUTOLINK_RE.exec(src);
      if (m) { push(urlNode(m[1], m[1].replace(/^mailto:/i, ""))); i += m[0].length; continue; }
    }
    if ((ch === "h" || ch === "H") && (i === 0 || !/[\w/]/.test(src[i - 1]))) {
      URL_RE.lastIndex = i;
      const m = URL_RE.exec(src);
      if (m) {
        let url = m[0];
        // Trailing punctuation belongs to the sentence, not the URL; keep a
        // closing paren only when the URL itself opened one.
        while (/[.,;:!?*_~]$/.test(url) || (url.endsWith(")") && count(url, "(") < count(url, ")"))) url = url.slice(0, -1);
        push(urlNode(url, url));
        i += url.length; continue;
      }
    }
    if (SHORTHAND_START.test(ch) && SHORTHAND_VAULTS.some((v) => src.startsWith(`${v}:`, i))) {
      const hit = matchShorthandAt(src, i);
      if (hit) { push({ t: "vaultlink", ref: hit.ref, href: null, c: [{ t: "text", v: src.slice(i, hit.end) }] }); i = hit.end; continue; }
    }
    const emph = matchEmphasis(src, i, depth, dead);
    if (emph) { push(emph.node); i = emph.end; continue; }
    text += ch;
    i++;
  }
  if (text) out.push({ t: "text", v: text });
  return out;

  function flushText(): Inline[] { const t = text; text = ""; return t ? [{ t: "text", v: t }] : []; }
}

const SHORTHAND_START = /[a-z]/;

/** A bare URL: a note URL becomes a vaultlink labelled by its vault and ref. */
function urlNode(href: string, label: string): Inline {
  const note = parseNoteUrl(href);
  return note ? { t: "vaultlink", ref: note, href, c: [{ t: "text", v: refLabel(note) }] } : { t: "link", href, c: [{ t: "text", v: label }] };
}

function count(s: string, c: string) { return s.split(c).length - 1; }

function matchLink(src: string, i: number): { label: string; href: string; end: number } | null {
  let depth = 0;
  let j = i;
  const limit = Math.min(src.length, i + MAX_LABEL + 2);
  for (; j < limit; j++) {
    if (src[j] === "\\") { j++; continue; }
    if (src[j] === "[") depth++;
    else if (src[j] === "]" && --depth === 0) break;
    else if (src[j] === "\n" && src[j + 1] === "\n") return null;
  }
  if (j >= limit || src[j + 1] !== "(") return null;
  const m = /^\(\s*<?([^\s()<>]*(?:\([^\s()]*\)[^\s()<>]*)*)>?(?:\s+"[^"]*")?\s*\)/.exec(src.slice(j + 1));
  if (!m) return null;
  return { label: src.slice(i + 1, j), href: m[1], end: j + 1 + m[0].length };
}

// `dead` maps a mark to the offset from which a closer search already ran off
// the end: whether a closer is valid never depends on the opener, so any later
// opener of that mark fails too. This keeps `*a *a *a …` linear, not quadratic.
function matchEmphasis(src: string, i: number, depth: number, dead: Map<string, number>): { node: Inline; end: number } | null {
  const tries: [string, "strong" | "em" | "del"][] = [["**", "strong"], ["__", "strong"], ["~~", "del"], ["*", "em"], ["_", "em"]];
  for (const [mark, t] of tries) {
    if (!src.startsWith(mark, i)) continue;
    const after = src[i + mark.length];
    if (!after || /\s/.test(after)) continue;
    // Intraword underscores (snake_case) are not emphasis.
    if (mark[0] === "_" && i > 0 && /\w/.test(src[i - 1])) continue;
    if (i >= (dead.get(mark) ?? Infinity)) continue;
    let j = i + mark.length;
    while (true) {
      j = src.indexOf(mark, j);
      if (j < 0) { dead.set(mark, Math.min(i, dead.get(mark) ?? Infinity)); break; }
      const closeOk = !/\s/.test(src[j - 1]) && j > i + mark.length &&
        !(mark === "*" && src[j + 1] === "*" && src[j - 1] !== "*") &&
        !(mark[0] === "_" && /\w/.test(src[j + mark.length] ?? ""));
      if (closeOk) {
        const inner = src.slice(i + mark.length, j);
        if (inner.includes("\n\n")) break;
        return { node: { t, c: parseInline(inner, depth + 1) }, end: j + mark.length };
      }
      j += mark.length;
    }
  }
  return null;
}

/** Plain-text rendering (room previews, notifications). */
export function markdownToText(src: string): string {
  const inl = (c: Inline[]): string => c.map((n) => n.t === "text" || n.t === "code" ? n.v : n.t === "br" ? " " : inl(n.c)).join("");
  const blk = (b: Block[]): string[] => b.flatMap((x): string[] => {
    switch (x.t) {
      case "p": case "h": return [inl(x.c)];
      case "code": return [x.v];
      case "quote": return blk(x.c);
      case "list": return x.items.flatMap((it) => blk(it));
      case "hr": return [];
    }
  });
  return blk(parseMarkdown(src)).join(" ").replace(/\s+/g, " ").trim();
}
