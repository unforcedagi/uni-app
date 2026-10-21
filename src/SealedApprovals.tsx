import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { copyText } from "./clipboard";
import { fingerprint } from "./secretRequest";
import { enrollError, shortId, type EnrollmentRecord, type SealedStatus } from "./sealedApprovals";

// T-234 Settings → Approvals. One confirm, then Rust signs and posts the enrollment (`sealed_enroll`); the sealing
// key stays in Rust. A failure says so and offers Try again; Rust first looks for the earlier signed event on the
// relay (its OK may have been lost), so a retry never posts a second one. Enable can't run twice at once (here and in
// Rust), and once enrolled there is no Enable button, only the record.

const day = (s: number) => new Date(s * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

export function SealedApprovals() {
  const [st, setSt] = useState<SealedStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "confirm" | "enabling" | "failed">("idle");
  const [room, setRoom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const load = useCallback(() => {
    setLoadError(null);
    invoke<SealedStatus>("sealed_status")
      .then((s) => { setSt(s); setRoom((r) => (s.rooms.some((x) => x.id === r) ? r : s.rooms[0]?.id ?? "")); })
      .catch((e) => setLoadError(enrollError(e)));
  }, []);
  useEffect(load, [load]);

  const enable = async () => {
    if (busy.current || !room) return;
    busy.current = true;
    setError(null);
    setPhase("enabling");
    try {
      const rec = await invoke<EnrollmentRecord>("sealed_enroll", { channel: room });
      setSt((s) => (s ? { ...s, enrolled: rec } : s));
      setPhase("idle");
    } catch (e) {
      setError(enrollError(e));
      setPhase("failed");
    } finally {
      busy.current = false;
    }
  };

  if (loadError) return <section className="approvals" aria-label="Approvals">
    <h2>Approvals</h2>
    <p className="secret-status warn" role="status">Couldn't check approvals: {loadError}</p>
    <button type="button" className="pairing-secondary" onClick={load}>Check again</button>
  </section>;
  if (!st) return <section className="approvals" aria-label="Approvals"><h2>Approvals</h2><p className="approvals-note">Checking…</p></section>;

  if (st.enrolled) {
    const r = st.enrolled;
    return <section className="approvals" aria-label="Approvals">
      <h2>Approvals</h2>
      <p className="secret-status ok" role="status"><span aria-hidden="true">🔑</span> Approvals for Uni are on, since {day(r.created_at)}.</p>
      <dl className="secret-facts">
        <dt>Uni</dt><dd><code>{fingerprint(r.uni)}</code></dd>
        <dt>Approvals key</dt><dd><code>{fingerprint(r.seal_pub)}</code></dd>
        <dt>Enrollment</dt><dd><code>{shortId(r.event_id)}</code> <button type="button" className="identity-copy" aria-label="Copy the enrollment event id" onClick={() => void copyText(r.event_id, "Copied enrollment id")}>⧉</button></dd>
      </dl>
    </section>;
  }

  const roomName = st.rooms.find((x) => x.id === room)?.name ?? "";
  const enabling = phase === "enabling";
  return <section className="approvals" aria-label="Approvals">
    <h2>Approvals</h2>
    {phase === "idle" && <>
      <p className="approvals-note">Uni can ask you here before it uses a locked credential, one job at a time.</p>
      {st.rooms.length
        ? <button type="button" className="pairing-secondary" onClick={() => setPhase("confirm")}>Enable approvals for Uni</button>
        : <><p className="secret-status warn" role="status">You and Uni don't share a room yet, so Uni couldn't read it. Join a room with Uni first.</p>
          <button type="button" className="pairing-secondary" onClick={load}>Check again</button></>}
    </>}
    {phase !== "idle" && <div className="approvals-confirm" role="group" aria-label="Enable approvals for Uni">
      <p className="approvals-title"><span aria-hidden="true">🔑</span> Enable approvals for Uni</p>
      <p className="approvals-note">Your key signs one message{roomName ? <> in <strong>{roomName}</strong></> : null} that tells Uni the public half of an
        approvals key made on this device. Uni seals credentials to it; only this device can open them, and only when you approve.
        The approvals key never leaves this device.</p>
      <dl className="secret-facts">
        <dt>For</dt><dd>Uni · <code>{fingerprint(st.uni)}</code></dd>
        <dt>Approvals key</dt><dd><code>{fingerprint(st.seal_pub)}</code></dd>
        {st.rooms.length > 1 && <><dt><label htmlFor="approvals-room">Posted in</label></dt><dd>
          <select id="approvals-room" value={room} disabled={enabling} onChange={(e) => setRoom(e.target.value)}>
            {st.rooms.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select></dd></>}
      </dl>
      {phase === "failed" && <p className="secret-status warn" role="alert">Not enabled yet: {error}. Trying again won't post it twice.</p>}
      <div className="approvals-actions">
        <button type="button" className="pairing-secondary" disabled={enabling} onClick={() => { setPhase("idle"); setError(null); }}>Cancel</button>
        <button type="button" className="approvals-enable" disabled={enabling || !room} onClick={() => void enable()}>
          {enabling ? "Enabling…" : phase === "failed" ? "Try again" : "Enable approvals"}</button>
      </div>
    </div>}
  </section>;
}

/** T-234: your own enrollment in the room, as a line. Drawn only when Rust has verified the kept signed event as an
 *  enrollment for the trusted Uni (`sealed_enrollment_line`); until then, and for anything else, the ordinary message. */
export function EnrollmentLine({ channel, reference, me, fallback }: { channel: string; reference: string; me: string | null; fallback: ReactNode }) {
  const [signer, setSigner] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    invoke<string | null>("sealed_enrollment_line", { channel, reference }).then((s) => { if (live) setSigner(s ?? null); }, () => {});
    return () => { live = false; };
  }, [channel, reference]);
  if (!signer || signer !== me) return <>{fallback}</>;
  return <p className="sealed-enrolled-line"><span aria-hidden="true">🔑</span> You enabled approvals for Uni</p>;
}
