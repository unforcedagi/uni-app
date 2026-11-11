// Contract v2: one manifest for an applet. It says what the applet reads and writes (which vault, which types or
// folders, which door), what else it reaches (a room, the microphone), what it offers to search, and its screens:
//
//   applet:
//     contract: 2
//     id: arcade
//     name: Arcade
//     access:
//       - door: arcade
//         ops: [home, rounds, react]
//       - vault: home                          # home (your own vault) | here (the vault its note is in) | a vault's name
//         allow:
//           - path: Journal/                   # a folder, and/or `type: <tag>`
//             verbs: [create]                  # read | create | update | delete   (Parachute 1.0's words)
//             own: true                        # only the notes it made
//     reach: [voice, {room: <room id>, verbs: [read, draft]}]
//     search: [{what: games}]
//     screens: [{id: home, name: Arcade}]
//
// Strict: an unknown key, door, op or verb, a hidden character or an over-long value is refused, never repaired.
// Two hosts read it. `native`: an applet compiled into the app, behind the applet port (port.ts). `sealed`: an HTML
// note run in the sealed frame, which may read, add and change notes in folders of the vault it lives in (never
// delete, never its own or another applet's note) and reach rooms.
// Pure: no React, no Tauri.

import { hasHidden, hasOnly, plain, safePrefix } from "./contract.ts";
import { doorOf, doorOp } from "./doors.ts";

export const CONTRACT_V2 = 2;
export const VERBS = ["read", "create", "update", "delete"] as const;
export type Verb = (typeof VERBS)[number];
export const ROOM_VERBS = ["read", "draft"] as const;
export type RoomVerb = (typeof ROOM_VERBS)[number];

/** What an applet may do to the notes of one type and/or under one folder. */
export type Rule = { type?: string; path?: string; verbs: Verb[]; own: boolean };
export type VaultAccess = { vault: string; allow: Rule[] };
export type DoorAccess = { door: string; ops: string[] };
export type Reach = { kind: "voice" } | { kind: "room"; room: string; verbs: RoomVerb[] };
/** What search can find in it. With a folder or a type it names where the shell looks; without, the words alone. */
export type SearchOffer = { what: string; vault?: string; type?: string; path?: string };
export type Screen = { id: string; name: string };
export type ManifestV2 = {
  contract: 2; id: string; name: string; glyph: string; note?: string;
  vaults: VaultAccess[]; doors: DoorAccess[]; reach: Reach[]; search: SearchOffer[]; screens: Screen[];
};
export type HostKind = "native" | "sealed";
export type Parse2 = { ok: true; manifest: ManifestV2 } | { ok: false; error: string };

export const LIMITS2 = { id: 40, name: 40, note: 120, access: 8, rules: 8, ops: 16, reach: 6, search: 8, what: 40, screens: 8 };
/** Symbolic vaults: the owner's own vault, and the vault the applet's note lives in. */
export const HOME = "home";
export const HERE = "here";

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VAULT = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const TYPE = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/;
const KEYS = ["contract", "id", "name", "glyph", "note", "access", "reach", "search", "screens"];
const DEFAULT_GLYPH = "◇";

const fail = (error: string): Parse2 => ({ ok: false, error });
function line(x: unknown, max: number): string | null {
  if (typeof x !== "string" || hasHidden(x) || /[\n\t]/.test(x)) return null;
  const s = x.trim();
  return s && [...s].length <= max ? s : null;
}
const list = (x: unknown, max: number): unknown[] | null => (x === undefined ? [] : Array.isArray(x) && x.length <= max ? x : null);
/** A list of distinct words from `allowed`, in the order `allowed` gives them. */
function wordsOf<T extends string>(x: unknown, allowed: readonly T[]): T[] | null {
  if (!Array.isArray(x) || !x.length || x.some((v) => typeof v !== "string" || !(allowed as readonly string[]).includes(v))) return null;
  if (new Set(x).size !== x.length) return null;
  return allowed.filter((v) => x.includes(v));
}
const typeOf = (x: unknown): string | null => (typeof x === "string" && x.length <= 64 && TYPE.test(x) ? x : null);
const pathOf = (x: unknown): string | null => (typeof x === "string" && !hasHidden(x) ? safePrefix(x) : null);

