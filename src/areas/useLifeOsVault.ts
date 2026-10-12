import { useSyncExternalStore } from "react";
import { readVaultChoice, writeVaultChoice } from "./profile";

// The selected Life OS vault, shared by the surface (which picks it) and the app shell (which hides Uni-only glue unless it is `uni`).
const EVENT = "uni:lifeos-vault";
const store = () => (typeof localStorage === "undefined" ? null : localStorage);
const subscribe = (cb: () => void) => { window.addEventListener(EVENT, cb); window.addEventListener("storage", cb); return () => { window.removeEventListener(EVENT, cb); window.removeEventListener("storage", cb); }; };
export const useLifeOsVault = (): string => useSyncExternalStore(subscribe, () => readVaultChoice(store()), () => "uni");
export function chooseLifeOsVault(vault: string) { writeVaultChoice(store(), vault); window.dispatchEvent(new Event(EVENT)); }
