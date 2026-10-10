// Zero-based failed attempt: cap retries at five minutes while the app is open.
export function voiceRetryDelay(attempt: number): number {
  return [15_000, 30_000, 60_000, 120_000, 300_000][Math.min(Math.max(0, attempt), 4)];
}
