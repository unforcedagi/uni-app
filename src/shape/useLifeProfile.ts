// T-335 the shape: the life vault's profile (who "you" are in its notes, its agents), which the old home's LifeOsSurface read and set for the
// whole app. Uni's vault has its profile at once (its note only refines it); another vault's is discovered (its `.parachute/life-os` note and
// pack) once signed in. Until then Uni's default stands, as it did when that surface hadn't read the vault yet.
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { defaultProfile, type VaultProfile } from "../areas/profile";
import { discover, type Found } from "../areas/discover";

export function useLifeProfile(vault: string, identity: string | null): VaultProfile {
  const [found, setFound] = useState<Found | null>(null);
  useEffect(() => {
    if (!identity) return;
    let live = true;
    discover(vault, invoke).then((f) => { if (live) setFound(f); }).catch(() => {});
    return () => { live = false; };
  }, [vault, identity]);
  const fallback = useMemo(() => defaultProfile(), []);
  return found?.vault === vault ? found.profile : fallback;
}
