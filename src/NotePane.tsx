import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import NoteView from "./NoteView";
import "./notePane.css";
import type { VaultRef } from "./vaultlinks";
import { noteLink, quoteBlock } from "./noteQuote";

/** T-200: wide enough to put the note beside the chat (in CSS pixels). */
export const BESIDE_MIN = 900;
const isAndroid = () => /Android/i.test(navigator.userAgent);

export type PaneShape = "beside" | "sheet";
/** Beside the chat on a wide screen; a sheet over the chat on a narrow one, and always on Android (the Daylight too, whatever its width). */
export function usePaneShape(): PaneShape {
  const query = `(min-width: ${BESIDE_MIN}px)`;
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const q = window.matchMedia(query);
    const sync = () => setWide(q.matches);
    q.addEventListener("change", sync);
    return () => q.removeEventListener("change", sync);
  }, [query]);
  return wide && !isAndroid() ? "beside" : "sheet";
}

const WIDTH_KEY = "uni.notePane.width", SHEET_KEY = "uni.notePane.sheet";
const storedWidth = () => { try { const n = Number(localStorage.getItem(WIDTH_KEY)); return n > 0 ? n : 460; } catch { return 460; } };
/** The chat keeps at least this much beside the note (with the tree and the companion folded to their icons). */
const clampWidth = (w: number) => Math.max(320, Math.min(w, window.innerWidth - 520));

/**
 * T-200: a note read next to the chat it was linked from. The chat stays mounted, so its scroll, draft and composer are untouched.
 * `beside`: a resizable column right of the chat, its width remembered. `sheet`: over the message list, ending at the composer's top edge,
 * at half or full height. No animation anywhere (e-ink).
 */
