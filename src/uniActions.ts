// Uni in Buzz: its room and member, a quote for a shared Journal entry, and the vault-search handoff. (The per-message
// "Keep as note" and "Ask Uni" handoffs were removed in T-124 r12.)

const MAX_QUOTE = 1200;

/** Markdown blockquote of `body`, truncated on a character boundary. */
export function quote(body: string, max = MAX_QUOTE): string {
  const chars = [...body.trim()];
  const text = chars.length > max ? chars.slice(0, max).join("").trimEnd() + " …" : chars.join("");
  return text.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
}

/** The Uni room: named "Uni" (case-insensitive). */
export function findUniRoom<R extends { id: string; name: string }>(rooms: R[]): R | undefined {
  return rooms.find((r) => r.name.trim().toLowerCase() === "uni");
}

/** Uni's member entry in that room: the profile named "Uni". */
export function findUniMember<M extends { pubkey: string; name: string }>(members: M[]): M | undefined {
  return members.find((m) => m.name.trim().toLowerCase() === "uni");
}


const MAX_SEARCH_QUERY = 500;

/**
 * "Ask Uni" for vault search: the fallback when the app can't reach the hub
 * directly. The query is handed to Uni in #Uni, which runs the Parachute
 * meaning search itself (see docs/ask-everything.md). Whitespace is collapsed to one line so the
 * query can't smuggle extra paragraphs; long queries are truncated.
 */
export function searchHandoffText(query: string, uniLabel: string): string {
  const q = [...query.replace(/\s+/g, " ").trim()];
  const text = q.length > MAX_SEARCH_QUERY ? q.slice(0, MAX_SEARCH_QUERY).join("").trimEnd() + " …" : q.join("");
  return `@${uniLabel} search my notes for: ${text}`;
}
