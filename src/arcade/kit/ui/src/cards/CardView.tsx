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

/** `bare`: one side of a pair. Only the thing being judged: no name, no caption, nothing else that differs. */
export function CardView({ card, focused = true, autoPlay = false, bare = false, long }: { card: Card; focused?: boolean; autoPlay?: boolean; bare?: boolean; long?: boolean }) {
  switch (card.kind) {
    case "image": case "layout": return <MediaCard card={card} bare={bare} />;
    case "sound": return <SoundCard card={card} autoPlay={autoPlay && focused} volume={autoPlay ? 0.35 : 0.6} bare={bare} />;
    case "clip": return <ClipCard card={card} focused={focused} bare={bare} />;
    case "palette": return <PaletteCard card={card} bare={bare} />;
    case "motion": return <MotionCard card={card} bare={bare} />;
    case "type": return <TypeCard card={card} bare={bare} />;
    case "artifact": return card.artifact ? <ArtifactView card={card} params={card.artifact.params} /> : <TextCard card={card} />;
    default: return <TextCard card={card} bare={bare} long={long} />;
  }
}
