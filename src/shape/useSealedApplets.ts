// T-335 the sealed applets in the drawer: the notes tagged `applet` in the primary vault, read through the one reader (src/vault/reader.ts)
// on its one poller, validated by src/interface/sealedApplet.ts. A note that isn't a valid applet is skipped and counted, never half-shown.
import { useEffect, useState } from "react";
import { reader } from "../vault/reader.ts";
import { discoverApplets, type Discovery } from "../interface/sealedApplet.ts";

export type SealedApplets = Discovery & { /** the first read has answered (an applet tab restored before it says "looking", not "gone") */ loaded: boolean };

const NONE: SealedApplets = { entries: [], skipped: 0, loaded: false };

export function useSealedApplets(vault: string | null): SealedApplets {
  const [state, setState] = useState<{ vault: string | null; key: string; value: SealedApplets }>({ vault: null, key: "", value: NONE });
  useEffect(() => {
    if (!vault) { setState({ vault: null, key: "", value: { ...NONE, loaded: true } }); return; }
    let on = true;
    const load = () => {
      reader.applets(vault).then((r) => {
        if (!on) return;
        const found = discoverApplets(r.rows);
        // the same list read again keeps its identity: the drawer and an open applet don't redraw every minute
        const key = JSON.stringify(found);
        setState((s) => (s.vault === vault && s.key === key && s.value.loaded ? s : { vault, key, value: { ...found, loaded: true } }));
      }).catch(() => {
        // a failed read keeps what was found (the next tick reads again); a first read that fails says it has answered, with nothing
        if (on) setState((s) => (s.vault === vault && s.value.loaded ? s : { vault, key: "", value: { ...NONE, loaded: true } }));
      });
    };
    load();
    const off = reader.onPoll(load);
    return () => { on = false; off(); };
  }, [vault]);
  return state.vault === vault ? state.value : NONE;
}
