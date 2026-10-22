// T-161: the Hermes approval prompts waiting in any room, kept current for every surface (Needs you, the room, the room list) and
// notified once each. Read from the store (`approval_messages`), decided by `pendingApprovals`; re-read on every live message, and once
// more when the earliest prompt's own window ends (the time it states, not a guess).
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { commandLine, pendingApprovals, type Approval, type ApprovalSource } from "./approvals";
import { notifyPlain } from "./desktopNotify";

export type ApprovalsView = { list: Approval[]; /** opens the prompt's room at its message, the composer focused */ open: (a: Approval) => void; roomName: (id: string) => string | null };
export const ApprovalsContext = createContext<ApprovalsView>({ list: [], open: () => {}, roomName: () => null });
export const useApprovalList = () => useContext(ApprovalsContext);

const NOTIFIED_KEY = "uni:approvals-notified";
const readNotified = (): string[] => { try { const v = JSON.parse(localStorage.getItem(NOTIFIED_KEY) ?? "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; } };

export function useApprovals(opts: { identity: string | null; enabled: boolean; synced: number; roomsReady: boolean; roomName: (id: string) => string | null; looking: (channel: string) => boolean }): Approval[] {
  const [list, setList] = useState<Approval[]>([]);
  const rows = useRef<ApprovalSource[]>([]);
  const optsRef = useRef(opts); optsRef.current = opts;
  const seq = useRef(0);
  const applied = useRef(0);
  const decide = useCallback(() => setList((old) => {
    const next = pendingApprovals(rows.current, Date.now() / 1000, optsRef.current.identity);
    return next.length === old.length && next.every((a, i) => a.ref === old[i].ref) ? old : next;
  }), []);
  const read = useCallback(() => {
    const n = ++seq.current;
    // any answer newer than the one applied counts (never only the latest: under steady traffic that one may never land)
    invoke<ApprovalSource[] | null>("approval_messages").then((r) => { if (n <= applied.current) return; applied.current = n; rows.current = r ?? []; decide(); }).catch(() => {});
  }, [decide]);
  useEffect(() => { if (opts.enabled) read(); else { rows.current = []; setList([]); } }, [opts.enabled, opts.identity, opts.synced, read]);
  useEffect(() => {
    if (!opts.enabled) return;
    let t: number | undefined;
    const un = listen<{ kind: string }>("uni://live", (e) => {
      if (e.payload.kind !== "message" && e.payload.kind !== "edit" && e.payload.kind !== "delete") return;
      window.clearTimeout(t); t = window.setTimeout(read, 150);
    });
    return () => { window.clearTimeout(t); void un.then((f) => f()); };
  }, [opts.enabled, read]);
  // the earliest window to end: the list is decided again then (and the room's message is still there to read, answered or not)
  useEffect(() => {
    const next = Math.min(...list.map((a) => a.deadline ?? Infinity));
    if (!Number.isFinite(next)) return;
    const t = window.setTimeout(decide, Math.max(0, next * 1000 - Date.now()) + 500);
    return () => window.clearTimeout(t);
  }, [list, decide]);
  // one notification per prompt, ever (kept across restarts), whatever screen is open; never for one the user is looking at. It waits for
  // the room list, so it names the room
  useEffect(() => {
    if (!list.length || !opts.roomsReady) return;
    const done = readNotified();
    const fresh = list.filter((a) => !done.includes(a.ref));
    if (!fresh.length) return;
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify([...done, ...fresh.map((a) => a.ref)].slice(-200)));
    for (const a of fresh) void notifyPlain({ author: "Hermes", room: optsRef.current.roomName(a.channel) ?? "a room", preview: `Needs your OK to run: ${commandLine(a)}`, looking: optsRef.current.looking(a.channel) });
  }, [list, opts.roomsReady]);
  return list;
}
