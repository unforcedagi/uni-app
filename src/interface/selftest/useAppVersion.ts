import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";

/** The running app version. `null` until known, and `null` for good if the host can't say, which keeps the gate closed. */
export function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    getVersion().catch(() => invoke<string>("app_version")).then((v) => on && setVersion(v ? String(v) : null), () => on && setVersion(null));
    return () => { on = false; };
  }, []);
  return version;
}

/** The wry and Tauri versions this build runs on, part of the self-test pass key. `null` until known and for good if the host can't say, which keeps the gate closed. */
export function useWebviewRuntime(): string | null {
  const [runtime, setRuntime] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    invoke<string>("webview_runtime").then((v) => on && setRuntime(v ? String(v) : null), () => on && setRuntime(null));
    return () => { on = false; };
  }, []);
  return runtime;
}
