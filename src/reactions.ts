// Reactions on a message (pure; tested in scripts/reactions.test.ts). Shown, never created from the app (T-124 r12).

/** `by`: who reacted (pubkeys, first first); older builds and fixtures may leave it out. */
export type Reaction = { emoji: string; count: number; mine: string | null; by?: string[] };

// NIP-25: "+" is a like, "-" a dislike.
export const emojiLabel = (e: string) => e === "+" || e === "" ? "👍" : e === "-" ? "👎" : e;
