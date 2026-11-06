// A palette drawn as a small landscape: the first colour is the sky, one is a sun, the rest are hills and stones.
// The same card always draws the same scene. Colours stay the subject: the swatches sit underneath, named for screen readers.
import { useMemo } from "react";
import type { Card } from "../../../engine/src/types.ts";
import { hash, rng } from "../kit/hooks.ts";

function hill(r: () => number, y: number, amp: number): string {
  const pts: string[] = [`M0 ${y}`];
  const n = 4;
  for (let i = 1; i <= n; i++) {
    const x = (i / n) * 320;
    const cx = x - 40;
    const cy = y - amp * (0.4 + r());
    pts.push(`Q${cx.toFixed(0)} ${cy.toFixed(0)} ${x.toFixed(0)} ${(y + (r() - 0.5) * amp * 0.6).toFixed(0)}`);
  }
  pts.push("L320 200 L0 200 Z");
  return pts.join(" ");
}

export function PaletteCard({ card }: { card: Card }) {
  const cols = (card.palette ?? []).slice(0, 6);
  const scene = useMemo(() => {
    const r = rng(hash(card.id));
    const sky = cols[0] ?? "#ccc";
    const sun = cols[1] ?? sky;
    const rest = cols.slice(2);
    const layers = rest.length ? rest : [sun];
    const hills = layers.map((c, i) => ({ c, d: hill(r, 92 + i * (90 / layers.length), 26 + r() * 22) }));
    return { sky, sun, sunX: 70 + r() * 180, sunY: 46 + r() * 22, sunR: 22 + r() * 16, hills };
  }, [card.id, cols.join(",")]);
  return (
    <figure className="ta-card ta-card-palette" data-kind="palette">
      <div className="ta-media-frame">
        <svg viewBox="0 0 320 200" preserveAspectRatio="xMidYMid slice" role="img" aria-label={`${card.title}: ${cols.join(", ")}`}>
          <rect width="320" height="200" fill={scene.sky} />
          <circle cx={scene.sunX} cy={scene.sunY} r={scene.sunR} fill={scene.sun} />
          {scene.hills.map((h, i) => <path key={i} d={h.d} fill={h.c} />)}
        </svg>
      </div>
      <figcaption className="ta-card-cap">
        <span className="ta-swatches" aria-hidden="true">{cols.map((c) => <i key={c} style={{ background: c }} />)}</span>
        {card.title}
      </figcaption>
    </figure>
  );
}
