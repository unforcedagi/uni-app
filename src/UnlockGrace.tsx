// T-335: the "Unlocked · 4 min" hint on a card whose approval would need only its tap (see unlockGraceCore.ts).
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SEALED_CHANGED } from "./sealedCardCore";
import { GRACE_CHANGED, graceText } from "./unlockGraceCore";

/** The grace's seconds left, read from Rust while `on` (a card that would use it is showing); else null. */
export function useUnlockGrace(on: boolean): number | null {
  const [got, setGot] = useState<{ secs: number; at: number } | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    setGot(null);
    if (!on) return;
    let live = true;
    const read = () => {
      invoke<number | null>("unlock_grace").then(
        (s) => { if (live) setGot(typeof s === "number" && s > 0 ? { secs: s, at: Date.now() } : null); },
        () => { if (live) setGot(null); });
    };
    // hidden is how a phone locks or leaves the app: Rust ends the grace then, and the hint goes with it
    const seen = () => { if (document.visibilityState === "visible") read(); else setGot(null); };
    read();
    const every = window.setInterval(read, 15_000);
    window.addEventListener(GRACE_CHANGED, read);
    window.addEventListener(SEALED_CHANGED, read);
    window.addEventListener("focus", read);
    document.addEventListener("visibilitychange", seen);
    return () => {
      live = false;
      window.clearInterval(every);
      window.removeEventListener(GRACE_CHANGED, read);
      window.removeEventListener(SEALED_CHANGED, read);
      window.removeEventListener("focus", read);
      document.removeEventListener("visibilitychange", seen);
    };
  }, [on]);
  // count down between reads
  useEffect(() => {
    if (!got) return;
    const t = window.setInterval(() => tick((n) => n + 1), 1_000);
    return () => window.clearInterval(t);
  }, [got]);
  if (!got) return null;
  const left = got.secs - (Date.now() - got.at) / 1000;
  return left > 0 ? left : null;
}

/** The hint, for a card that would go through on its tap: nothing when there's no grace. */
export function GraceHint({ on, sep = false }: { on: boolean; sep?: boolean }) {
  const text = graceText(useUnlockGrace(on));
  if (!text) return null;
  return <><span className="cc-grace" title="You unlocked this device for an approval a moment ago, so a routine approval needs only its tap. Powerful ones still ask.">{text}</span>{sep && " · "}</>;
}
