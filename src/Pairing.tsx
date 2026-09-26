import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type PairStep = "paste" | "connecting" | "code" | "receiving" | "done";

export default function Pairing({ onPaired }: { onPaired: (pubkey: string) => void }) {
  const [link, setLink] = useState("");
  const [step, setStep] = useState<PairStep>("paste");
  const [sas, setSas] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setError(null);
    setStep("connecting");
    try {
      const r = await invoke<{ sas: string }>("pairing_start", { uri: link.trim() });
      setSas(r.sas);
      setStep("code");
    } catch (e) { setError(String(e)); setStep("paste"); }
  }
  async function confirm() {
    setError(null);
    setStep("receiving");
    try {
      const r = await invoke<{ pubkey: string }>("pairing_confirm");
      setLink("");
      setStep("done");
      onPaired(r.pubkey);
    } catch (e) { setError(String(e)); setStep("paste"); }
  }
  async function cancel(codesDiffer: boolean) {
    try { await invoke("pairing_cancel", { codesDiffer }); } catch { /* best effort */ }
    setSas("");
    setStep("paste");
    if (codesDiffer) setError("Codes did not match — pairing cancelled. Start a new pairing in Buzz.");
  }

  return <main className="pairing">
    <div className="pairing-card">
      <span className="eyebrow">Unforced</span>
      <h1>Pair with Buzz desktop</h1>
      {(step === "paste" || step === "connecting") && <>
        <ol className="pairing-steps">
          <li>On your computer, open Buzz → Settings → <strong>Pair mobile device</strong>.</li>
          <li>Click <strong>Copy</strong> and get the link to this device (paste it here).</li>
          <li>Tap Start, then compare the 6-digit codes.</li>
        </ol>
        <label className="pairing-label">Pairing link
          <textarea value={link} onChange={(e) => setLink(e.target.value)} rows={4} spellCheck={false} autoCapitalize="off" autoCorrect="off" placeholder="nostrpair://…" disabled={step === "connecting"} />
        </label>
        <button className="send pairing-primary" disabled={!link.trim().startsWith("nostrpair://") || step === "connecting"} onClick={() => void start()}>{step === "connecting" ? "Connecting…" : "Start"}</button>
      </>}
      {(step === "code" || step === "receiving") && <>
        <p>Does Buzz desktop show this code?</p>
        <p className="sas" aria-label={`Code ${sas.split("").join(" ")}`}>{sas.slice(0, 3)} {sas.slice(3)}</p>
        <p className="pairing-note">Only continue if the codes are identical. Then confirm on Buzz desktop too.</p>
        <div className="pairing-actions">
          <button className="send pairing-primary" disabled={step === "receiving"} onClick={() => void confirm()}>{step === "receiving" ? "Waiting for Buzz desktop…" : "Codes match"}</button>
          <button className="pairing-secondary" onClick={() => void cancel(step === "code")}>Cancel</button>
        </div>
      </>}
      {step === "done" && <p>Paired. Loading your conversations…</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <p className="pairing-note">Your key is sent encrypted, end to end, and stored in this device's secure keystore.</p>
    </div>
  </main>;
}
