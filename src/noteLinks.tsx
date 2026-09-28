import { createContext, useContext } from "react";
import type { VaultRef } from "./vaultlinks.ts";

/** Opens a vault note in the in-app note view. `href` is the original URL, if any. */
export type OpenNote = (ref: VaultRef, href: string | null) => void;

export const NoteOpener = createContext<OpenNote | null>(null);

export function useNoteOpener(): OpenNote | null {
  return useContext(NoteOpener);
}
