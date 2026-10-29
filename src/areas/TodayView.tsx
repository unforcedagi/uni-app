export type RoomInfo = { id: string; name: string; last_message: string | null; last_ts: number | null;
  /** T-335: messages from others since your read marker, and whether one names you (absent in a list cached by an older app) */ unread?: number; mentions?: boolean };
