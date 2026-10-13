// T-124 r9 (pure, unit-tested in scripts/navtree.test.ts): note ids inside a task's text.
const ULID = /(?:\buni:)?\b[0-7][0-9A-HJKMNP-TV-Z]{25}\b/g;
export type RefPart = { text: string } | { id: string };

/** The text with its note ids picked out. */
export function splitRefs(text: string): RefPart[] {
  const out: RefPart[] = [];
  let at = 0;
  for (const m of text.matchAll(ULID)) {
    const start = m.index ?? 0;
    if (start > at) out.push({ text: text.slice(at, start) });
    out.push({ id: m[0].replace(/^uni:/, "") });
    at = start + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

/** The title of a note: the last segment of its path. */
export const titleOfPath = (path: unknown): string | null => (typeof path === "string" ? path.split("/").pop()?.trim() || null : null);

