// T-335 the applets registry: every applet in the drawer is described by one manifest, on the interface contract
// (contract.ts). Two kinds: a vault applet keeps its data in a vault, as notes; a door applet reaches something
// outside through a small service on the box that holds the credentials, and the app signs each call with the
// owner's key. Built-in applets are listed here; a sealed applet (an interface note hosted in a frame) joins by
// declaring `applet: {contract: 1, id, name, kind, where, searches}` in its note's metadata.
// Contract 2 (manifest2.ts) is one manifest that also says what the applet reads and writes; the shell grants exactly
// that on one card. Arcade is on it; a note may declare it too (`applet: {contract: 2, ...}`, no `interface` beside it).
// Pure: no React, no Tauri.

import { CONTRACT_VERSION, hasHidden, hasOnly, plain } from "./contract.ts";
import { CONTRACT_V2, parseManifest2, whereWords, type ManifestV2 } from "./manifest2.ts";
import { ARCADE_MANIFEST } from "../arcade/manifest.ts";

export type AppletKind = "vault" | "door";

export type AppletManifest = {
  contract: 1 | 2;
  /** Contract 2: the whole manifest (access, reach, search, screens). The words above are then the shell's, made from it. */
  v2?: ManifestV2;
  id: string;
  name: string;
  kind: AppletKind;
  /** Where its data lives, in words shown on the applet's head and on every search result from it. */
  where: string;
  /** What search can find in it (plural nouns). */
  searches: string[];
  /** Built into the app, or a sealed interface note hosted in a frame. */
  host: "native" | "sealed";
  /** One line under the name on its screen. */
  note?: string;
  /** Not built yet: the slot says so. */
  placeholder?: boolean;
  glyph: string;
};

// The `where` words are checked against how each place gets its data today:
// - Arcade: Rust calls the arcade door on the hub's host, NIP-98 signed (crates/uni-core/src/arcade.rs); the door keeps
//   the cards, reactions and taste profile on the box.
// - Studio: the look-here pins are asks, i.e. task notes in Uni's vault; the board itself is served from the box.
// - To Post: `post` notes in Uni's vault (src/post/postCore.ts), shown only when the life vault is Uni's.
// - Calendar: the calendar door on the hub's host; every event is a note in the vault and the door is the only writer,
//   checking role, op and revision (crates/uni-core/src/cal.rs).
// - Vault: VaultBrowser reads whichever vault you open.
// - Mail: the mail bridge on the hub's host holds the mail credentials (src-tauri/src/lib.rs, "Mail (T-45)").
// - Messages: the Matrix door on the hub's host signs this device in with its key (crates/uni-core/src/matrix_door.rs);
//   the Messages core on the device then keeps its own encrypted session (crates/uni-messages).
/** A contract 2 manifest as the drawer lists it: where it lives and what search finds are the shell's words, from its access. */
export function fromV2(m: ManifestV2, host: AppletManifest["host"]): AppletManifest {
  // a door with no vault beside it is a door applet; anything that keeps notes is a vault applet
  const kind: AppletKind = m.doors.length && !m.vaults.length ? "door" : "vault";
  return { contract: 2, v2: m, id: m.id, name: m.name, kind, host, glyph: m.glyph, where: whereWords(m), searches: m.search.map((s) => s.what), ...(m.note ? { note: m.note } : {}) };
}

/** A built-in on contract 2. Its manifest goes through the same parser as a note's: a bad one fails the build's tests. */
function builtIn2(raw: unknown): AppletManifest {
  const r = parseManifest2(raw, "native");
  if (!r.ok) throw new Error(`built-in applet manifest: ${r.error}`);
  return fromV2(r.manifest, "native");
}

export const BUILT_IN: readonly AppletManifest[] = [
  builtIn2(ARCADE_MANIFEST),
  { contract: 1, id: "studio", name: "Studio", kind: "vault", host: "native", glyph: "▢", where: "Uni vault, on the box", searches: ["pins"],
    note: "what Uni pinned for you on the Studio board" },
  { contract: 1, id: "topost", name: "To Post", kind: "vault", host: "native", glyph: "✎", where: "Uni vault, on the box", searches: ["posts"],
    note: "every post is a note; nothing goes out until you sign it" },
  { contract: 1, id: "recipes", name: "Recipes", kind: "vault", host: "native", glyph: "❀", where: "not built yet", searches: [], placeholder: true },
  { contract: 1, id: "calendar", name: "Calendar", kind: "vault", host: "native", glyph: "▦", where: "calendar door, on the box", searches: ["events"],
    note: "every event is a note; a guard on the box checks each change" },
  { contract: 1, id: "vault", name: "Vault", kind: "vault", host: "native", glyph: "▤", where: "the vault you open", searches: ["notes"] },
  { contract: 1, id: "mail", name: "Mail", kind: "door", host: "native", glyph: "✉", where: "mail bridge, on the box", searches: ["mail"] },
  { contract: 1, id: "messages", name: "Messages", kind: "door", host: "native", glyph: "❝", where: "Matrix, signed in through the box", searches: ["messages"],
    note: "the box signs this device in; it keeps its own encrypted session" },
];

export const APPLET_LIMITS = { id: 40, name: 40, where: 80, note: 120, search: 40, searches: 8, glyph: 1 };

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEYS = ["contract", "id", "name", "kind", "where", "searches", "note", "glyph"];
/** Built-in ids a note may not take; a placeholder's slot it may (that is how Recipes arrives). */
const RESERVED = new Set(BUILT_IN.filter((a) => !a.placeholder).map((a) => a.id));
const DEFAULT_GLYPH = "◇";

