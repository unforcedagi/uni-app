// T-335 one ask, step 2: the room asks this device holds, read from its store as signed (Rust keeps the signed events the ask rule needs:
// asks, answers, edits, deletions; `ask_events`), and the policy (who may ask, whose answers count; `ask_policy`). Read at start, on any
// message, edit or deletion the relay pushes, when the window comes back, and after an answer this device sends. Never on a timer: whether
// an ask is still open is worked out from these events and the clock where it is drawn (src/shape/oneAsk.ts), so a lapse needs no re-read.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { READ_BACK_S, type Policy, type Template } from "../ask/index.ts";

export type RoomAsks = { events: unknown[]; policy: Policy | null; reread: () => void; post: (channel: string, template: Template) => Promise<{ ref: string } | null> };

export function useRoomAsks(on: boolean, identity: string | null): RoomAsks {
  const [events, setEvents] = useState<unknown[]>([]);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const seq = useRef(0);
  const read = useCallback(() => {
    if (!on || !identity) return;
    const n = ++seq.current;
    // asks live at most 14 days: the window the spec reads (SPEC.md §5), from this device's own store
    const since = Math.floor(Date.now() / 1000) - READ_BACK_S;
    invoke<unknown[]>("ask_events", { since }).then((r) => { if (n === seq.current) setEvents(Array.isArray(r) ? r : []); }).catch(() => { /* the next message tries again */ });
  }, [on, identity]);
  useEffect(() => {
    setEvents([]); setPolicy(null);
    if (!on || !identity) return;
    let gone = false;
    invoke<Policy>("ask_policy").then((p) => { if (!gone && p && Array.isArray(p.askers) && Array.isArray(p.owner)) setPolicy({ askers: p.askers, owner: p.owner }); }).catch(() => {});
    read();
    let t: number | undefined;
    const soon = () => { if (t === undefined) t = window.setTimeout(() => { t = undefined; read(); }, 150); };
    const un = listen<{ kind: string }>("uni://live", (e) => { if (e.payload.kind === "message" || e.payload.kind === "edit" || e.payload.kind === "delete") soon(); });
    window.addEventListener("focus", soon);
    return () => { gone = true; window.clearTimeout(t); window.removeEventListener("focus", soon); void un.then((f) => f()); };
  }, [on, identity, read]);
  /** Post an answer as the library built it (signed by Rust as this identity, in the main line), then read again so every view has it. */
  const post = useCallback(async (channel: string, template: Template) => {
    const sent = await invoke<{ ref: string } | null>("post_answer", { channel, template });
    read();
    return sent;
  }, [read]);
  return { events, policy, reread: read, post };
}
