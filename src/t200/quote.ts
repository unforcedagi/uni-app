import { SHORTHAND_VAULTS, noteUrl } from "../vaultlinks.ts";

/** The note's link as chat writes it: `uni:<id>` (a chip in the room), or its hub URL for a vault the shorthand doesn't cover. */
export function noteLink(vault: string, id: string, hub: string | null): string {
  if ((SHORTHAND_VAULTS as readonly string[]).includes(vault)) return `${vault}:${id}`;
  return hub ? noteUrl(hub, vault, id) : `${vault}:${id}`;
}

/** A passage from a note as a `>` quote ending with the note's link, then a blank line to write under. */
export function quoteBlock(text: string, link: string): string {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim().split("\n").map((l) => l.trimEnd());
  if (!lines.join("").trim()) return "";
  return `${lines.map((l) => (l ? `> ${l}` : ">")).join("\n")}\n> — ${link}\n\n`;
}
