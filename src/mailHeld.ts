// T-213: how many of Uni's sends wait for you, for the Mail badge on the rail. Mail sets it each time it lists them; the
// app also asks once soon after it starts and again when it comes back into view (at most every ten minutes), and only
// where the bridge offers listing them. A failure leaves the badge as it was: the badge is a hint, Mail is the record.
// The held sends Mail last listed, and what deciding each did, are kept here too, so the outcome stays on screen when
// Mail is left and opened again (and goes with Forget).
import { invoke } from "@tauri-apps/api/core";
import { approvalOffered, can, type HeldOutcome, type Overview, type Parked } from "./mailCore";

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

/** A fresh listing of `accountId`: what is listed now (an earlier failure is kept on it), then what was decided here and
 *  has left the list (its outcome stays). One that left without being decided here was decided elsewhere: it goes. */
export function mergeListing(accountId: string, list: Parked[], forGen: number): void {
  if (forGen !== gen) return;
  const before = entries[accountId] ?? [];
  const now: HeldEntry[] = list.map((item) => {
    const was = before.find((e) => e.item.op_id === item.op_id);
    return { item, outcome: was?.outcome?.kind === "failed" ? was.outcome : null, listed: true };
  });
  for (const e of before) if (e.outcome && !list.some((p) => p.op_id === e.item.op_id)) now.push({ ...e, listed: false });
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
export async function checkHeld(minGapMs = 0): Promise<void> {
  if (Date.now() - lastCheck < minGapMs) return;
  lastCheck = Date.now();
  const mine = gen;
  try {
    const o = await invoke<Overview | null>("mail_overview");
    if (!o || !Array.isArray(o.accounts)) return;
    let n = 0;
    for (const a of o.accounts.filter((x) => approvalOffered(x) && can(x, "send.parked"))) {
      const list = await invoke<Parked[] | null>("mail_parked", { accountId: a.id });
      n += Array.isArray(list) ? list.length : 0;
    }
    setHeldCount(n, mine);
  } catch { /* unreachable, not allowed, no bridge: the badge stays as it was */ }
}

/** Forget this device: no count from the old key, and nothing still on its way back lands. */
export function forgetHeld(): void {
  gen++;
  entries = {};
  lastCheck = 0;
  count = 0;
  for (const f of subs) f(0);
}
