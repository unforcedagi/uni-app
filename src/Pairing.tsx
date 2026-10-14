import { pairingFailure } from "./pairingCore";
import { VoiceOutbox } from "./voiceOutbox";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type PairStep = "scanning" | "paste" | "connecting" | "code" | "receiving" | "done";

export default function Pairing({ onPaired }: { onPaired: (pubkey: string) => void }) {
  const [link, setLink] = useState("");
  const [step, setStep] = useState<PairStep>("paste");
  const [sas, setSas] = useState("");
  const [error, setErrorText] = useState<string | null>(null);
  /** r22 (Codex 5): the raw error, under Details; the line says what happened in words */
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const setError = (e: string | null, detail: string | null = null) => { setErrorText(e); setErrorDetail(detail); };
  const failed = (stage: "scan" | "start" | "confirm", e: unknown) => { const raw = e instanceof Error ? e.message : String(e); setError(pairingFailure(stage, raw), raw); };

  const isAndroid = /Android/i.test(navigator.userAgent);
  const scanning = useRef(false);
  useEffect(() => () => {
    if (scanning.current) void import("@tauri-apps/plugin-barcode-scanner").then((scanner) => scanner.cancel()).catch(() => {});
  }, []);
  async function scanQr() {
    setError(null);
    setStep("scanning");
    scanning.current = true;
    try {
      const scanner = await import("@tauri-apps/plugin-barcode-scanner");
      const permission = await scanner.checkPermissions();
      if (permission !== "granted" && await scanner.requestPermissions() !== "granted") {
        throw new Error("Camera permission denied. Allow Camera in Android Settings to scan, or paste a pairing link below.");
      }
      const result = await scanner.scan({ formats: [scanner.Format.QRCode], windowed: false });
      const uri = result.content.trim();
      if (!uri.startsWith("nostrpair://")) throw new Error("This QR code is not a Uni/Buzz pairing link.");
      setLink(uri);
      await start(uri);
    } catch (e) { failed("scan", e); setStep("paste"); }
    finally { scanning.current = false; }
  }

  async function start(uri = link.trim()) {
    setError(null);
    setStep("connecting");
    try {
      await new VoiceOutbox(() => {}).clear();
      const r = await invoke<{ sas: string }>("pairing_start", { uri });
      setSas(r.sas);
      setStep("code");
    } catch (e) { failed("start", e); setStep("paste"); }
  }
  async function confirm() {
    setError(null);
    setStep("receiving");
    try {
      const r = await invoke<{ pubkey: string }>("pairing_confirm");
      setLink("");
      setStep("done");
      onPaired(r.pubkey);
    } catch (e) { failed("confirm", e); setStep("paste"); }
  }
  async function cancel(codesDiffer: boolean) {
    try { await invoke("pairing_cancel", { codesDiffer }); } catch { /* best effort */ }
    setSas("");
    setStep("paste");
    if (codesDiffer) setError("Codes did not match — pairing cancelled. Start a new pairing on the other device.");
  }

  return <main className="pairing">
    <div className="pairing-card">
      <h1>Sign in to Uni from a device you already use</h1>
      <p className="pairing-note">Uni signs this device in with the key from one where you are signed in already. Nothing to type but a link.</p>
      {step === "scanning" && <p role="status">Scanning QR code…</p>}
      {(step === "paste" || step === "connecting") && <>
        <ol className="pairing-steps">
          <li>On the other device, open Uni → Settings → <strong>Pair a device</strong>.</li>
          <li>Scan the QR code it shows, or copy its link and paste it here.</li>
          <li>Tap Start, then compare the 6-digit codes.</li>
        </ol>
        {isAndroid && <button className="pairing-secondary" disabled={step === "connecting"} onClick={() => void scanQr()}>Scan QR code</button>}
        <label className="pairing-label">Pairing link
          <textarea value={link} onChange={(e) => setLink(e.target.value)} rows={4} spellCheck={false} autoCapitalize="off" autoCorrect="off" placeholder="Paste the link from the other device" disabled={step === "connecting"} />
        </label>
        <button className="send pairing-primary" disabled={!link.trim().startsWith("nostrpair://") || step === "connecting"} onClick={() => void start()}>{step === "connecting" ? "Connecting…" : "Start"}</button>
      </>}
      {(step === "code" || step === "receiving") && <>
        <p>Does the other device show this code?</p>
        <p className="sas" aria-label={`Code ${sas.split("").join(" ")}`}>{sas.slice(0, 3)} {sas.slice(3)}</p>
        <p className="pairing-note">Only continue if the codes are identical. Then confirm on the other device too.</p>
        <div className="pairing-actions">
          <button className="send pairing-primary" disabled={step === "receiving"} onClick={() => void confirm()}>{step === "receiving" ? "Waiting for the other device…" : "Codes match"}</button>
          {step === "code" && <button className="pairing-secondary" onClick={() => void cancel(true)}>They're different</button>}
          <button className="pairing-secondary" onClick={() => void cancel(false)}>Cancel</button>
        </div>
      </>}
      {step === "done" && <p>Paired. Loading your conversations…</p>}
      {error && <div className="error" role="alert"><p>{error}</p>{errorDetail && errorDetail !== error && <details className="pairing-detail"><summary>Details</summary><p>{errorDetail}</p></details>}</div>}
      <details className="pairing-help"><summary>More about signing in</summary>
        <p className="pairing-note">Your key is sent encrypted, end to end, and kept in this device's secure storage.</p>
        <p className="pairing-note">Buzz desktop can sign this device in too: its Settings → Pair mobile device.</p>
      </details>
    </div>
  </main>;
}
