// T-335 a sealed applet: an interface note (HTML, run in the sealed frame on this contract) that joins the applets drawer.
// Its note is tagged `applet` and its metadata carries either
//   contract 2, one manifest (manifest2.ts):
//     applet: {contract: 2, id, name, access: [{vault: "here", allow: [{path: "Seeds/", verbs: ["read"]}]}],
//              reach: [{room: "<room id>", verbs: ["read", "draft"]}], search: [{what: "seeds", vault: "here", path: "Seeds/"}]}
//   or contract 1, the pair:
//     applet:    {contract: 1, id, name, kind: "vault", where, searches, glyph?, note?}   (applets.ts, parseAppletManifest)
//     interface: {contract: 1, needs: [{"vault.read": "Seeds/"}, {"chat.read": "<room id>"}, ...]}   (manifest.ts, parseManifest)
// Both come to the same needs, the same card and the same router. A drawer applet has no area and no room of its own, so every
// scope must be explicit: a folder prefix it declares, or a room id this device has. The symbolic `area` scope (and the default
// needs, which are all `area`) is refused, never guessed at.
// Pure: no React, no Tauri.

import { parseAppletManifest, type AppletManifest } from "./applets.ts";
import { plain, stripExt } from "./contract.ts";
import { parseManifest, resolveNeeds, type HostContext, type Need, type Resolved } from "./manifest.ts";
import type { ManifestV2 } from "./manifest2.ts";
import type { Grant } from "./grant2.ts";

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
    const v2 = parsed.manifest.v2;
    const m = v2 || meta.interface === undefined || meta.interface === null ? null : parseManifest(meta, NO_PLACE);
    // contract 2: search looks where the manifest offers; contract 1: in every folder it reads
    const prefixes = v2 ? [...new Set(v2.search.flatMap((o) => (o.path ? [o.path] : [])))]
      : m?.ok ? [...new Set(m.manifest.needs.filter((n) => n.cap === "vault.read" && n.scope !== "area").map((n) => n.scope))] : [];
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
  const known = new Set(rooms);
  let needs: Need[];
  if (applet.manifest.v2) {
    // one manifest: a second, older one beside it could only disagree with it
    if (meta.interface !== undefined && meta.interface !== null) return { ok: false, error: "a contract 2 applet has one manifest. Its note must not carry interface too" };
    needs = needsOfV2(applet.manifest.v2);
  } else {
    if (meta.interface === undefined || meta.interface === null) return { ok: false, error: "it declares no needs. A drawer applet must name the folders it reads" };
    const m = parseManifest(meta, NO_PLACE);
    if (!m.ok) return { ok: false, error: `its interface manifest is invalid: ${m.error}` };
    needs = m.manifest.needs;
  }
  for (const n of needs) {
    if (n.scope === "area") return { ok: false, error: `it asks for ${n.cap} in "area", and an applet in the drawer has no area. It must name a folder or a room` };
    if (n.cap !== "vault.read" && !known.has(n.scope)) return { ok: false, error: `it asks for ${n.cap} in a room this device doesn't have` };
  }
  const resolved = resolveNeeds(needs, NO_PLACE);
  return { ok: true, manifest: applet.manifest, needs, resolved, prefixes: resolved["vault.read"] ?? [] };
}

/** A contract 2 sealed manifest as the frame's needs. The parser already held it to what the frame can do: folders to read, rooms. */
function needsOfV2(m: ManifestV2): Need[] {
  const needs: Need[] = [];
  for (const v of m.vaults) for (const r of v.allow) if (r.path !== undefined) needs.push({ cap: "vault.read", scope: r.path });
  for (const r of m.reach) if (r.kind === "room") {
    if (r.verbs.includes("read")) needs.push({ cap: "chat.read", scope: r.room });
    if (r.verbs.includes("draft")) needs.push({ cap: "chat.draft", scope: r.room });
  }
  return needs;
}

/** The folder an applet's note lives in ("Recipes/" for `Recipes/Recipe book`), or null at the vault's top. */
export const ownFolder = (notePath: string): string | null => { const p = stripExt(notePath); const i = p.lastIndexOf("/"); return i > 0 ? p.slice(0, i + 1) : null; };

/**
 * A sealed applet's needs as a grant, for the card (grant2.ts `grantLines`): the folders it reads in the vault its note is in,
 * and each room it reaches, read and draft on one row.
 */
export function needsGrant(needs: readonly Need[], vault: string, applet: { id: string; name: string }): Grant {
  const allow = needs.filter((n) => n.cap === "vault.read").map((n) => ({ path: n.scope, verbs: ["read" as const], own: false }));
  const rooms = [...new Set(needs.filter((n) => n.cap !== "vault.read").map((n) => n.scope))];
  return {
    applet: { ...applet, author: "note" },
    vaults: allow.length ? [{ vault, allow }] : [],
    doors: [],
    reach: rooms.map((room) => ({ kind: "room" as const, room, verbs: (["read", "draft"] as const).filter((v) => needs.some((n) => n.scope === room && n.cap === (v === "read" ? "chat.read" : "chat.draft"))) })),
  };
}
