// The vault's path listing for the sealed frame's vault bridge only. `vault_paths` pages the whole vault, so it is cached for 10 s per
// vault (a vault switch never serves the previous vault's listing) and concurrent asks share one request. Whatever drops the app's own
// listing (src/vaultPaths.ts `invalidatePaths`: an edit, a Refresh, Forget) drops this one too.
import { invoke } from "@tauri-apps/api/core";
import { watchPaths } from "../vaultPaths.ts";
import type { PathRow } from "./modules/vault.ts";

export const PATHS_TTL_MS = 10_000;

type Entry = { value: PathRow[] | null; at: number; inflight: Promise<PathRow[]> | null };
const caches = new Map<string, Entry>();
watchPaths(() => caches.clear());

export function bridgePaths(vault: string, now: () => number = Date.now): Promise<PathRow[]> {
  let entry = caches.get(vault);
  if (!entry) { entry = { value: null, at: 0, inflight: null }; caches.set(vault, entry); }
  const e = entry;
  if (e.value !== null && now() - e.at < PATHS_TTL_MS) return Promise.resolve(e.value);
  if (e.inflight) return e.inflight;
  const p = invoke<PathRow[]>("vault_paths", { vault })
    // (a listing dropped while it was being read is not put back)
    .then((v) => { if (caches.get(vault) === e) { e.value = v; e.at = now(); } return v; })
    .finally(() => { if (e.inflight === p) e.inflight = null; });
  e.inflight = p;
  return p;
}
