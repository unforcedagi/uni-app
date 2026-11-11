// T-335 the applets drawer: every applet in one sheet, from one registry (src/interface/applets.ts). Vault applets
// first, then doors (dashed tiles), and a legend for the two marks. A bottom sheet on a phone, a centred panel on a
// wide screen. Scrim and Escape close it; focus starts on the first tile and goes back to the opener on close.
import { useEffect, useRef, type KeyboardEvent, type MouseEvent } from "react";
import { countOf, type AppletCounts, type AppletManifest } from "../interface/applets.ts";
import "./applets.css";

export function AppletsDrawer({ applets, counts, onOpen, onClose }: {
  applets: readonly AppletManifest[];
  counts: AppletCounts;
  /** `tap`: the tile's click (a sealed applet starts only on a trusted one). */
  onOpen: (id: string, tap: MouseEvent) => void;
  onClose: () => void;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (sheet.current?.querySelector<HTMLElement>(".sh-ap-tile") ?? sheet.current)?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
    if (e.key !== "Tab" || !sheet.current) return;
    // aria-modal: Tab stays in the sheet
    const all = [...sheet.current.querySelectorAll<HTMLElement>("button")];
    if (!all.length) { e.preventDefault(); return; }
    const first = all[0], last = all[all.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  const tile = (a: AppletManifest) => {
    const n = countOf(counts, a.id);
    return <button key={a.id} type="button" className={`sh-ap-tile ${a.kind}`} aria-label={n ? `${a.name} (${n})` : a.name} onClick={(e) => onOpen(a.id, e)}>
      <i aria-hidden="true">{a.glyph}</i><span className="sh-ap-name">{a.name}</span>
      {n > 0 && <span className="sh-ap-count" aria-hidden="true">{n > 99 ? "99+" : n}</span>}
    </button>;
  };
  const vault = applets.filter((a) => a.kind === "vault");
  const doors = applets.filter((a) => a.kind === "door");

  return <div className="sh-ap-layer" onKeyDown={onKey}>
    <div className="sh-ap-scrim" aria-hidden="true" onClick={onClose} />
    <div ref={sheet} className="sh-ap-sheet" role="dialog" aria-modal="true" tabIndex={-1} aria-labelledby="sh-ap-title">
      <div className="sh-ap-grabber" aria-hidden="true" />
      <h2 id="sh-ap-title">Applets</h2>
      <p className="sh-ap-sub">Small apps for the ways you work. Each one tells search what it can find.</p>
      {vault.length > 0 && <section aria-labelledby="sh-ap-vault">
        <h3 id="sh-ap-vault" className="sh-ap-group">From your vault</h3>
        <p className="sh-ap-why">Their data lives in a vault, as notes.{vault.some((a) => a.id === "calendar") ? " Calendar too: every event is a note." : ""}</p>
        <div className="sh-ap-tiles">{vault.map(tile)}</div>
      </section>}
      {doors.length > 0 && <section aria-labelledby="sh-ap-doors">
        <h3 id="sh-ap-doors" className="sh-ap-group">Doors</h3>
        <p className="sh-ap-why">A small bridge on the box holds the keys; the app signs each call with yours.</p>
        <div className="sh-ap-tiles">{doors.map(tile)}</div>
      </section>}
      <div className="sh-ap-legend"><span><i className="sh-ap-mark" aria-hidden="true" />Vault applet</span><span><i className="sh-ap-mark door" aria-hidden="true" />Door</span></div>
    </div>
  </div>;
}
