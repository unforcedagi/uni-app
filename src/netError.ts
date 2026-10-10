// Rust upload and publish failures arrive as strings; preserve unrelated errors.
export function netError(error: unknown): string {
  const text = String(error);
  return /error sending request|dns|connect|timed out|connection reset/i.test(text)
    ? "Can't reach Buzz. Is Tailscale on? Your voice note is saved and will send when you're back online."
    : text;
}
