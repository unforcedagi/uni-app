import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { SuggestionStore } from "./suggestions";

type Suggestion = ReturnType<SuggestionStore["list"]>[number];

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
    {items.map((s) => <SuggestionRow key={s.id} s={s} store={store} appName={appName} roomName={roomName} />)}
  </div>;
}

/**
 * One pending suggestion. A draft taller than the bar's block scrolls, and "Add to draft" stays disabled
 * until the block has been scrolled to its bottom (or fits without scrolling), so the text is read first.
 * Once read it stays read.
 */
function SuggestionRow({ s, store, appName, roomName }: { s: Suggestion; store: SuggestionStore; appName: string; roomName: (id: string) => string }) {
  const block = useRef<HTMLQuoteElement>(null);
  const [read, setRead] = useState(false);
  useLayoutEffect(() => {
    const el = block.current;
    if (!el) return;
    const check = () => { if (el.scrollHeight <= el.clientHeight + 1 || el.scrollTop + el.clientHeight >= el.scrollHeight - 1) setRead(true); };
    check();
    const resize = new ResizeObserver(check);
    resize.observe(el);
    el.addEventListener("scroll", check);
    return () => { resize.disconnect(); el.removeEventListener("scroll", check); };
  }, [s.id]);
  return <div className="suggestion">
    <div className="suggestion-text">{s.kind === "draft"
      ? <><span><strong>{appName}</strong> suggests a draft for <strong>#{roomName(s.room)}</strong>:</span><blockquote ref={block} className="suggestion-draft" tabIndex={0} aria-label="Draft text">{s.text}</blockquote></>
      : <span><strong>{appName}</strong> suggests opening <strong className="suggestion-ref">{s.ref}</strong></span>}</div>
    <div className="suggestion-actions">
      <button className="suggestion-go" disabled={s.kind === "draft" && !read} onClick={(e) => { if (e.isTrusted) store.accept(s.id); }}>{s.kind === "draft" ? "Add to draft" : "Open"}</button>
      <button className="pairing-secondary" onClick={(e) => { if (e.isTrusted) store.dismiss(s.id); }}>Dismiss</button>
    </div>
  </div>;
}
