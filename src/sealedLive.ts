// T-234: Uni's approval cards waiting for a tap in any room, for Needs you and the room's banner, notified once each. Read
// from Rust (`sealed_waiting`: checked, unanswered, not expired), again on every live message, after an answer, and when
// the earliest card's answer-by time passes.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Approval } from "./approvals";
import { notifyPlain } from "./desktopNotify";
import { SEALED_CHANGED, waitingTitle, type SealedWaiting } from "./sealedCardCore";

const NOTIFIED_KEY = "uni:sealed-notified";
const readNotified = (): string[] => { try { const v = JSON.parse(localStorage.getItem(NOTIFIED_KEY) ?? "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; } };

/** A waiting card as a Needs you row (the T-161 row: it opens the card's room at the card). */
export const sealedApproval = (w: SealedWaiting): Approval => ({
  ref: w.ref, channel: w.channel, author: "", ts: w.ts, root: w.root, command: waitingTitle(w), why: "", answers: [], deadline: w.expires, kind: "sealed", sealed: w,
});

const valid = (w: unknown): w is SealedWaiting => {
  const x = w as SealedWaiting;
  return !!x && typeof x.ref === "string" && typeof x.channel === "string" && typeof x.expires === "number" && (x.kind === "single" || x.kind === "morning");
};

export function useSealedWaiting(opts: { enabled: boolean; synced: number; roomsReady: boolean; roomName: (id: string) => string | null; looking: (channel: string, root: string | null) => boolean }): Approval[] {
  const [list, setList] = useState<SealedWaiting[]>([]);
  const optsRef = useRef(opts); optsRef.current = opts;
  const seq = useRef(0);
  const read = useCallback(() => {
    const n = ++seq.current;
    invoke<SealedWaiting[] | null>("sealed_waiting").then((r) => {
      if (n !== seq.current) return;
      const next = (Array.isArray(r) ? r : []).filter(valid);
      setList((old) => (old.length === next.length && old.every((w, i) => w.ref === next[i].ref) ? old : next));
    }).catch(() => {});
  }, []);
  useEffect(() => { if (opts.enabled) read(); else setList([]); }, [opts.enabled, opts.synced, read]);
  useEffect(() => {
    if (!opts.enabled) return;
    let t: number | undefined;
    const soon = () => { if (t === undefined) t = window.setTimeout(() => { t = undefined; read(); }, 150); };
    const un = listen<{ kind: string }>("uni://live", (e) => { if (e.payload.kind === "message" || e.payload.kind === "delete") soon(); });
    window.addEventListener(SEALED_CHANGED, soon);
    return () => { window.clearTimeout(t); window.removeEventListener(SEALED_CHANGED, soon); void un.then((f) => f()); };
  }, [opts.enabled, read]);
  useEffect(() => {
    if (!list.length) return;
    const next = Math.min(...list.map((w) => w.expires));
    const t = window.setTimeout(read, Math.min(2 ** 31 - 1, Math.max(0, next * 1000 - Date.now()) + 500));
    return () => window.clearTimeout(t);
  }, [list, read]);
  useEffect(() => {
    if (!list.length || !opts.roomsReady) return;
    const done = readNotified();
    const fresh = list.filter((w) => !done.includes(w.ref));
    if (!fresh.length) return;
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify([...done, ...fresh.map((w) => w.ref)].slice(-200)));
    for (const w of fresh) void notifyPlain({ author: "Uni", room: optsRef.current.roomName(w.channel) ?? "a room",
      preview: w.kind === "morning" ? "The morning card needs your tap" : `Asks to use ${w.credential} (${w.class})`, looking: optsRef.current.looking(w.channel, w.root) });
  }, [list, opts.roomsReady]);
  return useMemo(() => list.map(sealedApproval), [list]);
}
