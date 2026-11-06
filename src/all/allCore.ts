// T-335 All view: the pure parts. Every area's room interleaved by time, and a message sent to the rooms the person chose: once each,
// in the order shown, nowhere else; after a failure only the rooms not yet sent to are tried again.

export type FeedMessage = { ref: string; channel: string; author: string; author_name: string; ts: number; body: string; root?: string | null };

/** The rooms' messages as one timeline: oldest first, each message once (by its ref), thread replies left in their threads. */
export function interleave<M extends FeedMessage>(byRoom: ReadonlyMap<string, readonly M[]>, limit = 200): M[] {
  const seen = new Set<string>();
  const all: M[] = [];
  for (const list of byRoom.values()) for (const m of list) {
    if (m.root || seen.has(m.ref)) continue;
    seen.add(m.ref);
    all.push(m);
  }
  all.sort((a, b) => a.ts - b.ts || (a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : a.ref < b.ref ? -1 : 1));
  return all.slice(-limit);
}

/** T-335 All v2: where the composer replies: a room, or a thread in it. No routing happens while there is one. */
export type ReplyTarget = { room: string; root: string | null };
/** A reply to this message goes to its thread when it has one, else into its room (rooms stay unthreaded by default). */
export const replyTargetOf = (m: Pick<FeedMessage, "channel" | "ref" | "root"> & { reply_count?: number }): ReplyTarget =>
  ({ room: m.channel, root: m.root ?? (m.reply_count ? m.ref : null) });
export const sameTarget = (a: ReplyTarget | null, b: ReplyTarget | null): boolean => (a?.room ?? null) === (b?.room ?? null) && (a?.root ?? null) === (b?.root ?? null);

/** The room as the person knows its address: "#kiln-studio", or its name when it has no room name of its own. */
export const roomAddress = (r: { name: string; slug?: string | null }): string => (r.slug ? `#${r.slug.replace(/^#/, "")}` : r.name);

/** T-335 one fluid surface: you said something in this room, from its own composer. Your own message may bring no live event, so All reads the room again. */
export const SAID_EVENT = "uni-said-in";
export const saidIn = (room: string) => { if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(SAID_EVENT, { detail: room })); };

export type SendResult = { sent: string[]; failed: { id: string; error: string }[] };

/**
 * Posts `body` to each room in `rooms` that is not already in `done`, one after another. `done` is updated as each send succeeds, so a
 * retry with the same set never posts twice to a room. Rooms are only ever the ones passed in: the caller passes what the person chose.
 */
export async function sendEach(rooms: readonly string[], body: string, post: (room: string, body: string) => Promise<unknown>, done: Set<string>): Promise<SendResult> {
  const result: SendResult = { sent: [], failed: [] };
  for (const id of [...new Set(rooms)]) {
    if (done.has(id)) continue;
    try { await post(id, body); done.add(id); result.sent.push(id); }
    catch (e) { result.failed.push({ id, error: String(e instanceof Error ? e.message : e).replace(/^Error:\s*/, "").slice(0, 160) }); }
  }
  return result;
}

/** "Kiln Studio", "Kiln Studio and North Field", "Kiln Studio, North Field and Glaze Tests". */
export function andList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
