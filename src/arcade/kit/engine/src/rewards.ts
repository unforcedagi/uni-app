// Small rewards: seeds that grow the Garden. Every reaction plants one; words and voice plant more, because they teach more.
// No streaks, no "you missed a day", nothing that counts down.
import type { Reaction, Stats } from "./types.ts";

export function seedsFor(r: Reaction): number {
  let s = 1;
  if (r.words && r.words.trim()) s += 2;
  if (r.kind === "voice") s += 3;
  return s;
}

export function stats(reactions: readonly Reaction[]): Stats {
  const out: Stats = { reactions: 0, seeds: 0, byGame: {}, guesses: { right: 0, total: 0 } };
  for (const r of reactions) {
    out.reactions += 1;
    out.seeds += seedsFor(r);
    if (r.game !== "import") out.byGame[r.game] = (out.byGame[r.game] ?? 0) + 1;
    if (r.kind === "guess" && r.guess) {
      out.guesses.total += 1;
      if (r.guess.right) out.guesses.right += 1;
    }
  }
  return out;
}

/** What one session taught, in a line or two: the features that moved most, strongest first. */
export function sessionLesson(before: Map<string, { score: number }>, after: Map<string, { score: number }>, max = 2): { feature: string; delta: number }[] {
  const moved: { feature: string; delta: number }[] = [];
  for (const [f, e] of after) {
    const d = e.score - (before.get(f)?.score ?? 0);
    if (Math.abs(d) >= 0.9) moved.push({ feature: f, delta: d });
  }
  return moved.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, max);
}
