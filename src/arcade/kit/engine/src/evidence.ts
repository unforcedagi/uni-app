// Reactions -> evidence per feature. Plain arithmetic, so a profile can always be rebuilt from the reaction log.
import type { Card, Reaction } from "./types.ts";

export interface FeatureEvidence {
  feature: string;
  /** signed: above 0 is a pull toward, below 0 a push away */
  score: number;
  /** how many reactions touched it */
  n: number;
  /** their words from reactions that pushed it up, verbatim */
  quotesFor: string[];
  /** their words from reactions that pushed it down */
  quotesAgainst: string[];
}

/** How strongly each kind of reaction counts. */
export const STRENGTH = { pick: 1, loser: 0.75, keep: 1, pin: 1.5, drop: 1, me: 1.5 } as const;

const MAX_NUDGE = 2;

export function cardIndex(cards: Iterable<Card>): Map<string, Card> {
  const m = new Map<string, Card>();
  for (const c of cards) m.set(c.id, c);
  return m;
}

/** "visual:warm+" -> ["visual:warm", 1] */
export function splitClaimId(id: string): [string, 1 | -1] | null {
  const m = /^([a-z]+:[a-z0-9-]+)([+-])$/.exec(id);
  return m ? [m[1], m[2] === "+" ? 1 : -1] : null;
}

export function evidence(cards: Iterable<Card> | Map<string, Card>, reactions: readonly Reaction[]): Map<string, FeatureEvidence> {
  const byId = cards instanceof Map ? cards : cardIndex(cards);
  const out = new Map<string, FeatureEvidence>();
  const touch = (f: string, delta: number, words?: string) => {
    let e = out.get(f);
    if (!e) out.set(f, (e = { feature: f, score: 0, n: 0, quotesFor: [], quotesAgainst: [] }));
    e.score += delta;
    e.n += 1;
    const w = words?.trim();
    if (w) {
      const list = delta >= 0 ? e.quotesFor : e.quotesAgainst;
      if (!list.includes(w)) list.push(w);
    }
  };
  for (const r of reactions) {
    const k = r.weight ?? 1;
    const card = byId.get(r.card);
    switch (r.kind) {
      case "pick": {
        const other = r.other ? byId.get(r.other) : undefined;
        const win = new Set(card?.features ?? []);
        const lose = new Set(other?.features ?? []);
        for (const f of win) if (!lose.has(f)) touch(f, STRENGTH.pick * k, r.words);
        for (const f of lose) if (!win.has(f)) touch(f, -STRENGTH.loser * k);
        break;
      }
      case "keep": case "pin": {
        const s = (r.kind === "pin" ? STRENGTH.pin : STRENGTH.keep) * k;
        for (const f of card?.features ?? []) touch(f, s, r.words);
        break;
      }
      case "drop":
        for (const f of card?.features ?? []) touch(f, -STRENGTH.drop * k, r.words);
        break;
      case "nudge": {
        const axes = card?.artifact?.axes ?? [];
        for (const [key, raw] of Object.entries(r.nudges ?? {})) {
          const axis = axes.find((a) => a.key === key);
          const v = Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, Number(raw) || 0));
          if (axis && Math.abs(v) >= 0.15) touch(axis.feature, v * k, r.words);
        }
        break;
      }
      case "claim": {
        // "that's me" on a feature claim is evidence; prune and not-me are verdicts, read in distill
        const split = r.claim && r.claim.verdict === "me" ? splitClaimId(r.claim.id) : null;
        if (split) touch(split[0], STRENGTH.me * split[1], r.words);
        break;
      }
      case "guess": {
        // a line by Uni that fooled them sounds like them: its features lean their way, a little
        if (card?.voice?.by === "uni" && r.guess && !r.guess.right) for (const f of card.features) touch(f, 0.5, r.words);
        if (card?.voice?.by === "uni" && r.guess?.right) for (const f of card.features) touch(f, -0.25, r.words);
        break;
      }
      default:
        break; // voice and words carry words, not scores (see distill: answers)
    }
  }
  return out;
}
