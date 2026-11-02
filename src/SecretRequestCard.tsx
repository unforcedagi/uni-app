import { useEffect, useId, useState } from "react";
import { flushSync } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { DoneCard, PendingCard, QuietCard } from "./CompactCard";
import { EyeIcon, EyeOffIcon } from "./Icons";
import { fingerprint, type SecretReceipt, type SecretRequest } from "./secretRequest";

// T-176: Uni's request for a secret, as a card with a masked field. The value goes only to the `send_secret`
// command (Rust seals it to the request's one-time key and publishes a gift wrap); it is cleared from React
// state as soon as Send is pressed and never rendered, logged or put in a chat message.
// What the card shows and who it says signed it come from `secret_request`, which re-verifies the request's signed
// event in Rust (once per card); whether that signer is trusted is checked against the pinned keys. A request that
// doesn't verify gets no field and no Trust button. Trust is offered only while no key is pinned: once one is, a request
// signed by any other key (a member who calls itself "Uni") gets a warning, not a button. `send_secret` re-checks both
// in Rust, and `secret_pin` refuses a second key.
// T-335: the eye button shows what was typed, to check it. It starts hidden and hides again on Send and when the app goes
// to the background or the window loses focus. Only the same input's type flips (never a remount): Chromium on Android then tells the keyboard it's a
// visible password (TYPE_TEXT_VARIATION_VISIBLE_PASSWORD), so suggestions and learning stay off while it's shown.

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

  if (!verified) return <QuietCard className="secret-card" label="Secret request (unverified)" icon="🔐" title="Secret request"
    status={unverified ? `Can't answer: ${unverified}` : "Checking who signed this request…"} warn={!!unverified} />;

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

  const facts = <>
    {request.purpose && <p className="secret-purpose">{request.purpose}</p>}
    <dl className="secret-facts">
      <dt>Kept</dt><dd><code>{request.store}</code> on uni, {request.keep_days} days</dd>
      <dt>Sealed to</dt><dd>{authorName} · <code>{fingerprint(author)}</code></dd>
    </dl>
    <p className="secret-note">Never goes into chat: it's sealed on this device and only {authorName}'s store can open it.</p>
  </>;
  const label = `Secret request: ${request.label}`;
  const errorLine = error && <p className="secret-status warn" role="alert">{error}</p>;

  // T-335: answered (stored, forgotten, refused) or expired: one line that opens to the facts
  if (receipt) {
    const forgetting = receipt.state === "stored" && trusted && phase !== "forget-sent"
      && <button type="button" className="secret-forget" onClick={() => void forget()} disabled={phase === "forgetting"}>Ask {authorName} to forget it</button>;
    const [mark, status, when] = receipt.state === "stored" ? ["🔒", "Stored", receipt.until ? `until ${day(receipt.until)}` : null]
      : receipt.state === "forgotten" ? ["🗑️", "Forgotten", null] : ["⚠️", `Not kept: ${receipt.reason ?? "refused"}`, null];
    const said = receipt.state === "stored" ? <p className="secret-status ok">Stored as <code>{request.name}</code>{receipt.until ? <> until {day(receipt.until)}</> : null}. {authorName} only sees the name.</p>
      : receipt.state === "forgotten" ? <p className="secret-status">{authorName} deleted it.</p>
      : <p className="secret-status warn">Not kept: {receipt.reason ?? "refused"}</p>;
    return <DoneCard className="secret-card" label={label} mark={mark} status={status} what={request.label} when={when}
      details={<>{said}{facts}{forgetting}</>}
      after={<>{phase === "forget-sent" && receipt.state !== "forgotten" && <p className="secret-status">Asked {authorName} to forget it…</p>}{errorLine}</>} />;
  }
  if (expired && phase !== "sent") return <DoneCard className="secret-card" label={label} mark="⌛" status="Expired" what={request.label}
    when={null} details={<><p className="secret-status warn">This request has expired. Ask {authorName} for a new one.</p>{facts}</>} after={errorLine} />;

  return <PendingCard className="secret-card" label={label} icon="🔐" what={request.label}
    meta={<>kept as <code>{request.store}</code>, {request.keep_days} days · </>}
    below={<>
      {phase === "sent"
        ? <p className="secret-status" role="status">Sealed and sent to {authorName}. Waiting for {authorName} to confirm…</p>
        : !trusted
          ? pins.length === 0
            ? <div className="secret-trust">
                <p>The app hasn't been told to trust this key for secrets. Check the fingerprint with {authorName} first.</p>
                <button type="button" className="pairing-secondary" onClick={onTrust}>Trust {authorName} ({fingerprint(author)})</button>
              </div>
            : <p className="secret-status warn" role="status">This isn't the key you trust for secrets, whatever its name says. Don't
                answer it here. Only the key you trusted before may ask; another one goes in the app's secret-requesters file by hand.</p>
          : <SecretForm label={request.label} value={value} setValue={setValue} sending={phase === "sending"} onSend={() => void send()} />}
      {errorLine}
    </>}
    details={facts} />;
}

// T-335: the field and its eye. `shown` lives here, so it goes with the form whenever the card stops offering it.
function SecretForm({ label, value, setValue, sending, onSend }: { label: string; value: string; setValue: (v: string) => void; sending: boolean; onSend: () => void }) {
  const [shown, setShown] = useState(false);
  const fieldId = useId();
  useEffect(() => {
    if (!shown) return;
    const hide = () => flushSync(() => setShown(false)); // re-masked before the page is snapshotted or left
    const away = () => { if (document.visibilityState === "hidden") hide(); };
    document.addEventListener("visibilitychange", away);
    window.addEventListener("pagehide", hide);
    window.addEventListener("blur", hide);
    return () => { document.removeEventListener("visibilitychange", away); window.removeEventListener("pagehide", hide); window.removeEventListener("blur", hide); };
  }, [shown]);
  return <form className="secret-form" onSubmit={(e) => { e.preventDefault(); if (value) { setShown(false); onSend(); } }}>
    <span className="secret-field">
      <input id={fieldId} type={shown ? "text" : "password"} aria-label={`Value for ${label}`} placeholder="Paste or type it here" value={value}
        onChange={(e) => setValue(e.target.value)} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        data-1p-ignore="" data-lpignore="true" disabled={sending} />
      <button type="button" className="secret-reveal" aria-label="Show what you typed" aria-pressed={shown} aria-controls={fieldId}
        disabled={sending} onPointerDown={(e) => e.preventDefault()} onClick={() => setShown((v) => !v)}>
        {shown ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </span>
    <button type="submit" disabled={!value || sending}>{sending ? "Sealing…" : "Send sealed"}</button>
  </form>;
}
