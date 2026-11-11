// Contract 2 manifests for two applets that are NOT on it yet: Calendar and To Post still call the shell's commands
// directly and ask for nothing on a card. These say what each would be granted when it moves, in the same words Arcade
// uses, so the move is a port and not a design. scripts/appletV2.test.ts keeps them valid and checks what their cards
// would say. What the move still needs from the contract is in docs/interfaces.md ("Not migrated yet").
// Plain data. Nothing in the app reads these.

/** Calendar: the calendar door is the only writer (it checks role, op and revision); every event is a note it keeps in the vault. */
export const CALENDAR_MANIFEST = {
  contract: 2,
  id: "calendar",
  name: "Calendar",
  glyph: "▦",
  note: "every event is a note; a guard on the box checks each change",
  access: [
    { door: "calendar", ops: ["session", "events", "event", "conflicts", "op"] },
    { vault: "home", allow: [{ type: "event", verbs: ["read"] }] },
  ],
  search: [{ what: "events", vault: "home", type: "event" }],
  screens: [{ id: "month", name: "Calendar" }, { id: "event", name: "An event" }],
} as const;

/** To Post: `post` notes in your own vault. Approve, edit and drop each change one note; the shell re-reads and signs it. */
export const TOPOST_MANIFEST = {
  contract: 2,
  id: "topost",
  name: "To Post",
  glyph: "✎",
  note: "every post is a note; nothing goes out until you sign it",
  access: [
    { vault: "home", allow: [{ type: "post", verbs: ["read", "update"] }] },
  ],
  search: [{ what: "posts", vault: "home", type: "post" }],
  screens: [{ id: "queue", name: "To Post" }],
} as const;

export const PLANNED = [CALENDAR_MANIFEST, TOPOST_MANIFEST] as const;
