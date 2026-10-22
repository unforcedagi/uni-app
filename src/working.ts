// T-132: "Uni is working · 0:42". Uni's gateway sends no typing event: it puts 👀 on the message it took and stays silent until its reply,
// or a "⏳ Working" ping from three minutes on. This reads that 👀 as the start of the work and the reply as its end. Pure; tested in
// scripts/working.test.ts.
import { isWorkerStatus, staleStatus, STATUS_STALE_S } from "./chatMarkers.ts";
import type { Reaction } from "./reactions.ts";

type Msg = { ref: string; author: string; ts: number; body: string; edited: boolean; last_reply_ts: number | null; reactions: Reaction[] };

/** The "I'm on it" reaction (with or without the emoji variation selector). */
const ON_IT = /^👀️?$/u;

/**
 * Who is working on your newest messages, and since when (seconds): one of your messages after the room's last real message from anyone
 * else carries a 👀 from someone else, who has not answered it. Counted from that 👀, the earliest of theirs on those messages; the newest
 * 👀 says who. Progress pings ("⏳ Working …") don't end it; a reply in the message's thread after the 👀 does (whose it is isn't known here,
 * and a line that stops early is better than one that runs on). Past an hour with no live ping of theirs it is let go: a reply that never
 * came is not shown as work going on.
 */
export function workingOn(messages: Msg[], me: string | null, nowS: number): { author: string; since: number } | null {
  if (!me) return null;
  type Reactor = { pubkey: string; ts: number };
  let found = null as { author: string; since: number } | null;
  const live = new Set<string>(); // who has a progress ping that still says something
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (isWorkerStatus(m.body)) { if (!staleStatus(m, nowS, i === messages.length - 1)) live.add(m.author); continue; }
    if (m.author !== me) break;
    const eyes: Reactor[] = m.reactions.filter((r) => ON_IT.test(r.emoji)).flatMap((r) => r.by ?? []).filter((b) => b.pubkey !== me);
    const who = found?.author;
    const by: Reactor | undefined = who ? eyes.find((b) => b.pubkey === who) : eyes.reduce<Reactor | undefined>((a, b) => !a || b.ts > a.ts ? b : a, undefined);
    if (!by) continue;
    if ((m.last_reply_ts ?? 0) >= by.ts) break; // answered in its thread
    found = { author: by.pubkey, since: Math.min(found?.since ?? Infinity, by.ts) };
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
