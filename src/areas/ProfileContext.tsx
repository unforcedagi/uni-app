import { createContext, useContext, type ReactNode } from "react";
import { defaultProfile, setActiveProfile, type VaultProfile } from "./profile";

const Ctx = createContext<VaultProfile>(defaultProfile());

/** Supplies the selected vault's profile. Without a provider the profile is Uni's own (today's behaviour). */
export function VaultProfileProvider({ profile, children }: { profile: VaultProfile; children: ReactNode }) {
  setActiveProfile(profile); // for non-React code (task parsing, the data layer); set during render so children read the new value
  return <Ctx.Provider value={profile}>{children}</Ctx.Provider>;
}
export const useVaultProfile = (): VaultProfile => useContext(Ctx);
