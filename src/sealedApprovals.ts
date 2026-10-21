// T-234: approvals for Uni (sealed credentials). Settings → Approvals enables them once: Rust derives this device's
// sealing key from the identity key and posts a signed enrollment `{"v":1,"seal_pub","for"}` in a room Uni is in.
// The webview only ever sees public halves (`sealed_status`, `sealed_enroll`); it never names the Uni key either.

export type SealedRoom = { id: string; name: string; members: number };
export type EnrollmentRecord = { identity: string; uni: string; seal_pub: string; event_id: string; channel: string; created_at: number };
export type SealedStatus = { uni: string; seal_pub: string; rooms: SealedRoom[]; enrolled: EnrollmentRecord | null };

const hex64 = (s: unknown) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);

/** The enrollment message as it shows in the room: exactly the three fields, else null (an ordinary message). */
export function parseEnrollment(body: string): { seal_pub: string; for: string } | null {
  if (!body.startsWith("{")) return null;
  try {
    const v = JSON.parse(body);
    const keys = v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).sort().join(",") : "";
    return keys === "for,seal_pub,v" && v.v === 1 && hex64(v.seal_pub) && hex64(v.for) ? { seal_pub: v.seal_pub, for: v.for } : null;
  } catch { return null; }
}

/** "9b13 b2ae": an event id short enough to read out. */
export const shortId = (id: string): string => `${id.slice(0, 4)} ${id.slice(4, 8)}`;

/** What a failed `sealed_enroll` says, in words. */
export const enrollError = (e: unknown): string => {
  const s = typeof e === "string" ? e : (e as Error)?.message ?? "";
  return s.trim() || "it couldn't be posted";
};
