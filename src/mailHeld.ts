// T-213: Uni's sends held for you, one store for every view. It holds the sends last listed and what deciding each did,
// so an outcome stays on screen when Mail is left and opened again, and reaches whichever Mail is open when it lands
// (views subscribe: `onHeld`). The Mail badge on the rail is its count of sends still waiting. Mail lists them when it
// opens and on Refresh; the app also asks once soon after it starts and again when it comes back into view (at most
// every ten minutes), only where the bridge offers listing them. A failure leaves everything as it was. Forget empties it.
import { invoke } from "@tauri-apps/api/core";
import { approvalOffered, can, type HeldOutcome, type Overview, type Parked } from "./mailCore.ts";

/** One held send as Mail shows it: `listed` while the bridge still lists it as waiting; `outcome` once you decided. */
export type HeldEntry = { item: Parked; outcome: HeldOutcome | null; listed: boolean };
let entries: Record<string, HeldEntry[]> = {};
const viewers = new Set<() => void>();

/** Subscribe to every change (for useSyncExternalStore with `heldEntries`). */
export function onHeld(f: () => void): () => void {
  viewers.add(f);
  return () => { viewers.delete(f); };
}

/** After each change: every view, and the count for the badge. */
function changed(): void {
  const n = waitingCount();
  if (n !== count) { count = n; for (const f of subs) f(n); }
  for (const f of viewers) f();
}

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
  changed();
}

export function setOutcome(accountId: string, opId: string, outcome: HeldOutcome, forGen: number): void {
  if (forGen !== gen) return;
  entries = { ...entries, [accountId]: (entries[accountId] ?? []).map((e) => (e.item.op_id === opId ? { ...e, outcome } : e)) };
  changed();
}

/** An account where deciding is no longer offered: what was decided there, or is being decided, is kept out of sight
 *  (not listed, not counted) so its outcome isn't lost if deciding comes back; the rest goes. */
export function keepAccounts(ids: string[], forGen: number): void {
  if (forGen !== gen) return;
  let touched = false;
  const next: Record<string, HeldEntry[]> = {};
  for (const [id, list] of Object.entries(entries)) {
    if (ids.includes(id)) { next[id] = list; continue; }
    const kept = list.filter((e) => e.outcome || deciding.has(e.item.op_id)).map((e) => (e.listed ? { ...e, listed: false } : e));
    if (kept.length !== list.length || kept.some((e, i) => e !== list[i])) touched = true;
    if (kept.length) next[id] = kept;
  }
  if (!touched) return;
  entries = next;
  changed();
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
    keepAccounts(offered.map((a) => a.id), mine);
    for (const a of offered.filter((x) => can(x, "send.parked"))) {
      const list = await invoke<Parked[] | null>("mail_parked", { accountId: a.id });
      if (Array.isArray(list)) mergeListing(a.id, list, mine, seq);
    }
  } catch { /* unreachable, not allowed, no bridge: the badge stays as it was */ }
}

/** Forget this device: no count from the old key, and nothing still on its way back lands. */
export function forgetHeld(): void {
  gen++;
  entries = {};
  deciding.clear();
  for (const k of Object.keys(merged)) delete merged[k];
  lastCheck = 0;
  changed();
}
