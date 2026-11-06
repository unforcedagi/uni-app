// A type pairing set live. The fonts are named in the card; if the device lacks one, the next in its stack stands in.
import type { Card } from "../../../engine/src/types.ts";

/** A card names a whole font stack ("Fraunces", Georgia, serif) or one family; either way it reaches the page whole. The app
 *  bundles its Fraunces as "Fraunces Glow", so that name stands behind it. */
export function stack(name: string): string {
  const families = name.split(",").map((f) => f.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  const out: string[] = [];
  for (const f of families) {
    out.push(/^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+)$/.test(f) ? f : `"${f.replace(/"/g, "")}"`);
    if (/^fraunces$/i.test(f)) out.push('"Fraunces Glow"');
  }
  const generic = /mono|courier|code|menlo|consolas/i.test(name) ? "ui-monospace, monospace" : /serif|georgia|palatino|iowan|literata|fraunces|times/i.test(name) && !/sans/i.test(name) ? "Georgia, serif" : "system-ui, sans-serif";
  return `${out.join(", ")}, ${generic}`;
}

const faceName = (s: string) => s.split(",")[0].trim().replace(/^["']|["']$/g, "");

export function TypeCard({ card, bare }: { card: Card; bare?: boolean }) {
  const t = card.type ?? { display: "Georgia", body: "system-ui", sample: card.title };
  return (
    <figure className="ta-card ta-card-type" data-kind="type">
      <div className="ta-type-sheet">
        <p className="ta-type-display" style={{ fontFamily: stack(t.display) }}>{t.sample}</p>
        <p className="ta-type-body" style={{ fontFamily: stack(t.body) }}>{card.blurb ?? "Small words carry the reading: how a page feels after the first glance."}</p>
      </div>
      {!bare && <figcaption className="ta-card-cap">{faceName(t.display)} <small>with {faceName(t.body)}</small></figcaption>}
    </figure>
  );
}
