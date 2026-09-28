import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import "./UpdateNotice.css";

type AndroidManifest = { version: string; url: string };
type Ready = { kind: "mac"; restart: () => Promise<void> } | { kind: "android"; url: string };

// Only stable numeric versions from our publisher are compared; no prerelease ordering.
export function newerVersion(latest: string, current: string): boolean {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : null;
  const a = parse(latest), b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}

export default function UpdateNotice() {
  const [ready, setReady] = useState<Ready | null>(null);
  useEffect(() => {
    let active = true, checking = false;
    const android = /Android/i.test(navigator.userAgent);
    const checkUpdate = async () => {
      if (checking || ready) return;
      checking = true;
      try {
        if (android) {
          const [current, manifest] = await Promise.all([getVersion(), invoke<AndroidManifest>("android_update_manifest")]);
          if (active && newerVersion(manifest.version, current)) setReady({ kind: "android", url: manifest.url });
        } else {
          // Dynamically loaded: the native plugin is registered on desktop only.
          const { check } = await import("@tauri-apps/plugin-updater");
          const update = await check();
          if (update) {
            await update.downloadAndInstall();
            if (active) setReady({ kind: "mac", restart: async () => {
              const { relaunch } = await import("@tauri-apps/plugin-process");
              await relaunch();
            } });
          }
        }
      } catch (error) { console.warn("Update check failed; will retry later", error); }
      finally { checking = false; }
    };
    void checkUpdate();
    const timer = window.setInterval(() => void checkUpdate(), 6 * 60 * 60 * 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, [ready]);
  if (!ready) return null;
  return <div className="update-notice" role="status">
    {ready.kind === "mac" ? <><span>Update ready</span><button onClick={() => void ready.restart()}>Restart</button></>
      : <><span>Update available</span><button onClick={() => void invoke("open_link", { url: ready.url })}>Download APK</button></>}
  </div>;
}