export type AppletParse = { ok: true; manifest: AppletManifest } | { ok: false; error: string };

/** A short visible line: a string, trimmed non-empty, within `max` code points, nothing hidden, one line. */
function line(x: unknown, max: number): string | null {
  if (typeof x !== "string" || hasHidden(x) || /[\n\t]/.test(x)) return null;
  const s = x.trim();
  return s && [...s].length <= max ? s : null;
}

/**
 * Validate the `applet` value of a note's metadata. Strict: unknown keys, another contract, an unknown kind, hidden
 * characters, over-long strings and a non-kebab or reserved id are refused, never repaired. A sealed applet is always
 * a vault applet: the frame reaches only what the contract grants (vault.read, chat.*), never a door's credentials, so
 * a note may not claim to be a door.
 */
export function parseAppletManifest(raw: unknown): AppletParse {
  if (!plain(raw)) return { ok: false, error: "applet must be an object" };
  if (raw.contract === CONTRACT_V2) {
    const r = parseManifest2(raw, "sealed");
    if (!r.ok) return r;
    if (RESERVED.has(r.manifest.id)) return { ok: false, error: `id ${r.manifest.id} belongs to a built-in applet` };
    return { ok: true, manifest: fromV2(r.manifest, "sealed") };
  }
  if (!hasOnly(raw, KEYS)) return { ok: false, error: "applet has a key the contract doesn't know" };
  if (raw.contract !== CONTRACT_VERSION) return { ok: false, error: `unsupported contract ${String(raw.contract)}` };
  const id = typeof raw.id === "string" && raw.id.length <= APPLET_LIMITS.id && ID.test(raw.id) ? raw.id : null;
  if (!id) return { ok: false, error: "id must be short kebab-case (a-z, 0-9, -)" };
  if (RESERVED.has(id)) return { ok: false, error: `id ${id} belongs to a built-in applet` };
  const name = line(raw.name, APPLET_LIMITS.name);
  if (!name) return { ok: false, error: "name must be one short visible line" };
  if (raw.kind === "door") return { ok: false, error: "a sealed applet can't be a door" };
  if (raw.kind !== "vault") return { ok: false, error: `unknown kind ${String(raw.kind)}` };
  const where = line(raw.where, APPLET_LIMITS.where);
  if (!where) return { ok: false, error: "where must be one short visible line" };
  if (!Array.isArray(raw.searches) || raw.searches.length > APPLET_LIMITS.searches) return { ok: false, error: "searches must be a short list" };
  const searches: string[] = [];
  for (const s of raw.searches) {
    const v = line(s, APPLET_LIMITS.search);
    if (!v) return { ok: false, error: "each search is one short word or phrase" };
    searches.push(v);
  }
  const manifest: AppletManifest = { contract: 1, id, name, kind: "vault", where, searches, host: "sealed", glyph: DEFAULT_GLYPH };
  if (raw.note !== undefined) {
    const note = line(raw.note, APPLET_LIMITS.note);
    if (!note) return { ok: false, error: "note must be one short visible line" };
    manifest.note = note;
  }
  if (raw.glyph !== undefined) {
    const glyph = line(raw.glyph, APPLET_LIMITS.glyph);
    if (!glyph || /\s/.test(glyph)) return { ok: false, error: "glyph must be one visible character" };
    manifest.glyph = glyph;
  }
  return { ok: true, manifest };
}

/**
 * The registry with sealed applets joined: one whose id matches a placeholder takes its slot; the rest follow, in the
 * order given. A repeated id keeps its first manifest.
 */
export function joinApplets(builtIn: readonly AppletManifest[], sealed: readonly AppletManifest[]): AppletManifest[] {
  const taken = new Set<string>();
  const sealedById = new Map<string, AppletManifest>();
  for (const s of sealed) if (!sealedById.has(s.id)) sealedById.set(s.id, s);
  const out: AppletManifest[] = [];
  for (const a of builtIn) {
    const s = a.placeholder ? sealedById.get(a.id) : undefined;
    out.push(s ?? a); taken.add(a.id);
  }
  for (const s of sealedById.values()) if (!taken.has(s.id)) { out.push(s); taken.add(s.id); }
  return out;
}

export type AppletFlags = { calendar: boolean; messages: boolean; uniGlue: boolean };
/** The applets that need Uni's own vault as the life vault (App.tsx: `showUniGlue(lifeVault)`). */
const UNI_GLUE = new Set(["arcade", "studio", "topost"]);

/** The applets this device shows, in drawer order: Calendar and Messages once their door answered, Uni's own only with Uni's vault. */
export function visibleApplets(list: readonly AppletManifest[], flags: AppletFlags): AppletManifest[] {
  return list.filter((a) => {
    if (a.host !== "native") return true;
    if (a.id === "calendar") return flags.calendar;
    if (a.id === "messages") return flags.messages;
    if (UNI_GLUE.has(a.id)) return flags.uniGlue;
    return true;
  });
}

/** What wants a look in each applet, by id (unread mail, posts waiting for you). Absent = nothing. */
export type AppletCounts = Partial<Record<string, number>>;

/** A count as a tile shows it: a whole number above zero, else 0. */
export const countOf = (counts: AppletCounts, id: string): number => {
  const n = counts[id];
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/** The bar's Applets badge: the counts of the applets shown, only. */
export function totalCount(counts: AppletCounts, visible: readonly AppletManifest[]): number {
  return visible.reduce((n, a) => n + countOf(counts, a.id), 0);
}
