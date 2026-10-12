// The Life OS surface for any vault: reads the vault's profile, offers the vault choice, says so when the vault has no pack.
// A wrapper around AreasSurface so the surface itself needs no change. The uni vault renders at once with Uni's own profile;
// its discovery runs in the background and only a profile note changes anything.
import { useEffect, useMemo, useState, type ComponentProps } from "react";
import { invoke } from "@tauri-apps/api/core";
import AreasSurface from "./AreasSurface";
import "./lifeos.css";
import { VaultProfileProvider } from "./ProfileContext";
import { defaultProfile, UNI_VAULT, vaultChoices } from "./profile";
import { discover, type Found } from "./discover";
import { chooseLifeOsVault, useLifeOsVault } from "./useLifeOsVault";

export { PROFILE_NOTE, discover } from "./discover";

export default function LifeOsSurface({ vaults, identity, ...rest }: { vaults: string[] } & ComponentProps<typeof AreasSurface>) {
  const vault = useLifeOsVault();
  const choices = useMemo(() => vaultChoices(vaults), [vaults]);
  // A saved choice that is no longer in the list falls back to uni (once the list is known).
  const chosen = !choices.length || choices.includes(vault) ? vault : UNI_VAULT;
  const [found, setFound] = useState<Found | null>(null);
  useEffect(() => {
    if (!identity) return;
    let live = true;
    discover(chosen, invoke).then((f) => { if (live) setFound(f); });
    return () => { live = false; };
  }, [chosen, identity]);
  const ready = found?.vault === chosen ? found : null;
  const profile = ready?.profile ?? (chosen === UNI_VAULT ? defaultProfile() : null);
  const pick = chooseLifeOsVault;
  const picker = choices.length > 1 ? <label className="lifeos-vault"><span>Life OS vault</span>
    <select value={chosen} onChange={(e) => pick(e.target.value)}>{choices.map((v) => <option key={v} value={v}>{v}</option>)}</select></label> : null;
  if (ready && !ready.hasPack) return <div className="areas-home lifeos-nopack">{picker}
    <h1>This vault has no Life OS pack</h1>
    <p className="empty">“{chosen}” has no <code>node</code> notes. Install the pack into it (<code>parachute-vault packs add life-os</code>) or choose another vault.</p></div>;
  if (!profile) return <div className="areas-home lifeos-nopack">{picker}<p className="empty">{identity ? "Opening vault…" : "Signing in…"}</p></div>;
  return <VaultProfileProvider profile={profile}>{picker}<AreasSurface key={chosen} identity={identity} {...rest} /></VaultProfileProvider>;
}
