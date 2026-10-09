// Live chat into the frame: the host pushes `chat.message` events for the rooms
// the user granted with chat.read. The same cleaning and caps as chat.recent;
// the event costs a request token; no chat.read, no event.

import { stripHidden } from "../contract.ts";
import type { Resolved } from "../manifest.ts";
import type { RoomMessage } from "./chat.ts";

export const MAX_CONTENT = 4000;
const MAX_AUTHOR = 80;
type Pusher = { push(event: string, data: unknown): boolean };

/** One chat.recent-shaped message (plus its room id), or null when the input is not a message. */
export function eventMessage(room: string, m: RoomMessage): { id: string; author: string; content: string; created_at: string; room: string } | null {
  if (!m || typeof m !== "object" || typeof m.ref !== "string" || typeof m.body !== "string" || typeof m.author !== "string" || typeof m.ts !== "number" || !Number.isFinite(m.ts)) return null;
  const name = typeof m.author_name === "string" && m.author_name ? m.author_name : m.author.slice(0, 8);
  const created = new Date(m.ts * 1000);
  if (Number.isNaN(created.getTime())) return null;
  return { id: m.ref, author: stripHidden(name).slice(0, MAX_AUTHOR), content: stripHidden(m.body).slice(0, MAX_CONTENT), created_at: created.toISOString(), room };
}

/** True when the event was handed to the frame. */
export function pushChatMessage(session: Pusher, grant: Resolved, room: string, m: RoomMessage): boolean {
  if (!(grant["chat.read"] ?? []).includes(room)) return false;
  const data = eventMessage(room, m);
  return data ? session.push("chat.message", data) : false;
}
