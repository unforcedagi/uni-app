import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

/** The running app version. `null` until known, and `null` for good if the host can't say, which keeps the gate closed. */
export function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    getVersion().then((v) => on && setVersion(v ? String(v) : null), () => on && setVersion(null));
    return () => { on = false; };
  }, []);
  return version;
}
