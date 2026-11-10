// What the games need from wherever they run. The Uni app implements this over its signed door to the owner's machine;
// the cloud version implements it over a Worker and the browser's own storage; tests implement it in memory.
import type { Card, DealOptions, GameId, Profile, Reaction, Round, Stats } from "../../engine/src/types.ts";

export type PlayGame = Exclude<GameId, "garden">;

/** A room's "look here" pin on one card (uni-tasks `tasks.py look --board arcade`): who asked, and why, in one line. */
export interface LookPin { card: string; game: PlayGame; title?: string; room: string; why: string }

export interface VoiceCapture {
  /** ask for the mic and start recording; rejects with a readable message if the mic can't be had */
  start(): Promise<void>;
  /** stop and save; resolves with where the recording landed (in the app: a journal path), or null if nothing was kept */
  stop(): Promise<{ ref: string; seconds: number; transcript?: string } | null>;
  /** throw the recording away */
  cancel(): void;
  /** 0..1, the current input level, for the ripples (optional) */
  level?(): number;
}

export interface ArcadeHost {
  /** whose taste this is: the app says the owner's name, the cloud says "you" */
  owner: { name: string; you: boolean };
  /** which games this host offers (the cloud has no Who Said It about a real person, for instance) */
  games: GameId[];
  /** `opts`: what this screen can show (no colour, nothing moving). The host deals only what can be judged there. */
  rounds(game: PlayGame, n: number, opts?: DealOptions): Promise<Round[]>;
  /** store reactions; ids are made by the caller (crypto.randomUUID), so a retry never doubles */
  react(reactions: Reaction[]): Promise<void>;
  /** the profile as it stands, Garden verdicts applied */
  profile(): Promise<Profile>;
  stats(): Promise<Stats>;
  /** how many rounds of each game are still unplayed, for the Arcade home (optional; the door's /home has it). Without
   *  it the home asks rounds() and says how many are ready instead. */
  fresh?(opts?: DealOptions): Promise<Partial<Record<PlayGame, number>>>;
  /** look here (T-335): the cards a room pinned for the owner, each with the game that deals it (the door's /home has
   *  them). Without it, or with none, the Arcade is plain play. Pass `look` to rounds() to deal a pinned card first. */
  look?(opts?: DealOptions): Promise<LookPin[]>;
  /** a URL the page can load for a card's media, or null */
  mediaUrl(card: Card, which: "src" | "poster"): Promise<string | null>;
  /** Ripple by voice; without it, Ripple takes typed answers */
  voice?: VoiceCapture;
  /** Ripple typed answer: where it was kept (in the app, a journal entry) */
  saveAnswer?(question: Card, text: string): Promise<{ ref?: string }>;
  /** ask for a fresh read of the profile now (after a burst); never blocks play */
  distill?(): Promise<void>;
  /** everything as one markdown file (the cloud's "take it with you") */
  exportMarkdown?(): Promise<string>;
  /** open the profile where it lives (the app: the vault note) */
  openProfile?(): void;
  /** forget everything (the cloud's "start over"); the app has none */
  reset?(): Promise<void>;
}

export function newId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
