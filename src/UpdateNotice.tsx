import { useEffect, useState, useSyncExternalStore } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { recordingHolder } from "./recLock";
import { isBusy, newerVersion, onDownloadEvent, updateLabel, type UpdateState } from "./updateCore";
import "./UpdateNotice.css";

export { newerVersion };

type AndroidManifest = { version: string; url: string };

// One store for the whole app: the automatic check (banner) and the Settings
// button read and drive the same state, so a download never runs twice.
let state: UpdateState = { kind: "idle" };
let inFlight = false;
let manualRequested = false;
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
  if (state.kind === "ready") return;
  if (inFlight) {
    // If a user clicks while a silent background check is running, promote
    // its result to a visible manual check without starting a second request.
    if (manual && state.kind !== "downloading") { manualRequested = true; set({ kind: "checking" }); }
    return;
  }
  inFlight = true;
  manualRequested = false;
  const before = state;
  if (manual) set({ kind: "checking" });
  try {
    if (/Android/i.test(navigator.userAgent)) {
      const [current, manifest] = await Promise.all([getVersion(), invoke<AndroidManifest>("android_update_manifest")]);
      if (newerVersion(manifest.version, current)) set({ kind: "available", version: manifest.version, url: manifest.url });
      else set(manual || manualRequested ? { kind: "current" } : before);
    } else {
      // Dynamically loaded: the native plugin is registered on desktop only.
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) { set(manual || manualRequested ? { kind: "current" } : before); return; }
      set({ kind: "downloading", received: 0, total: null });
      await update.downloadAndInstall((e) => set(onDownloadEvent(state, e)));
      set({ kind: "ready", version: update.version ?? null });
    }
  } catch (e) {
    console.warn("Update check failed", e);
    // A failed download is always shown; a failed quiet check keeps what was there.
    set(manual || manualRequested || state.kind === "downloading" ? { kind: "error", message: errorText(e) } : before);
  } finally { inFlight = false; manualRequested = false; }
}

export async function restartToUpdate(): Promise<void> {
  try {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) { set({ kind: "error", message: `Restart failed: ${errorText(e)}` }); }
}

/** Restart, unless a recording is open: a restart would lose it, sections and all. Says whether it went ahead. */
function restartIfFree(): boolean {
  if (recordingHolder()) return false;
  void restartToUpdate();
  return true;
}
const FINISH_FIRST = "Finish your recording first";

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
  // r14: the app plugin's version, else the app's own command; if neither answers, just "Uni" (never "version unknown" in Settings)
  const [held, setHeld] = useState(false);
  useEffect(() => { getVersion().catch(() => invoke<string>("app_version")).then((v) => setVersion(v ? String(v) : ""), () => setVersion("")); }, []);
  return <div className="update-settings">
    <span className="update-version">{version ? `Uni ${version}` : version === "" ? "Uni" : "Uni …"}</span>
    {s.kind === "ready" ? <button className="pairing-secondary" onClick={() => setHeld(!restartIfFree())}>{held ? FINISH_FIRST : `${label} — Restart`}</button>
      : s.kind === "available" ? <button className="pairing-secondary" onClick={() => openApkDownload(s.url)}>{label} — Download APK</button>
      : <button className="pairing-secondary" onClick={check} disabled={isBusy(s)}>{isBusy(s) ? label : "Check for updates"}</button>}
    {(s.kind === "current" || s.kind === "error") && <p className={`update-status ${s.kind === "error" ? "error" : ""}`} role="status">{label}</p>}
  </div>;
}

/** The update checks: at start and every 6 h. Mounted once, beside the app (main.tsx); it draws nothing itself. */
export default function UpdateChecks() {
  useEffect(() => {
    void checkForUpdates(false);
    const timer = window.setInterval(() => void checkForUpdates(false), 6 * 60 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);
  return null;
}

// "Later" hides the line for this version until the app restarts; a newer one shows it again.
let laterFor: string | null = null;
const laterListeners = new Set<() => void>();
const laterSnapshot = () => laterFor;
function subscribeLater(l: () => void) { laterListeners.add(l); return () => { laterListeners.delete(l); }; }

/**
 * T-335: an update, said in one line at the top of the main pane, in the page's flow: it pushes the room down rather than sitting over
 * it, so it never covers the composer or its Send button (it used to float bottom-right, over Send on a phone).
 */
export function UpdateBanner() {
  const { state: s } = useUpdater();
  const later = useSyncExternalStore(subscribeLater, laterSnapshot, laterSnapshot);
  const [held, setHeld] = useState(false);
  if (s.kind !== "ready" && s.kind !== "available") return null;
  const version = s.version ?? "";
  if (later !== null && later === version) return null;
  const hide = () => { laterFor = version; laterListeners.forEach((l) => l()); };
  return <div className="update-notice" role="status">
    <span className="update-notice-text">{held ? FINISH_FIRST : s.kind === "ready" ? "Update ready" : "Update available"}{version ? <small> · Uni {version}</small> : null}</span>
    {s.kind === "ready" ? <button type="button" className="update-notice-go" onClick={() => setHeld(!restartIfFree())}>Restart</button>
      : <button type="button" className="update-notice-go" onClick={() => openApkDownload(s.url)}>Download APK</button>}
    <button type="button" className="update-notice-later" onClick={hide}>Later</button>
  </div>;
}
