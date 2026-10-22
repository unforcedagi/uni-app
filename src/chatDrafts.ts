// T-132: a room's or thread's unsent message is kept on this device, so a reload or a room switch gives the exact text back.
// One entry per identity and scope (room, or room + thread): another identity on this device never reads it. Only the text and its
// settled @mentions are kept; attachments are not. Storage that refuses (full, private mode, blocked) never stops typing or sending:
// the caller keeps its in-memory copy and says so.

export const CHAT_DRAFT_PREFIX = "uni.chatDraft.v1:";

export type StoredDraft = { text: string; mentions: [string, string][] };

const storageKey = (identity: string, scope: string) => `${CHAT_DRAFT_PREFIX}${identity}:${scope}`;

/** The saved draft for this identity and scope, or null (none, unreadable or another shape). */
export function loadChatDraft(identity: string, scope: string): StoredDraft | null {
  try {
    const raw = localStorage.getItem(storageKey(identity, scope));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StoredDraft>;
    if (typeof v.text !== "string") return null;
    const mentions = Array.isArray(v.mentions) ? v.mentions.filter((m): m is [string, string] => Array.isArray(m) && m.length === 2 && typeof m[0] === "string" && typeof m[1] === "string") : [];
    return { text: v.text, mentions };
  } catch { return null; }
}

/** Saves (or, for no text, removes) the draft. False when the device's storage refused. */
export function saveChatDraft(identity: string, scope: string, text: string, mentions: Iterable<[string, string]> = []): boolean {
  try {
    const key = storageKey(identity, scope);
    if (!text) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ text, mentions: [...mentions] } satisfies StoredDraft));
    return true;
  } catch {
    // an older saved copy would come back after a reload as if it were the draft: it goes
    try { localStorage.removeItem(storageKey(identity, scope)); } catch { /* nothing readable is left either */ }
    return false;
  }
}
