import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import NoteView from "../NoteView";
import "./t200.css";
import type { VaultRef } from "../vaultlinks";
import { noteLink, quoteBlock } from "./quote";

// The message last tapped or clicked in the chat (a note link's message): the split keeps it in sight when it shortens the list.
let tapped: Element | null = null;
/** Only while a T-200 mode is on: remember the chat message each tap lands on. */
export function useTapTracking(on: boolean) {
  useEffect(() => {
    if (!on) return;
    const remember = (e: Event) => { const m = e.target instanceof Element ? e.target.closest(".message-list article") : null; if (m) tapped = m; };
    document.addEventListener("pointerdown", remember, true);
    document.addEventListener("click", remember, true);
    return () => { document.removeEventListener("pointerdown", remember, true); document.removeEventListener("click", remember, true); tapped = null; };
  }, [on]);
}

export type PaneShape = "beside" | "above" | "sheet" | "window";
const SPLIT_KEY = "uni.t200.split", SHEET_KEY = "uni.t200.sheet";
const stored = (key: string, fallback: number) => { try { const n = Number(localStorage.getItem(key)); return n > 0 ? n : fallback; } catch { return fallback; } };

/**
 * T-200: a note read next to the chat it was linked from. The chat stays mounted underneath, so its scroll, draft and composer are
 * untouched. `beside`: a resizable column right of the chat (wide screens). `above`: the note on top, the chat below, a draggable divider
 * (narrow screens). `sheet`: over the message list, above the composer, at half or full height. No animation anywhere (e-ink).
 */
