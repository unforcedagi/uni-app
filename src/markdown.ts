// Minimal, safe markdown for chat messages (Uni's replies are markdown).
//
// Output is a plain data tree, never HTML: the renderer builds React
// elements from it, so no message text can inject markup. Links are only
// kept for http(s) and mailto; anything else (javascript:, data:, intent:)
// degrades to plain text. Covers what agent replies actually use: headings,
// paragraphs, bold/italic/strike, inline code, fenced code, block quotes,
// ordered/unordered (nested by indent) lists, rules, [text](url) links and
// bare URLs.

export type Inline =
  | { t: "text"; v: string }
  | { t: "strong" | "em" | "del"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "link"; href: string; c: Inline[] }
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

export function parseMarkdown(src: string): Block[] {
  return parseBlocks(src.replace(/\r\n?/g, "\n").split("\n"));
}

function parseBlocks(lines: string[]): Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ t: "p", c: parseInline(para.join("\n")) });
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
    if (h) { flush(); out.push({ t: "h", level: h[1].length, c: parseInline(h[2]) }); i++; continue; }
    if (HR.test(line)) { flush(); out.push({ t: "hr" }); i++; continue; }
    if (QUOTE.test(line)) {
      flush();
      const body: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) body.push(QUOTE.exec(lines[i])![1]);
      out.push({ t: "quote", c: parseBlocks(body) });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      flush();
      const [list, next] = parseList(lines, i);
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

function parseList(lines: string[], start: number): [Block, number] {
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
  return [{ t: "list", ordered, start: ordered ? parseInt(first[2], 10) : 1, items: items.map((it) => parseBlocks(it)) }, i];
}

// ── Inline ────────────────────────────────────────────────────────────────

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/iy;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const push = (node: Inline) => { if (text) { out.push({ t: "text", v: text }); text = ""; } out.push(node); };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const rest = src.slice(i);
    if (ch === "\\" && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!~>|]/.test(src[i + 1])) { text += src[i + 1]; i += 2; continue; }
    if (ch === "\n") {
      // Chat semantics: every newline is a visible line break.
      push({ t: "br" }); i++; continue;
    }
    if (ch === "`") {
      const run = /^`+/.exec(rest)![0];
      const end = src.indexOf(run, i + run.length);
      if (end > 0) { push({ t: "code", v: src.slice(i + run.length, end).replace(/^ (.*) $/, "$1") }); i = end + run.length; continue; }
      text += run; i += run.length; continue;
    }
    if (ch === "[") {
      const link = matchLink(src, i);
      if (link) {
        const href = safeHref(link.href);
        if (href) push({ t: "link", href, c: parseInline(link.label) });
        else out.push(...flushText(), ...parseInline(link.label));
        i = link.end; continue;
      }
    }
    if (ch === "<") {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(rest);
      if (m) { push({ t: "link", href: m[1], c: [{ t: "text", v: m[1].replace(/^mailto:/i, "") }] }); i += m[0].length; continue; }
    }
    if ((ch === "h" || ch === "H") && (i === 0 || !/[\w/]/.test(src[i - 1]))) {
      URL_RE.lastIndex = i;
      const m = URL_RE.exec(src);
      if (m) {
        let url = m[0];
        // Trailing punctuation belongs to the sentence, not the URL; keep a
        // closing paren only when the URL itself opened one.
        while (/[.,;:!?*_~]$/.test(url) || (url.endsWith(")") && count(url, "(") < count(url, ")"))) url = url.slice(0, -1);
        push({ t: "link", href: url, c: [{ t: "text", v: url }] });
        i += url.length; continue;
      }
    }
    const emph = matchEmphasis(src, i);
    if (emph) { push(emph.node); i = emph.end; continue; }
    text += ch;
    i++;
  }
  if (text) out.push({ t: "text", v: text });
  return out;

  function flushText(): Inline[] { const t = text; text = ""; return t ? [{ t: "text", v: t }] : []; }
}

function count(s: string, c: string) { return s.split(c).length - 1; }

function matchLink(src: string, i: number): { label: string; href: string; end: number } | null {
  let depth = 0;
  let j = i;
  for (; j < src.length; j++) {
    if (src[j] === "\\") { j++; continue; }
    if (src[j] === "[") depth++;
    else if (src[j] === "]" && --depth === 0) break;
    else if (src[j] === "\n" && src[j + 1] === "\n") return null;
  }
  if (j >= src.length || src[j + 1] !== "(") return null;
  const m = /^\(\s*<?([^\s()<>]*(?:\([^\s()]*\)[^\s()<>]*)*)>?(?:\s+"[^"]*")?\s*\)/.exec(src.slice(j + 1));
  if (!m) return null;
  return { label: src.slice(i + 1, j), href: m[1], end: j + 1 + m[0].length };
}

function matchEmphasis(src: string, i: number): { node: Inline; end: number } | null {
  const tries: [string, "strong" | "em" | "del"][] = [["**", "strong"], ["__", "strong"], ["~~", "del"], ["*", "em"], ["_", "em"]];
  for (const [mark, t] of tries) {
    if (!src.startsWith(mark, i)) continue;
    const after = src[i + mark.length];
    if (!after || /\s/.test(after)) continue;
    // Intraword underscores (snake_case) are not emphasis.
    if (mark[0] === "_" && i > 0 && /\w/.test(src[i - 1])) continue;
    let j = i + mark.length;
    while (true) {
      j = src.indexOf(mark, j);
      if (j < 0) break;
      const closeOk = !/\s/.test(src[j - 1]) && j > i + mark.length &&
        !(mark === "*" && src[j + 1] === "*" && src[j - 1] !== "*") &&
        !(mark[0] === "_" && /\w/.test(src[j + mark.length] ?? ""));
      if (closeOk) {
        const inner = src.slice(i + mark.length, j);
        if (inner.includes("\n\n")) break;
        return { node: { t, c: parseInline(inner) }, end: j + mark.length };
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
