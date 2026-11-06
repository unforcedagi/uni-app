// Taste Arcade engine: the shared shapes. Pure data, no I/O. Everything here runs in a browser, a Worker and Node
// (node --experimental-strip-types), so: erasable TypeScript only (no enums, namespaces or parameter properties).

/** The five parts of a taste profile. Every card and every claim belongs to one. */
export type Domain = "visual" | "sound" | "motion" | "words" | "systems";
export const DOMAINS: readonly Domain[] = ["visual", "sound", "motion", "words", "systems"];
export const DOMAIN_NAMES: Record<Domain, string> = {
  visual: "Visual", sound: "Sound", motion: "Motion", words: "Words", systems: "Systems",
};

export type GameId = "this-or-that" | "gallery" | "fix-it" | "who-said-it" | "ripple" | "garden";
export const GAMES: readonly GameId[] = ["this-or-that", "gallery", "fix-it", "who-said-it", "ripple", "garden"];

/**
 * Anything reactable. `kind` says how it is shown; `features` say what it teaches ("visual:warm", "motion:slow").
 * A feature is `<domain>:<word>`; its meaning lives in the lexicon (features.ts) or is made up on the fly by a card
 * importer (unknown features still count, they just read plainly in a claim).
 */
export type CardKind =
  | "image"     // a still: photo, illustration, poster
  | "layout"    // a screenshot of a page or screen
  | "sound"     // an audio clip
  | "clip"      // a short video
  | "sentence"  // a line of words
  | "palette"   // a few colours, drawn live
  | "motion"    // a movement, drawn live (see MotionSpec)
  | "type"      // a type pairing, drawn live
  | "question"  // a question to answer (Ripple)
  | "artifact"  // something Uni made that is slightly off (Fix It)
  | "voice";    // a line for Who Said It: written by the owner, or by Uni as them

export interface MediaRef {
  /** A host-relative name the host resolves (in the app: a signed fetch; in the cloud: an R2 URL). Never a path. */
  src: string;
  poster?: string;
  mime?: string;
  seconds?: number;
  w?: number;
  h?: number;
}

export interface MotionSpec {
  /** what moves: a few drawn scenes the UI knows */
  scene: "rise" | "orbit" | "ripple" | "bounce" | "sway" | "unfold";
  /** seconds per cycle */
  duration: number;
  /** CSS easing */
  easing: string;
  /** 0..1, how far it travels */
  amplitude: number;
}

export interface TypeSpec { display: string; body: string; sample: string }

/** One slider in Fix It: moves a parameter between two named poles. */
export interface Axis {
  key: string;
  low: string;   // "cooler"
  high: string;  // "warmer"
  /** the feature this axis teaches, without sign: "visual:warm". Moving toward high adds to it, toward low takes away. */
  feature: string;
}

export interface Artifact {
  template: "poster" | "copy" | "motion" | "layout";
  /** the starting values, each -1..1; deliberately a little off */
  params: Record<string, number>;
  axes: Axis[];
  /** what Uni thinks is off, shown after the fix ("too corporate"); the lesson is in the gap between this and the fix */
  hunch: string;
  /** copy template: the words at each corner of the first two axes, keyed "low-low" | "low-high" | "high-low" | "high-high" | "mid" */
  variants?: Record<string, string>;
  /** poster / layout templates: the words drawn on it */
  text?: { title: string; body?: string };
}

export interface Card {
  id: string;
  kind: CardKind;
  domain: Domain;
  title: string;
  blurb?: string;
  features: string[];
  /** where it came from: a board, "generated", "public-writing" */
  source: string;
  media?: MediaRef;
  text?: string;
  palette?: string[];
  motion?: MotionSpec;
  type?: TypeSpec;
  artifact?: Artifact;
  /** Who Said It: whose line it is, and where a real one was published */
  voice?: { by: "owner" | "uni"; origin?: string; tell?: string };
  /** never leaves the owner's machine (e.g. imported from a private board) */
  private?: boolean;
}

/** The one thing a round asks about. See dimensions.ts. */
export type Dimension = "type" | "words" | "colour" | "value" | "image" | "layout" | "design" | "motion" | "sound" | "clip" | "voice" | "systems" | "claim";
export const DIMENSIONS: readonly Dimension[] = ["type", "words", "colour", "value", "image", "layout", "design", "motion", "sound", "clip", "voice", "systems", "claim"];

/** What a round says out loud: the question, and what stays the same while you answer it. */
export interface Ask { dimension: Dimension; prompt: string; detail: string }

/** What the screen can show. `grey`: no colour. `still`: nothing moves. */
export interface DealOptions { grey?: boolean; still?: boolean }

export type ReactionKind = "pick" | "keep" | "drop" | "nudge" | "pin" | "voice" | "guess" | "claim" | "words";

export type ClaimVerdict = "me" | "prune" | "not-me";

export interface Reaction {
  id: string;
  /** ISO time */
  at: string;
  game: GameId | "import";
  kind: ReactionKind;
  card: string;
  /** pick: the card that lost */
  other?: string;
  /** nudge: how far each axis moved from the start (-2..2) */
  nudges?: Record<string, number>;
  /** guess: 1 if right, 0 if wrong; `said` is who they thought wrote it */
  guess?: { said: "owner" | "uni"; right: boolean };
  /** claim: a push on one profile claim (Garden) */
  claim?: { id: string; verdict: ClaimVerdict };
  /** optional words, theirs, kept verbatim */
  words?: string;
  /** voice: where the recording landed (a journal path in the app), never the audio itself */
  voice?: { ref: string; seconds?: number };
  /** strength from an import, e.g. "love" = 1.5 */
  weight?: number;
  /** what the round was judging: only features about this are learned. Absent on imports and older reactions (all count). */
  dimension?: Dimension;
  /** seen on a greyscale screen: nothing about colour is learned from it */
  grey?: boolean;
}

export type ClaimStatus = "live" | "not-me" | "pruned";

export interface Claim {
  id: string;
  domain: Domain;
  text: string;
  /** 0..1, how sure */
  weight: number;
  /** how many reactions back it */
  evidence: number;
  status: ClaimStatus;
  /** their own words that back it, verbatim */
  quotes: string[];
  /** ISO date first seen */
  since?: string;
}

export interface Profile {
  /** ISO time of the last distil */
  updated: string;
  /** who wrote it: "local" (the engine's own rules) or a model name */
  by: string;
  summary: string;
  claims: Claim[];
  /** reactions counted when it was written */
  reactions: number;
  /** Ripple answers in their own words (Systems), newest first */
  answers: Answer[];
}

export interface Answer {
  question: string;
  words: string;
  /** where the full answer lives (a journal path in the app) */
  ref?: string;
  at: string;
}

/** What a game is handed to play: one round. */
export type Round =
  | { game: "this-or-that"; a: Card; b: Card; ask: Ask }
  | { game: "gallery"; card: Card; ask: Ask }
  | { game: "fix-it"; card: Card; ask: Ask }
  | { game: "who-said-it"; card: Card; ask: Ask }
  | { game: "ripple"; card: Card; ask: Ask };

export interface Stats {
  reactions: number;
  seeds: number;
  byGame: Partial<Record<GameId, number>>;
  /** Who Said It: right guesses of all guesses */
  guesses: { right: number; total: number };
}
