// A type pairing set live. The fonts are named in the card; if the device lacks one, the nearest kind stands in.
import type { Card } from "../../../engine/src/types.ts";

const SERIFS = /serif|garamond|caslon|baskerville|georgia|times|literata|fraunces|playfair|lora|merriweather|bodoni|didot|crimson|spectral|newsreader|charter|iowan|palatino|minion|tiempos|source serif|eb /i;
const MONO = /mono|courier|code|plex mono|menlo|consolas/i;

export function stack(name: string): string {
  const generic = MONO.test(name) ? "ui-monospace, monospace" : SERIFS.test(name) && !/sans/i.test(name) ? "Georgia, serif" : "system-ui, sans-serif";
  return `"${name.replace(/"/g, "")}", ${generic}`;
}

export function TypeCard({ card }: { card: Card }) {
  const t = card.type ?? { display: "Georgia", body: "system-ui", sample: card.title };
  return (
    <figure className="ta-card ta-card-type" data-kind="type">
      <div className="ta-type-sheet">
        <p className="ta-type-display" style={{ fontFamily: stack(t.display) }}>{t.sample}</p>
        <p className="ta-type-body" style={{ fontFamily: stack(t.body) }}>{card.blurb ?? "Small words carry the reading: how a page feels after the first glance."}</p>
      </div>
      <figcaption className="ta-card-cap">{t.display} <small>with {t.body}</small></figcaption>
    </figure>
  );
}
