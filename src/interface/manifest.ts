// The interface manifest: what a sealed interface needs, read from its note's
// metadata `interface: {contract: 1, needs: [{"vault.read": "Areas/Techne/"}, {"chat.read": "area"}, ...]}`.
// Symbolic scopes (`area`) resolve against the host context. The hash of the
// normalised needs keys the user's grant: any change to the needs re-asks.

import { CAPABILITIES, CONTRACT_VERSION, plain, safePrefix, type Capability } from "./contract.ts";

export type Need = { cap: Capability; scope: string };
export type Manifest = { contract: 1; needs: Need[] };
/** What the host knows about where the interface runs. */
export type HostContext = { areaPath: string; channels: string[] };
/** Needs resolved to concrete scopes: folder prefixes for vault.read, room ids for chat.*. */
export type Resolved = Partial<Record<Capability, string[]>>;
export type ManifestResult = { ok: true; manifest: Manifest; hash: string; defaulted: boolean } | { ok: false; error: string };

const MAX_NEEDS = 12;
const stripExt = (p: string) => p.replace(/\.(md|html)$/i, "");

/** `area` → the area's own folder. */
export const areaPrefix = (ctx: HostContext) => `${stripExt(ctx.areaPath)}/`;

/** The needs an interface gets when its note declares none. */
export function defaultNeeds(): Need[] {
  return [{ cap: "vault.read", scope: "area" }, { cap: "chat.read", scope: "area" }, { cap: "chat.draft", scope: "area" }];
}

const needKey = (n: Need) => `${n.cap}=${n.scope}`;

/** A stable, order-independent hash (cyrb53) of the normalised needs. */
export function hashNeeds(needs: readonly Need[]): string {
  const s = [...new Set(needs.map(needKey))].sort().join("\n");
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function validScope(cap: Capability, scope: unknown): string | null {
  if (typeof scope !== "string") return null;
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
    return { ok: true, manifest: { contract: CONTRACT_VERSION, needs }, hash: hashNeeds(needs), defaulted: true };
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
  return { ok: true, manifest: { contract: CONTRACT_VERSION, needs }, hash: hashNeeds(needs), defaulted: false };
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

/** The needs in plain words, for the grant prompt. */
export function describeNeeds(needs: readonly Need[], ctx: HostContext, roomName: (id: string) => string): string[] {
  const rooms = (scope: string) => (scope === "area" ? ctx.channels : [scope]).map((id) => `#${roomName(id)}`).join(", ") || "no room (none is linked)";
  return needs.map((n) => {
    switch (n.cap) {
      case "vault.read": return `Read notes in ${n.scope === "area" ? areaPrefix(ctx) : n.scope}`;
      case "chat.read": return `Read recent messages in ${rooms(n.scope)}`;
      case "chat.draft": return `Suggest drafts for ${rooms(n.scope)} (you decide what is added; nothing is sent)`;
    }
  });
}
