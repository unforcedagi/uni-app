// T-335: the "Unlocked · 4 min" hint on a card whose approval would need only its tap (see unlockGraceCore.ts).
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SEALED_CHANGED } from "./sealedCardCore";
import { GRACE_CHANGED, graceText } from "./unlockGraceCore";

// One read of Rust for every card showing the hint: on first use, every 15 s, on focus, and after any approval.
let got: { secs: number; at: number } | null = null;
const cards = new Set<() => void>();
let every: number | undefined;
let reading = false, again = false;

function publish(next: typeof got) {
  got = next;
  cards.forEach((f) => f());
}

function read() {
  // an approval during a read: read again after it, the first may predate the unlock
  if (reading) { again = true; return; }
  reading = true;
  invoke<number | null>("unlock_grace").then(
    (s) => publish(typeof s === "number" && s > 0 ? { secs: s, at: Date.now() } : null),
    () => publish(null),
  ).finally(() => {
    reading = false;
    if (again) { again = false; read(); }
  });
}

// hidden is how a phone locks or leaves the app: Rust ends the grace then, and the hint goes with it
function seen() {
  if (document.visibilityState === "visible") read(); else publish(null);
}

function start() {
  read();
  every = window.setInterval(read, 15_000);
  window.addEventListener(GRACE_CHANGED, read);
  window.addEventListener(SEALED_CHANGED, read);
  window.addEventListener("focus", read);
  document.addEventListener("visibilitychange", seen);
}

function stop() {
  window.clearInterval(every);
  window.removeEventListener(GRACE_CHANGED, read);
  window.removeEventListener(SEALED_CHANGED, read);
  window.removeEventListener("focus", read);
  document.removeEventListener("visibilitychange", seen);
  got = null;
}

/** The grace's seconds left while `on` (a card that would use it is showing); else null. */
export function useUnlockGrace(on: boolean): number | null {
  const [, render] = useState(0);
  useEffect(() => {
    if (!on) return;
    const f = () => render((n) => n + 1);
    cards.add(f);
    if (cards.size === 1) start(); else f();
    return () => { cards.delete(f); if (!cards.size) stop(); };
  }, [on]);
  const left = on && got ? got.secs - (Date.now() - got.at) / 1000 : null;
  // draw again when the minute shown changes, until it runs out
  useEffect(() => {
    if (left === null || left <= 0) return;
    const t = window.setTimeout(() => render((n) => n + 1), (left % 60) * 1000 + 20);
    return () => window.clearTimeout(t);
  });
  return left !== null && left > 0 ? left : null;
}

/** The hint, for a card that would go through on its tap: nothing when there's no grace. */
export function GraceHint({ on, sep = false }: { on: boolean; sep?: boolean }) {
  const text = graceText(useUnlockGrace(on));
  if (!text) return null;
  return <><span className="cc-grace" title="You unlocked this device for an approval a moment ago, so a routine approval needs only its tap. Powerful ones still ask.">{text}</span>{sep && " · "}</>;
}