function parseRule(raw: unknown): Rule | string {
  if (!plain(raw) || !hasOnly(raw, ["type", "path", "verbs", "own"])) return "each rule is {type and/or path, verbs, own?}";
  const rule: Rule = { verbs: [], own: false };
  if (raw.type !== undefined) { const t = typeOf(raw.type); if (!t) return "a type is a tag: lower-case letters, digits, - and /"; rule.type = t; }
  if (raw.path !== undefined) { const p = pathOf(raw.path); if (!p) return "a path is a plain folder that ends in /"; rule.path = p; }
  if (rule.type === undefined && rule.path === undefined) return "a rule names a type or a folder: nothing reads a whole vault";
  const verbs = wordsOf(raw.verbs, VERBS);
  if (!verbs) return `verbs are a list of ${VERBS.join(", ")}`;
  rule.verbs = verbs;
  if (raw.own !== undefined) { if (typeof raw.own !== "boolean") return "own is true or false"; rule.own = raw.own; }
  return rule;
}

/** Validate the `applet` value of a contract 2 manifest for the host that would run it. */
export function parseManifest2(raw: unknown, host: HostKind): Parse2 {
  if (!plain(raw)) return fail("applet must be an object");
  if (raw.contract !== CONTRACT_V2) return fail(`unsupported contract ${String(raw.contract)}`);
  if (!hasOnly(raw, KEYS)) return fail("applet has a key contract 2 doesn't know");
  const id = typeof raw.id === "string" && raw.id.length <= LIMITS2.id && ID.test(raw.id) ? raw.id : null;
  if (!id) return fail("id must be short kebab-case (a-z, 0-9, -)");
  const name = line(raw.name, LIMITS2.name);
  if (!name) return fail("name must be one short visible line");
  const m: ManifestV2 = { contract: 2, id, name, glyph: DEFAULT_GLYPH, vaults: [], doors: [], reach: [], search: [], screens: [] };
  if (raw.glyph !== undefined) {
    const glyph = line(raw.glyph, 1);
    if (!glyph || /\s/.test(glyph)) return fail("glyph must be one visible character");
    m.glyph = glyph;
  }
  if (raw.note !== undefined) {
    const note = line(raw.note, LIMITS2.note);
    if (!note) return fail("note must be one short visible line");
    m.note = note;
  }

  const access = list(raw.access, LIMITS2.access);
  if (!access) return fail("access must be a short list");
  for (const a of access) {
    if (!plain(a)) return fail("each access names a vault or a door");
    if ("door" in a) {
      if (!hasOnly(a, ["door", "ops"])) return fail("a door access is {door, ops}");
      if (host === "sealed") return fail("a sealed applet can't use a door: the frame holds no key");
      const door = typeof a.door === "string" ? a.door : "";
      if (!doorOf(door)) return fail(`unknown door ${door.slice(0, 40)}`);
      if (m.doors.some((d) => d.door === door)) return fail(`access names the ${door} door twice`);
      if (!Array.isArray(a.ops) || !a.ops.length || a.ops.length > LIMITS2.ops) return fail(`the ${door} door needs a short list of ops`);
      const ops: string[] = [];
      for (const op of a.ops) {
        if (typeof op !== "string" || !doorOp(door, op)) return fail(`the ${door} door has no op ${String(op).slice(0, 40)}`);
        if (!ops.includes(op)) ops.push(op);
      }
      m.doors.push({ door, ops });
      continue;
    }
    if (!hasOnly(a, ["vault", "allow"])) return fail("a vault access is {vault, allow}");
    const vault = typeof a.vault === "string" && VAULT.test(a.vault) ? a.vault : null;
    if (!vault) return fail("vault is home, here or a vault's name");
    if (host === "sealed" && vault !== HERE) return fail("a sealed applet reads only the vault it lives in: vault must be here");
    if (host === "native" && vault === HERE) return fail("a built-in applet lives in no vault: name one, or home");
    if (m.vaults.some((v) => v.vault === vault)) return fail(`access names the ${vault} vault twice`);
    if (!Array.isArray(a.allow) || !a.allow.length || a.allow.length > LIMITS2.rules) return fail(`the ${vault} vault needs a short list of rules`);
    const allow: Rule[] = [];
    for (const r of a.allow) {
      const rule = parseRule(r);
      if (typeof rule === "string") return fail(rule);
      if (host === "sealed" && rule.verbs.includes("delete")) return fail("a sealed applet can't delete: its verbs are read, create and update");
      if (host === "sealed" && (rule.path === undefined || rule.type !== undefined || rule.own)) return fail("a sealed applet works by folder: each rule is {path, verbs}, with no type and no own");
      allow.push(rule);
    }
    m.vaults.push({ vault, allow });
  }

  const reach = list(raw.reach, LIMITS2.reach);
  if (!reach) return fail("reach must be a short list");
  for (const r of reach) {
    if (r === "voice") {
      if (host === "sealed") return fail("a sealed applet can't record: the frame has no microphone");
      if (!m.reach.some((x) => x.kind === "voice")) m.reach.push({ kind: "voice" });
      continue;
    }
    if (!plain(r) || !hasOnly(r, ["room", "verbs"])) return fail("reach is voice, or {room, verbs}");
    const room = typeof r.room === "string" && r.room.length >= 1 && r.room.length <= 100 && !hasHidden(r.room) && !/[\u0000-\u001f]/.test(r.room) ? r.room : null;
    if (!room) return fail("a room is named by its id");
    if (m.reach.some((x) => x.kind === "room" && x.room === room)) return fail("reach names a room twice");
    const verbs = wordsOf(r.verbs, ROOM_VERBS);
    if (!verbs) return fail(`a room's verbs are a list of ${ROOM_VERBS.join(", ")}`);
    m.reach.push({ kind: "room", room, verbs });
  }

  const search = list(raw.search, LIMITS2.search);
  if (!search) return fail("search must be a short list");
  for (const s of search) {
    if (!plain(s) || !hasOnly(s, ["what", "vault", "type", "path"])) return fail("each search is {what, vault?, type?, path?}");
    const what = line(s.what, LIMITS2.what);
    if (!what) return fail("each search says what it finds, in a word or two");
    const offer: SearchOffer = { what };
    if (s.vault !== undefined || s.type !== undefined || s.path !== undefined) {
      const vault = typeof s.vault === "string" && VAULT.test(s.vault) ? s.vault : null;
      if (!vault) return fail("a search over notes names its vault");
      offer.vault = vault;
      if (s.type !== undefined) { const t = typeOf(s.type); if (!t) return fail("a search's type is a tag"); offer.type = t; }
      if (s.path !== undefined) { const p = pathOf(s.path); if (!p) return fail("a search's path is a plain folder that ends in /"); offer.path = p; }
      if (offer.type === undefined && offer.path === undefined) return fail("a search over notes names a type or a folder");
      // search only shows what the applet may read: the offer must sit inside one of its read rules
      const rules = m.vaults.find((v) => v.vault === vault)?.allow ?? [];
      const covered = rules.some((r) => r.verbs.includes("read") && !r.own
        && (r.path === undefined || (offer.path !== undefined && offer.path.startsWith(r.path)))
        && (r.type === undefined || offer.type === r.type));
      if (!covered) return fail(`it offers ${what} to search but can't read them`);
    }
    m.search.push(offer);
  }

  const screens = list(raw.screens, LIMITS2.screens);
  if (!screens) return fail("screens must be a short list");
  for (const s of screens) {
    if (!plain(s) || !hasOnly(s, ["id", "name"])) return fail("each screen is {id, name}");
    const sid = typeof s.id === "string" && s.id.length <= LIMITS2.id && ID.test(s.id) ? s.id : null;
    const sname = line(s.name, LIMITS2.name);
    if (!sid || !sname) return fail("a screen has a kebab-case id and a short name");
    if (m.screens.some((x) => x.id === sid)) return fail("screens names an id twice");
    m.screens.push({ id: sid, name: sname });
  }
  if (!m.screens.length) m.screens.push({ id: "home", name });
  return { ok: true, manifest: m };
}

/** The screen to open: the one asked for when the manifest declares it, else its first. */
export function screenOf(m: ManifestV2, asked?: string | null): Screen {
  return m.screens.find((s) => s.id === asked) ?? m.screens[0];
}

/** Where its data lives, in the shell's words (the drawer and search show them): its first door, else its first vault. */
export function whereWords(m: ManifestV2): string {
  const door = m.doors[0] ? doorOf(m.doors[0].door)?.name : null;
  if (door) return door.charAt(0).toLowerCase() + door.slice(1);
  const v = m.vaults[0];
  if (!v) return "nothing outside itself";
  return v.vault === HOME ? "your vault" : v.vault === HERE ? "the vault it lives in" : `${v.vault} vault`;
}
