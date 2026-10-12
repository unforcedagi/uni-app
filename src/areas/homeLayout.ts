// The Home layout setting (Settings → Home layout): Rooms (0.1.42: the room tree is the navigation on every screen), Map (the 0.1.41 tree
// home: the map with a level panel), Octopus (0.1.39) or Classic (the page without a map). Stored on the device; the default is Rooms,
// for anyone who never chose one (nothing stored). `tree` is the stored id of the Map layout, so an earlier choice of it stands. Pure helpers here; the hook is a tiny external store over localStorage.
import { useSyncExternalStore } from "react";

export type HomeLayout = "rooms" | "tree" | "octopus" | "classic";
export const HOME_LAYOUTS: { id: HomeLayout; label: string; hint: string }[] = [
  { id: "rooms", label: "Rooms (new)", hint: "The room tree always at hand; beside it, where we are and what needs you" },
  { id: "tree", label: "Map (0.1.41)", hint: "A map and a level panel; on a phone, a room tree" },
  { id: "octopus", label: "Octopus (0.1.39)", hint: "The map with the work under it" },
  { id: "classic", label: "Classic", hint: "A plain page: brief, inside list, work" },
];
export const HOME_LAYOUT_KEY = "uni.home.layout.v1";
const EVENT = "uni:home-layout";

export const parseHomeLayout = (raw: unknown): HomeLayout => (raw === "octopus" || raw === "classic" || raw === "tree" || raw === "rooms" ? raw : "rooms");

export function readHomeLayout(): HomeLayout {
  try { return parseHomeLayout(localStorage.getItem(HOME_LAYOUT_KEY)); } catch { return "rooms"; }
}
export function writeHomeLayout(layout: HomeLayout) {
  try { localStorage.setItem(HOME_LAYOUT_KEY, layout); } catch { /* private storage: this session only */ }
  window.dispatchEvent(new Event(EVENT));
}
const subscribe = (f: () => void) => { window.addEventListener(EVENT, f); window.addEventListener("storage", f); return () => { window.removeEventListener(EVENT, f); window.removeEventListener("storage", f); }; };
export const useHomeLayout = (): HomeLayout => useSyncExternalStore(subscribe, readHomeLayout, () => "rooms");

/** Daylight and tablets: the map with the level panel beside it. Narrower is the phone's room tree. */
export const WIDE_MIN = 900;
const wideQuery = `(min-width: ${WIDE_MIN}px)`;
const subscribeWide = (f: () => void) => { const mq = window.matchMedia(wideQuery); mq.addEventListener("change", f); return () => mq.removeEventListener("change", f); };
export const useWide = (): boolean => useSyncExternalStore(subscribeWide, () => window.matchMedia(wideQuery).matches, () => true);
