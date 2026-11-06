// Words as the card: a sentence, a question, a Who Said It line. Set big, in the reading face.
import type { Card } from "../../../engine/src/types.ts";

export function TextCard({ card }: { card: Card }) {
  const text = card.text ?? card.title;
  const long = text.length > 140;
  return (
    <figure className={`ta-card ta-card-text${long ? " is-long" : ""}`} data-kind={card.kind}>
      <blockquote className="ta-text">{text}</blockquote>
      {card.kind === "sentence" && card.blurb && <figcaption className="ta-card-cap">{card.blurb}</figcaption>}
    </figure>
  );
}
