// Profile discovery (pure; unit-tested in scripts/profile.test.ts with an injected invoke): the profile note, the pack check and the root tag.
import { readProfileNote, resolveProfile, UNI_VAULT, type VaultProfile } from "./profile.ts";

export const PROFILE_NOTE = ".parachute/life-os";
export type Found = { vault: string; profile: VaultProfile; hasPack: boolean };
type Invoke = <T>(cmd: string, args: Record<string, unknown>) => Promise<T>;

/**
 * The uni vault reads only its profile note: no tag probes, so its queries stay exactly today's.
 * Another vault also checks for `node` notes (the pack) and `root` notes (the pack's root tag). A probe that fails is unknown, never "no":
 * an unanswered pack check still opens the vault, and an unanswered root check falls back to the pack's `root`.
 */
export async function discover(vault: string, invoke: Invoke): Promise<Found> {
  const note = invoke<{ note: { content?: string | null; metadata?: unknown } }>("vault_note", { vault, noteRef: PROFILE_NOTE }).then((d) => readProfileNote(d.note)).catch(() => null);
  if (vault === UNI_VAULT) return { vault, profile: resolveProfile(vault, await note, false), hasPack: true };
  const has = (tag: string) => invoke<unknown[]>("vault_query", { vault, tag, includeContent: false, limit: 1 }).then((r) => Array.isArray(r) && r.length > 0).catch(() => null);
  const [n, nodes, roots] = await Promise.all([note, has("node"), has("root")]);
  return { vault, profile: resolveProfile(vault, n, roots !== false), hasPack: nodes !== false };
}
