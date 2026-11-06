// "Uni noticed…": what one burst taught, from the engine's own arithmetic over just this session's reactions.
import type { Card, Reaction } from "../../../engine/src/types.ts";
import { evidence } from "../../../engine/src/evidence.ts";
import { sessionLesson } from "../../../engine/src/rewards.ts";
import { claimText } from "../../../engine/src/features.ts";
import { seedsFor } from "../../../engine/src/rewards.ts";

export function noticed(cards: Iterable<Card>, reactions: readonly Reaction[], max = 2): string[] {
  if (!reactions.length) return [];
  const moved = sessionLesson(new Map(), evidence(cards, reactions), max);
  return moved.map((m) => claimText(m.feature, m.delta >= 0 ? 1 : -1));
}

export function seedsOf(reactions: readonly Reaction[]): number {
  let s = 0;
  for (const r of reactions) s += seedsFor(r);
  return s;
}

/** "warmer and slower", "warmer, slower and bigger" */
export function andList(xs: string[]): string {
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}
