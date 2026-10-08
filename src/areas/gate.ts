// Platform gate for live area apps. A platform joins this list only after a
// device self-test passes in that platform's Tauri webview (sandboxed srcdoc
// frame, CSP, postMessage bridge). Android and Mac stay on the default view.
export const LIVE_AREA_PLATFORMS: readonly string[] = ["linux"];

/** `android` is checked first: Android user agents also say Linux. */
export function platformName(ua: string): string {
  return /Android/i.test(ua) ? "android" : /Mac OS X|Macintosh|iPhone|iPad/i.test(ua) ? "mac" : /Linux|X11/i.test(ua) ? "linux" : "other";
}

export function liveAreaApps(platform: string, proven: readonly string[] = LIVE_AREA_PLATFORMS): boolean {
  return proven.includes(platform);
}
