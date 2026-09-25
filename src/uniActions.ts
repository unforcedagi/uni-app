// Message → Uni handoffs. The app holds no vault credentials: "Keep as note"
// and "Ask Uni" post a kind-9 in the Uni room that quotes the message and
// carries a buzz:// deep link, p-tagging Uni. Uni (Hermes) reads the link,
// pulls context with the Buzz CLI, and does the Parachute write itself.

export type UniAction = "note" | "ask";
export type SourceMessage = { ref: string; channel: string; author_name: string; ts: number; body: string };

const MAX_QUOTE = 1200;

/** Buzz deep link to one message (the CLI's `messages thread --link` format). */
export function messageLink(channel: string, id: string): string {
  return `buzz://message?channel=${encodeURIComponent(channel)}&id=${encodeURIComponent(id)}`;
}

/** Markdown blockquote of `body`, truncated on a character boundary. */
export function quote(body: string, max = MAX_QUOTE): string {
  const chars = [...body.trim()];
  const text = chars.length > max ? chars.slice(0, max).join("").trimEnd() + " …" : chars.join("");
  return text.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
}

/**
 * The message posted to the Uni room. `uniLabel` is Uni's member label, so the
 * existing mention binding highlights and p-tags it; `roomName` is where the
 * source lives. `question` is optional free text for "ask".
 */
export function handoffText(
  action: UniAction,
  m: SourceMessage,
  roomName: string,
  uniLabel: string,
  question = "",
): string {
  const when = new Date(m.ts * 1000).toISOString().slice(0, 16).replace("T", " ");
  const head = action === "note"
    ? `@${uniLabel} keep this as a note in the vault. Link it back to the message, file it with the right people and project, and tell me where it went.`
    : `@${uniLabel} ${question.trim() || "let's talk about this."}`;
  return `${head}\n\n${quote(m.body)}\n\n— ${m.author_name} in #${roomName}, ${when} UTC · ${messageLink(m.channel, m.ref)}`;
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
 * "Ask Uni" for vault search: the app holds no vault token, so a notes query
 * is handed to Uni in #Uni, which runs the Parachute meaning search itself
 * (see docs/ask-everything.md). Whitespace is collapsed to one line so the
 * query can't smuggle extra paragraphs; long queries are truncated.
 */
export function searchHandoffText(query: string, uniLabel: string): string {
  const q = [...query.replace(/\s+/g, " ").trim()];
  const text = q.length > MAX_SEARCH_QUERY ? q.slice(0, MAX_SEARCH_QUERY).join("").trimEnd() + " …" : q.join("");
  return `@${uniLabel} search my notes for: ${text}`;
}
