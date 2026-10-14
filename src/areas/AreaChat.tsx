import type { ReactNode } from "react";
import type { RoomMessage } from "../interface/modules/chat";

/** What the area view needs from the host's real room view (App owns it): its messages, and its pane (message list + composer). */
export type AreaRoom = {
  id: string;
  messages: RoomMessage[];
  /** The messages of this room are in `messages` (not a previous room's). */
  loaded: boolean;
  me: string | null;
  /** The room's own message list and composer; `above` is drawn directly over the composer; `placeholder` names the room in the line ("Message #atlas/build"). */
  render(above: ReactNode, placeholder?: string): ReactNode;
  /** Add text to the composer's draft (after any existing draft; never sends). */
  compose(text: string): void;
};

