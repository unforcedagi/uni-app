// chat module: read recent messages of the granted rooms, and *suggest* a draft.
// A draft is a pending suggestion shown by the host (consent.tsx); this module
// has no way to touch a composer, and nothing here can post.

import { cleanText, hasOnly, LIMITS, lineCount, plain, stripHidden } from "../contract.ts";
import type { UniModule } from "../router.ts";
import type { SuggestionInput } from "../suggestions.ts";

export type RoomMessage = { ref: string; author: string; author_name?: string | null; ts: number; body: string };
export type ChatDeps = {
  getMessages(room: string, limit: number): Promise<RoomMessage[]>;
  /** Record a pending suggestion. Must not act. */
  suggest(s: SuggestionInput): unknown;
  roomName(room: string): string;
};
const MAX_CONTENT = 4000;
const MAX_AUTHOR = 80;

export function createChatModule(deps: ChatDeps): UniModule {
  return {
    namespace: "chat",
    methods: {
      recent: {
        cap: "chat.read",
        validate: (p: unknown) => {
          const o = p === undefined ? {} : p;
          if (!plain(o) || !hasOnly(o, ["limit"])) return { ok: false };
          if (o.limit === undefined) return { ok: true, value: { limit: LIMITS.maxRecent } };
          return typeof o.limit === "number" && Number.isInteger(o.limit) && o.limit >= 1 && o.limit <= LIMITS.maxRecent ? { ok: true, value: { limit: o.limit } } : { ok: false };
        },
        async run({ limit }: { limit: number }, scopes) {
          const rooms = scopes["chat.read"] ?? [];
          const lists = await Promise.all(rooms.map((r) => deps.getMessages(r, limit).catch(() => [] as RoomMessage[])));
          const messages = lists.flat().sort((a, b) => b.ts - a.ts).slice(0, limit).map((m) => ({
            id: m.ref, author: stripHidden(m.author_name || m.author.slice(0, 8)).slice(0, MAX_AUTHOR), content: stripHidden(m.body).slice(0, MAX_CONTENT), created_at: new Date(m.ts * 1000).toISOString(),
          }));
          return { messages };
        },
      },
      draft: {
        cap: "chat.draft",
        validate: (p: unknown) => {
          if (!plain(p) || !hasOnly(p, ["text", "room"])) return { ok: false };
          if (typeof p.text !== "string" || p.text.length > LIMITS.maxDraft) return { ok: false };
          // What is shown and what is inserted are the same cleaned text.
          const text = cleanText(p.text);
          if (!text.trim() || lineCount(text) > LIMITS.maxDraftLines) return { ok: false };
          if (p.room !== undefined && (typeof p.room !== "string" || !p.room || p.room.length > 100)) return { ok: false };
          return { ok: true, value: { text, room: p.room as string | undefined } };
        },
        scopeCheck: (scopes, v: { room?: string }) => { const rooms = scopes["chat.draft"] ?? []; return v.room === undefined ? rooms.length > 0 : rooms.includes(v.room); },
        async run(v: { text: string; room?: string }, scopes, ctx) {
          const room = v.room ?? (scopes["chat.draft"] ?? [])[0];
          if (!ctx.closed()) deps.suggest({ kind: "draft", room, text: v.text });
          return { pending: true, room };
        },
      },
    },
  };
}
