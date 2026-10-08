// Platform gate for live area apps. The constant stays empty until a
// platform's webview is proven by hand; until then a platform is allowed only
// by a stored in-app sandbox self-test pass for this platform AND this app
// version (Settings → Area apps → Run sandbox self-test).
export const LIVE_AREA_PLATFORMS: readonly string[] = [];
export const SELFTEST_KEY = "uni.areaApps.selftest.v1";

export type SelfTestPass = { platform: string; passedAt: string; appVersion: string };

/** `android` is checked first: Android user agents also say Linux. */
export function platformName(ua: string): string {
  return /Android/i.test(ua) ? "android" : /Mac OS X|Macintosh|iPhone|iPad/i.test(ua) ? "mac" : /Linux|X11/i.test(ua) ? "linux" : "other";
}

export function parseSelfTest(raw: string | null): SelfTestPass | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object") return null;
    const { platform, passedAt, appVersion } = v as Record<string, unknown>;
    return typeof platform === "string" && typeof passedAt === "string" && typeof appVersion === "string" && platform && appVersion ? { platform, passedAt, appVersion } : null;
  } catch { return null; }
}

export function readSelfTest(): SelfTestPass | null {
  try { return parseSelfTest(localStorage.getItem(SELFTEST_KEY)); } catch { return null; }
}
export function storeSelfTest(pass: SelfTestPass): void {
  try { localStorage.setItem(SELFTEST_KEY, JSON.stringify(pass)); } catch { /* storage unavailable: the gate stays closed */ }
}

/** Allowed iff the platform is proven in the constant, or a stored pass matches this platform and app version. */
export function liveAreaApps(platform: string, appVersion: string | null, stored: SelfTestPass | null = readSelfTest(), proven: readonly string[] = LIVE_AREA_PLATFORMS): boolean {
  if (proven.includes(platform)) return true;
  return !!stored && !!appVersion && stored.platform === platform && stored.appVersion === appVersion;
}
