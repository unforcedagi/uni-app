// T-213: how many of Uni's sends wait for you, for the Mail badge on the rail. Mail sets it each time it lists them; the
// app also asks once soon after it starts and again when it comes back into view (at most every ten minutes), and only
// where the bridge offers listing them. A failure leaves the badge as it was: the badge is a hint, Mail is the record.
// The held sends Mail last listed, and what deciding each did, are kept here too, so the outcome stays on screen when
// Mail is left and opened again (and goes with Forget).
import { invoke } from "@tauri-apps/api/core";
import { approvalOffered, can, type HeldOutcome, type Overview, type Parked } from "./mailCore.ts";

/** One held send as Mail shows it: `listed` while the bridge still lists it as waiting; `outcome` once you decided. */
export type HeldEntry = { item: Parked; outcome: HeldOutcome | null; listed: boolean };
let entries: Record<string, HeldEntry[]> = {};

/** Still yours to decide: listed, and not sent or declined here. */
export function waiting(e: HeldEntry): boolean {
  return e.listed && (!e.outcome || e.outcome.kind === "failed");
}

export function heldEntries(): Record<string, HeldEntry[]> {
  return entries;
}

/** Sends whose decision is on its way to the bridge: one at a time each (a second tap does nothing), and kept through
 *  any listing until the answer lands. */
const deciding = new Set<string>();

export function startDeciding(opId: string): boolean {
  if (deciding.has(opId)) return false;
  deciding.add(opId);
  return true;
}

export function endDeciding(opId: string): void {
  deciding.delete(opId);
}

/** Each listing is numbered when it is asked for; one that comes back after a newer one was merged is dropped. */
let listings = 0;
const merged: Record<string, number> = {};

export function beginListing(): number {
  lastCheck = Date.now();
  return ++listings;
}

/** A fresh listing of `accountId`: what is listed now, then what has left the list but was decided here or is being
 *  decided (its outcome stays, or is still to come). A decision made here outlives a listing that still shows the send
 *  waiting (that listing was read before the decision). One that left without being decided here was decided elsewhere:
 *  it goes. */
export function mergeListing(accountId: string, list: Parked[], forGen: number, seq: number): void {
  if (forGen !== gen || seq < (merged[accountId] ?? 0)) return;
  merged[accountId] = seq;
  const before = entries[accountId] ?? [];
  const now: HeldEntry[] = list.map((item) => {
    const was = before.find((e) => e.item.op_id === item.op_id);
    return { item, outcome: was?.outcome ?? null, listed: true };
  });
  for (const e of before) if ((e.outcome || deciding.has(e.item.op_id)) && !list.some((p) => p.op_id === e.item.op_id)) now.push({ ...e, listed: false });
  entries = { ...entries, [accountId]: now };
}

export function setOutcome(accountId: string, opId: string, outcome: HeldOutcome, forGen: number): void {
  if (forGen !== gen) return;
  entries = { ...entries, [accountId]: (entries[accountId] ?? []).map((e) => (e.item.op_id === opId ? { ...e, outcome } : e)) };
}

/** Accounts that are no longer offered lose their entries. */
export function keepAccounts(ids: string[]): void {
  entries = Object.fromEntries(Object.entries(entries).filter(([id]) => ids.includes(id)));
}

export function waitingCount(): number {
  return Object.values(entries).flat().filter(waiting).length;
}

let count = 0;
/** Bumped by Forget: an answer that left before it is dropped. */
let gen = 0;
let lastCheck = 0;
const subs = new Set<(n: number) => void>();

export function heldCount(): number {
  return count;
}

export function onHeldCount(f: (n: number) => void): () => void {
  subs.add(f);
  return () => { subs.delete(f); };
}

/** Mail's own listing: `forGen` is `heldGen()` when it asked. */
export function setHeldCount(n: number, forGen = gen): void {
  if (forGen !== gen || n === count) return;
  count = n;
  for (const f of subs) f(n);
}

export function heldGen(): number {
  return gen;
}

/** Ask the bridge, unless it was asked less than `minGapMs` ago. */
/** Ask the bridge, unless it (or Mail) asked less than `minGapMs` ago. The answer goes into the same store Mail reads,
 *  so the badge and Mail always count the same way. */
export async function checkHeld(minGapMs = 0): Promise<void> {
  if (lastCheck && Date.now() - lastCheck < minGapMs) return;
  const mine = gen, seq = beginListing();
  try {
    const o = await invoke<Overview | null>("mail_overview");
    if (!o || !Array.isArray(o.accounts)) return;
    const offered = o.accounts.filter(approvalOffered);
    if (mine !== gen) return;
    keepAccounts(offered.map((a) => a.id));
    for (const a of offered.filter((x) => can(x, "send.parked"))) {
      const list = await invoke<Parked[] | null>("mail_parked", { accountId: a.id });
      if (Array.isArray(list)) mergeListing(a.id, list, mine, seq);
    }
    setHeldCount(waitingCount(), mine);
  } catch { /* unreachable, not allowed, no bridge: the badge stays as it was */ }
}

/** Forget this device: no count from the old key, and nothing still on its way back lands. */
export function forgetHeld(): void {
  gen++;
  entries = {};
  deciding.clear();
  for (const k of Object.keys(merged)) delete merged[k];
  lastCheck = 0;
  count = 0;
  for (const f of subs) f(0);
}
