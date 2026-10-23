// T-260: files published with `uni-publish` play inside a note and a decision, not behind a link to a browser.
//
// Pure (no DOM / React), so node tests it (scripts/publishedMedia.test.ts). `uni-publish` serves a file on the hub's host, port
// 8444 (`publish_origins` from the app's hub setting), at `/<slug>-<sha8>.<ext>`, and writes a `published` note whose metadata
// says `url`, `mime` and `kind`. Only those origins and the publisher's own file types play inline: video and audio with controls,
// images as images. A page or a PDF stays a link, as does anything from anywhere else; no URL is ever framed or fetched with the
// user's credentials (the webview loads the file itself, as any image in a note).

import { parseMarkdown, type Block, type Inline } from "./markdown.ts";

export type PublishedKind = "video" | "audio" | "image" | "doc" | "page";
export type Published = {
  /** The URL as written (trimmed): its encoded path, query and fragment are kept. */
  url: string;
  kind: PublishedKind;
  /** From a Published note's metadata, when it agrees with the kind; else null. */
  mime: string | null;
  /** The file's name, decoded, for labels. */
  name: string;
};

/** The tag `uni-publish` puts on the note it writes for a file. */
export const PUBLISHED_TAG = "published";

/** The publisher's file types (`uni-publish` refuses any other). */
const TYPES: Record<string, PublishedKind> = {
  mp4: "video", webm: "video", m4a: "audio", mp3: "audio",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
  pdf: "doc", html: "page",
};

/** The kinds that play or show in place; a doc or page stays a link. */
export const inline = (kind: PublishedKind): kind is "video" | "audio" | "image" => kind === "video" || kind === "audio" || kind === "image";

const originOf = (o: string): string | null => { try { return new URL(o).origin; } catch { return null; } };

/**
 * A link to a published file, or null. It must be an absolute http(s) URL as typed (no whitespace, control characters or
 * backslashes, which parsers read differently), carry no credentials, be on one of `origins` exactly (scheme, host and port: a
 * lookalike host or another port is another origin), and name a file of the publisher's types by its path, never its query.
 */
export function classifyPublished(raw: unknown, origins: readonly string[]): Published | null {
  if (typeof raw !== "string" || !origins.length) return null;
  const url = raw.trim();
  if (!/^https?:\/\/[^/\\]/i.test(url) || /[\s\\\u0000-\u001f\u007f]/.test(url)) return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.username || u.password) return null;
  if (!origins.some((o) => originOf(o) === u.origin)) return null;
  let name: string;
  try { name = decodeURIComponent(u.pathname.split("/").pop() ?? ""); } catch { return null; }
  if (!name || /[/\\\u0000-\u001f\u007f]/.test(name)) return null;
  const kind = TYPES[/\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase() ?? ""];
  return kind ? { url, kind, mime: null, name } : null;
}

const MIME_OF: Record<PublishedKind, (m: string) => boolean> = {
  video: (m) => m.startsWith("video/"),
  audio: (m) => m.startsWith("audio/"),
  image: (m) => m.startsWith("image/") && m !== "image/svg+xml",
  doc: (m) => m === "application/pdf",
  page: (m) => m === "text/html" || m.startsWith("text/html;"),
};

/**
 * The file a Published note is for, from its metadata (`url`, `mime`, `kind`: the producer's contract), or null. The URL passes
 * {@link classifyPublished}; its type decides the kind, and the metadata's mime is kept only when it and `kind` agree with that.
 */
export function publishedFromNote(note: { tags?: unknown; metadata?: unknown } | null | undefined, origins: readonly string[]): Published | null {
  if (!note || !Array.isArray(note.tags) || !note.tags.includes(PUBLISHED_TAG)) return null;
  const m = note.metadata && typeof note.metadata === "object" ? note.metadata as Record<string, unknown> : {};
  const base = classifyPublished(m.url, origins);
  if (!base) return null;
  const mime = typeof m.mime === "string" ? m.mime.trim().toLowerCase() : "";
  return { ...base, mime: m.kind === base.kind && mime && MIME_OF[base.kind](mime) ? mime : null };
}

/** The published files a markdown text links (bare, `<url>` or `[label](url)`), in order, each once. Code is not a link. */
export function publishedIn(markdown: string, origins: readonly string[]): Published[] {
  if (!markdown || !origins.length) return [];
  const out: Published[] = [];
  const seen = new Set<string>();
  const add = (href: string) => {
    const p = classifyPublished(href, origins);
    if (p && !seen.has(p.url)) { seen.add(p.url); out.push(p); }
  };
  const inl = (c: Inline[]): void => { for (const n of c) { if (n.t === "link") add(n.href); if ("c" in n) inl(n.c); } };
  const blk = (b: Block[]): void => {
    for (const x of b) {
      if (x.t === "p" || x.t === "h") inl(x.c);
      else if (x.t === "quote") blk(x.c);
      else if (x.t === "list") x.items.forEach(blk);
      else if (x.t === "table") [x.head, ...x.rows].forEach((r) => r.forEach(inl));
    }
  };
  blk(parseMarkdown(markdown));
  return out;
}

