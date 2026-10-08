/** Host-rendered first-open request: what the app needs, in plain words. Nothing runs until [Allow]. */
export default function GrantPrompt({ name, lines, onAllow, onNotNow }: { name: string; lines: string[]; onAllow: () => void; onNotNow: () => void }) {
  return <section className="grant-prompt" role="region" aria-label={`${name} is asking for access`}>
    <h2>{name} wants to run its app</h2>
    <p className="area-quiet">It runs in a sealed frame. It would be able to:</p>
    <ul>{lines.map((l) => <li key={l}>{l}</li>)}</ul>
    <p className="area-quiet">It can't send messages, change notes or reach the internet.</p>
    <div className="area-actions">
      <button className="suggestion-go" onClick={(e) => { if (e.isTrusted) onAllow(); }}>Allow</button>
      <button className="pairing-secondary" onClick={(e) => { if (e.isTrusted) onNotNow(); }}>Not now</button>
    </div>
  </section>;
}
