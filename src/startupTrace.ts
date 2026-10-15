// r25 (Codex 8): where a cold start's time goes, in milliseconds from the page's start: who we are, when rooms are known, when messages are
// first drawn (from the saved copy, or from the local store), when the composer is usable, and when the background sync starts and ends.
// `window.__uniStartup` holds the marks; the walk reads it. Each mark is taken once.
export type StartupMark = "identity" | "roomsCached" | "rooms" | "messagesCached" | "messages" | "composer" | "syncStart" | "syncDone";
export function mark(name: StartupMark): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as { __uniStartup?: Partial<Record<StartupMark, number>> };
  const m = (w.__uniStartup ??= {});
  if (m[name] === undefined) m[name] = Math.round(performance.now());
}