export default function NotePane({ shape, stack, hub, onOpen, onBack, onClose, onQuote, layoutKey = "" }: {
  shape: PaneShape;
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

  // beside: width in px; above: height in % of the screen; sheet: "half" | "full".
  const [width, setWidth] = useState(() => stored(SPLIT_KEY, 460));
  const [height, setHeight] = useState(() => stored(`${SPLIT_KEY}.h`, 50));
  const [full, setFull] = useState(() => { try { return localStorage.getItem(SHEET_KEY) === "full"; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem(SPLIT_KEY, String(Math.round(width))); localStorage.setItem(`${SPLIT_KEY}.h`, String(Math.round(height))); localStorage.setItem(SHEET_KEY, full ? "full" : "half"); } catch { /* private storage */ } }, [width, height, full]);
  const clampW = (w: number) => Math.max(320, Math.min(w, window.innerWidth - 480));
  const clampH = (h: number) => Math.max(25, Math.min(h, 75));
  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      if (shape === "beside") setWidth(clampW(window.innerWidth - ev.clientX));
      else setHeight(clampH((ev.clientY / window.innerHeight) * 100));
    };
    const up = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", up); handle.removeEventListener("pointercancel", up); };
    handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", up); handle.addEventListener("pointercancel", up);
  };
  const nudge = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 80 : 24;
    if (shape === "beside" && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { e.preventDefault(); setWidth((w) => clampW(w + (e.key === "ArrowLeft" ? step : -step))); }
    if (shape === "above" && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); setHeight((h) => clampH(h + (e.key === "ArrowDown" ? 5 : -5))); }
  };

  // sheet: sits exactly over the message list of the room underneath, ending at the composer's top edge.
  // above: spans the conversation column (the rail stays where it is), and the conversation starts below it.
  const [rect, setRect] = useState<{ left: number; width: number; top: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    if (shape !== "sheet" && shape !== "above") return;
    const parts = () => shape === "sheet" ? [document.querySelector(".conversation .message-list"), document.querySelector(".conversation .composer")] : [document.querySelector(".conversation"), document.querySelector(".conversation")];
    const measure = () => {
      const [area, foot] = parts();
      if (!area || !foot) { setRect(null); return; }
      const l = area.getBoundingClientRect(), c = foot.getBoundingClientRect();
      const next = { left: l.left, width: l.width, top: l.top, bottom: shape === "sheet" ? c.top : l.bottom };
      setRect((r) => r && r.left === next.left && r.width === next.width && r.top === next.top && r.bottom === next.bottom ? r : next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const el of parts()) if (el) ro.observe(el);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); window.visualViewport?.removeEventListener("resize", measure); };
  }, [shape, layoutKey]);
  // above: the message list loses its top half. While the note is open the tapped message is kept in sight; closing puts the list back
  // exactly where it was.
  const anchor = useRef<{ list: HTMLElement; top: number; msg: Element | null } | null>(null);
  useLayoutEffect(() => {
    if (shape !== "above") return;
    const list = document.querySelector<HTMLElement>(".conversation .message-list");
    anchor.current = list ? { list, top: list.scrollTop, msg: tapped && list.contains(tapped) ? tapped : null } : null;
    return () => {
      document.documentElement.style.removeProperty("--t200-above");
      const a = anchor.current;
      if (a?.list.isConnected) a.list.scrollTop = a.top;
    };
  }, [shape]);
  useLayoutEffect(() => {
    if (shape !== "above") return;
    document.documentElement.style.setProperty("--t200-above", `${height}dvh`);
    const a = anchor.current;
    if (!a?.msg?.isConnected) return;
    const l = a.list.getBoundingClientRect(), m = a.msg.getBoundingClientRect();
    if (m.bottom > l.bottom - 8) a.list.scrollTop += Math.min(m.bottom - l.bottom + 8, m.top - l.top - 8);
    else if (m.top < l.top + 8) a.list.scrollTop -= l.top + 8 - m.top;
  }, [shape, height]);

  const style: CSSProperties = shape === "window" ? {} : shape === "beside" ? { width }
    : shape === "above" ? { height: `${height}dvh`, ...(rect ? { left: rect.left, width: rect.width } : { left: 0, right: 0 }) }
    : rect ? { left: rect.left, width: rect.width, top: full ? rect.top : rect.top + (rect.bottom - rect.top) / 2, height: full ? rect.bottom - rect.top : (rect.bottom - rect.top) / 2 }
    : { left: 0, right: 0, bottom: 0, height: full ? "85dvh" : "50dvh" };

  return <section ref={box} className={`t200-pane t200-${shape}${shape === "sheet" ? (full ? " full" : " half") : ""}`} style={style} role="complementary" aria-label="Note beside the chat"
    onKeyDown={(e) => { if (e.key === "Escape" && !(e.target instanceof HTMLTextAreaElement)) { e.stopPropagation(); onClose(); } }}>
    {(shape === "beside" || shape === "above") && <div className="t200-handle" role="separator" tabIndex={0} aria-orientation={shape === "beside" ? "vertical" : "horizontal"}
      aria-label={shape === "beside" ? "Resize the note (← →)" : "Resize the note (↑ ↓)"} aria-valuenow={Math.round(shape === "beside" ? width : height)}
      onPointerDown={drag} onKeyDown={nudge}><span aria-hidden="true" /></div>}
    <NoteView key={key} target={top} hub={hub} compact onOpen={onOpen}
      onBack={prev ? onBack : onClose} backIcon={prev ? "←" : "×"} backLabel={prev ? titles[`${prev.vault}:${prev.ref}`] ?? prev.ref.split("/").pop() ?? "note" : "Close note"}
      onTitle={(t) => setTitles((m) => m[key] === t ? m : { ...m, [key]: t })}
      onResolved={(id) => setIds((m) => m[key] === id ? m : { ...m, [key]: id })}
      onDirty={() => {}} onCreate={() => {}} onSearch={() => {}}
      actions={<>
        <button type="button" className={`note-action t200-quote${picked ? " ready" : ""}`} disabled={!picked || !ids[key]} onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()} onClick={quote}
          title={picked ? "Put the selected passage in your reply" : "Select a passage in the note first"}>Quote in reply</button>
        {prev && <button type="button" className="note-action t200-close" aria-label="Close note" onClick={onClose}>×</button>}
        {shape === "sheet" && <button type="button" className="note-action t200-size" aria-pressed={full} onClick={() => setFull((f) => !f)}>{full ? "Half" : "Full"}</button>}
      </>} />
  </section>;
}
