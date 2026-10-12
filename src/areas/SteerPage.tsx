// "Steer, don't chat" (T-122): the parts of a node page that steer. The steering bar (a docked line that posts to the node's room through
// the app's own send path), the Log strip (the room's conversation, folded away until asked for), Running and Drafts, and the hook that
// shows what a steer changed. Pure parts (the diff, parsing, the placeholder) are in steerCore.ts.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cleanText } from "../interface/contract";
import type { AreaRoom } from "./AreaChat";
import { Changed } from "./Changed";
import { ownerLabel, useHoldTalk, type Talk } from "./NodeWork";
import { agoLabel } from "./treeRooms";
import { refKey } from "./refs";
import type { RoomRef } from "./talkCore";
import type { Task } from "./taskCore";
import { diffDrafts, diffTasks, marksById, POLL_COUNT, POLL_MS, type Draft, type Mark, type Run, type Steer } from "./steerCore";

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
/** Server clocks drift from this one; a change this much before the steer still counts as after it (the baseline already excludes older changes). */
export const SKEW_MS = 30_000;

// ---------------------------------------------------------------------------------------------- the steering bar

/** The docked bar: a mic (hold to talk), a line, Steer. Posts to the room the page names; shows no reply, the page itself changes. */
export function SteerBar({ room, talk, label, placeholder, about, onSteer }: {
  room: RoomRef | null; talk: Talk; label: string; placeholder: string;
  /** A task the Log was opened about ("T-07"): lines go out prefixed with it. */
  about: string | null;
  /** Called after a line went out (not for a voice note, which the outbox delivers on its own). */
  onSteer: (room: RoomRef) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const hold = useHoldTalk(room, talk, () => input.current?.focus());
  const { mine, error, setError } = hold;
  useEffect(() => { if (!sent) return; const t = setTimeout(() => setSent(null), 6000); return () => clearTimeout(t); }, [sent]);
  const submit = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    const body = text.trim();
    if (!room || !body || busy) return;
    setBusy(true); setError(null);
    try {
      await talk.sendText(room.id, about ? `About ${about}: ${body}` : body);
      setText(""); hold.setWasVoice(false); setSent(`Sent to #${room.name}`);
      onSteer(room);
    } catch (err) { setError(`Couldn't send: ${String(err).replace(/^Error:\s*/, "").slice(0, 120)}`); }
    finally { setBusy(false); }
  };
  const name = room ? `#${room.name}` : "no room";
  const status = error ?? sent ?? hold.voiceLine;
  return <form className="steer" aria-label={`Steer ${label}`} onSubmit={submit}>
    <button type="button" className={`steer-mic ${mine ? "recording" : ""}`} disabled={!room} aria-pressed={mine}
      aria-label={mine ? `Recording for ${name}. Release to send.` : `Hold to talk to ${name}. Tap to type.`} {...hold.pointer}><span aria-hidden="true" /></button>
    {mine ? <p className="steer-rec" role="status">Recording {mmss(talk.recording!.elapsed)} · release to send<small>to {name}</small></p>
      : <input ref={input} className="steer-line" value={text} onChange={(e) => setText(e.target.value)} maxLength={500} placeholder={room ? placeholder : "This level has no room yet"} aria-label={placeholder.replace(/…$/, "")} enterKeyHint="send" disabled={busy || !room} />}
    <button type="submit" className="steer-go" disabled={busy || !room || !text.trim()}>Steer</button>
    <p className={`steer-status ${error ? "bad" : ""}`} role={error ? "alert" : "status"} aria-live="polite">{status}</p>
  </form>;
}

// ---------------------------------------------------------------------------------------------- the effect of a steer

/**
 * After a steer: remember it, keep the tasks as they were, and for three minutes re-read every ten seconds (through the page's own
 * refresh). Whatever changed after the steer is marked in place until the node is left. `key` is the node: another node starts clean.
 */
export function useSteerEffect({ key, tasks, drafts, refresh }: { key: string; tasks: readonly Task[] | null; drafts: readonly Draft[]; refresh: () => void }) {
  type State = { steer: Steer; tasks: readonly Task[]; drafts: readonly Draft[] };
  const [state, setState] = useState<State | null>(null);
  const latest = useRef({ tasks, drafts });
  latest.current = { tasks, drafts };
  useEffect(() => { setState(null); }, [key]);
  const pollMs = () => (typeof window !== "undefined" && Number((window as unknown as { __STEER_POLL_MS?: number }).__STEER_POLL_MS)) || POLL_MS;
  const started = state?.steer.steerId;
  useEffect(() => {
    if (!started) return;
    let n = 0;
    const timer = setInterval(() => { if (typeof document === "undefined" || document.visibilityState !== "hidden") refresh(); if (++n >= POLL_COUNT) clearInterval(timer); }, pollMs());
    return () => clearInterval(timer);
  }, [started]); // eslint-disable-line react-hooks/exhaustive-deps
  const steered = useCallback((room: RoomRef) => {
    const steerId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setState((prev) => {
      // A second steer inside the window keeps the first baseline (and its marks) and restarts the polling.
      if (prev && Date.now() - prev.steer.at < POLL_COUNT * POLL_MS) return { ...prev, steer: { ...prev.steer, steerId, room: room.id } };
      // Before the first load there is nothing to compare with: no baseline, no marks (else every recent task reads "added").
      if (!latest.current.tasks) return prev;
      return { steer: { steerId, room: room.id, at: Date.now() }, tasks: latest.current.tasks, drafts: latest.current.drafts };
    });
  }, []);
  const marks = useMemo<Map<string, Mark[]>>(() => {
    if (!state) return new Map();
    const since = state.steer.at - SKEW_MS;
    return marksById([...diffTasks(state.tasks, tasks ?? [], since), ...diffDrafts(state.drafts, drafts, since)]);
  }, [state, tasks, drafts]);
  return { marks, steer: state?.steer ?? null, steered };
}

