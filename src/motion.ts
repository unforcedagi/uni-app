// T-335: one switch for "nothing moves". On the Daylight every frame of an animation is a slow screen redraw, so a device can be
// set to Calm (Settings → Calm screen): no transitions, no animations, scrolls jump. The system's reduced-motion setting and a
// slow-refresh screen (`update: slow`) turn it on as well. It is the device's choice (localStorage), never the account's, and it
// never reads the user agent: the Pixel is Android too and keeps its motion.
// The CSS side is one rule in App.css on `:root[data-motion="calm"]` (and the same media queries, so it holds before this runs).
import { useSyncExternalStore } from "react";

const KEY = "uni.motion";
const SYSTEM = ["(prefers-reduced-motion: reduce)", "(update: slow)"];
const listeners = new Set<() => void>();

/** The device was set to Calm in Settings. */
export function calmChosen(): boolean {
  try { return localStorage.getItem(KEY) === "calm"; } catch { return false; }
}

/** The system asks for it: reduced motion, or a screen that redraws slowly. */
export function calmBySystem(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia && SYSTEM.some((q) => window.matchMedia(q).matches);
}

export const calmMotion = (): boolean => calmChosen() || calmBySystem();

/** How a script-driven scroll moves: a glide normally, a jump when calm. */
export const scrollMotion = (): ScrollBehavior => (calmMotion() ? "auto" : "smooth");

function apply() {
  if (typeof document === "undefined") return;
  if (calmMotion()) document.documentElement.dataset.motion = "calm";
  else delete document.documentElement.dataset.motion;
  listeners.forEach((f) => f());
}

export function setCalmChosen(on: boolean) {
  try { if (on) localStorage.setItem(KEY, "calm"); else localStorage.removeItem(KEY); } catch { /* private storage: this session only */ }
  apply();
}

let started = false;
/** Sets the root's `data-motion` now and keeps it current (system changes, another window's choice). Once, from main.tsx. */
export function startMotion() {
  apply();
  if (started || typeof window === "undefined") return;
  started = true;
  for (const q of SYSTEM) window.matchMedia?.(q).addEventListener?.("change", apply);
  window.addEventListener("storage", (e) => { if (e.key === KEY || e.key === null) apply(); });
}

const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };

/** Re-renders when calm turns on or off. */
export const useCalmMotion = (): boolean => useSyncExternalStore(subscribe, calmMotion, () => false);
export const useCalmChosen = (): boolean => useSyncExternalStore(subscribe, calmChosen, () => false);
export const useCalmBySystem = (): boolean => useSyncExternalStore(subscribe, calmBySystem, () => false);
