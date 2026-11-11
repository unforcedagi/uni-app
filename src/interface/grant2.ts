// Contract v2: the grant. A manifest resolved against this device (which vault is home, which rooms exist) is exactly
// what the card shows, what the owner's tap allows and what the runtime checks: one value, `Grant`, for all three.
// - `resolveGrant`: manifest + place → Grant, or a sentence saying why it can't be granted here.
// - `grantLines`: the card's rows, in the shell's words.
// - `allowsDoor` / `allowsNote` / `allowsQuery` / `allowsReach`: the runtime's questions. Anything not named is refused.
// - `grantKey`: SHA-256 of the canonical grant; the store keys the owner's tap by it, so any change asks again.
// - `grantEvents`: the same grant in the shape Parachute 1.0 proposes for an owner-signed grant, one per vault. Nothing
//   signs or sends them yet (the event kinds aren't fixed); they exist so the words match and signing is one step later.
// Pure: no React, no Tauri.

import { inScope, stripExt } from "./contract.ts";
import { doorOf, doorOp } from "./doors.ts";
import { sha256Hex } from "./manifest.ts";
import { HERE, HOME, type DoorAccess, type ManifestV2, type Reach, type Rule, type Verb, type VaultAccess } from "./manifest2.ts";

/** What the shell knows about where the applet runs. */
export type Place = {
  /** The owner's own vault (the life vault), or null when this device has none. */
  home: string | null;
  /** The vault a sealed applet's note lives in; null for a built-in. */
  here: string | null;
  /** The rooms this device has. */
  rooms: readonly { id: string; name: string }[];
  /** Who vouches for the code: "shell" for a built-in (the release is signed), else the note's author. */
  author: string;
};

export type Grant = {
  applet: { id: string; name: string; author: string };
  /** Vault access with every symbolic vault resolved to its name. */
  vaults: VaultAccess[];
  doors: DoorAccess[];
  reach: Reach[];
};
export type Resolve = { ok: true; grant: Grant } | { ok: false; error: string };

/** How long a grant lasts before the card comes back (Parachute 1.0's lean for the longest grant: a year). */
export const GRANT_DAYS = 365;
export const grantExpiry = (from: Date): Date => new Date(from.getTime() + GRANT_DAYS * 86_400_000);

export function resolveGrant(m: ManifestV2, place: Place): Resolve {
  const vaults: VaultAccess[] = [];
  for (const v of m.vaults) {
    const name = v.vault === HOME ? place.home : v.vault === HERE ? place.here : v.vault;
    if (!name) return { ok: false, error: v.vault === HOME ? "it asks for your own vault, and this device has none open" : "the vault it lives in isn't known" };
    const at = vaults.find((x) => x.vault === name);
    // (home and a vault named outright can be the same vault: one row on the card, one set of rules)
    if (at) at.allow.push(...v.allow); else vaults.push({ vault: name, allow: [...v.allow] });
  }
  const known = new Set(place.rooms.map((r) => r.id));
  for (const r of m.reach) if (r.kind === "room" && !known.has(r.room)) return { ok: false, error: "it asks for a room this device doesn't have" };
  return { ok: true, grant: { applet: { id: m.id, name: m.name, author: place.author }, vaults, doors: m.doors, reach: m.reach } };
}

// ── the runtime's questions ──

export const allowsDoor = (g: Grant, door: string, op: string): boolean => !!doorOp(door, op) && g.doors.some((d) => d.door === door && d.ops.includes(op));
export const allowsReach = (g: Grant, kind: "voice"): boolean => g.reach.some((r) => r.kind === kind);
export const allowsRoom = (g: Grant, room: string, verb: "read" | "draft"): boolean => g.reach.some((r) => r.kind === "room" && r.room === room && r.verbs.includes(verb));

/** A note as the runtime judges it: where it is, what it is tagged, and whether this grant made it. */
export type NoteFacts = { path: string | null | undefined; tags?: readonly unknown[] | null; own?: boolean };

/** A note has a type when it carries that tag or one beneath it (`post/draft` is a `post`). */
const hasType = (tags: readonly unknown[] | null | undefined, type: string) => Array.isArray(tags) && tags.some((t) => typeof t === "string" && (t === type || t.startsWith(`${type}/`)));

function ruleCovers(rule: Rule, verb: Verb, note: NoteFacts): boolean {
  if (!rule.verbs.includes(verb)) return false;
  if (rule.path !== undefined && !inScope([rule.path], note.path)) return false;
  if (rule.type !== undefined && !hasType(note.tags, rule.type)) return false;
  // a note it is making now is its own; any other is its own only when the caller knows this grant made it
  if (rule.own && verb !== "create" && note.own !== true) return false;
  return true;
}

/** May the applet do `verb` to this note in this vault? Judged on the note itself: its real path and tags. */
export function allowsNote(g: Grant, vault: string, verb: Verb, note: NoteFacts): boolean {
  return g.vaults.some((v) => v.vault === vault && v.allow.some((r) => ruleCovers(r, verb, note)));
}

/** May it list notes of this type and/or under this folder? The question itself must sit inside one read rule. */
export function allowsQuery(g: Grant, vault: string, q: { type?: string | null; pathPrefix?: string | null }): boolean {
  return g.vaults.some((v) => v.vault === vault && v.allow.some((r) => r.verbs.includes("read")
    && (r.path === undefined || (typeof q.pathPrefix === "string" && stripExt(q.pathPrefix).startsWith(r.path) && inScope([r.path], `${q.pathPrefix}x`)))
    && (r.type === undefined || (typeof q.type === "string" && (q.type === r.type || q.type.startsWith(`${r.type}/`))))));
}

// ── the card ──

