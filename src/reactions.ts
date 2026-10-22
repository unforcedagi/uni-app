// Reactions on a message (pure; tested in scripts/reactions.test.ts). Shown, never created from the app (T-124 r12).

/** `by`: who reacted and when they first did, first first; older builds and fixtures may leave it out. */
export type Reaction = { emoji: string; count: number; mine: string | null; by?: { pubkey: string; ts: number }[] };

// NIP-25: "+" is a like, "-" a dislike.
export const emojiLabel = (e: string) => e === "+" || e === "" ? "👍" : e === "-" ? "👎" : e;
