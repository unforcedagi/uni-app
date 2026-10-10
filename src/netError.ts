// Rust upload and publish failures arrive as strings; preserve unrelated errors.
export function isNetworkError(error: unknown): boolean {
  return /\b(?:error sending request|dns error|failed to lookup address|connection refused|connection reset|timed out|network is unreachable)\b/i.test(String(error));
}

export function netError(error: unknown): string {
  return isNetworkError(error)
    ? "Can't reach Buzz. Is Tailscale on? Your voice note is saved and will send when you're back online."
    : String(error);
}
