// T-124 r22 (Codex 5): what a failed pairing step says, in words (pure, tested in scripts/simpleR22.test.ts).
/**
 * What a failed pairing step says (r22, Codex 5): plain words and the way on; the raw error goes under Details. A message written for people
 * (the camera permission, a QR code that isn't a pairing link) is kept as it is.
 */
export function pairingFailure(stage: "scan" | "start" | "confirm", raw: string): string {
  if (/^(Camera permission denied|This QR code is not)/.test(raw)) return raw;
  if (/cancel/i.test(raw)) return "Pairing was cancelled. Start a new pairing on the other device, then paste its link again.";
  if (/time(d)?\s?out|timeout|expired/i.test(raw)) return "The other device didn't answer in time. Start a new pairing on it, then paste its new link.";
  if (/invalid|parse|malformed|uri|url/i.test(raw) && stage === "start") return "That link couldn't be read. Copy the whole link from the other device again and paste it here.";
  if (stage === "scan") return "Couldn't scan the code. Paste the pairing link below instead.";
  if (stage === "confirm") return "This device wasn't signed in: the key didn't arrive. Start a new pairing on the other device and try again.";
  return "Couldn't reach the other device. Check that both are online, start a new pairing there, then paste its link again.";
}
