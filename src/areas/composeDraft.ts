/** Add `text` to a room's unsent draft: after a blank line when there is one, never replacing it. */
export function appendDraft(existing: string | undefined, text: string): string {
  const old = existing?.trim();
  // r17: "Say it" with no words to put there only opens the composer: the draft stays as it was
  if (!text.trim()) return existing ?? "";
  return old ? `${old}\n\n${text}` : text;
}
