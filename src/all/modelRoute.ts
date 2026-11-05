// T-335 All v2: asking the route door (services/route on the person's own box, tailnet only, signed with the device key like Mail and the calendar)
// where an unaddressed message should go. The word match (route.ts) is already on screen: this only ever improves it.
// - Asked when the typing pauses, never for a room the person named, never with a private area in the list (All's rooms leave those out).
// - An answer within DEADLINE_MS takes over the route; a later one is `late` (only offers, see mergeRoute); a failure leaves the word match.
// - Nothing here sends anything. The message's words go to the door and to Haiku through it, and nowhere else; no third party, no log of them.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RoutePick } from "./route";

export const DEADLINE_MS = 1500;
/** How long the typing pauses before asking. */
const PAUSE_MS = 400;
/** Shorter than this there is little for a model to read. */
const MIN_CHARS = 8;

export type ModelState = "skipped" | "waiting" | "in-time" | "late" | "down";
export type ModelRoute = { state: ModelState; picks: RoutePick[]; timely: boolean; suggestion: string | null };
export type DoorRoom = { id: string; name: string; about: string };
const IDLE: ModelRoute = { state: "skipped", picks: [], timely: false, suggestion: null };

const related = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

/** The model's route for `text` among `rooms`; `enabled` false (a named room, a reply) asks nothing and forgets the answer; `hold` (the person
 *  has chosen the rooms) asks nothing more and keeps it, for the log. */
export function useModelRoute(text: string, rooms: readonly DoorRoom[], enabled: boolean, hold = false): ModelRoute {
  const [route, setRoute] = useState<ModelRoute>(IDLE);
  const answered = useRef(""); // the text the answer on screen was for
  const seq = useRef(0);
  const roomsKey = JSON.stringify(rooms);
  const body = text.trim();
  useEffect(() => {
    const mine = ++seq.current;
    if (hold) return;
    if (!enabled || body.length < MIN_CHARS) { answered.current = ""; setRoute(IDLE); return; }
    // still typing the same thought: the last answer stays until the next one, so the chips don't flicker; a new thought drops it
    if (answered.current && !related(body, answered.current)) { answered.current = ""; setRoute(IDLE); }
    const pause = setTimeout(() => {
      const asked = performance.now();
      setRoute((r) => (r.picks.length ? r : { ...IDLE, state: "waiting" }));
      invoke<{ id?: string; picks?: RoutePick[] }>("route_suggest", { text: body, rooms: JSON.parse(roomsKey) as DoorRoom[] })
        .then((a) => {
          if (seq.current !== mine) return;
          const known = new Set((JSON.parse(roomsKey) as DoorRoom[]).map((r) => r.id));
          const picks = (a?.picks ?? []).filter((p) => p && known.has(p.id)).map((p) => ({ id: p.id, why: String(p.why ?? "").slice(0, 60), sure: !!p.sure }));
          if (!picks.length) { answered.current = ""; setRoute({ ...IDLE, state: "down" }); return; }
          const timely = performance.now() - asked <= DEADLINE_MS;
          answered.current = body;
          setRoute({ state: timely ? "in-time" : "late", picks, timely, suggestion: a?.id ?? null });
        })
        .catch(() => { if (seq.current === mine) { answered.current = ""; setRoute({ ...IDLE, state: "down" }); } });
    }, PAUSE_MS);
    return () => clearTimeout(pause);
  }, [body, roomsKey, enabled, hold]);
  return route;
}

/** What was suggested against what was sent: room ids only, never the words. Best effort: a lost line costs nothing. */
export type RouteOutcome = { suggestion: string | null; model: string[]; modelState: ModelState; words: string[]; sent: string[]; edited: boolean };
export const logOutcome = (outcome: RouteOutcome) => { void invoke("route_outcome", { outcome }).catch(() => {}); };
