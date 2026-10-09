// The interface manifest: what a sealed interface needs, read from its note's
// metadata `interface: {contract: 1, needs: [{"vault.read": "Areas/Techne/"}, {"chat.read": "area"}, ...]}`.
// Symbolic scopes (`area`) resolve against the host context. The user's grant
// is keyed by what the needs RESOLVE to (prefixes, room ids, area path), see
// `grantKey`, so moving the note or editing the area's room re-asks.

import { CAPABILITIES, CONTRACT_VERSION, hasHidden, plain, safePrefix, type Capability } from "./contract.ts";

export type Need = { cap: Capability; scope: string };
export type Manifest = { contract: 1; needs: Need[] };
/** What the host knows about where the interface runs. */
export type HostContext = { areaPath: string; channels: string[] };
/** Needs resolved to concrete scopes: folder prefixes for vault.read, room ids for chat.*. */
export type Resolved = Partial<Record<Capability, string[]>>;
export type ManifestResult = { ok: true; manifest: Manifest; defaulted: boolean } | { ok: false; error: string };

const MAX_NEEDS = 12;
const stripExt = (p: string) => p.replace(/\.(md|html)$/i, "");

/** `area` → the area's own folder. */
export const areaPrefix = (ctx: HostContext) => `${stripExt(ctx.areaPath)}/`;

/** The needs an interface gets when its note declares none. */
export function defaultNeeds(): Need[] {
  return [{ cap: "vault.read", scope: "area" }, { cap: "chat.read", scope: "area" }, { cap: "chat.draft", scope: "area" }];
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * SHA-256 over the canonical RESOLVED needs plus the area path: the same
 * symbolic `area` need means something else in another folder or room, and
 * that must ask again. Order and duplicates do not matter.
 */
export function grantKey(resolved: Resolved, areaPath: string): Promise<string> {
  const caps = Object.keys(resolved).sort().map((cap) => [cap, [...new Set(resolved[cap as Capability] ?? [])].sort()]);
  return sha256Hex(JSON.stringify({ area: stripExt(areaPath), caps }));
}

/** SHA-256 of the app's HTML: a change runs, but the host says so. */
export const htmlHash = (html: string) => sha256Hex(html);

function validScope(cap: Capability, scope: unknown): string | null {
  if (typeof scope !== "string") return null;
  if (hasHidden(scope)) return null;
  if (scope === "area") return scope;
  if (cap === "vault.read") return safePrefix(scope);
  // chat.*: an explicit room id
  return scope.length >= 1 && scope.length <= 100 && !/[\u0000-\u001f]/.test(scope) ? scope : null;
}

/** Parse the metadata of an interface note. No `interface` key means the default needs. */
export function parseManifest(metadata: unknown, _ctx: HostContext): ManifestResult {
  const meta = plain(metadata) ? metadata : {};
  if (!("interface" in meta) || meta.interface === undefined || meta.interface === null) {
    const needs = defaultNeeds();
    return { ok: true, manifest: { contract: CONTRACT_VERSION, needs }, defaulted: true };
  }
  const raw = meta.interface;
  if (!plain(raw)) return { ok: false, error: "interface must be an object" };
  if (raw.contract !== CONTRACT_VERSION) return { ok: false, error: `unsupported contract ${String(raw.contract)}` };
  if (!Array.isArray(raw.needs) || raw.needs.length > MAX_NEEDS) return { ok: false, error: "needs must be a short list" };
  const needs: Need[] = [];
  for (const item of raw.needs) {
    if (!plain(item)) return { ok: false, error: "each need is {capability: scope}" };
    const keys = Object.keys(item);
    if (keys.length !== 1) return { ok: false, error: "each need names one capability" };
    const cap = keys[0] as Capability;
    if (!(CAPABILITIES as readonly string[]).includes(cap)) return { ok: false, error: `unknown capability ${cap}` };
    const scope = validScope(cap, item[cap]);
    if (scope === null) return { ok: false, error: `bad scope for ${cap}` };
    needs.push({ cap, scope });
  }
  return { ok: true, manifest: { contract: CONTRACT_VERSION, needs }, defaulted: false };
}

/** Resolve symbolic scopes against the host context. A cap with no resolvable scope is absent (not granted). */
export function resolveNeeds(needs: readonly Need[], ctx: HostContext): Resolved {
  const out: Resolved = {};
  const add = (cap: Capability, scopes: string[]) => { if (!scopes.length) return; out[cap] = [...new Set([...(out[cap] ?? []), ...scopes])]; };
  for (const n of needs) {
    if (n.cap === "vault.read") add(n.cap, [n.scope === "area" ? areaPrefix(ctx) : n.scope]);
    else add(n.cap, n.scope === "area" ? ctx.channels : [n.scope]);
  }
  return out;
}

export type NeedLine = { text: string; /** A vault prefix or a room outside the area: the prompt stresses it. */ outside: boolean };

/** The needs in plain words, for the grant prompt. The host writes every word; nothing here comes from the app. */
export function describeNeeds(needs: readonly Need[], ctx: HostContext, roomName: (id: string) => string): NeedLine[] {
  const rooms = (scope: string) => (scope === "area" ? ctx.channels : [scope]).map((id) => `#${roomName(id)}`).join(", ") || "no room (none is linked)";
  const outsideRoom = (scope: string) => scope !== "area" && !ctx.channels.includes(scope);
  const own = areaPrefix(ctx);
  return needs.map((n): NeedLine => {
    switch (n.cap) {
      case "vault.read": {
        const prefix = n.scope === "area" ? own : n.scope;
        return prefix.startsWith(own) ? { text: `Read notes in ${prefix}`, outside: false } : { text: `Read notes outside this area, in ${prefix}`, outside: true };
      }
      case "chat.read": return outsideRoom(n.scope)
        ? { text: `Read recent messages in a room outside this area, ${rooms(n.scope)}`, outside: true }
        : { text: `Read recent messages in ${rooms(n.scope)}`, outside: false };
      case "chat.draft": return outsideRoom(n.scope)
        ? { text: `Suggest drafts for a room outside this area, ${rooms(n.scope)} (you decide what is added; nothing is sent)`, outside: true }
        : { text: `Suggest drafts for ${rooms(n.scope)} (you decide what is added; nothing is sent)`, outside: false };
    }
  });
}
