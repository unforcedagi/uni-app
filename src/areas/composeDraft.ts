/** Add `text` to a room's unsent draft: after a blank line when there is one, never replacing it. */
export function appendDraft(existing: string | undefined, text: string): string {
  const old = existing?.trim();
  return old ? `${old}\n\n${text}` : text;
}
