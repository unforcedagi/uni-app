import { useSyncExternalStore } from "react";
import type { SuggestionStore } from "./suggestions";

/**
 * Host-rendered, outside the frame. An interface can only *suggest*; the
 * pending suggestions land here, and only a tap on these buttons acts. The
 * frame cannot reach this UI: it lives in another document. The bar shows the
 * WHOLE text that "Add to draft" inserts (already cleaned and capped by the
 * store), in a scrollable block, so consent covers everything that is added.
 */
export default function SuggestionBar({ store, appName, roomName }: { store: SuggestionStore; appName: string; roomName: (id: string) => string }) {
  const items = useSyncExternalStore(store.subscribe, store.list, store.list);
  if (!items.length) return null;
  return <div className="suggestion-bar" role="region" aria-label={`Suggestions from ${appName}`}>
    {items.map((s) => <div className="suggestion" key={s.id}>
      <div className="suggestion-text">{s.kind === "draft"
        ? <><span><strong>{appName}</strong> suggests a draft for <strong>#{roomName(s.room)}</strong>:</span><blockquote className="suggestion-draft" tabIndex={0} aria-label="Draft text">{s.text}</blockquote></>
        : <span><strong>{appName}</strong> suggests opening <strong className="suggestion-ref">{s.ref}</strong></span>}</div>
      <div className="suggestion-actions">
        <button className="suggestion-go" onClick={(e) => { if (e.isTrusted) store.accept(s.id); }}>{s.kind === "draft" ? "Add to draft" : "Open"}</button>
        <button className="pairing-secondary" onClick={(e) => { if (e.isTrusted) store.dismiss(s.id); }}>Dismiss</button>
      </div>
    </div>)}
  </div>;
}
