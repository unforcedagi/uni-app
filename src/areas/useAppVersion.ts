import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

/** The running app version; "dev" when the host can't say (browser harness). `null` until known. */
export function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    getVersion().then((v) => on && setVersion(v ? String(v) : "dev"), () => on && setVersion("dev"));
    return () => { on = false; };
  }, []);
  return version;
}
