import { useLayoutEffect, type ReactNode } from "react";
import { defaultProfile, setActiveProfile, type VaultProfile } from "./profile";

/** Makes the selected vault's profile the active one for the code under it (the data layer reads `activeProfile()`). */
export function VaultProfileProvider({ profile, children }: { profile: VaultProfile; children: ReactNode }) {
  setActiveProfile(profile); // set during render so children read the new value
  useLayoutEffect(() => { setActiveProfile(profile); return () => setActiveProfile(defaultProfile()); }, [profile]); // re-assert after a discarded render; back to Uni's on unmount
  return <>{children}</>;
}
