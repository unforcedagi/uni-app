import { useEffect, useState, useSyncExternalStore } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { isBusy, newerVersion, onDownloadEvent, updateLabel, type UpdateState } from "./updateCore";
import "./UpdateNotice.css";

export { newerVersion };

type AndroidManifest = { version: string; url: string };

// One store for the whole app: the automatic check (banner) and the Settings
// button read and drive the same state, so a download never runs twice.
let state: UpdateState = { kind: "idle" };
let inFlight = false;
const listeners = new Set<() => void>();
function set(next: UpdateState) { state = next; listeners.forEach((l) => l()); }
function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }
const snapshot = () => state;

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message || String(e);
  if (typeof e === "string") return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}

/** Check (and on desktop, download + install). `manual` shows "Checking…",
 *  "Up to date" and failures; the background check stays quiet about those. */
export async function checkForUpdates(manual: boolean): Promise<void> {
  // One check at a time, and nothing to do once an update is installed.
  if (inFlight || state.kind === "ready") return;
  inFlight = true;
  const before = state;
  if (manual) set({ kind: "checking" });
  try {
    if (/Android/i.test(navigator.userAgent)) {
      const [current, manifest] = await Promise.all([getVersion(), invoke<AndroidManifest>("android_update_manifest")]);
      if (newerVersion(manifest.version, current)) set({ kind: "available", version: manifest.version, url: manifest.url });
      else set(manual ? { kind: "current" } : before);
    } else {
      // Dynamically loaded: the native plugin is registered on desktop only.
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) { set(manual ? { kind: "current" } : before); return; }
      set({ kind: "downloading", received: 0, total: null });
      await update.downloadAndInstall((e) => set(onDownloadEvent(state, e)));
      set({ kind: "ready", version: update.version ?? null });
    }
  } catch (e) {
    console.warn("Update check failed", e);
    // A failed download is always shown; a failed quiet check keeps what was there.
    set(manual || state.kind === "downloading" ? { kind: "error", message: errorText(e) } : before);
  } finally { inFlight = false; }
}

export async function restartToUpdate(): Promise<void> {
  try {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) { set({ kind: "error", message: `Restart failed: ${errorText(e)}` }); }
}

export function openApkDownload(url: string) {
  void invoke("open_link", { url }).catch((e) => set({ kind: "error", message: `Couldn't open the download: ${errorText(e)}` }));
}

export function useUpdater(): { state: UpdateState; label: string; check: () => void } {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);
  return { state: s, label: updateLabel(s), check: () => void checkForUpdates(true) };
}

/** Settings block: the running version, Check for updates, and its state. */
export function UpdateSettings() {
  const { state: s, label, check } = useUpdater();
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => { getVersion().then(setVersion).catch(() => setVersion("(version unknown)")); }, []);
  return <div className="update-settings">
    <span className="update-version">Uni {version ?? "…"}</span>
    {s.kind === "ready" ? <button className="pairing-secondary" onClick={() => void restartToUpdate()}>{label} — Restart</button>
      : s.kind === "available" ? <button className="pairing-secondary" onClick={() => openApkDownload(s.url)}>{label} — Download APK</button>
      : <button className="pairing-secondary" onClick={check} disabled={isBusy(s)}>{isBusy(s) ? label : "Check for updates"}</button>}
    {(s.kind === "current" || s.kind === "error") && <p className={`update-status ${s.kind === "error" ? "error" : ""}`} role="status">{label}</p>}
  </div>;
}

export default function UpdateNotice() {
  const { state: s } = useUpdater();
  useEffect(() => {
    void checkForUpdates(false);
    const timer = window.setInterval(() => void checkForUpdates(false), 6 * 60 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);
  if (s.kind === "ready") return <div className="update-notice" role="status"><span>Update ready</span><button onClick={() => void restartToUpdate()}>Restart</button></div>;
  if (s.kind === "available") return <div className="update-notice" role="status"><span>Update available</span><button onClick={() => openApkDownload(s.url)}>Download APK</button></div>;
  return null;
}
