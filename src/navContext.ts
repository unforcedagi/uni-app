// Back / Forward over the places visited, and the few most recent ones (T-124 r7). The App owns the history; the room sidebar shows it.
import { createContext, useContext } from "react";

export type NavRecent = { key: string; title: string; go: () => void };
export type NavControls = { canBack: boolean; canForward: boolean; back: () => void; forward: () => void; recent: readonly NavRecent[] };
export const NavContext = createContext<NavControls | null>(null);
export const useNav = (): NavControls | null => useContext(NavContext);
