// The Life OS surface for any vault: reads the vault's profile, offers the vault choice, says so when the vault has no pack.
// A wrapper around AreasSurface so the surface itself needs no change. The uni vault renders at once with Uni's own profile;
// its discovery runs in the background and only a profile note changes anything.
import { useEffect, useMemo, useState, type ComponentProps } from "react";
import { invoke } from "@tauri-apps/api/core";
import AreasSurface from "./AreasSurface";
import "./lifeos.css";
import { VaultProfileProvider } from "./ProfileContext";
import { defaultProfile, readProfileNote, readVaultChoice, resolveProfile, UNI_VAULT, vaultChoices, writeVaultChoice, type VaultProfile } from "./profile";

export const PROFILE_NOTE = ".parachute/life-os";
type Found = { vault: string; profile: VaultProfile; hasPack: boolean };
const tagHasNotes = (vault: string, tag: string) => invoke<unknown[]>("vault_query", { vault, tag, includeContent: false, limit: 1 }).then((r) => Array.isArray(r) && r.length > 0).catch(() => null);

/** Profile note (if any), the pack check (any `node` note) and the root tag default, all from the vault itself. */
export async function discover(vault: string): Promise<Found> {
  const uni = vault === UNI_VAULT; // uni is never probed: its queries stay exactly today's (it has the pack's tags and the `uni` root)
  const [note, nodes, roots] = await Promise.all([
    invoke<{ note: { content?: string | null; metadata?: unknown } }>("vault_note", { vault, noteRef: PROFILE_NOTE }).then((d) => readProfileNote(d.note)).catch(() => null),
    uni ? true : tagHasNotes(vault, "node"), uni ? false : tagHasNotes(vault, "root"),
  ]);
  return { vault, profile: resolveProfile(vault, note, roots === true), hasPack: vault === UNI_VAULT || nodes !== false }; // uni is never "no pack"; an unanswered check is not "no pack" either
}

export default function LifeOsSurface({ vaults, identity, ...rest }: { vaults: string[] } & ComponentProps<typeof AreasSurface>) {
  const [vault, setVault] = useState(() => readVaultChoice(typeof localStorage === "undefined" ? null : localStorage));
  const choices = useMemo(() => vaultChoices(vaults), [vaults]);
  // A saved choice that is no longer in the list falls back to uni (once the list is known).
  const chosen = !choices.length || choices.includes(vault) ? vault : UNI_VAULT;
  const [found, setFound] = useState<Found | null>(null);
  useEffect(() => {
    if (!identity) return;
    let live = true;
    discover(chosen).then((f) => { if (live) setFound(f); });
    return () => { live = false; };
  }, [chosen, identity]);
  const ready = found?.vault === chosen ? found : null;
  const profile = ready?.profile ?? (chosen === UNI_VAULT ? defaultProfile() : null);
  const pick = (v: string) => { writeVaultChoice(localStorage, v); setVault(v); };
  const picker = choices.length > 1 ? <label className="lifeos-vault"><span>Life OS vault</span>
    <select value={chosen} onChange={(e) => pick(e.target.value)}>{choices.map((v) => <option key={v} value={v}>{v}</option>)}</select></label> : null;
  if (ready && !ready.hasPack) return <div className="areas-home lifeos-nopack">{picker}
    <h1>This vault has no Life OS pack</h1>
    <p className="empty">“{chosen}” has no <code>node</code> notes. Install the pack into it (<code>parachute-vault packs add life-os</code>) or choose another vault.</p></div>;
  if (!profile) return <div className="areas-home lifeos-nopack">{picker}<p className="empty">{identity ? "Opening vault…" : "Signing in…"}</p></div>;
  return <VaultProfileProvider profile={profile}>{picker}<AreasSurface key={chosen} identity={identity} {...rest} /></VaultProfileProvider>;
}
