import type { NeedLine } from "./manifest";

/**
 * Host-rendered first-open request. Every sentence is the host's. The only text
 * that comes from the note is the area name, shown quoted and marked as
 * unverified (it is the note's title, not a statement from the app).
 * Nothing runs until [Allow].
 */
/** Host-rendered line for approved-code mode when the app's HTML changed since it was allowed. */
export const CODE_CHANGED_LINE = "This app's code changed since you allowed it. On this device apps can reach the network through WebRTC, so only code you've approved runs.";

export default function GrantPrompt({ name, lines, updated, codeChanged, onAllow, onNotNow }: { name: string; lines: NeedLine[]; updated?: boolean; codeChanged?: boolean; onAllow: () => void; onNotNow: () => void }) {
  return <section className="grant-prompt" role="region" aria-label={`${name} is asking for access`}>
    <h2>An app wants to run</h2>
    {codeChanged && <p className="area-quiet grant-changed" role="status"><strong>{CODE_CHANGED_LINE}</strong></p>}
    <p className="area-quiet">{updated ? "It asks for different access than before. " : ""}The app in the area <q data-untrusted="true" className="grant-name">{name}</q> (a name taken from the note, not verified) would run in a sealed frame. It would be able to:</p>
    <ul>{lines.map((l) => <li key={l.text} className={l.outside ? "grant-outside" : undefined}>{l.outside ? <strong>{l.text}</strong> : l.text}</li>)}</ul>
    <p className="area-quiet">It can't send messages, change notes or reach the internet. It runs inside Uni, so a faulty app can freeze it; you can stop or revoke it from the bar above the app.</p>
    <div className="area-actions">
      <button className="suggestion-go" onClick={(e) => { if (e.isTrusted) onAllow(); }}>{codeChanged ? "Allow this version" : "Allow"}</button>
      <button className="pairing-secondary" onClick={(e) => { if (e.isTrusted) onNotNow(); }}>Not now</button>
    </div>
  </section>;
}
