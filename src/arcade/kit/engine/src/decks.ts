// What to play next. Unseen first, then least seen; This or That pairs things of one kind that differ most, so each tap
// teaches something. Every round says what it's judging (dimensions.ts), and only what the screen can show is dealt.
import type { Card, CardKind, DealOptions, GameId, Reaction, Round } from "./types.ts";
import { askFor, canPair, dealable, dimensionOf, judgedFeatures, samePair } from "./dimensions.ts";

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

type PlayGame = Exclude<GameId, "garden">;

/** The game a card is played in (T-335 look here), first fit: The Gallery for a media card, Fix It, Ripple, Who Said It,
 * else This or That when it can stand in a pair. null: nothing can deal it on this screen. */
export function gameOf(card: Card, opts: DealOptions = {}): PlayGame | null {
  const c = dealable(card, opts);
  if (!c) return null;
  if (GALLERY_KINDS.includes(c.kind) && c.media) return "gallery";
  if (c.kind === "artifact" && c.artifact) return "fix-it";
  if (c.kind === "question") return "ripple";
  if (c.kind === "voice") return "who-said-it";
  return pairable(c, opts) ? "this-or-that" : null;
}

/** The round for one card in its own game: a room's "look here" pin, dealt first. In This or That it is paired with the
 * least-seen card it can stand beside. null: it can't be dealt here. */
export function roundFor(cardId: string, allCards: readonly Card[], reactions: readonly Reaction[], rand: Rand = Math.random, opts: DealOptions = {}): Round | null {
  const raw = allCards.find((c) => c.id === cardId);
  const card = raw ? dealable(raw, opts) : null;
  const game = card ? gameOf(card, opts) : null;
  if (!card || !game) return null;
  if (game !== "this-or-that") return { game, card, ask: askFor(game, dimensionOf(card, opts), opts) } as Round;
  const seen = seenCounts(reactions);
  const mates = freshFirst(allCards.map((c) => dealable(c, opts)).filter((c): c is Card => c !== null && c.id !== card.id && canPair(card, c, opts)), seen, rand);
  if (!mates.length) return null;
  const [a, b] = samePair(card, mates[0], opts);
  return { game, a, b, ask: askFor(game, dimensionOf(a, opts), opts) };
}

const has = (r: Round, id: string) => ("card" in r && r.card.id === id) || ("a" in r && (r.a.id === id || r.b.id === id));

export function buildRounds(game: Exclude<GameId, "garden">, allCards: readonly Card[], reactions: readonly Reaction[], n: number, rand: Rand = Math.random, opts: DealOptions = {}): Round[] {
  if (opts.look) {   // a pinned card's round first, then the deal as usual without it
    const { look, ...rest } = opts;
    const first = roundFor(look, allCards, reactions, rand, rest);
    const others = buildRounds(game, allCards, reactions, n, rand, rest);
    if (!first || first.game !== game) return others;
    const ids = "card" in first ? [first.card.id] : [first.a.id, first.b.id];   // This or That: its mate shows once too
    return [first, ...others.filter((r) => !ids.some((id) => has(r, id)))].slice(0, n);
  }
  const seen = seenCounts(reactions);
  const cards = allCards.map((c) => dealable(c, opts)).filter((c): c is Card => c !== null);
  const one = <G extends "gallery" | "fix-it" | "who-said-it" | "ripple">(g: G, card: Card) => ({ game: g, card, ask: askFor(g, dimensionOf(card, opts), opts) }) as Round;
  if (game === "this-or-that") {
    const pool = cards.filter((c) => pairable(c, opts));
    const order = freshFirst(pool, seen, rand);
    const used = new Set<string>();
    const out: Round[] = [];
    const pair = (x: Card, y: Card): Round => {
      const [a, b] = samePair(x, y, opts);
      return { game, a, b, ask: askFor(game, dimensionOf(a, opts), opts) };
    };
    for (const a of order) {
      if (out.length >= n) break;
      if (used.has(a.id)) continue;
      const mates = order.filter((b) => !used.has(b.id) && canPair(a, b, opts));
      if (!mates.length) continue;
      // among the least-seen few, the one that differs most
      const near = mates.slice(0, 8).sort((x, y) => distance(a, y) - distance(a, x));
      const b = near[0];
      used.add(a.id); used.add(b.id);
      out.push(rand() < 0.5 ? pair(a, b) : pair(b, a));
    }
    // a short deck (few cards): allow repeats of cards across rounds, never within one
    for (let guard = 0; out.length < n && pool.length >= 2 && guard < n * 4; guard++) {
      const a = pool[Math.floor(rand() * pool.length)];
      const mates = pool.filter((b) => canPair(a, b, opts));
      if (!mates.length) continue;
      out.push(pair(a, mates[Math.floor(rand() * mates.length)]));
    }
    return out;
  }
  if (game === "gallery") return freshFirst(cards.filter((c) => GALLERY_KINDS.includes(c.kind) && c.media), seen, rand).slice(0, n).map((card) => one("gallery", card));
  if (game === "fix-it") return freshFirst(cards.filter((c) => c.kind === "artifact" && c.artifact), seen, rand).slice(0, n).map((card) => one("fix-it", card));
  if (game === "ripple") return freshFirst(cards.filter((c) => c.kind === "question"), seen, rand).slice(0, n).map((card) => one("ripple", card));
  // who-said-it: alternate, so neither side is a safe guess
  const owner = freshFirst(cards.filter((c) => c.kind === "voice" && c.voice?.by === "owner"), seen, rand);
  const uni = freshFirst(cards.filter((c) => c.kind === "voice" && c.voice?.by === "uni"), seen, rand);
  const out: Round[] = [];
  while (out.length < n && (owner.length || uni.length)) {
    const fromOwner = owner.length && (!uni.length || rand() < 0.5);
    const card = (fromOwner ? owner : uni).shift()!;
    out.push(one("who-said-it", card));
  }
  return out;
}

/** Can this card stand in a pair at all: a pair kind, teaching something under these options. */
function pairable(c: Card, opts: DealOptions): boolean {
  return PAIR_KINDS.includes(c.kind) && c.features.length > 0 && judgedFeatures(c, dimensionOf(c, opts), opts.grey).length > 0;
}

/** How many rounds of each game were never played, under these options (This or That: pairs, kind by kind). */
export function freshCounts(allCards: readonly Card[], reactions: readonly Reaction[], opts: DealOptions = {}): Record<Exclude<GameId, "garden">, number> {
  const seen = new Set<string>();
  for (const r of reactions) { seen.add(r.card); if (r.other) seen.add(r.other); }
  const unseen = allCards.filter((c) => !seen.has(c.id)).map((c) => dealable(c, opts)).filter((c): c is Card => c !== null);
  const byKind = new Map<string, number>();
  for (const c of unseen) if (pairable(c, opts)) byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + 1);
  let pairs = 0;
  for (const k of byKind.values()) pairs += Math.floor(k / 2);
  return {
    "this-or-that": pairs,
    gallery: unseen.filter((c) => GALLERY_KINDS.includes(c.kind) && !!c.media).length,
    "fix-it": unseen.filter((c) => c.kind === "artifact" && !!c.artifact).length,
    "who-said-it": unseen.filter((c) => c.kind === "voice").length,
    ripple: unseen.filter((c) => c.kind === "question").length,
  };
}
