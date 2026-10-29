// T-161: the Hermes approval prompts waiting in any room, kept current for every surface (Needs you, the room, the room list) and
// notified once each. Read from the store (`approval_messages`), decided by `pendingApprovals`; re-read on every live message, and once
// more when the earliest prompt's own window ends (the time it states, not a guess).
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { commandLine, readApprovals, type Approval, type ApprovalOutcome, type ApprovalSource } from "./approvals";
import { notifyPlain } from "./desktopNotify";

export type ApprovalsView = { list: Approval[]; /** opens the prompt's room at its message, the composer focused */ open: (a: Approval) => void; roomName: (id: string) => string | null };
export const ApprovalsContext = createContext<ApprovalsView>({ list: [], open: () => {}, roomName: () => null });
export const useApprovalList = () => useContext(ApprovalsContext);

const NOTIFIED_KEY = "uni:approvals-notified";
const readNotified = (): string[] => { try { const v = JSON.parse(localStorage.getItem(NOTIFIED_KEY) ?? "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; } };

/** How far back `approval_messages` reads (lib.rs: a day): a prompt older than that is in neither the list nor `ended`. */
export const APPROVAL_WINDOW_S = 86_400;

/**
 * The prompts waiting, and (T-335) how each other prompt the store read ended, by the same reading over every room and thread. `ended` is
 * null until the store has answered once; `failed` says the last read failed (so a prompt's state is unknown, not waiting).
 */
export function useApprovals(opts: { identity: string | null; enabled: boolean; synced: number; roomsReady: boolean; roomName: (id: string) => string | null; looking: (channel: string, root: string | null) => boolean }): { list: Approval[]; ended: Map<string, ApprovalOutcome> | null; failed: boolean } {
  const [list, setList] = useState<Approval[]>([]);
  const [ended, setEnded] = useState<Map<string, ApprovalOutcome> | null>(null);
  const [failed, setFailed] = useState(false);
  const rows = useRef<ApprovalSource[]>([]);
  const optsRef = useRef(opts); optsRef.current = opts;
  const seq = useRef(0);
  const applied = useRef(0);
  /** the newest read that failed: an older read that lands after it doesn't make the state known again */
  const failedAt = useRef(0);
  const decide = useCallback(() => {
    const { pending: next, ended: out } = readApprovals(rows.current, Date.now() / 1000, optsRef.current.identity);
    const key = (m: Map<string, ApprovalOutcome>) => [...m].map(([k, v]) => `${k} ${v.outcome} ${v.at}`).sort().join("\n");
    setEnded((was) => (was && key(was) === key(out) ? was : out));
    // the same prompts, unedited: keep the old list (an edited one has a new command or window, so it is replaced)
    const same = (a: Approval, b: Approval) => a.ref === b.ref && a.command === b.command && a.why === b.why && a.deadline === b.deadline && a.answers.join() === b.answers.join();
    setList((old) => (next.length === old.length && next.every((a, i) => same(a, old[i])) ? old : next));
  }, []);
  const read = useCallback(() => {
    const n = ++seq.current;
    // any answer newer than the one applied counts (never only the latest: under steady traffic that one may never land)
    invoke<ApprovalSource[] | null>("approval_messages").then((r) => { if (n <= applied.current) return; applied.current = n; rows.current = r ?? []; setFailed(failedAt.current > n); decide(); })
      .catch(() => { failedAt.current = Math.max(failedAt.current, n); if (n > applied.current) setFailed(true); });
  }, [decide]);
  useEffect(() => { if (opts.enabled) read(); else { rows.current = []; failedAt.current = 0; setList([]); setEnded(null); setFailed(false); } }, [opts.enabled, opts.identity, opts.synced, read]);
  useEffect(() => {
    if (!opts.enabled) return;
    // at most one read each 150 ms, after the first message of a burst: steady traffic can't keep putting it off
    let t: number | undefined;
    const un = listen<{ kind: string }>("uni://live", (e) => {
      if (e.payload.kind !== "message" && e.payload.kind !== "edit" && e.payload.kind !== "delete") return;
      if (t === undefined) t = window.setTimeout(() => { t = undefined; read(); }, 150);
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
    for (const a of fresh) void notifyPlain({ author: "Hermes", room: optsRef.current.roomName(a.channel) ?? "a room", preview: `Needs your OK to run: ${commandLine(a)}`, looking: optsRef.current.looking(a.channel, a.root) });
  }, [list, opts.roomsReady]);
  return { list, ended, failed };
}
