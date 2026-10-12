// The Life OS profile (pure, unit-tested in scripts/profile.test.ts): everything that differs between one Life OS vault and another.
// `defaultProfile()` is exactly today's Uni vault. No React, no Tauri.

export type VaultProfile = {
  vault: string;
  /** The root node's display title. */
  title: string;
  /** The tag on the root note (`uni` in Uni's vault, `root` in the life-os pack). */
  rootTag: string;
  /** The owner value that means the signed-in person, and how it reads. */
  me: string;
  meLabel: string;
  /** Owners shown as "agents"; a task owned by one of these (or by a room) is not the person's. */
  agentOwners: string[];
  /** Owner prefix for chat rooms (`room:`), or null when the vault has none. */
  roomOwnerPrefix: string | null;
  /** Areas live at `<areaPrefix><Name>`; null = parent references only. */
  areaPrefix: string | null;
  briefs: { mode: "paths" | "none" };
  chat: { provider: "buzz" | null };
};

export const UNI_VAULT = "uni";

/** Today's Uni values. The uni vault must keep behaving exactly like this. */
export function defaultProfile(vault: string = UNI_VAULT): VaultProfile {
  return { vault, title: "Uni", rootTag: "uni", me: "aaron", meLabel: "You", agentOwners: ["uni"], roomOwnerPrefix: "room:", areaPrefix: "Areas/", briefs: { mode: "paths" }, chat: { provider: "buzz" } };
}

/** Defaults for a vault that has the pack but no profile note: the pack's own vocabulary, no Uni glue. */
export function packProfile(vault: string, rootTag: string): VaultProfile {
  return { vault, title: "Life", rootTag, me: "me", meLabel: "You", agentOwners: ["uni", "agent"], roomOwnerPrefix: null, areaPrefix: null, briefs: { mode: "none" }, chat: { provider: null } };
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : null); // profile strings are labels and owner ids: capped

/** A profile note's settings: JSON in `metadata`, else the first fenced block (```json or bare) in the content. Unknown or invalid fields are ignored. */
export function readProfileNote(note: { content?: string | null; metadata?: unknown } | null | undefined): Partial<VaultProfile> | null {
  if (!note) return null;
  const meta = note.metadata && typeof note.metadata === "object" ? (note.metadata as Record<string, unknown>) : {};
  const known = ["title", "rootTag", "me", "agentOwners", "roomOwnerPrefix", "areaPrefix", "briefs", "chat"];
  let raw: unknown = known.some((k) => k in meta) ? meta : null;
  if (!raw) {
    const m = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(note.content ?? "");
    if (m) { try { raw = JSON.parse(m[1]); } catch { raw = null; } }
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: Partial<VaultProfile> = {};
  if (str(r.title)) out.title = str(r.title)!;
  if (str(r.rootTag)) out.rootTag = str(r.rootTag)!;
  if (str(r.me)) out.me = str(r.me)!;
  if (str(r.meLabel)) out.meLabel = str(r.meLabel)!;
  if (Array.isArray(r.agentOwners)) out.agentOwners = r.agentOwners.map(str).filter((s): s is string => !!s);
  if (r.roomOwnerPrefix === null) out.roomOwnerPrefix = null; else if (str(r.roomOwnerPrefix)) out.roomOwnerPrefix = str(r.roomOwnerPrefix)!;
  if (r.areaPrefix === null) out.areaPrefix = null; else if (str(r.areaPrefix)) out.areaPrefix = str(r.areaPrefix)!;
  const briefs = r.briefs as { mode?: unknown } | null | undefined;
  if (briefs && (briefs.mode === "paths" || briefs.mode === "none")) out.briefs = { mode: briefs.mode };
  const chat = r.chat as { provider?: unknown } | null | undefined;
  if (chat && (chat.provider === "buzz" || chat.provider === null)) out.chat = { provider: chat.provider };
  return Object.keys(out).length ? out : null;
}

/**
 * The profile for a vault. `uni` without a note is exactly today's behaviour. Otherwise: the note's settings over the pack defaults,
 * where the root tag defaults to `root` if that tag has notes, else `uni`.
 */
export function resolveProfile(vault: string, note: Partial<VaultProfile> | null, rootHasNotes: boolean): VaultProfile {
  const base = vault === UNI_VAULT ? defaultProfile(vault) : packProfile(vault, rootHasNotes ? "root" : "uni");
  return { ...base, ...(note ?? {}), vault };
}

// ── The module's current profile, for code that is not a React component (task parsing, the Tauri-facing data layer).
let active: VaultProfile = defaultProfile();
export const activeProfile = (): VaultProfile => active;
export function setActiveProfile(p: VaultProfile): void { active = p; }

/** Owner classification helpers shared by taskCore and the labels. */
export const isMe = (owner: string, p: VaultProfile = active) => owner === p.me;
export const isAgentOwner = (owner: string, p: VaultProfile = active) => p.agentOwners.includes(owner) || (!!p.roomOwnerPrefix && owner.startsWith(p.roomOwnerPrefix));

// ── Which vault the Life OS surface shows. Persisted on the device (not in vault.json, which also decides where the journal writes).
export const VAULT_CHOICE_KEY = "uni.lifeos.vault";
type Store = Pick<Storage, "getItem" | "setItem">;
const validVault = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]+$/.test(v);
export function readVaultChoice(store: Store | null): string {
  try { const v = store?.getItem(VAULT_CHOICE_KEY); return validVault(v) ? v : UNI_VAULT; } catch { return UNI_VAULT; }
}
export function writeVaultChoice(store: Store | null, vault: string): void {
  if (!validVault(vault)) return;
  try { store?.setItem(VAULT_CHOICE_KEY, vault); } catch { /* storage unavailable: the choice lasts this session */ }
}
/** The choices to offer: the vault list, `uni` first when present. A saved choice that no longer exists falls back to `uni`. */
export function vaultChoices(vaults: readonly string[]): string[] {
  return [...vaults].sort((a, b) => (a === UNI_VAULT ? -1 : b === UNI_VAULT ? 1 : a.localeCompare(b)));
}
