// T-335: for a few minutes after an approval's device unlock, a routine approval needs only its tap. Rust decides that at
// the tap (src-tauri/src/unlock_grace.rs); the card only shows it, quietly: "Unlocked · 4 min". Pure helpers here
// (unit-tested in scripts/unlockGrace.test.ts); the hook and the hint are in UnlockGrace.tsx.

/** Fired after an approval of any kind, so the hint reads Rust again. */
export const GRACE_CHANGED = "uni:grace-changed";

/** "Unlocked · 4 min": the minutes left, rounded up; null when there's no grace. */
export function graceText(secs: number | null | undefined): string | null {
  if (typeof secs !== "number" || !(secs > 0)) return null;
  return `Unlocked · ${Math.ceil(secs / 60)} min`;
}