/** One row of the card: where, and what there. `stress`: it changes something, or reaches outside the applet's own place. */
export type CardLine = { where: string; text: string; stress: boolean };

const VERB_WORDS: Record<Verb, string> = { read: "Read", create: "Add", update: "Change", delete: "Delete" };
const joinWords = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function ruleWords(r: Rule): string {
  const verbs = joinWords(r.verbs.map((v, i) => (i ? VERB_WORDS[v].toLowerCase() : VERB_WORDS[v])));
  const what = r.type !== undefined ? `${r.type} notes` : "notes";
  const where = r.path !== undefined ? ` in ${r.path}` : "";
  return `${verbs} ${what}${where}${r.own ? " (only the ones it made)" : ""}`;
}

/**
 * The card's rows for a grant. Every word is the shell's: a door's and an op's come from doors.ts, a room's name from this device.
 * `ownFolder` (a sealed applet: the folder its note lives in, or null at the vault's top): a folder it reads outside that one is stressed.
 */
export function grantLines(g: Grant, roomName: (id: string) => string, opts: { ownFolder?: string | null } = {}): CardLine[] {
  const sealed = "ownFolder" in opts;
  const outside = (r: Rule) => sealed && r.path !== undefined && !(opts.ownFolder && r.path.startsWith(opts.ownFolder));
  const out: CardLine[] = [];
  for (const d of g.doors) {
    const door = doorOf(d.door);
    if (!door) continue;
    const ops = Object.keys(door.ops).filter((op) => d.ops.includes(op));
    out.push({ where: door.name, text: cap(ops.map((op) => door.ops[op].words).join(" · ")), stress: ops.some((op) => door.ops[op].write) });
  }
  for (const v of g.vaults) for (const r of v.allow) {
    out.push(outside(r) && r.verbs.length === 1 && r.verbs[0] === "read"
      ? { where: `${v.vault} vault`, text: `Read notes outside this applet's folder, in ${r.path}`, stress: true }
      : { where: `${v.vault} vault`, text: ruleWords(r), stress: outside(r) || r.verbs.some((x) => x !== "read") });
  }
  for (const r of g.reach) {
    if (r.kind === "voice") out.push({ where: "This device", text: "Record your voice when you ask it to", stress: false });
    else {
      const words: string[] = [];
      if (r.verbs.includes("read")) words.push("Read recent messages");
      if (r.verbs.includes("draft")) words.push(`${words.length ? "s" : "S"}uggest drafts (you decide what is added; nothing is sent)`);
      out.push({ where: `#${roomName(r.room)}`, text: words.join(" and "), stress: true });
    }
  }
  return out;
}

// ── the key and the 1.0 shape ──

/** Canonical JSON: sorted keys, no spaces. Order inside lists is kept by the caller. */
export function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(",")}]`;
  if (x && typeof x === "object") return `{${Object.keys(x).sort().filter((k) => (x as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((x as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(x ?? null);
}

const ruleKey = (r: Rule) => canonical({ type: r.type, path: r.path, verbs: [...r.verbs].sort(), own: r.own });
/** A grant with every list in one order, so the same access always hashes the same. */
function normal(g: Grant) {
  return {
    applet: { id: g.applet.id, author: g.applet.author },
    vaults: [...g.vaults].sort((a, b) => a.vault.localeCompare(b.vault)).map((v) => ({ vault: v.vault, allow: [...new Set(v.allow.map(ruleKey))].sort() })),
    doors: [...g.doors].sort((a, b) => a.door.localeCompare(b.door)).map((d) => ({ door: d.door, ops: [...d.ops].sort() })),
    reach: g.reach.map((r) => (r.kind === "voice" ? "voice" : canonical({ room: r.room, verbs: [...r.verbs].sort() }))).sort(),
  };
}

/**
 * SHA-256 of what is granted, to whom, and (for an applet that is a note) where that note is. The applet's name is not
 * in it: a rename alone changes nothing it can reach.
 */
export function grantKey(g: Grant, notePath = ""): Promise<string> {
  return sha256Hex(canonical({ v: 2, note: stripExt(notePath), grant: normal(g) }));
}

/** "9b13 b2ae": the first eight digits of the key, to tell two cards apart (as a sealed card's "Exact job"). */
export const fingerprint = (key: string): string => `${key.slice(0, 4)} ${key.slice(4, 8)}`;

export type GrantEvent = {
  /** Not fixed yet (Parachute 1.0 spec, open call A), so nothing can be signed. */
  kind: null;
  tags: string[][];
  content: { v: 1; grantee: { kind: "applet"; id: string; author: string }; allow: { type: string; verbs: Verb[]; own?: true }[]; deny_markers: string[] };
  /** Rules the 1.0 shape can't say (a folder with no type): only the shell holds the applet to them. */
  shellOnly: Rule[];
};

/** The grant as Parachute 1.0's owner-signed event would say it: one per vault, by type and verb. Unsigned templates. */
export function grantEvents(g: Grant, expires: Date): GrantEvent[] {
  return g.vaults.map((v) => ({
    kind: null,
    tags: [["d", `applet:${g.applet.id}:${v.vault}`], ["vault", v.vault], ["expiration", String(Math.floor(expires.getTime() / 1000))]],
    content: {
      v: 1 as const,
      grantee: { kind: "applet" as const, id: g.applet.id, author: g.applet.author },
      allow: v.allow.filter((r) => r.type !== undefined && r.path === undefined).map((r) => ({ type: r.type!, verbs: r.verbs, ...(r.own ? { own: true as const } : {}) })),
      deny_markers: [],
    },
    shellOnly: v.allow.filter((r) => r.type === undefined || r.path !== undefined),
  }));
}
