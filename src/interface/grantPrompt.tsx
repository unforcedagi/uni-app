import type { NeedLine } from "./manifest";

/**
 * Host-rendered first-open request. Every sentence is the host's. The only text
 * that comes from the note is the applet's name, shown quoted and marked as
 * unverified (it is the note's own claim, not a statement the host checked).
 * Nothing runs until [Allow].
 */
/** Host-rendered line for approved-code mode when the applet's HTML changed since it was allowed. */
export const CODE_CHANGED_LINE = "This applet's code changed since you allowed it. On this device applets can reach the network through WebRTC, so only code you've approved runs.";

/** Host-rendered replacement for the sealed / no-internet sentences when WebRTC is present. */
export const APPROVED_CODE_LINE = "On this device applets can reach the network through WebRTC, so this applet is only as safe as its code. Allow it only if you trust it.";

export default function GrantPrompt({ name, lines, updated, codeChanged, approvedCode, onAllow, onNotNow }: { name: string; lines: NeedLine[]; updated?: boolean; codeChanged?: boolean; approvedCode?: boolean; onAllow: () => void; onNotNow: () => void }) {
  return <section className="grant-prompt" role="region" aria-label={`${name} is asking for access`}>
    <h2>An applet wants to run</h2>
    {codeChanged && <p className="area-quiet grant-changed" role="status"><strong>{CODE_CHANGED_LINE}</strong></p>}
    <p className="area-quiet">{updated ? "It asks for different access than before. " : ""}The applet <q data-untrusted="true" className="grant-name">{name}</q> (a name taken from its note, not verified) would run {approvedCode ? "inside Uni" : "in a sealed frame"}. It would be able to:</p>
    <ul>{lines.map((l) => <li key={l.text} className={l.outside ? "grant-outside" : undefined}>{l.outside ? <strong>{l.text}</strong> : l.text}</li>)}</ul>
    {approvedCode
      ? <p className="area-quiet grant-network" role="status"><strong>{APPROVED_CODE_LINE}</strong> It can't send chat messages or change notes. It runs inside Uni, so a faulty applet can freeze it; you can stop or revoke it from the bar above it.</p>
      : <p className="area-quiet">It can't send messages, change notes or reach the internet. It runs inside Uni, so a faulty applet can freeze it; you can stop or revoke it from the bar above it.</p>}
    <div className="area-actions">
      <button className="suggestion-go" onClick={(e) => { if (e.isTrusted) onAllow(); }}>{codeChanged ? "Allow this version" : "Allow"}</button>
      <button className="pairing-secondary" onClick={(e) => { if (e.isTrusted) onNotNow(); }}>Not now</button>
    </div>
  </section>;
}
