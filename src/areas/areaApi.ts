// The bridge methods for one area, with their side effects injected so the
// scoping rules are unit-testable without Tauri. Everything is read-only
// except `compose` (draft only) and `open` (navigation inside the area).

import { areaNotes, scopedPath, type Area, type PathRow } from "./areasCore.ts";
import type { BridgeApi } from "./bridge.ts";

export type RoomMessage = { ref: string; author: string; author_name?: string | null; ts: number; body: string };
export type AreaDeps = {
  /** Paths in the `uni` vault (a fresh listing). */
  listPaths(): Promise<PathRow[]>;
  getNote(path: string): Promise<{ id: string; path?: string | null; content?: string | null; updatedAt?: string | null }>;
  getMessages(channel: string, limit: number): Promise<RoomMessage[]>;
  /** Put `text` in the room's composer draft and show the room. Never sends. */
  compose(channel: string, text: string): void;
  /** The display name of a room, for the compose reply. */
  roomName(channel: string): string;
  openNote(ref: string): void;
};

const MAX_CONTENT = 4000;

export function createAreaApi(area: Area, deps: AreaDeps): BridgeApi {
  return {
    areaGet: async () => ({ title: area.title, body: area.body, metadata: area.metadata, updatedAt: area.updatedAt }),
    notesList: async (limit) => ({ notes: areaNotes(await deps.listPaths(), area.path, limit) }),
    noteGet: async (path) => {
      const clean = scopedPath(area.path, path);
      if (!clean) throw new Error("out_of_scope");
      const note = await deps.getNote(clean);
      return { path: clean, content: note.content ?? "", updatedAt: note.updatedAt ?? null };
    },
    channelRecent: async (limit) => {
      const lists = await Promise.all(area.channels.map((c) => deps.getMessages(c, limit).catch(() => [])));
      const messages = lists.flat().sort((a, b) => b.ts - a.ts).slice(0, limit).map((m) => ({
        id: m.ref, author: m.author_name || m.author.slice(0, 8), content: m.body.slice(0, MAX_CONTENT), created_at: new Date(m.ts * 1000).toISOString(),
      }));
      return { messages };
    },
    channelCompose: async (text) => {
      const channel = area.channels[0];
      if (!channel) throw new Error("no_channel");
      deps.compose(channel, text);
      return { ok: true, room: deps.roomName(channel) };
    },
    noteOpen: async (ref) => {
      const clean = scopedPath(area.path, ref);
      if (!clean) throw new Error("out_of_scope");
      deps.openNote(clean);
      return { ok: true };
    },
  };
}
