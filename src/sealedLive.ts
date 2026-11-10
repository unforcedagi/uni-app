// T-234: Uni's approval cards waiting for a tap in any room, for Needs you and the room's banner, notified once each. Read
// from Rust (`sealed_waiting`: checked, unanswered, not expired), again on every live message or edit, after an answer, and
// when the earliest card's answer-by time passes.
// T-335 card timing: a card has a deadline, so a read is never lost. Any answer newer than the one shown counts (never only the
// latest: while rooms keep talking that one may not land), and a read that fails is tried again by itself.
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

/** T-335: how long after a failed read of the waiting cards each retry waits. */
const RETRY_MS = [1000, 3000, 10_000];

const valid = (w: unknown): w is SealedWaiting => {
  const x = w as SealedWaiting;
  return !!x && typeof x.ref === "string" && typeof x.channel === "string" && typeof x.expires === "number" && (x.kind === "single" || x.kind === "morning");
};

export function useSealedWaiting(opts: { enabled: boolean; synced: number; roomsReady: boolean; roomName: (id: string) => string | null; looking: (channel: string, root: string | null) => boolean }): Approval[] {
  const [list, setList] = useState<SealedWaiting[]>([]);
  const optsRef = useRef(opts); optsRef.current = opts;
  const seq = useRef(0);
  const applied = useRef(0);
  const retry = useRef<{ timer: number | undefined; tries: number }>({ timer: undefined, tries: 0 });
  const read = useCallback((again = false) => {
    const n = ++seq.current;
    // a read asked for by something new starts the retries over; either way this read replaces a retry still waiting
    window.clearTimeout(retry.current.timer); retry.current.timer = undefined;
    if (!again) retry.current.tries = 0;
    invoke<SealedWaiting[] | null>("sealed_waiting").then((r) => {
      if (n <= applied.current) return;
      applied.current = n;
      const next = (Array.isArray(r) ? r : []).filter(valid);
      setList((old) => (old.length === next.length && old.every((w, i) => w.ref === next[i].ref) ? old : next));
    }).catch(() => {
      // nothing newer is on its way: try again in 1 s, 3 s, then 10 s, and then leave it to the next message
      if (n !== seq.current || retry.current.tries >= RETRY_MS.length) return;
      retry.current.timer = window.setTimeout(() => read(true), RETRY_MS[retry.current.tries++]);
    });
  }, []);
  useEffect(() => { if (opts.enabled) read(); else { seq.current += 1; applied.current = seq.current; window.clearTimeout(retry.current.timer); setList([]); } }, [opts.enabled, opts.synced, read]);
  useEffect(() => () => { seq.current += 1; applied.current = seq.current; window.clearTimeout(retry.current.timer); }, []);
  useEffect(() => {
    if (!opts.enabled) return;
    let t: number | undefined;
    const soon = () => { if (t === undefined) t = window.setTimeout(() => { t = undefined; read(); }, 150); };
    // an edit too: Uni edits a card that ended (answered on another device, expired, void) to one line, and Rust no longer lists it
    const un = listen<{ kind: string }>("uni://live", (e) => { if (e.payload.kind === "message" || e.payload.kind === "edit" || e.payload.kind === "delete") soon(); });
    window.addEventListener(SEALED_CHANGED, soon);
    return () => { window.clearTimeout(t); window.removeEventListener(SEALED_CHANGED, soon); void un.then((f) => f()); };
  }, [opts.enabled, read]);
  useEffect(() => {
    if (!list.length) return;
    const next = Math.min(...list.map((w) => w.expires));
    const t = window.setTimeout(() => read(), Math.min(2 ** 31 - 1, Math.max(0, next * 1000 - Date.now()) + 500));
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
