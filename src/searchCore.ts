// Pure helpers for the "Ask everything" search view (tested in
// scripts/search.test.ts). Snippets arrive from the Rust store as plain text
// with U+E000 / U+E001 around matches (see uni_core::store::SNIPPET_START);
// they are split into segments and rendered as React <mark> elements — never
// injected as HTML.

export const SNIPPET_START = "\uE000";
export const SNIPPET_END = "\uE001";

export type SnippetSegment = { text: string; hit: boolean };

/** A note found in a vault (uni_core::parachute::NoteHit). */
export type NoteHit = { vault: string; id: string; path: string; snippet: string; score: number | null; mode: "meaning" | "keyword" };

/** A message found in this device's index (uni_core::store::SearchHit); `snippet` carries SNIPPET_START/END around matches. */
export type SearchHit = {
  message: { ref: string; channel: string; author: string; author_name: string; ts: number; body: string; root: string | null; edited: boolean };
  channel_name: string;
  snippet: string;
};

/** Split a marked snippet into plain / highlighted runs. Unbalanced markers are tolerated. */
export function snippetSegments(snippet: string): SnippetSegment[] {
  const out: SnippetSegment[] = [];
  let hit = false;
  let buf = "";
  const flush = () => {
    if (!buf) return;
    const last = out[out.length - 1];
    if (last && last.hit === hit) last.text += buf; else out.push({ text: buf, hit });
    buf = "";
  };
  for (const ch of snippet) {
    if (ch === SNIPPET_START) { flush(); hit = true; }
    else if (ch === SNIPPET_END) { flush(); hit = false; }
    else buf += ch;
  }
  flush();
  return out;
}

/**
 * Where tapping a hit should land: a thread reply opens its thread (root),
 * everything else opens the room's main timeline.
 */
export function hitTarget(m: { ref: string; channel: string; root: string | null }): { channel: string; root: string | null; focus: string } {
  const inThread = !!m.root && m.root !== m.ref;
  return { channel: m.channel, root: inThread ? m.root : null, focus: m.ref };
}

/** T-335 glow-up: a note's snippet as clean prose: no heading marks, emphasis stars or link brackets. */
export function plainSnippet(text: string): string {
  return text.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "").replace(/(^|[\s(])\*\*([^*\n]+?)\*\*(?=$|[\s).,;:!?])/g, "$1$2")
    .replace(/(^|[\s(])__([^_\n]+?)__(?=$|[\s).,;:!?])/g, "$1$2").replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=$|[\s).,;:!?])/g, "$1$2")
    .replace(/`([^`]*)`/g, "$1").replace(/\s+/g, " ").trim();
}

/**
 * T-335 the shape: the query's words marked in plain text, for text the server did not mark (notes, titles).
 * Case-insensitive, each word on its own, regex characters taken literally. The parts are rendered as React
 * text and <mark> nodes, never as HTML.
 */
export function markParts(text: string, q: string): SnippetSegment[] {
  if (!text) return [];
  const words = [...new Set(q.trim().toLowerCase().split(/\s+/).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!words.length) return [{ text, hit: false }];
  const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "giu");
  const out: SnippetSegment[] = [];
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (!m[0]) continue;
    if (m.index > at) out.push({ text: text.slice(at, m.index), hit: false });
    const last = out[out.length - 1];
    if (last?.hit) last.text += m[0]; else out.push({ text: m[0], hit: true });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}
