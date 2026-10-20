// T-200 prototypes: how a note linked in chat opens. Off (null) unless a build sets VITE_T200_MODE (a | b | c), or a fixture build is
// given `?t200=a|b|c`, so the shipped app keeps today's behaviour.
export type NoteMode = "split" | "sheet" | "window";

const NAMES: Record<string, NoteMode> = { a: "split", b: "sheet", c: "window" };

function read(): NoteMode | null {
  const fromBuild = import.meta.env.VITE_T200_MODE as string | undefined;
  if (fromBuild) return NAMES[fromBuild] ?? null;
  if (import.meta.env.VITE_T200_FIXTURE !== "1") return null;
  try { return NAMES[new URLSearchParams(location.search).get("t200") ?? ""] ?? null; } catch { return null; }
}

export const NOTE_MODE: NoteMode | null = read();

/** A room's chat is what is on screen (a room, a thread, Uni or an area with its room) with no full-page note over it. */
export function chatOnScreen(tab: { kind: string } | null, channel: string | null, fullPageNotes: number): boolean {
  return !!channel && !!tab && ["room", "thread", "areas", "area"].includes(tab.kind) && !fullPageNotes;
}

/** Wide enough to put the note beside the chat. */
export const WIDE = "(min-width: 900px)";
