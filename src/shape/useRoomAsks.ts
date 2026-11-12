// T-335 one ask, step 2: the room asks this device holds, read from its store as signed (Rust keeps the signed events the ask rule needs:
// asks, answers, edits, deletions; `ask_events`), and the policy (who may ask, whose answers count; `ask_policy`). Read at start, on any
// message, edit or deletion the relay pushes, when the window comes back, and after an answer this device sends. Never on a timer: whether
// an ask is still open is worked out from these events and the clock where it is drawn (src/shape/oneAsk.ts), so a lapse needs no re-read.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { READ_BACK_S, type Policy, type Template } from "../ask/index.ts";

/** Sent when the app stored messages with no live event (older history): the cards read the store again. */
export const ASKS_STORED = "uni:asks-stored";

export type RoomAsks = { events: unknown[]; policy: Policy | null; reread: () => Promise<void>; post: (channel: string, template: Template) => Promise<{ ref: string } | null> };

/** `moved`: anything that changes when the rooms' messages move (their newest time): a history fetch stores messages with no live event. */
export function useRoomAsks(on: boolean, identity: string | null, moved = 0): RoomAsks {
  const [events, setEvents] = useState<unknown[]>([]);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const seq = useRef(0);
  const soonRef = useRef<(() => void) | null>(null);
  const policyRef = useRef<Policy | null>(null); policyRef.current = policy;
  const who = useRef(identity); who.current = identity;
  const askPolicy = useCallback(() => {
    if (!on || !identity) return;
    // (an answer for an identity no longer current is dropped: the next read asks again for this one)
    invoke<Policy>("ask_policy").then((p) => { if (who.current === identity && p && Array.isArray(p.askers) && Array.isArray(p.owner)) setPolicy((old) => (old && JSON.stringify(old) === JSON.stringify(p) ? old : { askers: p.askers, owner: p.owner })); }).catch(() => { /* asked again on the next read */ });
  }, [on, identity]);
  const read = useCallback(async () => {
    if (!on || !identity) return;
    // (the keys may not have been loaded at the first ask: every read asks again until it has the policy)
    if (!policyRef.current) askPolicy();
    const n = ++seq.current;
    // asks live at most 14 days: the window the spec reads (SPEC.md §5), from this device's own store
    const since = Math.floor(Date.now() / 1000) - READ_BACK_S;
    await invoke<unknown[]>("ask_events", { since }).then((r) => { if (n === seq.current) setEvents(Array.isArray(r) ? r : []); }).catch(() => { /* the next message tries again */ });
  }, [on, identity, askPolicy]);
  useEffect(() => {
    setEvents([]); setPolicy(null); policyRef.current = null;
    if (!on || !identity) return;
    let gone = false;
    void read();
    let t: number | undefined;
    const soon = () => { if (t === undefined) t = window.setTimeout(() => { t = undefined; void read(); }, 150); };
    soonRef.current = soon;
    // (what can bring an ask, an answer or a close: not typing, profiles or status)
    const un = listen<{ kind: string }>("uni://live", (e) => { if (!gone && ["message", "edit", "delete", "rooms"].includes(e.payload.kind)) soon(); });
    window.addEventListener("focus", soon);
    window.addEventListener(ASKS_STORED, soon);
    return () => { gone = true; soonRef.current = null; window.clearTimeout(t); window.removeEventListener("focus", soon); window.removeEventListener(ASKS_STORED, soon); void un.then((f) => f()); };
  }, [on, identity, read]);
  // the rooms' messages moved (a sync stores them with no live event): read again, through the same debounce, once per change
  const lastMoved = useRef(moved);
  useEffect(() => { if (moved === lastMoved.current) return; lastMoved.current = moved; soonRef.current?.(); }, [moved]);
  /** Post an answer as the library built it (signed by Rust as this identity, in the main line), then read again so every view has it
   *  (awaited: the card stays busy until it shows the answer, so a second tap can't send a second answer). */
  const post = useCallback(async (channel: string, template: Template) => {
    const sent = await invoke<{ ref: string } | null>("post_answer", { channel, template });
    await read();
    return sent;
  }, [read]);
  return { events, policy, reread: read, post };
}
