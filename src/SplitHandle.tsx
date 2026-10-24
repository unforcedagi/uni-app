import { useEffect, useRef } from "react";

/** How close (px) a let-go size must be to a snap point to land on it. */
const SNAP_PX = 36;
/** A flick toward the far edge faster than this (px/ms), let go below the lowest snap point, closes the pane. */
const FLING = 0.8;

/**
 * T-273: the handle between the chat and a note, one component for both splits. `y`: the top edge of a sheet over the chat (drag up to make
 * it taller); `x`: the left edge of a column beside it (drag left to make it wider). `size` is the pane's height or width in px; `span` is
 * the whole length it can take (for aria-valuenow, a percent). A drag reports each size live (`onDrag`, null when it ends), then the size it
 * settles on (`onCommit`): a snap point when it is let go near one. With `onDismiss`, pulling it past `min` (or flicking it down hard) closes
 * the pane. Arrow keys resize it, Home and End go to `min` and `max`. No animation: the size follows the pointer and stops (e-ink).
 */
export default function SplitHandle({ axis, size, min, max, span, snaps, label, onDrag, onCommit, onDismiss }: {
  axis: "x" | "y";
  size: number;
  min: number;
  max: number;
  span: number;
  snaps: number[];
  label: string;
  onDrag: (size: number | null) => void;
  onCommit: (size: number) => void;
  onDismiss?: () => void;
}) {
  // a drag reads the bounds and callbacks of the latest render: the room under a sheet can change size while it is held (a phone's keyboard
  // goes away as the handle is touched)
  const props = useRef({ min, max, snaps, onDrag, onCommit, onDismiss });
  props.current = { min, max, snaps, onDrag, onCommit, onDismiss };
  const clamp = (s: number) => Math.max(props.current.min, Math.min(props.current.max, s));
  /** Ends the drag in hand without settling it (the handle is going away). */
  const drop = useRef<(() => void) | null>(null);
  useEffect(() => () => drop.current?.(), []);
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || drop.current) return;
    e.preventDefault();
    const handle = e.currentTarget, id = e.pointerId;
    try { handle.setPointerCapture(id); } catch { /* a synthetic pointer */ }
    const at = (ev: PointerEvent) => (axis === "y" ? ev.clientY : ev.clientX);
    const start = size, from = at(e.nativeEvent);
    let raw = start;
    // the last tenth of a second of the drag, for the speed it was let go at
    const trail: { t: number; p: number }[] = [{ t: e.timeStamp, p: from }];
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      const { min, max, onDismiss } = props.current;
      raw = start + from - at(ev);
      trail.push({ t: ev.timeStamp, p: at(ev) });
      while (trail.length > 2 && ev.timeStamp - trail[0].t > 100) trail.shift();
      // past `min` the pane follows the pointer toward its edge, so a pull that closes it shows before it is let go
      props.current.onDrag(Math.max(onDismiss ? Math.min(min, 24) : min, Math.min(max, raw)));
    };
    // on the window, not the handle: the drag still ends when the pointer capture is lost or never took
    const stop = () => {
      drop.current = null;
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end);
      props.current.onDrag(null);
    };
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      stop();
      const { min, max, snaps, onCommit, onDismiss } = props.current;
      // the speed of the last moves (toward the far edge is positive); a pause before letting go is no flick
      const first = trail[0], last = trail[trail.length - 1];
      const speed = ev.timeStamp - last.t > 100 ? 0 : (last.p - first.p) / Math.max(1, last.t - first.t);
      const lowest = Math.min(...snaps.filter((s) => s >= min), max);
      if (onDismiss && ev.type === "pointerup" && (raw < min - 16 || (speed > FLING && raw < lowest))) { onCommit(start); onDismiss(); return; }
      const s = clamp(raw);
      const near = snaps.filter((p) => p >= min && p <= max).concat(max).reduce((a, b) => (Math.abs(b - s) < Math.abs(a - s) ? b : a), s + SNAP_PX * 2);
      onCommit(Math.abs(near - s) <= SNAP_PX ? near : s);
    };
    drop.current = stop;
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end); window.addEventListener("pointercancel", end);
  };
  const key = (e: React.KeyboardEvent) => {
    const grow = axis === "y" ? "ArrowUp" : "ArrowLeft", shrink = axis === "y" ? "ArrowDown" : "ArrowRight";
    const step = e.shiftKey ? 80 : 24;
    const next = e.key === grow ? size + step : e.key === shrink ? size - step : e.key === "Home" ? min : e.key === "End" ? max : null;
    if (next === null) return;
    e.preventDefault();
    onCommit(clamp(next));
  };
  const pct = (s: number) => Math.round((s / Math.max(1, span)) * 100);
  return <div className={`split-handle split-handle-${axis}`} role="separator" tabIndex={0} aria-label={label}
    aria-orientation={axis === "y" ? "horizontal" : "vertical"} aria-valuenow={pct(size)} aria-valuemin={pct(min)} aria-valuemax={pct(max)}
    onPointerDown={down} onKeyDown={key}><span aria-hidden="true" /></div>;
}
