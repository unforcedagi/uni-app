// What to play next. Unseen first, then least seen; This or That pairs things of one kind that differ most, so each tap
// teaches something.
import type { Card, CardKind, GameId, Reaction, Round } from "./types.ts";

export type Rand = () => number;

/** A small seeded random (mulberry32), so a deck can be replayed in a test. */
export function seeded(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PAIR_KINDS: readonly CardKind[] = ["image", "layout", "sound", "clip", "palette", "motion", "type", "sentence"];
export const GALLERY_KINDS: readonly CardKind[] = ["image", "layout", "clip", "sound"];

function seenCounts(reactions: readonly Reaction[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of reactions) {
    m.set(r.card, (m.get(r.card) ?? 0) + 1);
    if (r.other) m.set(r.other, (m.get(r.other) ?? 0) + 1);
  }
  return m;
}

function shuffle<T>(xs: T[], rand: Rand): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** least seen first, ties shuffled */
function freshFirst(cards: Card[], seen: Map<string, number>, rand: Rand): Card[] {
  const keyed = shuffle(cards, rand).map((c, i) => ({ c, k: (seen.get(c.id) ?? 0) * 1000 + i }));
  return keyed.sort((a, b) => a.k - b.k).map((x) => x.c);
}

function distance(a: Card, b: Card): number {
  const A = new Set(a.features), B = new Set(b.features);
  const union = new Set([...A, ...B]).size || 1;
  let both = 0;
  for (const f of A) if (B.has(f)) both++;
  return 1 - both / union;
}

export function buildRounds(game: Exclude<GameId, "garden">, cards: readonly Card[], reactions: readonly Reaction[], n: number, rand: Rand = Math.random): Round[] {
  const seen = seenCounts(reactions);
  if (game === "this-or-that") {
    const pool = cards.filter((c) => PAIR_KINDS.includes(c.kind) && c.features.length > 0);
    const order = freshFirst(pool, seen, rand);
    const used = new Set<string>();
    const out: Round[] = [];
    for (const a of order) {
      if (out.length >= n) break;
      if (used.has(a.id)) continue;
      const mates = order.filter((b) => b.id !== a.id && !used.has(b.id) && b.kind === a.kind);
      if (!mates.length) continue;
      // among the least-seen few, the one that differs most
      const near = mates.slice(0, 8).sort((x, y) => distance(a, y) - distance(a, x));
      const b = near[0];
      used.add(a.id); used.add(b.id);
      out.push(rand() < 0.5 ? { game, a, b } : { game, a: b, b: a });
    }
    // a short deck (few cards): allow repeats of cards across rounds, never within one
    for (let guard = 0; out.length < n && pool.length >= 2 && guard < n * 4; guard++) {
      const a = pool[Math.floor(rand() * pool.length)];
      const mates = pool.filter((b) => b.id !== a.id && b.kind === a.kind);
      if (!mates.length) continue;
      out.push({ game, a, b: mates[Math.floor(rand() * mates.length)] });
    }
    return out;
  }
  if (game === "gallery") return freshFirst(cards.filter((c) => GALLERY_KINDS.includes(c.kind) && c.media), seen, rand).slice(0, n).map((card) => ({ game, card }));
  if (game === "fix-it") return freshFirst(cards.filter((c) => c.kind === "artifact" && c.artifact), seen, rand).slice(0, n).map((card) => ({ game, card }));
  if (game === "ripple") return freshFirst(cards.filter((c) => c.kind === "question"), seen, rand).slice(0, n).map((card) => ({ game, card }));
  // who-said-it: alternate, so neither side is a safe guess
  const owner = freshFirst(cards.filter((c) => c.kind === "voice" && c.voice?.by === "owner"), seen, rand);
  const uni = freshFirst(cards.filter((c) => c.kind === "voice" && c.voice?.by === "uni"), seen, rand);
  const out: Round[] = [];
  while (out.length < n && (owner.length || uni.length)) {
    const fromOwner = owner.length && (!uni.length || rand() < 0.5);
    const card = (fromOwner ? owner : uni).shift()!;
    out.push({ game, card });
  }
  return out;
}
