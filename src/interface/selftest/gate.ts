// Platform gate for live area apps. The constant stays empty until a
// platform's webview is proven by hand; until then a platform is allowed only
// by a stored in-app sandbox self-test pass for this platform AND this app
// version AND webview user agent (Settings → Area apps → Run sandbox self-test).
// A failed re-run clears the pass; a webview upgrade changes the user agent and
// so forces a re-test.
export const LIVE_AREA_PLATFORMS: readonly string[] = [];
export const SELFTEST_KEY = "uni.areaApps.selftest.v1";

export type SelfTestPass = { platform: string; passedAt: string; appVersion: string; userAgent: string };

/** `android` is checked first: Android user agents also say Linux. */
export function platformName(ua: string): string {
  return /Android/i.test(ua) ? "android" : /Mac OS X|Macintosh|iPhone|iPad/i.test(ua) ? "mac" : /Linux|X11/i.test(ua) ? "linux" : "other";
}

export function parseSelfTest(raw: string | null): SelfTestPass | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object") return null;
    const { platform, passedAt, appVersion, userAgent } = v as Record<string, unknown>;
    return typeof platform === "string" && typeof passedAt === "string" && typeof appVersion === "string" && typeof userAgent === "string" && platform && appVersion && userAgent
      ? { platform, passedAt, appVersion, userAgent } : null;
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

/** Allowed iff the platform is proven in the constant, or a stored pass matches this platform, app version and webview user agent. */
export function liveAreaApps(platform: string, appVersion: string | null, stored: SelfTestPass | null = readSelfTest(), userAgent: string = currentUserAgent(), proven: readonly string[] = LIVE_AREA_PLATFORMS): boolean {
  if (proven.includes(platform)) return true;
  return !!stored && !!appVersion && !!userAgent && stored.platform === platform && stored.appVersion === appVersion && stored.userAgent === userAgent;
}
