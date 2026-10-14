// The Life OS surface for any vault: reads the vault's profile, offers the vault choice, says so when the vault has no pack.
// A wrapper around AreasSurface so the surface itself needs no change. The uni vault renders at once with Uni's own profile;
// its discovery runs in the background and only a profile note changes anything.
import { useEffect, useMemo, useState, type ComponentProps } from "react";
import { invoke } from "@tauri-apps/api/core";
import AreasSurface from "./AreasSurface";
import "./lifeos.css";
import { VaultProfileProvider } from "./ProfileContext";
import { defaultProfile, effectiveLifeVault, UNI_VAULT, vaultChoices } from "./profile";
import { discover, type Found } from "./discover";
import { chooseLifeOsVault, useLifeOsVault } from "./useLifeOsVault";
import { UNI_CHANNEL } from "./treeCore";
import { findUniRoom } from "../uniActions";
import { SLOW_MS } from "./useTasks";

export { PROFILE_NOTE, discover } from "./discover";

export default function LifeOsSurface({ vaults, identity, ...rest }: { vaults: string[] } & ComponentProps<typeof AreasSurface>) {
  const vault = useLifeOsVault();
  const choices = useMemo(() => vaultChoices(vaults), [vaults]);
  // A saved choice that is no longer in the list falls back to uni (once the list is known).
  const chosen = effectiveLifeVault(vault, choices);
  const [found, setFound] = useState<Found | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (!identity) return;
    let live = true;
    discover(chosen, invoke).then((f) => { if (live) setFound(f); });
    return () => { live = false; };
  }, [chosen, identity, tries]);
  const ready = found?.vault === chosen ? found : null;
  const [slow, setSlow] = useState(false);
  useEffect(() => { setSlow(false); if (ready) return; const t = setTimeout(() => setSlow(true), SLOW_MS); return () => clearTimeout(t); }, [chosen, tries, !!ready]); // eslint-disable-line react-hooks/exhaustive-deps
  const profile = ready?.profile ?? (chosen === UNI_VAULT ? defaultProfile() : null);
  const pick = chooseLifeOsVault;
  // Decided 10-12: the uni home stays unchanged (no picker row). The picker shows here only while another vault is
  // open, as the way back; otherwise it lives in Settings → Life OS vault.
  const picker = choices.length > 1 && chosen !== UNI_VAULT ? <label className="lifeos-vault"><span>Areas and projects vault</span>
    <select value={chosen} onChange={(e) => pick(e.target.value)}>{choices.map((v) => <option key={v} value={v}>{v}</option>)}</select></label> : null;
  // r15: the ways on, said as actions: ask Uni (its room's composer, filled in, never sent), look again, or go back to Uni's own vault
  const uniRoom = rest.rooms.some((r) => r.id === UNI_CHANNEL) ? UNI_CHANNEL : findUniRoom(rest.rooms)?.id ?? null;
  if (ready && !ready.hasPack) return <div className="areas-home lifeos-nopack">{picker}
    <h1>“{chosen}” isn't set up for Uni yet</h1>
    <p className="empty">It has no areas or projects for Uni to show yet.</p>
    <p className="sr-missing-go">
      {uniRoom && <button type="button" className="task-do primary" onClick={() => rest.actions.compose(uniRoom, `@Uni Please set up the "${chosen}" vault so it has areas and projects to show.`)}>Ask Uni to set it up ›</button>}
      <button type="button" className="task-do" onClick={() => { setFound(null); setTries((n) => n + 1); }}>Retry</button>
      {choices.includes(UNI_VAULT) && <button type="button" className="task-do" onClick={() => pick(UNI_VAULT)}>Back to Uni's vault</button>}
    </p>
    <details className="settings-dev"><summary>Developer</summary><p className="settings-dev-line">No <code>node</code> notes. Install the Life OS pack: <code>parachute-vault packs add life-os</code></p></details></div>;
  // r19 (Codex 9): never an endless "Opening vault…": past SLOW_MS it says so, with Retry and the way back to Uni's vault
  if (!profile) return <div className="areas-home lifeos-nopack">{picker}{slow && identity
    ? <><p className="empty" role="status">Still opening “{chosen}”.</p><p className="sr-missing-go">
      <button type="button" className="task-do primary" onClick={() => { setFound(null); setTries((n) => n + 1); }}>Retry</button>
      {choices.includes(UNI_VAULT) && chosen !== UNI_VAULT && <button type="button" className="task-do" onClick={() => pick(UNI_VAULT)}>Back to Uni's vault</button>}</p></>
    : <p className="empty">{identity ? "Opening vault…" : "Signing in…"}</p>}</div>;
  return <VaultProfileProvider profile={profile}>{picker}<AreasSurface key={chosen} identity={identity} {...rest} /></VaultProfileProvider>;
}
