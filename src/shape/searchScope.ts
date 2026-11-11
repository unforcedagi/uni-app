// T-335 the shape: search starts where you are and groups what it finds by place. Every place says where it lives,
// and matches elsewhere are never blended in: they are counted apart ("Also in: Place N"). Pure; tested in
// scripts/search.test.ts.
import { hitTarget, plainSnippet } from "../searchCore.ts";
import type { NoteHit, SearchHit } from "../searchCore.ts";

/** Where the person is when they open search. */
export type Where =
  | { kind: "home" }
  | { kind: "room"; id: string; name: string }
  | { kind: "journal" }
  /** An applet. With a vault (and maybe a folder) its notes are its search source; without one (Mail, Messages) it has none here. */
  | { kind: "applet"; id: string; name: string; vault?: string | null; pathPrefix?: string | null }
  /** The vault browser, or a folder in it (`pathPrefix`, an optional addition: search opened on a folder). */
  | { kind: "vault"; vault: string; pathPrefix?: string | null };

/** A place results can live in. id: "room:<id>" | "journal" | "vault:<name>" | "applet:<id>" | "folder:<vault>:<prefix>". */
export type Place = { id: string; name: string; /** Words for where it lives ("a room on this device", "uni vault"); may be empty when the name says it. */ where: string };

export type SearchCtx = {
  rooms: readonly { id: string; name: string }[];
  vaults: readonly string[];
  /** The journal's vault and path prefix ("Journal/"), or null when unknown. */
  journal: { vault: string; prefix: string } | null;
  primaryVault: string | null;
  /** Where search was opened: an applet or a folder there is a place of its own. */
  here?: Where;
};

export type HitOpen =
  | { kind: "message"; target: { channel: string; root: string | null; focus: string } }
  | { kind: "note"; note: NoteHit };
export type Hit = {
  key: string;
  title: string;
  /** Messages: the store's snippet, with SNIPPET_START/END around matches. Notes: plain prose. */
  text: string;
  /** Small words beside the title: "in thread", "edited", a note's folder. */
  meta: string[];
  /** Seconds, for messages. */
  ts: number | null;
  open: HitOpen;
};
export type Group = { place: Place; hits: Hit[] };
export type Scope = { label: string; placeIds: string[] };

/** In a scope's placeIds: every room, including ones the host's list doesn't name. */
export const ANY_ROOM = "room:*";
/** In a scope's placeIds: every vault (the old Find, opened without knowing the journal, searched all notes). */
export const ANY_VAULT = "vault:*";

const trimSlash = (p: string) => p.replace(/^\/+|\/+$/g, "");
const folderId = (vault: string, prefix: string) => `folder:${vault}:${trimSlash(prefix)}`;

function homeScope(ctx: SearchCtx): Scope {
  const rooms = [...ctx.rooms.map((r) => `room:${r.id}`), ANY_ROOM];
  return ctx.journal ? { label: "rooms and the journal", placeIds: [...rooms, "journal"] } : { label: "your rooms", placeIds: rooms };
}

/** Where search looks, from where you are. A place with nothing to search here (Mail, Messages) searches from home instead. */
export function scopeOf(where: Where, ctx: SearchCtx): Scope {
  switch (where.kind) {
    case "room": return { label: where.name, placeIds: [`room:${where.id}`] };
    case "journal": return ctx.journal ? { label: "the journal", placeIds: ["journal"] } : homeScope(ctx);
    case "vault": {
      const prefix = trimSlash(where.pathPrefix ?? "");
      return prefix ? { label: `${prefix.split("/").pop()} in the ${where.vault} vault`, placeIds: [folderId(where.vault, prefix)] }
        : { label: `the ${where.vault} vault`, placeIds: [`vault:${where.vault}`] };
    }
    case "applet": return where.vault ? { label: where.name, placeIds: [`applet:${where.id}`] } : homeScope(ctx);
    default: return homeScope(ctx);
  }
}

/**
 * The one narrow vault search the scope needs ("here"), besides the search across every vault that counts "also in".
 * Null when the scope has no notes (a room).
 */
export function hereNotes(where: Where, ctx: SearchCtx): { vault: string; pathPrefix: string | null } | null {
  switch (where.kind) {
    case "room": return null;
    case "vault": return { vault: where.vault, pathPrefix: trimSlash(where.pathPrefix ?? "") ? where.pathPrefix! : null };
    case "applet": if (where.vault) return { vault: where.vault, pathPrefix: where.pathPrefix || null }; break;
  }
  return ctx.journal ? { vault: ctx.journal.vault, pathPrefix: ctx.journal.prefix } : null;
}

