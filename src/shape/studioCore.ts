// T-335 the Studio applet, pure part: what Uni has pinned for you to look at on the media Studio board. A pin is an
// ask of kind "look" that carries a link. An Arcade card's look link (arcadeCore lookCard) opens the Arcade, not the
// board, so it is not a Studio pin. No React, no Tauri.
import { lookCard } from "../arcade/arcadeCore.ts";
import type { Ask } from "./types.ts";

export type StudioLook = { id: string; what: string; why: string | null; link: string; roomName: string | null };

/** The look-here pins, newest first, each with its room's name (null when the room isn't one this device has). */
export function studioLooks(asks: readonly Ask[], roomName: (id: string | null) => string | null): StudioLook[] {
  return asks
    .flatMap((a) => {
      const link = a.kind === "look" ? a.link?.trim() ?? "" : "";
      return link && lookCard(link) === null ? [{ a, link }] : [];
    })
    .sort((x, y) => y.a.updatedAt - x.a.updatedAt)
    .map(({ a, link }) => ({ id: a.id, what: a.what, why: a.why, link, roomName: roomName(a.room) }));
}
