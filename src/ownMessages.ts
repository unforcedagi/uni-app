// Pure helpers for editing/deleting your own messages (kept React-free so
// scripts/ownMessages.test.ts can run them under plain node).

export type EditorKeyAction = "save" | "cancel" | null;

/** Inline editor keys: Enter saves, Shift+Enter is a newline, Esc cancels. */
export function editorKeyAction(key: string, shift: boolean, composing: boolean): EditorKeyAction {
  if (composing) return null;
  if (key === "Escape") return "cancel";
  if (key === "Enter" && !shift) return "save";
  return null;
}

/** What saving `next` over `original` should do. Buzz trims edits and rejects
 * empty ones; an unchanged text needs no event at all. */
export function editOutcome(original: string, next: string): "publish" | "unchanged" | "empty" {
  const t = next.trim();
  if (!t) return "empty";
  return t === original.trim() ? "unchanged" : "publish";
}

/** The newest message in a chronological list authored by `me` (ArrowUp in
 * an empty composer edits it — the Slack/Buzz convention). */
export function lastOwnMessage<T extends { author: string }>(list: readonly T[], me: string | null): T | null {
  if (!me) return null;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].author === me) return list[i];
  return null;
}

/** How long an armed delete button waits for the confirming second tap. */
export const DELETE_CONFIRM_MS = 4000;