// ── In a rendered note: the markdown tree (hast), before React ─────────────────────────────────────────────

/** The part of a hast node this step reads and writes. */
export type HastNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] };

/** The element a player is drawn for (`components["published-media"]`); its data-* say what it plays. */
export const PLAYER_TAG = "published-media";

const player = (p: Published): HastNode => ({ type: "element", tagName: PLAYER_TAG, properties: { dataUrl: p.url, dataKind: p.kind, dataName: p.name, ...(p.mime ? { dataMime: p.mime } : {}) }, children: [] });
/** Elements whose children are blocks that may hold a link alone in its paragraph. */
const CONTAINERS = new Set(["root", "blockquote", "ul", "ol", "li", "div", "section", "details"]);
/** Inline elements a link may sit in; code, and anything else, is not looked into. */
const INLINE = new Set(["a", "img", "strong", "em", "del", "s", "b", "i", "span", "sup", "sub"]);
const blank = (n: HastNode) => (n.type === "text" && !(n.value ?? "").trim()) || (n.type === "element" && n.tagName === "br");
const target = (n: HastNode): string | null => n.type !== "element" ? null : n.tagName === "a" ? String(n.properties?.href ?? "") : n.tagName === "img" ? String(n.properties?.src ?? "") : null;

/**
 * rehype step: a link (or `![](…)`) to a published video, audio or image becomes its player. Alone in its paragraph or list item,
 * the player takes its place; in a sentence the link stays and the player follows the paragraph (or ends the item). Each file plays
 * once, where it is first linked; later links to it stay links. A file in `shown` already plays above the body (a Published note's
 * own): a paragraph that is only its link goes, and other mentions stay links. Table cells, headings and code are left alone.
 */
export function rehypePublished(opts: { origins: readonly string[]; shown?: readonly string[] }) {
  const origins = opts.origins;
  const shown = new Set(opts.shown ?? []);
  return (tree: HastNode): void => {
    if (!origins.length) return;
    const seen = new Set<string>(shown);
    /** The new players a run of inline nodes links, marking them seen. */
    const collect = (nodes: HastNode[], into: Published[]) => {
      for (const n of nodes) {
        if (n.type !== "element" || !INLINE.has(n.tagName ?? "")) continue;
        const p = classifyPublished(target(n), origins);
        if (p && inline(p.kind) && !seen.has(p.url)) { seen.add(p.url); into.push(p); }
        if (n.children) collect(n.children, into);
      }
    };
    /** A run of inline nodes that is only links to files: their players (null if anything else is there). */
    const alone = (nodes: HastNode[], filesOnly: (p: Published | null) => boolean): Published[] | null => {
      const hits: Published[] = [];
      for (const n of nodes) {
        if (blank(n)) continue;
        const p = classifyPublished(target(n), origins);
        if (!p || !filesOnly(p)) return null;
        hits.push(p);
      }
      return hits.length ? hits : null;
    };
    const fresh = (p: Published | null) => !!p && inline(p.kind) && !seen.has(p.url);
    const walk = (parent: HastNode) => {
      const out: HastNode[] = [];
      for (const child of parent.children ?? []) {
        if (child.type !== "element") { out.push(child); continue; }
        if (child.tagName === "p") {
          const kids = child.children ?? [];
          // only links to files already playing above: the line that repeats them goes
          if (shown.size && alone(kids, (p) => !!p && shown.has(p.url))) continue;
          const solo = alone(kids, fresh);
          if (solo && new Set(solo.map((p) => p.url)).size === solo.length) { solo.forEach((p) => seen.add(p.url)); out.push(...solo.map(player)); continue; }
          const found: Published[] = [];
          collect(kids, found);
          out.push(child, ...found.map(player));
          continue;
        }
        if (CONTAINERS.has(child.tagName ?? "")) {
          walk(child);
          if (child.tagName === "li") item(child);
        }
        out.push(child);
      }
      parent.children = out;
    };
    /** A tight list item's own words (no paragraph): alone, the link is the player; in a sentence the player ends the item. */
    const item = (li: HastNode) => {
      const kids = li.children ?? [];
      const words = kids.filter((n) => n.type === "text" || (n.type === "element" && INLINE.has(n.tagName ?? "")) || blank(n));
      if (!words.length) return;
      const solo = words.length === kids.length ? alone(kids, fresh) : null;
      if (solo && new Set(solo.map((p) => p.url)).size === solo.length) { solo.forEach((p) => seen.add(p.url)); li.children = solo.map(player); return; }
      const found: Published[] = [];
      collect(words, found);
      if (found.length) li.children = [...kids, ...found.map(player)];
    };
    walk(tree);
  };
}
