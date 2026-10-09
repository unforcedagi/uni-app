// Platform gate for live area apps. The constant stays empty until a
// platform's webview is proven by hand; until then a platform is allowed only
// by a stored in-app sandbox self-test pass for this platform AND this app
// version AND webview user agent (Settings → Area apps → Run sandbox self-test).
// A failed re-run clears the pass; a webview upgrade changes the user agent and
// so forces a re-test.
export const LIVE_AREA_PLATFORMS: readonly string[] = [];
export const SELFTEST_KEY = "uni.areaApps.selftest.v1";

/**
 * `sealed`: every check passed. `approved-code`: only the WebRTC checks failed (every other check passed with
 * positive evidence), so only code the user has approved runs. A result with any other failure is never stored.
 */
export type GateMode = "sealed" | "approved-code";
/** `runtime` is the wry and Tauri versions the pass was earned on (T-77b); a dependency bump changes it and forces a re-run. */
export type SelfTestPass = { platform: string; passedAt: string; appVersion: string; userAgent: string; mode: GateMode; runtime?: string };
export const MODE_LABEL: Record<GateMode, string> = { sealed: "Sealed", "approved-code": "Approved code only (WebRTC present)" };

/** `android` is checked first: Android user agents also say Linux. */
export function platformName(ua: string): string {
  return /Android/i.test(ua) ? "android" : /Mac OS X|Macintosh|iPhone|iPad/i.test(ua) ? "mac" : /Linux|X11/i.test(ua) ? "linux" : "other";
}

export function parseSelfTest(raw: string | null): SelfTestPass | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object") return null;
    const { platform, passedAt, appVersion, userAgent, mode = "sealed", runtime } = v as Record<string, unknown>;
    return typeof platform === "string" && typeof passedAt === "string" && typeof appVersion === "string" && typeof userAgent === "string" && platform && appVersion && userAgent && (mode === "sealed" || mode === "approved-code")
      ? { platform, passedAt, appVersion, userAgent, mode, ...(typeof runtime === "string" && runtime ? { runtime } : {}) } : null;
  } catch { return null; }
}

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());
/** Subscribe to stored-pass changes (this window and, via `storage`, other windows). */
export function subscribeSelfTest(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => { if (!e.key || e.key === SELFTEST_KEY) cb(); };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => { listeners.delete(cb); if (typeof window !== "undefined") window.removeEventListener("storage", onStorage); };
}
/** The raw stored record (a string compares by value, so it is a stable snapshot). */
export function readSelfTestRaw(): string | null {
  try { return localStorage.getItem(SELFTEST_KEY); } catch { return null; }
}
export function readSelfTest(): SelfTestPass | null { return parseSelfTest(readSelfTestRaw()); }
export function storeSelfTest(pass: SelfTestPass): void {
  try { localStorage.setItem(SELFTEST_KEY, JSON.stringify(pass)); } catch { /* storage unavailable: the gate stays closed */ }
  notify();
}
export function clearSelfTest(): void {
  try { localStorage.removeItem(SELFTEST_KEY); } catch { /* storage unavailable */ }
  notify();
}

export const currentUserAgent = () => (typeof navigator === "undefined" ? "" : navigator.userAgent);

/**
 * `closed` unless the platform is proven in the constant (sealed), or a stored result matches this platform, app version, webview user agent
 * and, when `runtime` is passed, the wry/Tauri versions (`null` = host could not say, so closed; `undefined` = not checked).
 */
export function gateMode(platform: string, appVersion: string | null, stored: SelfTestPass | null = readSelfTest(), userAgent: string = currentUserAgent(), proven: readonly string[] = LIVE_AREA_PLATFORMS, runtime?: string | null): GateMode | "closed" {
  if (proven.includes(platform)) return "sealed";
  if (!stored || !appVersion || !userAgent || stored.platform !== platform || stored.appVersion !== appVersion || stored.userAgent !== userAgent) return "closed";
  if (runtime !== undefined && (!runtime || stored.runtime !== runtime)) return "closed";
  return stored.mode === "approved-code" ? "approved-code" : stored.mode === "sealed" ? "sealed" : "closed";
}

/** Allowed iff the gate is open in either mode. */
export function liveAreaApps(platform: string, appVersion: string | null, stored: SelfTestPass | null = readSelfTest(), userAgent: string = currentUserAgent(), proven: readonly string[] = LIVE_AREA_PLATFORMS, runtime?: string | null): boolean {
  return gateMode(platform, appVersion, stored, userAgent, proven, runtime) !== "closed";
}

export type RunDecision = "closed" | "ask" | "ask-updated" | "run" | "run-notice";
/**
 * What an area does with an app, from the gate mode and the grant status. In approved-code mode only an
 * unchanged app that was approved under approved-code mode runs; changed code, or a grant made under a sealed pass, asks again. Sealed keeps "runs, with an Accept notice".
 */
export function runDecision(mode: GateMode | "closed", status: "none" | "ok" | "updated", grantedUnder?: GateMode | null): RunDecision {
  if (mode !== "sealed" && mode !== "approved-code") return "closed";
  if (status === "none") return "ask";
  if (mode === "approved-code") return status === "ok" && grantedUnder === "approved-code" ? "run" : "ask-updated";
  return status === "ok" ? "run" : "run-notice";
}
