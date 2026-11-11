// T-335 the shape: home is rooms, a room is its chat plus a strip, the journal, the applets drawer, search where you are.
// These are the few types the pieces share. Pure data; no React, no Tauri.

/** A room as the host knows it (App.tsx `Room`). */
export type ShapeRoom = { id: string; name: string; last_message: string | null; last_ts: number | null; mentions?: boolean; unread?: number; dm?: boolean | null };

/** An ask that needs the owner (a vault task with `needs_aaron: true`), placed in its room. */
export type Ask = {
  /** The task note's id. */ id: string;
  /** Its T-number, when it has one. */ tid: string | null;
  /** The channel id of the room it belongs to; null when its room isn't one this device has (it then shows in Uni's room). */ room: string | null;
  kind: "do" | "choose" | "look" | "tell" | "decision";
  /** The one line that says what is wanted. */ what: string;
  /** (added, T-335 fixes) Its next action as the room wrote it (`next`): what to do now, in one line; null when it says none. */ next?: string | null;
  /** Why, or the ask's context, when the ask carries it. */ why: string | null;
  /** Choices to answer with (may be empty). */ options: string[];
  /** The choice taken if the owner says nothing: its value and label. */ fallback: { value: string; label: string } | null;
  /** A single action word ("Done"), when the ask is a thing to do. */ action: string | null;
  /** A link to look at. */ link: string | null;
  /** Seconds. */ updatedAt: number;
  /** (added, T-335) The message an answer threads under (`reply_root`), only in the room it names: its quick replies give way to the ask's buttons. */ replyRoot?: string | null;
  /** (added, T-335) Its room is private: drawn in full only inside that room (its chat and strip); home shows a wordless mark. */ private?: boolean;
};

/** What a room's worker is doing, or waiting for: one line on home and in the room's strip. */
export type RoomRun = {
  /** The run note's id: its story opens from it. */ id: string;
  state: "moving" | "waiting";
  /** What the run is for. */ title: string;
  /** Moving: the step it is on now. Waiting: what it waits on the owner for. */ line: string;
  /** Seconds. */ startedAt: number | null;
  /** (added, T-335 fixes) The task it works on (`T-NN`), when its note names one: a waiting run opens that task's ask when it is one. */ task?: string | null;
};
export type RoomRuns = { moving: RoomRun | null; waiting: RoomRun | null };

/** An approval card about to expire, pinned over the rooms. */
export type Pin = { ref: string; room: string; roomName: string; what: string; detail: string | null; /** Unix seconds. */ expires: number; sealed: boolean;
  /** (added, T-335) From a private room: drawn on home without its words (no card, no command, no room name), opened in its room. */ private?: boolean };

/** One row of home. */
export type HomeRow = {
  room: ShapeRoom;
  /** Seconds; what the list is sorted by, newest first. */ at: number;
  runs: RoomRuns;
  asks: Ask[];
  /** (added, T-335) Asks waiting in this private room: counted, drawn on home only as a wordless mark (their words stay inside). */ hushed?: number;
  unread: number; mention: boolean;
};
