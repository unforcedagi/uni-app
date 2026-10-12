import { useEffect, useState } from "react";
import { readVaultChoice, writeVaultChoice } from "./profile";

// The selected Life OS vault, shared by the surface (which picks it) and the app shell (which hides Uni-only glue unless it is `uni`).
// Plain state + an event listener: the shell re-renders only when the choice actually changes.
const EVENT = "uni:lifeos-vault";
const store = () => (typeof localStorage === "undefined" ? null : localStorage);
export function useLifeOsVault(): string {
  const [vault, setVault] = useState(() => readVaultChoice(store()));
  useEffect(() => {
    const sync = () => setVault((v) => { const n = readVaultChoice(store()); return n === v ? v : n; });
    window.addEventListener(EVENT, sync); window.addEventListener("storage", sync);
    return () => { window.removeEventListener(EVENT, sync); window.removeEventListener("storage", sync); };
  }, []);
  return vault;
}
export function chooseLifeOsVault(vault: string) { writeVaultChoice(store(), vault); window.dispatchEvent(new Event(EVENT)); }
