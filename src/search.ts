// Pure helpers for the "Ask everything" search view (tested in
// scripts/search.test.ts). Snippets arrive from the Rust store as plain text
// with U+E000 / U+E001 around matches (see uni_core::store::SNIPPET_START);
// they are split into segments and rendered as React <mark> elements — never
// injected as HTML.

export const SNIPPET_START = "\uE000";
export const SNIPPET_END = "\uE001";

export type SnippetSegment = { text: string; hit: boolean };

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
 * Group ranked hits by room. Rooms appear in the order of their best hit, and
 * hits keep their rank order inside a room.
 */
export function groupByRoom<H extends { channel_name: string; message: { channel: string } }>(hits: H[]): { channel: string; name: string; hits: H[] }[] {
  const groups = new Map<string, { channel: string; name: string; hits: H[] }>();
  for (const h of hits) {
    const id = h.message.channel;
    let g = groups.get(id);
    if (!g) { g = { channel: id, name: h.channel_name, hits: [] }; groups.set(id, g); }
    g.hits.push(h);
  }
  return [...groups.values()];
}

/**
 * Where tapping a hit should land: a thread reply opens its thread (root),
 * everything else opens the room's main timeline.
 */
export function hitTarget(m: { ref: string; channel: string; root: string | null }): { channel: string; root: string | null; focus: string } {
  const inThread = !!m.root && m.root !== m.ref;
  return { channel: m.channel, root: inThread ? m.root : null, focus: m.ref };
}
