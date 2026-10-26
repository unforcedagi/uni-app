// T-301: the projects and sessions the app shows, and what a person can do to them (start, stop, retire).
// In the prototype the work is made up and the live sessions are simulated: a fresh session takes a step every few seconds and
// finishes. Nothing here calls a worker; the real source (the run ledger) would replace `demoWork` and the simulation.
import { useSyncExternalStore } from "react";
import { FRESH_RESULT, FRESH_STEPS, demoWork } from "./demoData";
import { finishSession, isLive, restoreSession, retireSession, startSession, stepSession, stopSession, type Session, type Work } from "./model";

type Listener = () => void;
export type WorkEvent = { kind: "finished"; session: Session };

let work: Work = { areas: [], projects: [], sessions: [] };
/** The steps still to come for each simulated session (by id). */
const script = new Map<string, string[]>();
const listeners = new Set<Listener>();
const eventListeners = new Set<(e: WorkEvent) => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let fresh = 0;

/** How often a simulated session takes its next step. */
export const STEP_MS = 7000;

const set = (next: Work) => { work = next; for (const l of listeners) l(); };

export function loadDemo(now = Date.now()) {
  script.clear();
  set(demoWork(now));
  if (!timer && typeof window !== "undefined") timer = setInterval(tick, STEP_MS);
}

/** One beat of the simulation: each session started here takes its next step, or finishes. Seeded live sessions keep their line. */
export function tick(at = Date.now()) {
  let next = work;
  const done: string[] = [];
  for (const [id, steps] of script) {
    const s = next.sessions.find((x) => x.id === id);
    if (!s || !isLive(s)) { script.delete(id); continue; }
    const step = steps.shift();
    if (step) next = stepSession(next, id, step, at);
    else { next = finishSession(next, id, at, FRESH_RESULT, "https://example.com/walkthrough/fresh"); script.delete(id); done.push(id); }
  }
  if (next !== work) set(next);
  for (const id of done) { const s = work.sessions.find((x) => x.id === id); if (s) for (const l of eventListeners) l({ kind: "finished", session: s }); }
}

export const workActions = {
  start(project: string, ask: string, at = Date.now()) {
    const id = `fresh-${++fresh}`;
    set(startSession(work, project, ask, at, id));
    script.set(id, FRESH_STEPS.slice(1));
    return id;
  },
  stop(id: string, at = Date.now()) { script.delete(id); set(stopSession(work, id, at)); },
  retire(id: string, at = Date.now()) { script.delete(id); set(retireSession(work, id, at)); },
  restore(id: string) { set(restoreSession(work, id)); },
};

export const getWork = () => work;
export const onWorkEvent = (l: (e: WorkEvent) => void) => { eventListeners.add(l); return () => { eventListeners.delete(l); }; };
const subscribe = (l: Listener) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useWork = () => useSyncExternalStore(subscribe, getWork, getWork);
