// T-335 a sealed applet: an interface note (HTML, run in the sealed frame on this contract) that joins the applets drawer.
// Its note is tagged `applet` and its metadata carries the pair:
//   applet:    {contract: 1, id, name, kind: "vault", where, searches, glyph?, note?}   (applets.ts, parseAppletManifest)
//   interface: {contract: 1, needs: [{"vault.read": "Seeds/"}, {"chat.read": "<room id>"}, ...]}   (manifest.ts, parseManifest)
// A drawer applet has no area and no room of its own, so every scope must be explicit: a folder prefix it declares, or a room id this
// device has. The symbolic `area` scope (and the default needs, which are all `area`) is refused, never guessed at.
// Pure: no React, no Tauri.

import { parseAppletManifest, type AppletManifest } from "./applets.ts";
import { plain, stripExt } from "./contract.ts";
import { parseManifest, resolveNeeds, type HostContext, type Need, type NeedLine, type Resolved } from "./manifest.ts";

/** An applet found in the vault: its manifest, the note that holds it, and the folders it declares it reads (where search looks when it is
 *  open; the grant is decided on the note as read when it opens, never on this list). */
export type SealedEntry = { manifest: AppletManifest; noteId: string; path: string; prefixes: string[] };
export type Discovery = { entries: SealedEntry[]; /** notes tagged `applet` that were not shown (bad manifest, repeated id) */ skipped: number };
type Row = { id?: unknown; path?: unknown; tags?: unknown; metadata?: unknown };

/** No area and no room: `resolveNeeds` never meets a symbolic scope here (they are refused first), so this is never read. */
const NO_PLACE: HostContext = { areaPath: "", channels: [] };

/**
 * The drawer's sealed applets from the notes tagged `applet`. A note whose `applet` manifest doesn't parse (a door, a built-in's id,
 * an unknown key ...) is skipped and counted, never half-shown; so is a second note with an id already taken. Order: by path.
 */
export function discoverApplets(rows: readonly Row[]): Discovery {
  const entries: SealedEntry[] = [];
  const ids = new Set<string>();
  let skipped = 0;
  const sorted = [...rows].sort((a, b) => String(a.path ?? "").localeCompare(String(b.path ?? "")));
  for (const r of sorted) {
    const tagged = Array.isArray(r.tags) && r.tags.includes("applet");
    const meta = plain(r.metadata) ? r.metadata : {};
    const parsed = "applet" in meta ? parseAppletManifest(meta.applet) : null;
    if (typeof r.id !== "string" || !r.id || typeof r.path !== "string" || !r.path || !tagged || !parsed?.ok || ids.has(parsed.manifest.id)) { skipped++; continue; }
    ids.add(parsed.manifest.id);
    const m = meta.interface === undefined || meta.interface === null ? null : parseManifest(meta, NO_PLACE);
    const prefixes = m?.ok ? [...new Set(m.manifest.needs.filter((n) => n.cap === "vault.read" && n.scope !== "area").map((n) => n.scope))] : [];
    entries.push({ manifest: parsed.manifest, noteId: r.id, path: r.path, prefixes });
  }
  return { entries, skipped };
}

export type HostNeeds =
  | { ok: true; manifest: AppletManifest; needs: Need[]; resolved: Resolved; /** the vault.read folder prefixes, in the order declared */ prefixes: string[] }
  | { ok: false; error: string };

/**
 * What a loaded applet note may ask for, checked when it opens (its metadata as read then, not as listed). `rooms`: the room ids this device
 * has. Refused, with a sentence for the screen: a bad applet manifest, no `interface` (the default needs are all `area`), a bad interface
 * manifest, the `area` scope anywhere, and a chat need whose room this device doesn't have.
 */
export function appletHostNeeds(metadata: unknown, rooms: Iterable<string>): HostNeeds {
  const meta = plain(metadata) ? metadata : {};
  const applet = parseAppletManifest(meta.applet);
  if (!applet.ok) return { ok: false, error: `its applet manifest is invalid: ${applet.error}` };
  if (meta.interface === undefined || meta.interface === null) return { ok: false, error: "it declares no needs. A drawer applet must name the folders it reads" };
  const m = parseManifest(meta, NO_PLACE);
  if (!m.ok) return { ok: false, error: `its interface manifest is invalid: ${m.error}` };
  const known = new Set(rooms);
  for (const n of m.manifest.needs) {
    if (n.scope === "area") return { ok: false, error: `it asks for ${n.cap} in "area", and an applet in the drawer has no area. It must name a folder or a room` };
    if (n.cap !== "vault.read" && !known.has(n.scope)) return { ok: false, error: `it asks for ${n.cap} in a room this device doesn't have` };
  }
  const resolved = resolveNeeds(m.manifest.needs, NO_PLACE);
  return { ok: true, manifest: applet.manifest, needs: m.manifest.needs, resolved, prefixes: resolved["vault.read"] ?? [] };
}

/** The folder an applet's note lives in ("Recipes/" for `Recipes/Recipe book`), or null at the vault's top. */
export const ownFolder = (notePath: string): string | null => { const p = stripExt(notePath); const i = p.lastIndexOf("/"); return i > 0 ? p.slice(0, i + 1) : null; };

/**
 * The needs in plain words, for the grant prompt. The host writes every word; nothing comes from the app. A folder at or under the one
 * its note lives in is its own; any other folder is stressed ("outside"), as a folder outside an area's own was; a room is a conversation
 * outside it, so a chat line is always stressed.
 */
export function describeAppletNeeds(needs: readonly Need[], roomName: (id: string) => string, notePath: string): NeedLine[] {
  const own = ownFolder(notePath);
  return needs.map((n): NeedLine => {
    switch (n.cap) {
      case "vault.read": return own && n.scope.startsWith(own) ? { text: `Read notes in ${n.scope}`, outside: false } : { text: `Read notes outside this applet's folder, in ${n.scope}`, outside: true };
      case "chat.read": return { text: `Read recent messages in #${roomName(n.scope)}`, outside: true };
      case "chat.draft": return { text: `Suggest drafts for #${roomName(n.scope)} (you decide what is added; nothing is sent)`, outside: true };
    }
  });
}
