import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

type Step = "unlock" | "waiting" | "code" | "sending" | "done" | "error";

export default function PairSource({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<Step>("unlock");
  const [qr, setQr] = useState("");
  const [sas, setSas] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [seconds, setSeconds] = useState(120);
  const session = useRef("");
  const link = useRef("");
  const finished = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    // A separate generation for every mount also handles React StrictMode cleanup.
    const id = crypto.randomUUID();
    session.current = id;
    finished.current = false;
    let active = true;
    let ticker: ReturnType<typeof setInterval> | undefined;
    dialog.current?.showModal();
    const cancel = () => invoke("pair_source_cancel", { sessionId: id, codesDiffer: false }).catch(() => {});
    void (async () => {
      try {
        // StrictMode can mount/clean up synchronously; do not open a native prompt for that discarded mount.
        await Promise.resolve();
        if (!active) return;
        const started = await invoke<{ uri: string; qr_svg: string; expires_in_ms: number }>("pair_source_start", { sessionId: id });
        if (!active) { await cancel(); return; }
        link.current = started.uri;
        setQr(started.qr_svg);
        setStep("waiting");
        const expires = Date.now() + started.expires_in_ms;
        ticker = setInterval(() => {
          if (finished.current) return;
          const left = Math.max(0, Math.ceil((expires - Date.now()) / 1000));
          setSeconds(left);
          if (left === 0) {
            finished.current = true;
            link.current = "";
            setQr("");
            setError("Pairing expired after 120 seconds. Close and start again to unlock a new session.");
            setStep("error");
            void cancel();
          }
        }, 250);
        const offer = await invoke<{ sas: string }>("pair_source_wait_offer", { sessionId: id });
        if (active && !finished.current) {
          link.current = "";
          setQr("");
          setSas(offer.sas);
          setStep("code");
        }
      } catch (e) {
        if (active && !finished.current) {
          finished.current = true;
          link.current = "";
          setQr("");
          setError(String(e));
          setStep("error");
        }
      }
    })();
    return () => {
      active = false;
      clearInterval(ticker);
      link.current = "";
      void cancel();
    };
  }, []);

  async function cancel(codesDiffer = false) {
    finished.current = true;
    link.current = "";
    setQr("");
    await invoke("pair_source_cancel", { sessionId: session.current, codesDiffer }).catch(() => {});
    if (codesDiffer) { setError("Codes did not match — pairing cancelled. Close and start again."); setStep("error"); }
    else onClose();
  }
  async function confirm() {
    setStep("sending");
    const id = session.current;
    try {
      await invoke("pair_source_confirm", { sessionId: id });
      if (!finished.current && session.current === id) { finished.current = true; setStep("done"); }
    } catch (e) {
      if (!finished.current && session.current === id) { finished.current = true; setError(String(e)); setStep("error"); }
    }
  }
  async function copy() {
    try { await writeText(link.current); setCopied(true); }
    catch { setError("Could not copy the link. Scan the QR code instead."); }
  }

  return <dialog ref={dialog} className="pair-source" aria-labelledby="pair-source-title" onCancel={(e) => { e.preventDefault(); void cancel(); }}>
    <h2 id="pair-source-title">Pair a device</h2>
    {step === "unlock" && <p role="status">Unlock your device to continue…</p>}
    {step === "waiting" && <>
      <p>On the other device, open Uni → Pair, scan this code or paste the link.</p>
      <img className="pair-source-qr" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr)}`} alt="Pairing QR code" />
      <button className="pairing-secondary" onClick={() => void copy()}>{copied ? "Link copied" : "Copy link"}</button>
      <p className="pairing-note">This link contains a session secret. Share it only with the device you are pairing.</p>
      <p role="status">Waiting for the other device…</p>
    </>}
    {step === "code" && <>
      <p>Does the other device show this code?</p>
      <p className="sas" aria-label={`Code ${sas.split("").join(" ")}`}>{sas.slice(0, 3)} {sas.slice(3)}</p>
      <p>Compare all six digits, then confirm on both devices.</p>
      <div className="pairing-actions">
        <button className="send pairing-primary" onClick={() => void confirm()}>Codes match</button>
        <button className="pairing-secondary" onClick={() => void cancel(true)}>They're different</button>
      </div>
    </>}
    {step === "sending" && <p role="status">Sending… Confirm the code on the other device too.</p>}
    {step === "done" && <p role="status">Paired ✓</p>}
    {["waiting", "code", "sending"].includes(step) && <p>Expires in {seconds} seconds</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <button className="pairing-secondary" onClick={() => void cancel()}>{step === "done" || step === "error" ? "Close" : "Cancel"}</button>
  </dialog>;
}

export function PairDeviceButton({ onOpen }: { onOpen: () => void }) {
  const [available, setAvailable] = useState(false);
  useEffect(() => { void invoke<boolean>("pair_source_available").then(setAvailable).catch(() => {}); }, []);
  return <>
    <button className="pairing-secondary" disabled={!available} onClick={onOpen} aria-describedby={!available ? "pair-unavailable" : undefined}>Pair a device</button>
    {!available && <p id="pair-unavailable" className="pairing-note">Pairing from this device requires native device unlock, available on macOS and Android.</p>}
  </>;
}
