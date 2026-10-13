// Reactions on a message (pure; tested in scripts/reactions.test.ts). Shown, never created from the app (T-124 r12).

export type Reaction = { emoji: string; count: number; mine: string | null };

// NIP-25: "+" is a like, "-" a dislike.
export const emojiLabel = (e: string) => e === "+" || e === "" ? "👍" : e === "-" ? "👎" : e;
