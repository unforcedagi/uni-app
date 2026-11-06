// One card, drawn by its kind.
import type { Card } from "../../../engine/src/types.ts";
import { MediaCard } from "./MediaCard.tsx";
import { SoundCard } from "./SoundCard.tsx";
import { ClipCard } from "./ClipCard.tsx";
import { PaletteCard } from "./PaletteCard.tsx";
import { MotionCard } from "./MotionCard.tsx";
import { TypeCard } from "./TypeCard.tsx";
import { TextCard } from "./TextCard.tsx";
import { ArtifactView } from "./ArtifactView.tsx";

export function CardView({ card, focused = true, autoPlay = false }: { card: Card; focused?: boolean; autoPlay?: boolean }) {
  switch (card.kind) {
    case "image": case "layout": return <MediaCard card={card} />;
    case "sound": return <SoundCard card={card} autoPlay={autoPlay && focused} volume={autoPlay ? 0.35 : 0.6} />;
    case "clip": return <ClipCard card={card} focused={focused} />;
    case "palette": return <PaletteCard card={card} />;
    case "motion": return <MotionCard card={card} />;
    case "type": return <TypeCard card={card} />;
    case "artifact": return card.artifact ? <ArtifactView card={card} params={card.artifact.params} /> : <TextCard card={card} />;
    default: return <TextCard card={card} />;
  }
}
