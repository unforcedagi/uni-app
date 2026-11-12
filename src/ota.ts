// T-335 OTA: the screens' side of over-the-air bundles (src-tauri/src/ota.rs).
import { invoke } from "@tauri-apps/api/core";
import { recordingHolder } from "./recLock.ts";

/** The shell command API these screens were built against. Must equal `SHELL_API` in src-tauri/src/ota.rs
 *  (scripts/ota.test.ts); scripts/ota-bundle.sh writes it into each bundle's uni-bundle.json. */
export const SHELL_API = 3;

export type OtaStatus = {
  shell_api: number;
  builtin: string;
  active: { version: string; api: number } | null;
  channel: string | null;
};

/** Coming back to the app looks for new screens (one small signed file); at most once a minute, so flicking between
 *  apps doesn't fetch it again and again. */
export const RESUME_CHECK_MS = 60 * 1000;
/** New screens go in on coming back only after this long away: a quick switch to another app keeps the page as it was
 *  (a send or upload under way, where you were), and the new screens wait for the next longer absence or start. */
export const APPLY_AWAY_MS = 2 * 60 * 1000;

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** A bundle refuses a shell with another API: it doesn't start, and asks to be dropped. */
export function refusesShell(status: Pick<OtaStatus, "shell_api" | "active">, ours = SHELL_API): boolean {
  return status.active !== null && status.shell_api !== ours;
}

let status: Promise<OtaStatus | null> | null = null;
export function otaStatus(): Promise<OtaStatus | null> {
  status ??= inTauri() ? invoke<OtaStatus>("ota_status").catch(() => null) : Promise.resolve(null);
  return status;
}

/** Before the first render. False when these screens were built for another shell: they don't start, and ask the shell
 *  to drop them (it does only while they are on trial) and go back to the last good screens. */
export async function otaBoot(reload = () => location.reload()): Promise<boolean> {
  const s = await otaStatus();
  const active = s?.active;
  if (s && active && refusesShell(s)) {
    const reason = `screens built for shell API ${SHELL_API}, shell has ${s.shell_api}`;
    console.warn(`${reason}: not starting`);
    if (await invoke<boolean>("ota_refused", { version: active.version, reason }).catch(() => false)) reload();
    return false;
  }
  return true;
}

let lastCheck = 0;
function check(now: number) {
  lastCheck = now;
  void invoke("ota_check").catch(() => {});
}

/** When the app comes back to the foreground after APPLY_AWAY_MS or more: new screens staged earlier are put in now, with a
 *  reload, before the person has done anything (never over an open recording). Either way, look for newer ones (at most
 *  once a minute). */
export async function otaResumed(now = Date.now(), away = 0, reload = () => location.reload()): Promise<"reloaded" | "checked" | "idle"> {
  if (away >= APPLY_AWAY_MS && !recordingHolder() && await invoke<boolean>("ota_apply").catch(() => false)) {
    reload();
    return "reloaded";
  }
  if (now - lastCheck < RESUME_CHECK_MS) return "idle";
  check(now);
  return "checked";
}

/** After the first render: keep the bundle on trial, and look for newer screens whenever the app comes back (the shell
 *  itself looks a few seconds after launch). */
export function otaRendered(): () => void {
  if (!inTauri()) return () => {};
  void invoke("ota_ready").catch(() => {});
  lastCheck = Date.now();
  let hiddenAt = 0;
  const back = () => {
    if (document.visibilityState === "hidden") hiddenAt = Date.now();
    else if (hiddenAt) void otaResumed(Date.now(), Date.now() - hiddenAt);
  };
  document.addEventListener("visibilitychange", back);
  return () => document.removeEventListener("visibilitychange", back);
}

/** "Screens 0.3.8 · over the air" or "Screens built in"; null outside the app or where there is no channel. */
export function webLabel(s: OtaStatus | null): string | null {
  if (!s || (!s.channel && !s.active)) return null;
  return s.active ? `Screens ${s.active.version} · over the air` : "Screens built in";
}
