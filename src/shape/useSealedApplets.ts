// T-335 the sealed applets in the drawer: the notes tagged `applet` in every vault this device has, read through the one reader
// (src/vault/reader.ts) on its one poller, validated by src/interface/sealedApplet.ts. The primary vault comes first, so an id it holds
// can't be taken from another vault. A note that isn't a valid applet is skipped and counted, never half-shown.
import { useEffect, useState } from "react";
import { reader } from "../vault/reader.ts";
import { discoverApplets, joinDiscoveries, type Discovery } from "../interface/sealedApplet.ts";

export type SealedApplets = Discovery & { /** the first read has answered (an applet tab restored before it says "looking", not "gone") */ loaded: boolean };

const NONE: SealedApplets = { entries: [], skipped: 0, loaded: false };

/** `vaults`: the primary vault first, then the others; read as one list (a vault that fails to answer keeps what it had). */
export function useSealedApplets(vaults: readonly string[]): SealedApplets {
  const sig = vaults.join("\n");
  const [state, setState] = useState<{ sig: string; key: string; value: SealedApplets }>({ sig: "\0", key: "", value: NONE });
  useEffect(() => {
    const names = sig ? sig.split("\n") : [];
    if (!names.length) { setState({ sig, key: "", value: { ...NONE, loaded: true } }); return; }
    let on = true;
    const last = new Map<string, Discovery>();
    const load = () => {
      // (a first read that fails still says it has answered, with nothing from that vault)
      void Promise.all(names.map((v) => reader.applets(v).then((r) => { last.set(v, discoverApplets(r.rows, v)); }, () => {}))).then(() => {
        if (!on) return;
        // a vault that failed this time keeps what it last gave; one that never answered gives nothing
        const found = joinDiscoveries(names.map((v) => last.get(v) ?? { entries: [], skipped: 0 }));
        // the same list read again keeps its identity: the drawer and an open applet don't redraw every minute
        const key = JSON.stringify(found);
        setState((s) => (s.sig === sig && s.key === key && s.value.loaded ? s : { sig, key, value: { ...found, loaded: true } }));
      });
    };
    load();
    const off = reader.onPoll(load);
    return () => { on = false; off(); };
  }, [sig]);
  return state.sig === sig ? state.value : NONE;
}
