import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fingerprint, type SecretReceipt, type SecretRequest } from "./secretRequest";

// T-176: Uni's request for a secret, as a card with a masked field. The value goes only to the `send_secret`
// command (Rust seals it to the request's one-time key and publishes a gift wrap); it is cleared from React
// state as soon as Send is pressed and never rendered, logged or put in a chat message.
// What the card shows and who it says signed it come from `secret_request`, which re-verifies the request's signed
// event in Rust (once per card); whether that signer is trusted is checked against the pinned keys. A request that
// doesn't verify gets no field and no Trust button. `send_secret` re-checks both in Rust.

type Props = {
  channel: string; requestRef: string; authorName: string; receipts: (author: string, rid: string) => SecretReceipt | undefined;
  pins: string[]; onTrust: () => void;
};
type Verified = { author: string; request: SecretRequest };

const day = (s: number) => new Date(s * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

export function SecretRequestCard({ channel, requestRef, authorName, receipts, pins, onTrust }: Props) {
  const [verified, setVerified] = useState<Verified | null>(null);
  const [unverified, setUnverified] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [phase, setPhase] = useState<"idle" | "sending" | "sent" | "forgetting" | "forget-sent">("idle");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    invoke<Verified>("secret_request", { channel, request: requestRef })
      .then((v) => { if (live) { setVerified(v); setUnverified(null); } })
      .catch((e) => { if (live) { setVerified(null); setUnverified(typeof e === "string" ? e : "this request can't be verified"); } });
    return () => { live = false; };
  }, [channel, requestRef]);

  if (!verified) return <section className="secret-card" aria-label="Secret request (unverified)">
    <header><span aria-hidden="true">🔐</span> <strong>Secret request</strong></header>
    <p className={`secret-status ${unverified ? "warn" : ""}`} role="status">{unverified ? `Can't answer: ${unverified}` : "Checking who signed this request…"}</p>
  </section>;

  const { author, request } = verified;
  const trusted = pins.includes(author);
  const receipt = receipts(author, request.rid);
  const expired = Date.now() / 1000 > request.expires;

  const send = async () => {
    const v = value;
    setValue("");
    setError(null);
    setPhase("sending");
    try {
      await invoke<string>("send_secret", { channel, request: requestRef, value: v });
      setPhase("sent");
    } catch (e) {
      setError(typeof e === "string" ? e : (e as Error)?.message ?? "could not send");
      setPhase("idle");
    }
  };
  const forget = async () => {
    setError(null);
    setPhase("forgetting");
    try {
      await invoke<string>("forget_secret", { channel, request: requestRef });
      setPhase("forget-sent");
    } catch (e) {
      setError(typeof e === "string" ? e : (e as Error)?.message ?? "could not send");
      setPhase("idle");
    }
  };

  const status = receipt?.state === "stored" ? <p className="secret-status ok" role="status">🔒 Stored as <code>{request.name}</code>{receipt.until ? <> until {day(receipt.until)}</> : null}. {authorName} only sees the name.</p>
    : receipt?.state === "forgotten" ? <p className="secret-status" role="status">🗑️ Forgotten: {authorName} deleted it.</p>
    : receipt?.state === "refused" ? <p className="secret-status warn" role="status">⚠️ Not kept: {receipt.reason ?? "refused"}</p>
    : phase === "sent" ? <p className="secret-status" role="status">Sealed and sent to {authorName}. Waiting for {authorName} to confirm…</p>
    : null;

  return <section className="secret-card" aria-label={`Secret request: ${request.label}`}>
    <header><span aria-hidden="true">🔐</span> <strong>{request.label}</strong></header>
    {request.purpose && <p className="secret-purpose">{request.purpose}</p>}
    <dl className="secret-facts">
      <dt>Kept</dt><dd><code>{request.store}</code> on uni, {request.keep_days} days</dd>
      <dt>Sealed to</dt><dd>{authorName} · <code>{fingerprint(author)}</code></dd>
    </dl>
    {status}
    {!receipt && phase !== "sent" && (!trusted
      ? <div className="secret-trust">
          <p>The app hasn't been told to trust this key for secrets. Check the fingerprint with {authorName} first.</p>
          <button type="button" className="pairing-secondary" onClick={onTrust}>Trust {authorName} ({fingerprint(author)})</button>
        </div>
      : expired
        ? <p className="secret-status warn">This request has expired. Ask {authorName} for a new one.</p>
        : <form className="secret-form" onSubmit={(e) => { e.preventDefault(); if (value) void send(); }}>
            <input type="password" aria-label={`Value for ${request.label}`} placeholder="Paste or type it here" value={value}
              onChange={(e) => setValue(e.target.value)} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
              data-1p-ignore="" data-lpignore="true" disabled={phase === "sending"} />
            <button type="submit" disabled={!value || phase === "sending"}>{phase === "sending" ? "Sealing…" : "Send sealed"}</button>
          </form>)}
    {receipt?.state === "stored" && trusted && phase !== "forget-sent" &&
      <button type="button" className="secret-forget" onClick={() => void forget()} disabled={phase === "forgetting"}>Ask {authorName} to forget it</button>}
    {phase === "forget-sent" && receipt?.state !== "forgotten" && <p className="secret-status">Asked {authorName} to forget it…</p>}
    {error && <p className="secret-status warn" role="alert">{error}</p>}
    <p className="secret-note">Never goes into chat: it's sealed on this device and only {authorName}'s store can open it.</p>
  </section>;
}
