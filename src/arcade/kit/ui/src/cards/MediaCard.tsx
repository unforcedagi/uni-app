// image and layout: the host's URL in an <img>. A layout is a page screenshot: shown from its top, in a quiet frame.
import type { Card } from "../../../engine/src/types.ts";
import { useMediaUrl } from "../kit/hooks.ts";

export function MediaCard({ card, bare }: { card: Card; bare?: boolean }) {
  const { url, state } = useMediaUrl(card, "src");
  return (
    <figure className="ta-card ta-card-media" data-kind={card.kind}>
      <div className="ta-media-frame">
        {url
          ? <img src={url} alt={card.blurb ? `${card.title}: ${card.blurb}` : card.title} draggable={false} decoding="async" />
          : <div className={`ta-media-missing${state === "loading" ? " is-loading" : ""}`} aria-hidden={state === "loading"}>{state === "loading" ? "" : "No picture for this one"}</div>}
      </div>
      {!bare && <figcaption className="ta-card-cap">{card.title}</figcaption>}
    </figure>
  );
}
