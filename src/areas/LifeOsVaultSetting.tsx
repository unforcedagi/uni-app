import { useMemo } from "react";
import { effectiveLifeVault, vaultChoices } from "./profile";
import { chooseLifeOsVault, useLifeOsVault } from "./useLifeOsVault";

/** Settings → Life OS vault. The uni home shows no picker (decided 10-12): choosing another vault lives here, and the
 *  picker appears on the home only while a non-uni vault is open, so there is always a way back. */
export default function LifeOsVaultSetting({ vaults }: { vaults: string[] }) {
  const saved = useLifeOsVault();
  const choices = useMemo(() => vaultChoices(vaults), [vaults]);
  if (choices.length < 2) return null;
  const chosen = effectiveLifeVault(saved, choices);
  return <label className="lifeos-vault lifeos-vault-setting"><span>Life OS vault</span>
    <select value={chosen} onChange={(e) => chooseLifeOsVault(e.target.value)}>
      {choices.map((v) => <option key={v} value={v}>{v}</option>)}
    </select></label>;
}
