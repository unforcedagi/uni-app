import { useSyncExternalStore } from "react";
import type { SuggestionStore } from "./suggestions";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Host-rendered, outside the frame. An interface can only *suggest*; the
 * pending suggestions land here, and only a tap on these buttons acts. The
 * frame cannot reach this UI: it lives in another document.
 */
export default function SuggestionBar({ store, appName, roomName }: { store: SuggestionStore; appName: string; roomName: (id: string) => string }) {
  const items = useSyncExternalStore(store.subscribe, store.list, store.list);
  if (!items.length) return null;
  return <div className="suggestion-bar" role="region" aria-label={`Suggestions from ${appName}`}>
    {items.map((s) => <div className="suggestion" key={s.id}>
      <p className="suggestion-text">{s.kind === "draft"
        ? <><strong>{appName}</strong> suggests a draft for <strong>#{roomName(s.room)}</strong>: <q>{clip(s.text, 280)}</q></>
        : <><strong>{appName}</strong> suggests opening <strong>{clip(s.ref, 120)}</strong></>}</p>
      <div className="suggestion-actions">
        <button className="suggestion-go" onClick={(e) => { if (e.isTrusted) store.accept(s.id); }}>{s.kind === "draft" ? "Add to draft" : "Open"}</button>
        <button className="pairing-secondary" onClick={(e) => { if (e.isTrusted) store.dismiss(s.id); }}>Dismiss</button>
      </div>
    </div>)}
  </div>;
}