// ---------------------------------------------------------------------------------------------- Running and Drafts

const STATE_MARK: Record<Run["state"], string> = { queued: "◌", running: "●", stalled: "▲", done: "✓", failed: "✕" };

/** The dispatch ledger under this node. Nothing at all when there are no runs. */
export function RunSection({ runs, nowMs, onOpenNote }: { runs: readonly Run[]; nowMs: number; onOpenNote: (ref: string) => void }) {
  if (!runs.length) return null;
  const nowSec = Math.floor(nowMs / 1000);
  return <section className="ss ss-run" aria-label="Running"><h3 className="wr-h"><span>Running</span><em>{runs.filter((r) => r.state !== "done" && r.state !== "failed").length}</em></h3>
    <ul className="sl">{runs.map((r) => {
      const at = Date.parse(r.updated ?? "");
      return <li key={r.id} className="run" data-state={r.state}>
        <span className="run-chip" data-state={r.state}><i aria-hidden="true">{STATE_MARK[r.state]}</i>{r.state}</span>
        <span className="run-what">{r.task && <b className="wr-id">{r.task}</b>}<span>{cleanText(r.what)}</span>
          <small>{[r.by && ownerLabel(cleanText(r.by)), Number.isNaN(at) ? null : `${agoLabel(nowSec, Math.floor(at / 1000))}`].filter(Boolean).join(" · ")}</small></span>
        {r.result && refKey(r.result) && <button type="button" className="th-link" onClick={() => onOpenNote(refKey(r.result)!)} aria-label={`Open the result of: ${cleanText(r.what)}`}>Open</button>}
      </li>;
    })}</ul></section>;
}

/** Notes being drafted for a task (read-only): Open shows the note. Nothing at all when there are none. */
export function DraftSection({ drafts, marks, nowMs, onOpenNote }: { drafts: readonly Draft[]; marks: ReadonlyMap<string, readonly Mark[]>; nowMs: number; onOpenNote: (ref: string) => void }) {
  if (!drafts.length) return null;
  return <section className="ss ss-draft" aria-label="Drafts"><h3 className="wr-h"><span>Drafts</span><em>{drafts.length}</em></h3>
    <ul className="sl">{drafts.map((d) => <li key={d.id} className={`draft ${marks.get(d.id)?.length ? "changed" : ""}`} data-status={d.status}>
      <span className="run-chip" data-state={d.status === "ready" ? "done" : "running"}><i aria-hidden="true">{d.status === "ready" ? "✓" : "✎"}</i>{d.status}</span>
      <span className="run-what">{d.task && <b className="wr-id">{d.task}</b>}<span>{cleanText(d.title)}</span><Changed marks={marks.get(d.id)} nowMs={nowMs} /></span>
      <button type="button" className="th-link" onClick={() => onOpenNote(d.id)} aria-label={`Open draft: ${cleanText(d.title)}`}>Open</button>
    </li>)}</ul></section>;
}

// ---------------------------------------------------------------------------------------------- the Log

const startOfDaySec = (nowMs: number) => { const d = new Date(nowMs); d.setHours(0, 0, 0, 0); return Math.floor(d.getTime() / 1000); };
const hhmm = (sec: number) => new Date(sec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

/** `Log · #atlas/build · 4 messages today · last 14:06` */
export function logLine(a: { name: string; messages: readonly { ts: number }[] | null; nowMs: number }): string {
  const head = `Log · #${a.name}`;
  if (!a.messages) return head;
  const today = a.messages.filter((m) => m.ts >= startOfDaySec(a.nowMs));
  const last = a.messages.reduce((x, m) => Math.max(x, m.ts), 0);
  if (!a.messages.length) return `${head} · no messages yet`;
  return `${head} · ${today.length} message${today.length === 1 ? "" : "s"} today${last ? ` · last ${hhmm(last)}` : ""}`;
}

/**
 * The room's conversation, folded to one line at the foot of the page. Opened it covers the page upward with the room's own message list
 * (reactions, threads and attachments are the app's, restyled as slips); closing returns to the state. `about` names a task it was opened for.
 */
export function LogStrip({ room, view, nowMs, open, about, onToggle, onClose, onOpenTab }: {
  room: RoomRef; view: AreaRoom | null; nowMs: number; open: boolean; about: string | null;
  onToggle: () => void; onClose: () => void; onOpenTab: (id: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", key);
    box.current?.focus();
    return () => document.removeEventListener("keydown", key);
  }, [open, onClose]);
  const messages = view?.loaded ? view.messages : null;
  const line = logLine({ name: room.name.replace(/^#/, ""), messages, nowMs });
  return <>
    {open && <div ref={box} className="steer-log" role="dialog" aria-label={`Log #${room.name}`} tabIndex={-1}>
      <header className="steer-log-head">
        <div><b>Log · #{room.name}</b>{about && <small>about {about}</small>}</div>
        <button type="button" className="th-link" onClick={() => onOpenTab(room.id)}>Open as tab</button>
        <button type="button" className="th-link" onClick={onClose}>Close</button>
      </header>
      <div className="steer-log-body">{view ? view.render(null) : <p className="th-quiet" role="status">Opening the room…</p>}</div>
    </div>}
    <button type="button" className="logstrip" aria-expanded={open} onClick={onToggle}><span>{line}</span><i aria-hidden="true">{open ? "⌄" : "⌃"}</i></button>
  </>;
}
