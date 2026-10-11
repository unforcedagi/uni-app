// References between notes (pure, unit-tested in scripts/tasks.test.ts): a `parent`, `node` or `brief` field holds a note id (a ULID),
// a path or a `[[link]]`, and for a while a vault may hold all three. One resolver reads them all and answers with the node's path,
// which is what the app navigates and displays by.
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
export const stripExt = (p: string) => p.replace(/\.(md|html)$/i, "");

/** A reference field as an id-or-path key: `[[ ]]`, alias, extension and surrounding slashes are tolerated. */
export function refKey(v: unknown): string | null {
  const raw = str(v);
  if (!raw) return null;
  const k = stripExt(raw.replace(/^\[\[|\]\]$/g, "").split("|")[0].trim().replace(/^\/+|\/+$/g, ""));
  return k || null;
}

/** A Crockford ULID, the shape of a Parachute note id. */
export const isUlid = (s: string | null | undefined): boolean => !!s && /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(s);

/** id and path → path. A path wins over an id when a string is both (no real ULID is a path, but ids in tests are short words). */
export function pathResolver(entries: Iterable<{ id: string; path: string }>): (ref: unknown) => string | null {
  const byPath = new Set<string>();
  const byId = new Map<string, string>();
  for (const e of entries) { byPath.add(e.path); byId.set(e.id, e.path); }
  return (ref) => { const k = refKey(ref); return k ? (byPath.has(k) ? k : byId.get(k) ?? null) : null; };
}
