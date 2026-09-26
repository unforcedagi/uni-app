// Reaction helpers (pure; tested in scripts/reactions.test.ts).

export type Reaction = { emoji: string; count: number; mine: string | null };

// NIP-25: "+" is a like, "-" a dislike.
export const emojiLabel = (e: string) => e === "+" || e === "" ? "👍" : e === "-" ? "👎" : e;

/** Optimistic reaction toggle on the client copy (the store re-read corrects it). */
export function toggleLocal(rs: Reaction[], emoji: string, removing: boolean): Reaction[] {
  const i = rs.findIndex((r) => emojiLabel(r.emoji) === emojiLabel(emoji));
  if (removing) {
    if (i < 0) return rs;
    return rs[i].count <= 1 ? rs.filter((_, j) => j !== i) : rs.map((x, j) => j === i ? { ...x, count: x.count - 1, mine: null } : x);
  }
  if (i < 0) return [...rs, { emoji, count: 1, mine: "pending" }];
  return rs.map((x, j) => j === i ? { ...x, count: x.count + 1, mine: "pending" } : x);
}
