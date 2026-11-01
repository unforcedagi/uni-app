// T-335: one switch for "nothing moves". On the Daylight every frame of an animation is a slow screen redraw, so a device can be
// set to Calm (Settings → Calm screen): no transitions, no animations, scrolls jump. The system's reduced-motion setting and a
// slow-refresh screen (`update: slow`) turn it on as well. It is the device's choice (localStorage), never the account's, and it
// never reads the user agent: the Pixel is Android too and keeps its motion.
// The CSS side is one rule in App.css on `:root[data-motion="calm"]`, set here before the first render.
import { useSyncExternalStore } from "react";

const KEY = "uni.motion";
const listeners = new Set<() => void>();
const query = (q: string): MediaQueryList | null => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(q) : null);
// made once: they are read on every render of a subscriber and on every glide
const reduced = query("(prefers-reduced-motion: reduce)");
const slow = query("(update: slow)");
/** The choice as made this session, when storage refused to keep it. */
let unsaved: boolean | null = null;

/** The device was set to Calm in Settings. */
export function calmChosen(): boolean {
  if (unsaved !== null) return unsaved;
  try { return localStorage.getItem(KEY) === "calm"; } catch { return false; }
}

/** The system asks for it: reduced motion, or a screen that redraws slowly. */
export const calmBySystem = (): boolean => !!reduced?.matches || !!slow?.matches;

export const calmMotion = (): boolean => calmChosen() || calmBySystem();

/** A screen that is itself slow (the switch, or `update: slow`): e-ink looks beyond motion (no shadows) apply. Reduced motion alone is
 *  about motion only, so a Mac with Reduce motion keeps its shadows. */
export const calmScreen = (): boolean => calmChosen() || !!slow?.matches;

/** How a script-driven scroll moves: a glide normally, a jump when calm. */
export const scrollMotion = (): ScrollBehavior => (calmMotion() ? "auto" : "smooth");

function apply() {
  if (typeof document === "undefined") return;
  if (calmMotion()) document.documentElement.dataset.motion = "calm";
  else delete document.documentElement.dataset.motion;
  listeners.forEach((f) => f());
}

export function setCalmChosen(on: boolean) {
  try { if (on) localStorage.setItem(KEY, "calm"); else localStorage.removeItem(KEY); unsaved = null; } catch { unsaved = on; /* private storage: this session only */ }
  apply();
}

let started = false;
/** Sets the root's `data-motion` now and keeps it current (system changes, another window's choice). Once, from main.tsx. */
export function startMotion() {
  apply();
  if (started || typeof window === "undefined") return;
  started = true;
  for (const mq of [reduced, slow]) {
    if (!mq) continue;
    // an older WebView's MediaQueryList has only addListener
    if (mq.addEventListener) mq.addEventListener("change", apply); else mq.addListener?.(apply);
  }
  window.addEventListener("storage", (e) => { if (e.key === KEY || e.key === null) apply(); });
}

const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };

/** Re-render when calm turns on or off. */
export const useCalmScreen = (): boolean => useSyncExternalStore(subscribe, calmScreen, () => false);
export const useCalmChosen = (): boolean => useSyncExternalStore(subscribe, calmChosen, () => false);
export const useCalmBySystem = (): boolean => useSyncExternalStore(subscribe, calmBySystem, () => false);