export default function NotePane({ shape, stack, hub, list, onOpen, onBack, onClose, onQuote, onOpenPage, onDirty, onSearch, layoutKey = "" }: {
  shape: PaneShape;
  /** The room's message list (the sheet lies over it, down to the room's composer). */
  list: HTMLElement;
  /** "Search all vaults" from a note that can't be found. */
  onSearch: (query: string) => void;
  /** Changes when the chat underneath is a different view (room, thread): the sheet measures it again. */
  layoutKey?: string;
  stack: VaultRef[];
  hub: string | null;
  /** A link inside the note: it opens in the pane, over this one. */
  onOpen: (ref: VaultRef, href: string | null) => void;
  onBack: () => void;
  onClose: () => void;
  /** Text for the composer of the room underneath. */
  onQuote: (text: string) => void;
  /** The note as today's full page. */
  onOpenPage: (ref: VaultRef, title: string) => void;
  /** An edit in the pane that is not saved yet (its draft is kept on this device). */
  onDirty: (ref: VaultRef, dirty: boolean) => void;
}) {
  const top = stack[stack.length - 1];
  const box = useRef<HTMLElement>(null);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [ids, setIds] = useState<Record<string, string>>({});
  const key = `${top.vault}:${top.ref}`;
  const prev = stack.length > 1 ? stack[stack.length - 2] : null;

  // Quote in reply: the passage selected inside this note's text.
  const [picked, setPicked] = useState("");
  useEffect(() => {
    const read = () => {
      const s = document.getSelection();
      const body = box.current?.querySelector(".note-body");
      const inside = !!s && !s.isCollapsed && !!body && !!s.anchorNode && body.contains(s.anchorNode) && !!s.focusNode && body.contains(s.focusNode);
      setPicked(inside ? s!.toString() : "");
    };
    document.addEventListener("selectionchange", read);
    return () => document.removeEventListener("selectionchange", read);
  }, []);
  const quote = () => {
    if (!ids[key]) return; // the link is the note's id, once it is known (a path would not make a chip)
    const text = quoteBlock(picked, noteLink(top.vault, ids[key], hub));
    if (!text) return;
    onQuote(text);
    document.getSelection()?.removeAllRanges();
    setPicked("");
  };

  // beside: width in px; sheet: half or full height. Both remembered on this device.
  const [width, setWidthState] = useState(() => clampWidth(storedWidth()));
  const widthRef = useRef(width);
  const setWidth = (w: number) => { widthRef.current = w; setWidthState(w); };
  const keep = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* private storage */ } };
  const [full, setFull] = useState(() => { try { return localStorage.getItem(SHEET_KEY) === "full"; } catch { return false; } });
  useEffect(() => {
    const fit = () => setWidth(clampWidth(widthRef.current));
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setWidth(clampWidth(window.innerWidth - ev.clientX));
    // the width is kept once the drag ends, not on every move
    const up = () => { keep(WIDTH_KEY, String(Math.round(widthRef.current))); handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", up); handle.removeEventListener("pointercancel", up); };
    handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", up); handle.addEventListener("pointercancel", up);
  };
  const nudge = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = e.shiftKey ? 80 : 24;
    const w = clampWidth(widthRef.current + (e.key === "ArrowLeft" ? step : -step));
    setWidth(w);
    keep(WIDTH_KEY, String(Math.round(w)));
  };

  // sheet: sits exactly over the message list of the room underneath, ending at the composer's top edge.
  const [rect, setRect] = useState<{ left: number; width: number; top: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    if (shape !== "sheet") return;
    const parts = () => [list, list.parentElement?.querySelector(":scope > .composer") ?? null];
    const measure = () => {
      const [area, foot] = parts();
      if (!area || !foot) { setRect(null); return; }
      const l = area.getBoundingClientRect(), c = foot.getBoundingClientRect();
      const next = { left: l.left, width: l.width, top: l.top, bottom: c.top };
      setRect((r) => r && r.left === next.left && r.width === next.width && r.top === next.top && r.bottom === next.bottom ? r : next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const el of parts()) if (el) ro.observe(el);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); window.visualViewport?.removeEventListener("resize", measure); };
  }, [shape, layoutKey, list]);

  const style: CSSProperties = shape === "beside" ? { width }
    : rect ? { left: rect.left, width: rect.width, top: full ? rect.top : rect.top + (rect.bottom - rect.top) / 2, height: full ? rect.bottom - rect.top : (rect.bottom - rect.top) / 2 }
    : { left: 0, right: 0, bottom: 0, height: full ? "85dvh" : "50dvh" };
  const title = titles[key] ?? top.ref.split("/").pop() ?? top.ref;

  return <section ref={box} className={`note-pane note-pane-${shape}${shape === "sheet" ? (full ? " full" : " half") : ""}`} style={style} role="complementary" aria-label="Note beside the chat"
    onKeyDown={(e) => { if (e.key === "Escape" && !(e.target instanceof HTMLTextAreaElement)) { e.stopPropagation(); onClose(); } }}>
    {shape === "beside" && <div className="note-pane-handle" role="separator" tabIndex={0} aria-orientation="vertical" aria-label="Resize the note (← →)" aria-valuenow={Math.round(width)}
      onPointerDown={drag} onKeyDown={nudge}><span aria-hidden="true" /></div>}
    <NoteView key={key} target={top} hub={hub} compact onOpen={onOpen}
      onBack={prev ? onBack : onClose} backIcon={prev ? "←" : "×"} backLabel={prev ? titles[`${prev.vault}:${prev.ref}`] ?? prev.ref.split("/").pop() ?? "note" : "Close note"}
      onTitle={(t) => setTitles((m) => m[key] === t ? m : { ...m, [key]: t })}
      onResolved={(id) => setIds((m) => m[key] === id ? m : { ...m, [key]: id })}
      onDirty={(dirty) => onDirty(top, dirty)} onCreate={() => {}} onSearch={onSearch}
      actions={<>
        <button type="button" className={`note-action note-pane-quote${picked ? " ready" : ""}`} disabled={!picked || !ids[key]} onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()} onClick={quote}
          title={picked ? "Put the selected passage in your reply" : "Select a passage in the note first"}>Quote in reply</button>
        <button type="button" className="note-action quiet" onClick={() => onOpenPage(ids[key] ? { ...top, ref: ids[key] } : top, title)}>Open as page</button>
        {prev && <button type="button" className="note-action note-pane-close" aria-label="Close note" onClick={onClose}>×</button>}
        {shape === "sheet" && <button type="button" className="note-action note-pane-size" aria-pressed={full} onClick={() => { keep(SHEET_KEY, full ? "half" : "full"); setFull(!full); }}>{full ? "Half" : "Full"}</button>}
      </>} />
  </section>;
}
