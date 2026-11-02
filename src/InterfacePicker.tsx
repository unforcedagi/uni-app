// T-305 interface platform spike: which interface the shell shows. Uni is always there; the others are agents' own
// interfaces the person installed, each allowed only what the person granted it (src-tauri/src/iface.rs).
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

type Iface = { id: string; name: string; active: boolean; grants: string[] };

const SAYS: Record<string, string> = {
  "rooms.read": "read your rooms",
  "rooms.send": "send messages",
  "rooms.edit": "edit and delete its messages",
  "identity.read": "see your public key",
  "vault.read": "read your vault",
  "vault.write": "change your vault",
  "media.read": "open media",
  "media.send": "send media and voice",
  "approvals.read": "see approvals waiting",
  usage: "set usage preferences",
};

/** "It may read your rooms and send messages." */
export function grantsSentence(grants: string[]): string {
  const said = grants.map((g) => SAYS[g] ?? g);
  if (!said.length) return "It may not use anything yet.";
  const list = said.length === 1 ? said[0] : `${said.slice(0, -1).join(", ")} and ${said[said.length - 1]}`;
  return `It may ${list}.`;
}

export default function InterfacePicker() {
  const [list, setList] = useState<Iface[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { void invoke<Iface[]>("iface_list").then(setList, () => setList(null)); }, []);
  if (!list || list.length < 2) return null;
  const use = (i: Iface) => {
    setBusy(i.id);
    setError("");
    invoke("iface_use", { id: i.id }).catch((e) => { setError(String(e)); setBusy(null); });
  };
  return <div className="iface-picker" role="group" aria-label="Interface">
    <span className="update-version">Interface</span>
    {list.filter((i) => i.id !== "uni").map((i) => <div key={i.id} className="iface-row">
      {i.active ? <span>{i.name} is showing</span>
        : <button className="pairing-secondary" disabled={busy !== null} onClick={() => use(i)}>{busy === i.id ? `Opening ${i.name}…` : `Use ${i.name}`}</button>}
      <small className="pairing-note">{grantsSentence(i.grants)}</small>
    </div>)}
    {error && <p className="pairing-note" role="alert">{error}</p>}
  </div>;
}
