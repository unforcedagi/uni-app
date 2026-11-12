/** Just enough Nostr for asks: event ids (NIP-01) and BIP-340 signatures, on @noble/curves. */
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export type Tag = string[];
export interface Template { kind: number; tags: Tag[]; content: string }
export interface NostrEvent extends Template { id: string; pubkey: string; created_at: number; sig: string }

const enc = new TextEncoder();
const HEX = /^[0-9a-f]*$/;

export function serialize(ev: Pick<NostrEvent, "pubkey" | "created_at" | "kind" | "tags" | "content">): string {
  return JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]);
}

export function eventId(ev: Pick<NostrEvent, "pubkey" | "created_at" | "kind" | "tags" | "content">): string {
  return bytesToHex(sha256(enc.encode(serialize(ev))));
}

export function pubkeyHex(sk: Uint8Array): string {
  return bytesToHex(schnorr.getPublicKey(sk));
}

/** A template signed at `createdAt`. `aux` defaults to fresh randomness. */
export function signEvent(sk: Uint8Array, t: Template, createdAt: number, aux?: Uint8Array): NostrEvent {
  const base = { pubkey: pubkeyHex(sk), created_at: Math.trunc(createdAt), kind: t.kind,
    tags: t.tags.map((x) => [...x]), content: t.content };
  const id = eventId(base);
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), sk, aux));
  return { ...base, id, sig };
}

const isHex = (v: unknown, n: number): v is string => typeof v === "string" && v.length === n && HEX.test(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

const sigOk = new Map<string, boolean>();

/** null when the event is well formed, its id is its hash and its signature checks; else "bad-id" or "bad-sig".
 * Never throws. Only the Schnorr check is cached, on id + pubkey + sig; the id is re-hashed every time. */
export function checkEvent(ev: unknown): "bad-id" | "bad-sig" | null {
  try { return check(ev); } catch { return "bad-id"; }
}

function check(ev: unknown): "bad-id" | "bad-sig" | null {
  const e = ev as Record<string, unknown>;
  if (!(e && typeof e === "object" && isHex(e.id, 64) && isHex(e.pubkey, 64) && isHex(e.sig, 128)
    && isInt(e.created_at) && isInt(e.kind) && e.created_at >= 0 && e.created_at <= Number.MAX_SAFE_INTEGER
    && e.kind >= 0 && e.kind <= 65535 && typeof e.content === "string" && Array.isArray(e.tags)
    && e.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === "string")))) return "bad-id";
  const n = e as unknown as NostrEvent;
  // A lone surrogate has no UTF-8 form, so the event has no id (Python can't hash it either).
  if (!n.content.isWellFormed() || !n.tags.every((t) => t.every((x) => x.isWellFormed()))) return "bad-id";
  if (eventId(n) !== n.id) return "bad-id";
  const key = n.id + n.pubkey + n.sig;
  let ok = sigOk.get(key);
  if (ok === undefined) {
    try { ok = schnorr.verify(hexToBytes(n.sig), hexToBytes(n.id), hexToBytes(n.pubkey)); } catch { ok = false; }
    if (sigOk.size >= 65536) sigOk.clear();
    sigOk.set(key, ok);
  }
  return ok ? null : "bad-sig";
}

export const verifyEvent = (ev: unknown): boolean => checkEvent(ev) === null;
