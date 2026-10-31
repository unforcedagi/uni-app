// T-305 spike: the web layer's side of over-the-air bundles (src-tauri/src/ota.rs).
import { invoke } from "@tauri-apps/api/core";

/** The shell command API this web layer was built against. Must equal `SHELL_API` in src-tauri/src/ota.rs
 *  (scripts/ota.test.ts); scripts/ota-bundle.sh writes it into each bundle's uni-bundle.json. */
export const SHELL_API = 1;

export type OtaStatus = {
  shell_api: number;
  builtin: string;
  active: { version: string; api: number } | null;
  channel: string | null;
};

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** A bundle refuses a shell with another API: the shell drops it and reloads the built-in web layer. */
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

/** After the first render: keep the bundle on trial, then look for a newer one for the next launch. */
export function otaRendered(): void {
  if (!inTauri()) return;
  void invoke("ota_ready").catch(() => {});
  window.setTimeout(() => void invoke("ota_check").catch(() => {}), 3000);
}

/** "web 0.1.85 (over the air)" or "web built in"; null outside the app. */
export function webLabel(s: OtaStatus | null): string | null {
  if (!s) return null;
  return s.active ? `web ${s.active.version} (over the air)` : "web built in";
}
