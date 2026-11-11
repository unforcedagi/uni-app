// Contract v2: the doors the shell knows. A door is a small service on the box that holds a credential the app never
// sees; the app signs each call with the device key (NIP-98). An applet's manifest may name only a door and ops listed
// here, and the grant card says each op in the words below: the shell's words, never the applet's.
// `cmd` is the one shell command an op reaches; a door grant reaches nothing else. Pure: no React, no Tauri.

export type DoorOp = { cmd: string; words: string; /** changes something behind the door */ write: boolean };
export type Door = { name: string; ops: Readonly<Record<string, DoorOp>> };

export const DOORS: Readonly<Record<string, Door>> = {
  arcade: {
    name: "Arcade door, on the box",
    ops: {
      home: { cmd: "arcade_home", words: "see what's new and your counts", write: false },
      rounds: { cmd: "arcade_rounds", words: "deal rounds", write: false },
      profile: { cmd: "arcade_profile", words: "read your taste profile", write: false },
      media: { cmd: "arcade_media", words: "show a card's picture, sound or clip", write: false },
      react: { cmd: "arcade_react", words: "save your reactions", write: true },
      distill: { cmd: "arcade_distill", words: "ask for a fresh taste profile", write: true },
    },
  },
  calendar: {
    name: "Calendar door, on the box",
    ops: {
      session: { cmd: "cal_session", words: "see what this device may do", write: false },
      events: { cmd: "cal_events", words: "list events", write: false },
      event: { cmd: "cal_event", words: "read one event", write: false },
      conflicts: { cmd: "cal_conflicts", words: "list conflicts", write: false },
      op: { cmd: "cal_op", words: "ask the door to change an event (it checks each change)", write: true },
    },
  },
};

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
export const doorOf = (id: string): Door | null => (own(DOORS, id) ? DOORS[id] : null);
export const doorOp = (door: string, op: string): DoorOp | null => { const d = doorOf(door); return d && own(d.ops, op) ? d.ops[op] : null; };
