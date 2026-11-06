// T-335 All v2: asking the route door (services/route on the person's own box, tailnet only, signed with the device key like Mail and the calendar)
// where an unaddressed message should go. The word match (route.ts) is already on screen: this only ever improves it.
// - Asked when the typing pauses, one ask at a time and a few for one thought; never for a room the person named, never with a private area in the
//   list (All's rooms leave those out); not again for words already answered, even after leaving and coming back.
// - An answer within DEADLINE_MS takes over the route; a later one is `late` (only offers, see mergeRoute). A later or failed ask never moves a
//   route an earlier answer gave: only a timely answer does, or a new thought, which drops it. With no answer at all, the word match stands.
// - Nothing here sends anything. The message's words go to the door and to Haiku through it, and nowhere else; no third party, no log of them.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RoutePick } from "./route";

export const DEADLINE_MS = 1500;
/** How long the typing pauses before asking. */
const PAUSE_MS = 400;
/** Shorter than this there is little for a model to read. */
const MIN_CHARS = 8;
/** Asks for one thought: past this the last answer stands. */
const MAX_ASKS = 4;

export type ModelState = "skipped" | "waiting" | "in-time" | "late" | "down";
export type ModelRoute = { state: ModelState; picks: RoutePick[]; timely: boolean; suggestion: string | null };
export type DoorRoom = { id: string; name: string; about: string };
const IDLE: ModelRoute = { state: "skipped", picks: [], timely: false, suggestion: null };

const related = (a: string, b: string) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));
/** The last answer: a composer that comes back to the same draft has it without asking again. */
const last = { body: "", key: "", route: IDLE, asks: 0 };

/** Forget this device's key: the last answer's words go too. */
export function forgetModelRoute() { last.body = ""; last.key = ""; last.route = IDLE; last.asks = 0; }

/** The model's route for `text` among `rooms`; `enabled` false (a named room, a reply) asks nothing and forgets the answer; `hold` (the person
 *  has chosen the rooms) asks nothing more and keeps it, for the log. */
export function useModelRoute(text: string, rooms: readonly DoorRoom[], enabled: boolean, hold = false): ModelRoute {
  const body = text.trim();
  const key = JSON.stringify(rooms);
  const [route, setRouteState] = useState<ModelRoute>(() => (enabled && last.key === key && related(body, last.body) ? last.route : IDLE));
  const s = useRef({ thought: route.picks.length ? last.body : "", answered: route.picks.length ? last.body : "", route, inFlight: false, queued: false, asks: route.picks.length ? last.asks : 0, latest: body, on: enabled && !hold, key, live: true });
  s.current.latest = body; s.current.on = enabled && !hold; s.current.key = key;
  const setRoute = (r: ModelRoute) => { s.current.route = r; setRouteState(r); };
  const ask = (asked: string) => {
    const st = s.current, roomsNow = JSON.parse(st.key) as DoorRoom[], started = performance.now();
    st.inFlight = true; st.asks += 1; st.thought = asked;
    if (!st.route.picks.length) setRoute({ ...IDLE, state: "waiting" });
    const next = () => {
      st.inFlight = false;
      if (!st.queued) return;
      st.queued = false;
      if (st.live && st.on && st.latest.length >= MIN_CHARS && st.latest !== st.answered && st.asks < MAX_ASKS) ask(st.latest);
    };
    invoke<{ id?: string; picks?: RoutePick[] }>("route_suggest", { text: asked, rooms: roomsNow })
      .then((a) => {
        if (!st.live || !st.on || !related(st.latest, asked)) return;
        const known = new Set(roomsNow.map((r) => r.id));
        const picks = (a?.picks ?? []).filter((p) => p && known.has(p.id)).map((p) => ({ id: p.id, why: String(p.why ?? "").slice(0, 60), sure: !!p.sure }));
        const timely = performance.now() - started <= DEADLINE_MS;
        if (!picks.length) { if (!st.route.picks.length) setRoute({ ...IDLE, state: "down" }); return; }
        // a route already given stays until a timely answer replaces it
        if (!timely && st.route.timely) { st.answered = asked; return; }
        st.answered = asked;
        const r: ModelRoute = { state: timely ? "in-time" : "late", picks, timely, suggestion: a?.id ?? null };
        setRoute(r);
        last.body = asked; last.key = st.key; last.route = r; last.asks = st.asks;
      })
      .catch(() => { if (st.live && st.on && !st.route.picks.length) setRoute({ ...IDLE, state: "down" }); })
      .finally(next);
  };
  useEffect(() => { const st = s.current; st.live = true; return () => { st.live = false; }; }, []);
  useEffect(() => {
    const st = s.current;
    // the person's own choice: the answer stays for the log while it is about these words, and goes with them
    if (hold) { if (st.answered && !related(body, st.answered)) { st.answered = ""; st.asks = 0; setRoute(IDLE); } return; }
    if (!enabled || body.length < MIN_CHARS) {
      st.answered = ""; st.thought = ""; st.asks = 0; st.queued = false;
      if (!body) last.body = "";
      if (st.route !== IDLE) setRoute(IDLE);
      return;
    }
    // still typing the same thought: the last answer stays until the next one, so the chips don't flicker; a new thought drops it
    if (st.answered && !related(body, st.answered)) { st.answered = ""; setRoute(IDLE); }
    // a new thought gets its own asks, whether or not the last one was ever answered
    if (st.thought && !related(body, st.thought)) { st.thought = ""; st.asks = 0; }
    if (body === st.answered || st.asks >= MAX_ASKS) return;
    const pause = setTimeout(() => { if (st.inFlight) st.queued = true; else if (st.asks < MAX_ASKS) ask(st.latest); }, PAUSE_MS);
    return () => clearTimeout(pause);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, key, enabled, hold]);
  return route;
}

/** What was suggested against what was sent: room ids only, never the words. Best effort: a lost line costs nothing. */
export type RouteOutcome = { suggestion: string | null; model: string[]; modelState: ModelState; words: string[]; sent: string[]; edited: boolean };
export const logOutcome = (outcome: RouteOutcome) => { void invoke("route_outcome", { outcome }).catch(() => {}); };
