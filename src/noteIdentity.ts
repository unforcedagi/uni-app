import type { VaultRef } from "./vaultlinks.ts";
export const ALIASES_KEY = "uni.noteAliases.v1";
export function resolveNote(ref: VaultRef, aliases: Record<string, string>): VaultRef {
  return { ...ref, ref: aliases[JSON.stringify([ref.vault, ref.ref])] ?? ref.ref };
}
export function tabHasDraft(note: VaultRef | undefined, stack: VaultRef[], aliases: Record<string, string>, read: (vault: string, id: string) => string | null): boolean {
  return [...stack, ...(note ? [note] : [])].some((ref) => {
    const resolved = resolveNote(ref, aliases);
    return !!read(resolved.vault, resolved.ref);
  });
}
