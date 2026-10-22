// T-132: "Uni is working · 0:42". Uni's gateway sends no typing event: it puts 👀 on the message it took and stays silent until its reply,
// or a "⏳ Working" ping from three minutes on. This reads that 👀 as the start of the work and the reply as its end. Pure; tested in
// scripts/working.test.ts.
import { isWorkerStatus, staleStatus, STATUS_STALE_S } from "./chatMarkers.ts";
import type { Reaction } from "./reactions.ts";

type Msg = { ref: string; author: string; ts: number; body: string; edited: boolean; reply_count: number; reactions: Reaction[] };

/** The "I'm on it" reaction (with or without the emoji variation selector). */
const ON_IT = /^👀️?$/u;

/**
 * Who is working on your newest messages, and since when (seconds): one of your messages after the room's last real message from anyone
 * else carries a 👀 from someone else, who has not answered it (in the room or in its thread). Progress pings ("⏳ Working …") don't end
 * it. Past an hour with no live ping it is let go: a reply that never came is not shown as work going on.
 */
export function workingOn(messages: Msg[], me: string | null, nowS: number): { author: string; since: number } | null {
  if (!me) return null;
  let found: { author: string; since: number } | null = null;
  const live = new Set<string>(); // who has a progress ping that still says something
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (isWorkerStatus(m.body)) { if (!staleStatus(m, nowS, i === messages.length - 1)) live.add(m.author); continue; }
    if (m.author !== me) break;
    if (m.reply_count > 0) break; // answered in its thread
    const by = m.reactions.find((r) => ON_IT.test(r.emoji))?.by?.find((pk) => pk !== me);
    if (by) found = { author: by, since: m.ts };
  }
  if (!found) return null;
  return live.has(found.author) || nowS - found.since <= STATUS_STALE_S ? found : null;
}

/** "0:42", "12:05", "1:02:09". */
export function elapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(r)}` : `${m}:${two(r)}`;
}