/** Note places narrower than a vault: the journal, and the applet or folder search was opened on. */
function noteSources(ctx: SearchCtx): { id: string; vault: string; prefix: string }[] {
  const out: { id: string; vault: string; prefix: string }[] = [];
  if (ctx.journal) out.push({ id: "journal", vault: ctx.journal.vault, prefix: ctx.journal.prefix });
  const h = ctx.here;
  if (h?.kind === "applet" && h.vault) out.push({ id: `applet:${h.id}`, vault: h.vault, prefix: h.pathPrefix ?? "" });
  if (h?.kind === "vault" && trimSlash(h.pathPrefix ?? "")) out.push({ id: folderId(h.vault, h.pathPrefix!), vault: h.vault, prefix: h.pathPrefix! });
  return out;
}

const underPrefix = (path: string, prefix: string) => {
  const p = trimSlash(prefix);
  return !p || path === p || path.startsWith(p + "/");
};

/**
 * The words saying where a place lives. Every vault the app reaches comes through the one hub it is set to, and the app
 * can't tell a vault kept on the box from one in the cloud, so a vault says only its name.
 */
export function whereOf(place: { id: string }, ctx: SearchCtx): string {
  const id = place.id;
  if (id.startsWith("room:")) return "a room on this device";
  if (id === "journal") return ctx.journal ? `${ctx.journal.vault} vault` : "";
  if (id.startsWith("vault:")) return id.slice(6) === ctx.primaryVault ? "your main vault" : "";
  const src = noteSources(ctx).find((s) => s.id === id);
  if (src) return trimSlash(src.prefix) && id.startsWith("applet:") ? `${src.vault} vault, ${trimSlash(src.prefix)}` : `${src.vault} vault`;
  return "";
}

function placeFor(id: string, name: string, ctx: SearchCtx): Place {
  return { id, name, where: whereOf({ id }, ctx) };
}

function placeName(id: string, ctx: SearchCtx): string {
  if (id === "journal") return "Journal";
  if (id.startsWith("vault:")) return `${id.slice(6)} vault`;
  const h = ctx.here;
  if (id.startsWith("applet:") && h?.kind === "applet") return h.name;
  if (id.startsWith("folder:")) return id.slice(id.indexOf(":", 7) + 1).split("/").pop() || id;
  return id;
}

/** Every hit in exactly one place: a message in its room; a note in the narrowest place it falls under (journal, applet, folder), else its vault. */
export function group(results: { messages: readonly SearchHit[]; notes: readonly NoteHit[] }, ctx: SearchCtx): Group[] {
  const groups = new Map<string, Group>();
  const add = (id: string, name: () => string, hit: Hit) => {
    let g = groups.get(id);
    if (!g) { g = { place: placeFor(id, name(), ctx), hits: [] }; groups.set(id, g); }
    if (!g.hits.some((x) => x.key === hit.key)) g.hits.push(hit);
  };
  for (const h of results.messages) {
    const m = h.message, target = hitTarget(m);
    add(`room:${m.channel}`, () => ctx.rooms.find((r) => r.id === m.channel)?.name ?? h.channel_name, {
      key: `m:${m.ref}`, title: m.author_name, text: h.snippet, ts: m.ts,
      meta: [...(target.root ? ["in thread"] : []), ...(m.edited ? ["edited"] : [])], open: { kind: "message", target },
    });
  }
  const sources = noteSources(ctx);
  for (const n of results.notes) {
    const src = sources.filter((s) => s.vault === n.vault && underPrefix(n.path, s.prefix)).sort((a, b) => trimSlash(b.prefix).length - trimSlash(a.prefix).length)[0];
    const id = src?.id ?? `vault:${n.vault}`;
    const parts = n.path.split("/");
    add(id, () => placeName(id, ctx), {
      key: `n:${n.vault}:${n.id}`, title: parts.pop() || n.id, text: plainSnippet(n.snippet), ts: null,
      meta: parts.length ? [parts.join(" › ")] : [], open: { kind: "note", note: n },
    });
  }
  return [...groups.values()];
}

/** The groups that show (the scope's, or the one place you tapped under "also in"), and the rest as counts. */
export function split(groups: readonly Group[], scopeIds: readonly string[], focus: string | null): { here: Group[]; also: { place: Place; count: number }[] } {
  const inScope = (id: string) => scopeIds.includes(id) || (id.startsWith("room:") && scopeIds.includes(ANY_ROOM)) || (id.startsWith("vault:") && scopeIds.includes(ANY_VAULT));
  const here = groups.filter((g) => focus ? g.place.id === focus : inScope(g.place.id));
  return { here, also: groups.filter((g) => !here.includes(g)).map((g) => ({ place: g.place, count: g.hits.length })) };
}
