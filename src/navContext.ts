// Back / Forward over the places visited, and the few most recent ones (T-124 r7). The App owns the history; the room sidebar shows it.
import { createContext, useContext } from "react";

/** A recent place: its identity (`placeKey`), its name, and for an area or project its path, so a name two places share can show where each sits. */
export type NavRecent = { key: string; title: string; path?: string | null; room?: string | null; go: () => void };
export type NavControls = { canBack: boolean; canForward: boolean; back: () => void; forward: () => void; recent: readonly NavRecent[] };
export const NavContext = createContext<NavControls | null>(null);
export const useNav = (): NavControls | null => useContext(NavContext);
