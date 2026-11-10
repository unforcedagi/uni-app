// T-335 OTA: the screens' side of over-the-air bundles (src-tauri/src/ota.rs).
import { invoke } from "@tauri-apps/api/core";
import { recordingHolder } from "./recLock.ts";

/** The shell command API these screens were built against. Must equal `SHELL_API` in src-tauri/src/ota.rs
 *  (scripts/ota.test.ts); scripts/ota-bundle.sh writes it into each bundle's uni-bundle.json. */
export const SHELL_API = 1;

export type OtaStatus = {
  shell_api: number;
  builtin: string;
  active: { version: string; api: number } | null;
  channel: string | null;
};

/** How often coming back to the app looks for new screens. */
export const RESUME_CHECK_MS = 30 * 60 * 1000;

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** A bundle refuses a shell with another API: the shell drops it and reloads the last good screens. */
export function refusesShell(status: Pick<OtaStatus, "shell_api" | "active">, ours = SHELL_API): boolean {
  return status.active !== null && status.shell_api !== ours;
}

let status: Promise<OtaStatus | null> | null = null;
export function otaStatus(): Promise<OtaStatus | null> {
  status ??= inTauri() ? invoke<OtaStatus>("ota_status").catch(() => null) : Promise.resolve(null);
  return status;
}

/** Before the first render. False when this bundle refused the shell (the page is about to reload). */
export async function otaBoot(): Promise<boolean> {
  const s = await otaStatus();
  if (!s) return true;
  if (refusesShell(s)) {
    await invoke("ota_reject", { reason: `bundle built for shell API ${SHELL_API}, shell has ${s.shell_api}` }).catch(() => {});
    return false;
  }
  return true;
}

let lastCheck = 0;
function check(now: number) {
  lastCheck = now;
  void invoke("ota_check").catch(() => {});
}

/** When the app comes back to the foreground: new screens staged earlier are put in now, with a reload, before the
 *  person has done anything (never over an open recording); otherwise look for newer ones, at most every half hour. */
export async function otaResumed(now = Date.now(), reload = () => location.reload()): Promise<"reloaded" | "checked" | "idle"> {
  if (!recordingHolder() && await invoke<boolean>("ota_apply").catch(() => false)) {
    reload();
    return "reloaded";
  }
  if (now - lastCheck < RESUME_CHECK_MS) return "idle";
  check(now);
  return "checked";
}

/** After the first render: keep the bundle on trial, look for a newer one, and again whenever the app comes back. */
export function otaRendered(): () => void {
  if (!inTauri()) return () => {};
  void invoke("ota_ready").catch(() => {});
  const soon = window.setTimeout(() => check(Date.now()), 3000);
  const back = () => { if (document.visibilityState === "visible") void otaResumed(); };
  document.addEventListener("visibilitychange", back);
  return () => { window.clearTimeout(soon); document.removeEventListener("visibilitychange", back); };
}

/** "Screens 0.3.8 · over the air" or "Screens built in"; null outside the app or where there is no channel. */
export function webLabel(s: OtaStatus | null): string | null {
  if (!s || (!s.channel && !s.active)) return null;
  return s.active ? `Screens ${s.active.version} · over the air` : "Screens built in";
}
