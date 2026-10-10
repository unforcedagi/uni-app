import { useLayoutEffect, useRef, useState } from "react";
import type { Area } from "./areasCore";
import { stageLayout, centreLines, MARK_LABEL, metrics, tipLayout, type Alive, type ArmIn, type Mark } from "./nodeMap";

/** One arm of the map: a child, its status mark, and the children at its tip. */
export type StageKid = { node: Area; mark: Mark; tips: string[]; needs: number };

/**
 * A zoom in flight: the tap records where the tapped node and the old centre were, and the next stage (a fresh mount for
 * the new node) grows from there. One short transition per tap; nothing loops.
 */
export type Intent = { dir: "in" | "out"; from: DOMRect | null; centre: DOMRect | null; at: number };
export type ZoomState = { intent: Intent | null; everMounted: boolean };
const FRESH_MS = 1500;
export const ZOOM_MS = 300;

const reducedMotion = () => typeof window === "undefined" || !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Where the transform of `el` (final place) must start so that it appears at `from`. */
function flip(el: Element, from: DOMRect, opts: KeyframeAnimationOptions) {
  const to = el.getBoundingClientRect();
  if (!to.width || !from.width) return;
  const dx = from.left + from.width / 2 - (to.left + to.width / 2), dy = from.top + from.height / 2 - (to.top + to.height / 2);
  el.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${from.width / to.width})` }, { transform: "none" }], opts);
}

export default function NodeStage({ node, kids, parent, alive, pending, fresh, kindLabel, onOpen, onUp, count, zoom }: {
  zoom: React.RefObject<ZoomState>;
  node: Area; kids: readonly StageKid[]; parent: Area | null; alive: Alive; fresh: string; kindLabel: string;
  /** Not loaded yet: said in the centre instead of "No brief yet". */
  pending: string | null;
  onOpen: (child: Area) => void; onUp: (() => void) | null;
  /** The mark of the node's own tip: how many things need you / are moving here (for the phone's count line). */
  count: { needs: number; moving: number };
}) {
  const box = useRef<HTMLDivElement>(null);
  const measureBox = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = box.current; if (!el) return;
    const measure = () => { const r = el.getBoundingClientRect(); const h = measureBox.current?.getBoundingClientRect().height ?? r.height; setSize((s) => (s && Math.abs(s.w - r.width) < 1 && Math.abs(s.h - h) < 1 ? s : { w: r.width, h })); };
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    if (measureBox.current) ro?.observe(measureBox.current);
    return () => ro?.disconnect();
  }, []);
  const base = size ? metrics(size.w, size.h, kids.length === 0, !!onUp) : null;
  const hasParent = !!onUp;
  const ins: ArmIn[] = kids.map((k) => ({ name: k.node.name, mark: k.mark, background: k.node.status === "background", tips: k.tips.length }));
  const layout = base ? stageLayout(ins, base, hasParent, pending ? 0 : Math.min(alive.needs.length, 3)) : null;
  const m = layout?.m ?? null;
  const arms = layout?.arms ?? [];

  // The zoom: runs once when this node's stage first draws at its real size.
  const ran = useRef(false);
  useLayoutEffect(() => {
    if (!m || ran.current) return;
    ran.current = true;
    const { intent, everMounted } = zoom.current;
    const mine = intent && performance.now() - intent.at < FRESH_MS ? intent : null;
    zoom.current.intent = null;
    const animate = everMounted && !reducedMotion();
    zoom.current.everMounted = true;
    const root = box.current;
    if (!animate || !root) return;
    const opts: KeyframeAnimationOptions = { duration: ZOOM_MS, easing: "cubic-bezier(.2,.7,.2,1)" };
    const core = root.querySelector(".node-core"), chip = root.querySelector(".node-chip");
    const dir = mine?.dir ?? "out";
    if (core) {
      if (mine?.from) flip(core, mine.from, opts);
      else core.animate([{ transform: "scale(.78)", opacity: 0 }, { transform: "none", opacity: 1 }], opts);
    }
    if (chip && dir === "in" && mine?.centre) flip(chip, mine.centre, opts);
    else chip?.animate([{ opacity: 0 }, { opacity: 1 }], { ...opts, duration: ZOOM_MS - 80 });
    for (const el of root.querySelectorAll(".node-bloom")) el.animate([{ opacity: 0, transform: "scale(.86)" }, { opacity: 1, transform: "none" }], { ...opts, delay: 40, duration: ZOOM_MS - 40, fill: "backwards" });
  }, [!!m]); // eslint-disable-line react-hooks/exhaustive-deps

  const remember = (dir: "in" | "out", from: Element | null) => {
    const core = box.current?.querySelector(".node-core");
    zoom.current.intent = { dir, from: from?.getBoundingClientRect() ?? null, centre: core?.getBoundingClientRect() ?? null, at: performance.now() };
  };
  const lines = centreLines(alive, 2);
  const narrow = !!m?.narrow;
  const stageClass = `node-stage ${narrow ? "narrow" : ""} ${kids.length === 0 ? "leaf" : kids.length <= 2 ? "few" : ""} ${m && m.core < 250 ? "compact" : ""}`;
  return <div ref={box} className={stageClass} style={layout?.compact ? { height: m?.h } : undefined} role="group" aria-label={`Map of ${node.name}`}>
    <div ref={measureBox} className={`${stageClass} node-stage-measure`} aria-hidden="true" />
    {m && <>
      <svg className="node-lines" width={m.w} height={m.h} viewBox={`0 0 ${m.w} ${m.h}`} aria-hidden="true">
        {!layout?.compact && arms.map((a, i) => {
          const k = kids[i];
          return <g key={k.node.id} className="node-bloom">
            <path className={`node-line ${k.mark}`} d={`M${m.cx.toFixed(1)},${m.cy.toFixed(1)} L${a.x.toFixed(1)},${a.y.toFixed(1)}`} />
            {(layout?.compact ? [] : tipLayout(a, k.tips.length, m)).map((t, j) => <path key={j} className="node-line tip" d={`M${a.x.toFixed(1)},${a.y.toFixed(1)} L${t.x.toFixed(1)},${t.y.toFixed(1)}`} />)}
          </g>;
        })}
      </svg>
      {arms.map((a, i) => {
        const k = kids[i];
        return <div key={k.node.id} className="node-bloom">
          <button type="button" className={`node-arm ${k.mark} ${k.node.status}`} data-mark={k.mark} data-name={k.node.name}
            style={{ left: a.x - a.d / 2, top: a.y - a.d / 2, width: a.d, height: a.d }}
            aria-label={`${k.node.name}, ${k.needs ? `${k.needs} need${k.needs === 1 ? "s" : ""} you` : MARK_LABEL[k.mark]}`} onClick={(e) => { remember("in", e.currentTarget); onOpen(k.node); }} />
          <span className={`node-label ${k.mark} ${k.node.status} ${a.side}`} aria-hidden="true" style={{ left: a.label.x, top: a.label.y, width: a.label.w, height: a.label.h }}><span>{k.node.name}</span></span>
          {(layout?.compact ? [] : tipLayout(a, k.tips.length, m)).map((t, j) => <span key={j} className={`node-tip ${t.side}`} aria-hidden="true" style={{ left: t.x, top: t.y }}><i /><b>{k.tips[j]}</b></span>)}
        </div>;
      })}
      {parent && onUp && <button type="button" className="node-chip" aria-label={`Zoom out to ${parent.name}`} style={{ left: m.chip.x - m.chip.d / 2, top: m.chip.y - m.chip.d / 2, width: m.chip.d, height: m.chip.d }}
        onClick={(e) => { remember("out", e.currentTarget); onUp(); }}>
        <span aria-hidden="true">↑</span><b>{parent.name}</b></button>}
      <div className="node-core" style={{ left: m.cx - m.core / 2, top: m.cy - m.core / 2, width: m.core, height: m.core }}>
        <span className="node-cap">{kindLabel}</span>
        <h1 className="note-title">{node.title}</h1>
        {fresh && <time className="node-fresh">{fresh}</time>}
        {narrow
          ? pending ? null : <p className="node-count">{(alive.has ? (count.needs ? `${count.needs} need${count.needs === 1 ? "s" : ""} you` : count.moving ? `${count.moving} moving` : "Quiet") : "No brief yet")}</p>
          : pending ? null
          : !alive.has ? <p className="node-none">No brief yet</p>
          : lines.length === 0 ? <p className="node-none">Nothing needs you</p>
          : <ul className="node-alive" aria-label="What is alive here">{lines.map((l, i) => <li key={i} className={l.kind}>{lines[i - 1]?.kind !== l.kind && <b>{l.kind === "needs" ? "Needs you" : "Moving"}</b>}<span>{l.text}</span></li>)}</ul>}
      </div>
      {narrow && !pending && alive.needs.length > 0 && <ul className="node-phone-needs" aria-label="Needs you here" style={{ top: m.cy + m.core / 2 + 12 }}>{alive.needs.slice(0, 3).map((text, i) => <li key={i} title={text}>{text}</li>)}</ul>}
    </>}
  </div>;
}
