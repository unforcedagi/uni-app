// Update-check state (pure, unit-tested). The banner and the Settings button
// share one store built on these (see UpdateNotice.tsx).

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "downloading"; received: number; total: number | null }
  | { kind: "ready"; version: string | null }
  | { kind: "available"; version: string; url: string }
  | { kind: "error"; message: string };

/** Same shape as @tauri-apps/plugin-updater's DownloadEvent. */
export type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

// Only stable numeric versions from our publisher are compared; no prerelease ordering.
export function newerVersion(latest: string, current: string): boolean {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : null;
  const a = parse(latest), b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}

/** Fold one download event into the downloading state. */
export function onDownloadEvent(s: UpdateState, e: DownloadEvent): UpdateState {
  const cur = s.kind === "downloading" ? s : { kind: "downloading" as const, received: 0, total: null };
  if (e.event === "Started") return { kind: "downloading", received: 0, total: e.data.contentLength && e.data.contentLength > 0 ? e.data.contentLength : null };
  if (e.event === "Progress") return { ...cur, received: cur.received + e.data.chunkLength };
  return cur.total ? { ...cur, received: cur.total } : cur;
}

/** Whole percent (0–100), or null when the size is unknown. */
export function downloadPercent(s: UpdateState): number | null {
  if (s.kind !== "downloading" || !s.total) return null;
  return Math.max(0, Math.min(100, Math.floor((s.received / s.total) * 100)));
}

/** A check is already running or downloading: don't start another. */
export function isBusy(s: UpdateState): boolean {
  return s.kind === "checking" || s.kind === "downloading";
}

/** Nothing more to check for until the user restarts / installs. */
export function isSettled(s: UpdateState): boolean {
  return s.kind === "ready";
}

/** Status text for Settings. */
export function updateLabel(s: UpdateState): string {
  switch (s.kind) {
    case "idle": return "";
    case "checking": return "Checking…";
    case "current": return "Up to date";
    case "downloading": { const p = downloadPercent(s); return p === null ? "Downloading…" : `Downloading… ${p}%`; }
    case "ready": return s.version ? `Update ${s.version} ready` : "Update ready";
    case "available": return `Update ${s.version} available`;
    case "error": return `Update check failed: ${s.message}`;
  }
}
